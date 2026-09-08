import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

export const DEFAULT_CONFIG = Object.freeze({ branch: 'main', autoPullOnStartup: true,
  autoSync: false, syncIntervalSeconds: 60, commitMessage: 'sync: home config & memory', sshBatch: true })
export class SyncError extends Error {
  constructor(reason, message, status = 409) { super(message); this.reason = reason; this.status = status }
}
const fail = (reason, message, status) => { throw new SyncError(reason, message, status) }
const exists = file => { try { return fs.lstatSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const split0 = value => value.split('\0').filter(Boolean)

export function validateBranch(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value === 'HEAD' || value === '@' ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) || value.startsWith('-') || value.includes('..') || value.includes('@{') ||
    value.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock'))) fail('invalid-branch', '分支名称无效。', 400)
  return value
}
export function validateConfig(input, base = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-config', '配置必须是 JSON 对象。', 400)
  const allowed = [...Object.keys(DEFAULT_CONFIG), 'autoSyncOnStartup']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('invalid-config', `未知配置项：${key}`, 400)
  const cfg = { ...base, ...input }
  if (!Object.hasOwn(input, 'autoSync') && Object.hasOwn(input, 'autoSyncOnStartup')) cfg.autoSync = input.autoSyncOnStartup
  for (const key of ['autoSync', 'autoPullOnStartup', 'sshBatch']) if (typeof cfg[key] !== 'boolean') fail('invalid-config', `${key} 必须是布尔值。`, 400)
  if (Object.hasOwn(input, 'autoSyncOnStartup') && typeof input.autoSyncOnStartup !== 'boolean') fail('invalid-config', 'autoSyncOnStartup 必须是布尔值。', 400)
  delete cfg.autoSyncOnStartup
  validateBranch(cfg.branch)
  if (!Number.isInteger(cfg.syncIntervalSeconds) || cfg.syncIntervalSeconds < 15 || cfg.syncIntervalSeconds > 86400) fail('invalid-config', '同步间隔必须为 15–86400 秒的整数。', 400)
  if (typeof cfg.commitMessage !== 'string' || !cfg.commitMessage.trim() || cfg.commitMessage.length > 1000 || cfg.commitMessage.includes('\0')) fail('invalid-config', '提交信息必须为 1–1000 个字符。', 400)
  return cfg
}
export function validateRemote(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-') || (!path.isAbsolute(value) && /\s/.test(value))) fail('invalid-remote', '远端地址无效。', 400)
  if (/^(https|ssh):\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { fail('invalid-remote', '远端 URL 无效。', 400) }
    if (!url.hostname || url.password || (url.protocol === 'https:' && url.username)) fail('invalid-remote', '请使用凭据管理器，不要在 URL 中放置口令。', 400)
  } else if (!path.isAbsolute(value) && !/^(?:[\w.-]+@)?[\w.-]+:[\w./-]+$/.test(value)) fail('invalid-remote', '仅支持 HTTPS、SSH、SCP 格式或绝对本地仓库路径。', 400)
  return value
}
const exactFiles = new Set(['.gitignore', 'settings.yaml', 'cordis.patch.yml',
  'profiles/web/package.json', 'profiles/web/pnpm-lock.yaml', 'profiles/web/pnpm-workspace.yaml',
  'profiles/web/cordis.yml', 'profiles/web/cordis.patch.yml', 'profiles/web/.dsh-market/state.json'])
export function allowedFile(rel) {
  if (typeof rel !== 'string' || /[\\:\x00-\x1f\x7f]/.test(rel)) return false
  const parts = rel.split('/')
  if (parts.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) return false
  if (exactFiles.has(rel)) return true
  return parts[0] === 'mnemon' && parts.length > 1 && !parts.slice(1).some(s => s.startsWith('.') || /^(data|state|credentials?|secrets?)$/i.test(s)) && !/\.(log|wal|shm)$/i.test(rel)
}

export function createHomeSync(directory = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const home = exists(path.resolve(directory)) ? fs.realpathSync.native(path.resolve(directory)) : path.resolve(directory)
  if (home === path.parse(home).root) fail('invalid-home', 'DSH_HOME 不能是磁盘根目录。', 400)
  const configFile = path.join(home, 'dsh-home-sync.json'), lockDir = home + '.home-sync-lock'
  const historyFile = home + '.home-sync-history.json'
  const trackingRef = cfg => 'refs/dsh-home-sync/branches/' + cfg.branch
  let disposed = false, active = null, lastResult = null, historyWarning = null
  function readHistory() {
    try {
      const stat = exists(historyFile)
      if (!stat) return []
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('操作记录文件类型或大小无效')
      const rows = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
      if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || typeof r.message !== 'string')) throw new Error('操作记录格式无效')
      return rows.slice(0, 100)
    } catch (error) { historyWarning = '操作记录读取失败：' + error.message; return [] }
  }
  function recordResult(result) {
    historyWarning = null
    const temp = historyFile + '.' + crypto.randomUUID() + '.tmp'
    try {
      const rows = readHistory()
      if (historyWarning) return
      const row = { id: active.id, at: result.at, kind: result.kind, ok: result.ok,
        message: String(result.message || (result.ok ? '操作完成。' : result.reason)).slice(0, 6000), backupDir: result.backupDir }
      const saved = [row, ...rows].slice(0, 100)
      let serialized = JSON.stringify(saved)
      while (Buffer.byteLength(serialized) > 900 * 1024 && saved.length > 1) { saved.pop(); serialized = JSON.stringify(saved) }
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, historyFile)
    } catch (error) { historyWarning = '操作记录保存失败：' + error.message }
    finally { try { if (exists(temp)) fs.unlinkSync(temp) } catch (error) { historyWarning = '操作记录临时文件清理失败：' + error.message } }
  }
  function checkActive() { if (disposed) fail('stopped', '插件已停止。', 503) }
  function readConfig() {
    try { return validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))) }
    catch (e) { if (e.code === 'ENOENT') return { ...DEFAULT_CONFIG }; fail('config-corrupt', `配置读取失败，自动任务已暂停：${e.message}`, 503) }
  }
  function atomicConfig(cfg) {
    fs.mkdirSync(home, { recursive: true })
    const temp = configFile + '.' + crypto.randomUUID() + '.tmp'
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(cfg, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, configFile)
    } finally { if (exists(temp)) fs.unlinkSync(temp) }
  }
  function git(args, { cwd = home, cfg = DEFAULT_CONFIG, input, cleanup = false } = {}) {
    if (!cleanup) checkActive()
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|CONFIG_PARAMETERS|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|PREFIX|SSH|SSH_COMMAND)$/.test(key)) delete env[key]
    env.GIT_TERMINAL_PROMPT = '0'; env.GCM_INTERACTIVE = 'never'; env.GIT_OPTIONAL_LOCKS = '0'; env.GIT_NO_REPLACE_OBJECTS = '1'
    if (cfg.sshBatch) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15'
    // `safe.directory=*` skips Git's "dubious ownership" check: we only run
    // Git inside the validated DSH home or our own temp repositories, so a
    // directory legitimately owned by another Windows user (e.g. created by
    // an elevated prompt) must not block sync/init.
    return new Promise(resolve => {
      const child = execFile('git', ['-c', 'safe.directory=*', '--literal-pathspecs', '-C', cwd, ...args],
      { env, timeout: 90000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!error?.killed })
      })
      child.stdin.on('error', () => {}); child.stdin.end(input)
    })
  }
  async function must(args, options) {
    const r = await git(args, options)
    if (!r.ok) fail('git-failed', (r.stderr || r.stdout || `Git 失败：${r.code}`).trim())
    return r.stdout.trim()
  }
  function safeHomePath(rel) {
    if (!allowedFile(rel)) fail('unsafe-path', `禁止同步此路径：${rel}`)
    const target = path.resolve(home, ...rel.split('/'))
    if (!target.startsWith(home + path.sep)) fail('unsafe-path', '路径超出主目录。')
    const parts = rel.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const entry = exists(path.join(home, ...parts.slice(0, i)))
      if (entry && (entry.isSymbolicLink() || (i < parts.length ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1))) fail('path-collision', `路径不是独立的普通文件或目录：${rel}`)
    }
    return target
  }
  async function tree(ref, cwd = home) {
    const r = await git(['ls-tree', '-r', '-z', ref], { cwd })
    if (!r.ok) fail('tree-failed', r.stderr.trim())
    const files = []
    for (const row of split0(r.stdout)) {
      const tab = row.indexOf('\t'), rel = row.slice(tab + 1), mode = row.slice(0, 6)
      if (tab < 0 || !['100644', '100755'].includes(mode) || !allowedFile(rel)) fail('unsafe-tree', `仓库含禁止同步的路径或文件类型：${rel}`)
      files.push(rel)
    }
    if (new Set(files.map(f => f.toLowerCase())).size !== files.length) fail('path-collision', '仓库含大小写冲突的文件路径。')
    return files
  }
  async function ensureRepo(cfg, requireBranch = true, allowUnborn = false) {
    if (!exists(path.join(home, '.git'))) fail('no-repo', '尚未初始化同步仓库。')
    const root = await must(['rev-parse', '--show-toplevel'])
    const canonical = file => { const value = fs.realpathSync.native(file); return process.platform === 'win32' ? value.toLowerCase() : value }
    if (canonical(root) !== canonical(home)) fail('wrong-repo', 'Git 仓库根目录与 DSH_HOME 不一致。')
    const branch = await must(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (requireBranch && branch !== cfg.branch) fail('branch-mismatch', `当前分支 ${branch} 与同步分支 ${cfg.branch} 不一致。`)
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const location = await must(['rev-parse', '--git-path', marker])
      if (exists(path.resolve(home, location))) fail('unfinished-operation', '请先完成或撤销现有 Git 合并/变基操作。')
    }
    const head = await git(['rev-parse', '--verify', 'HEAD'])
    if (!head.ok) {
      const ref = await git(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch])
      if (!allowUnborn || ref.code !== 1) fail('invalid-head', head.stderr.trim())
    }
    return branch
  }
  async function inspectIndex() {
    const r = await git(['ls-files', '--stage', '-z'])
    if (!r.ok) fail('index-failed', r.stderr.trim())
    const files = []
    for (const row of split0(r.stdout)) {
      const tab = row.indexOf('\t'), rel = row.slice(tab + 1), meta = row.slice(0, tab).split(' ')
      if (!['100644', '100755'].includes(meta[0]) || meta[2] !== '0' || !allowedFile(rel)) fail('unsafe-index', `索引包含禁止路径或未解决冲突：${rel}`)
      safeHomePath(rel); files.push(rel)
    }
    return files
  }
  async function fetchRemote(cfg) {
    const remote = validateRemote(await must(['remote', 'get-url', 'origin']))
    await must(['fetch', '--no-tags', '--no-recurse-submodules', remote, '+refs/heads/' + cfg.branch + ':' + trackingRef(cfg)], { cfg })
    await tree(trackingRef(cfg))
    return await must(['rev-parse', trackingRef(cfg)])
  }
  async function aheadBehind(ref) {
    const [ahead, behind] = (await must(['rev-list', '--left-right', '--count', 'HEAD...' + ref])).split(/\s+/).map(Number)
    return { ahead, behind }
  }
  async function stageChanges() {
    const tracked = await inspectIndex(), r = await git(['ls-files', '--others', '--exclude-standard', '-z'])
    if (!r.ok) fail('status-failed', r.stderr.trim())
    const files = [...new Set([...tracked, ...split0(r.stdout).filter(allowedFile)])]
    for (const rel of files) safeHomePath(rel)
    if (files.length) await must(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: files.join('\0') + '\0' })
    await inspectIndex()
  }
  async function sync(pullOnly = false) {
    const cfg = readConfig()
    await ensureRepo(cfg); await tree('HEAD'); await inspectIndex()
    const remoteRef = await fetchRemote(cfg), targetFiles = await tree(remoteRef)
    for (const rel of targetFiles) safeHomePath(rel)
    const currentFiles = new Set(await tree('HEAD'))
    for (const rel of targetFiles) if (!currentFiles.has(rel) && exists(safeHomePath(rel))) fail('local-collision', `远端新增文件与本机未跟踪文件同名：${rel}`)
    if (!pullOnly) {
      await stageChanges()
      const changed = await git(['diff', '--cached', '--quiet'])
      if (changed.code === 1) await must(['commit', '-m', cfg.commitMessage], { cfg })
      else if (!changed.ok) fail('status-failed', changed.stderr.trim())
    }
    const counts = await aheadBehind(remoteRef)
    if (counts.behind) {
      const r = await git(['merge', '--no-autostash', pullOnly ? '--ff-only' : '--no-edit', remoteRef], { cfg })
      if (!r.ok) {
        const merging = await git(['rev-parse', '--verify', 'MERGE_HEAD'], { cleanup: true })
        if (merging.ok) {
          const abort = await git(['merge', '--abort'], { cleanup: true })
          if (!abort.ok) fail('recovery-required', '合并中止失败，请手动恢复；本地提交已保留。' + abort.stderr)
        }
        fail('sync-conflict', '未推送：无法自动整合远端。已保留本地内容，请手动解决冲突后重试。\n' + r.stderr.trim())
      }
    }
    await inspectIndex()
    if (!pullOnly) {
      // Every push destination receives reachable history, including ancestors already at the fetch remote.
      const commits = (await must(['rev-list', '--max-count=1001', 'HEAD'])).split('\n').filter(Boolean)
      if (commits.length > 1000) fail('history-too-large', '可达历史超过 1000 个提交，请先人工检查并建立干净的同步历史。')
      for (const ref of commits) await tree(ref)
      const pushRemotes = (await must(['remote', 'get-url', '--push', '--all', 'origin'])).split('\n').map(validateRemote)
      await must(['-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', 'origin', 'HEAD:refs/heads/' + cfg.branch], { cfg })
      if (pushRemotes.includes(await must(['remote', 'get-url', 'origin']))) await must(['update-ref', trackingRef(cfg), await must(['rev-parse', 'HEAD'])])
    }
    return { ok: true, message: pullOnly ? '已拉取远端更新。' : '同步完成。', ...(await aheadBehind(trackingRef(cfg))) }
  }
  async function initialize(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid-body', '初始化参数必须是对象。', 400)
    for (const key of Object.keys(body)) if (!['remote', 'branch', 'confirm', 'mode'].includes(key)) fail('invalid-body', '未知初始化参数。', 400)
    const cfg = readConfig(), branch = validateBranch(body.branch ?? cfg.branch), remote = validateRemote(body.remote)
    if (body.confirm !== true) fail('needs-confirm', '请确认将覆盖同步文件；执行前会创建完整恢复备份。', 400)
    if (!['reset', 'merge'].includes(body.mode)) fail('invalid-mode', '初始化模式无效。', 400)
    const gitDir = path.join(home, '.git'), hadRepo = !!exists(gitDir)
    if (hadRepo && (!exists(gitDir).isDirectory() || exists(gitDir).isSymbolicLink())) fail('unsupported-repo', '初始化暂不支持链接仓库或 Git worktree。')
    if (hadRepo && (exists(path.join(gitDir, 'commondir')) || exists(path.join(gitDir, 'objects/info/alternates')))) fail('unsupported-repo', '初始化暂不支持共享对象库，请先建立独立完整仓库。')
    let oldFiles = []
    if (hadRepo) {
      await ensureRepo(cfg, false, true)
      const head = await git(['rev-parse', '--verify', 'HEAD'])
      oldFiles = [...new Set([...await inspectIndex(), ...(head.ok ? await tree('HEAD') : [])])]
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-sync-init-'))
    let backupDir = null, manifest = null, touched = false
    try {
      await must(['init', '-b', branch], { cwd: temp })
      await must(['fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/' + branch + ':refs/dsh-home-sync/target'], { cwd: temp, cfg })
      const target = await must(['rev-parse', 'refs/dsh-home-sync/target'], { cwd: temp }), files = await tree(target, temp)
      const affected = [...new Set([...oldFiles, ...files])]
      if (new Set(affected.map(f => f.toLowerCase())).size !== affected.length) fail('path-collision', '本机与远端存在大小写路径冲突。')
      for (const rel of affected) safeHomePath(rel)
      // Hard reset is confined to this newly created temporary repository.
      await must(['reset', '--hard', target], { cwd: temp })
      const backupRoot = home + '.home-sync-backups'
      if (exists(backupRoot)?.isSymbolicLink()) fail('unsafe-backup', '备份目录不能是符号链接。')
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
      backupDir = fs.mkdtempSync(path.join(backupRoot, 'init-'))
      manifest = { home, target, branch, createdAt: new Date().toISOString(), hadRepo, state: 'prepared', files: [] }
      for (const rel of affected) {
        const src = safeHomePath(rel), present = !!exists(src)
        if (present) {
          const dest = path.join(backupDir, 'files', ...rel.split('/'))
          fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest)
          manifest.files.push({ path: rel, existed: true, sha256: hash(dest) })
        } else manifest.files.push({ path: rel, existed: false })
      }
      if (hadRepo) fs.cpSync(gitDir, path.join(backupDir, 'repository'), { recursive: true })
      const oldConfig = exists(configFile) ? fs.readFileSync(configFile) : null
      if (oldConfig) fs.writeFileSync(path.join(backupDir, 'config.json'), oldConfig)
      manifest.hadConfig = oldConfig !== null
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      fs.writeFileSync(path.join(backupDir, 'MERGE.md'), '# 初始化恢复备份\n\nfiles/ 保存所有被覆盖或删除的原始文件，repository/ 保存原 Git 元数据。manifest.json 记录原文件是否存在。\n\n迁移合并需手动比较 files/ 与主目录内容后再开启自动同步；不要整份覆盖记忆。\n\n恢复时先停止 DSH，按 manifest 恢复文件（删除原先不存在的文件），用 repository/ 替换 .git，并恢复 config.json；若原先没有仓库/配置则移除新建项。请勿在 DSH 运行中恢复。\n')
      for (const file of manifest.files) {
        const src = safeHomePath(file.path)
        if (!!exists(src) !== file.existed || (file.existed && hash(src) !== file.sha256)) fail('home-changed', '备份期间文件发生变化，初始化已取消，请重试。')
      }
      checkActive(); touched = true
      if (!hadRepo) { fs.mkdirSync(home, { recursive: true }); await must(['init', '-b', branch]) }
      await must(['fetch', '--no-tags', '--no-recurse-submodules', temp, target])
      for (const rel of affected) {
        checkActive()
        const dest = safeHomePath(rel)
        if (files.includes(rel)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(temp, ...rel.split('/')), dest) }
        else if (exists(dest)) fs.unlinkSync(dest)
      }
      await must(['symbolic-ref', 'HEAD', 'refs/heads/' + branch]); await must(['reset', '--mixed', target])
      const origin = await git(['remote', 'get-url', 'origin'])
      await must(['remote', origin.ok ? 'set-url' : 'add', 'origin', remote])
      const unset = await git(['config', '--unset-all', 'remote.origin.pushurl'])
      if (!unset.ok && unset.code !== 5) fail('config-failed', unset.stderr.trim())
      await must(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
      await must(['update-ref', 'refs/remotes/origin/' + branch, target])
      await must(['update-ref', trackingRef({ branch }), target])
      await must(['branch', '--set-upstream-to=origin/' + branch, branch])
      atomicConfig({ ...cfg, branch, autoSync: false, autoPullOnStartup: false })
      manifest.state = 'complete'; fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
      return { ok: true, config: readConfig(), mode: body.mode, backupDir, backed: manifest.files.filter(f => f.existed).map(f => f.path), message: '初始化完成，自动任务已暂停。请检查备份并手动合并需要保留的内容。' }
    } catch (error) {
      if (touched && manifest) {
        try {
          for (const file of manifest.files) {
            const dest = safeHomePath(file.path)
            if (file.existed) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(backupDir, 'files', ...file.path.split('/')), dest) }
            else if (exists(dest)) fs.unlinkSync(dest)
          }
          // Fixed paths under the checked home and this operation's backup.
          if (path.resolve(gitDir) !== path.join(home, '.git')) throw new Error('Invalid recovery path')
          if (exists(gitDir)) fs.renameSync(gitDir, path.join(backupDir, 'failed-repository'))
          if (manifest.hadRepo) fs.cpSync(path.join(backupDir, 'repository'), gitDir, { recursive: true })
          if (manifest.hadConfig) fs.copyFileSync(path.join(backupDir, 'config.json'), configFile)
          else if (exists(configFile)) fs.unlinkSync(configFile)
          manifest.state = 'rolled-back'; fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
        } catch (recovery) { fail('recovery-required', `恢复未完成，请停止 DSH 并从 ${backupDir} 恢复：${recovery.message}`, 500) }
      }
      if (backupDir) error.message += `\n备份：${backupDir}`
      throw error
    } finally {
      // Only the directory created by mkdtemp above is deleted.
      if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('dsh-home-sync-init-')) {
        try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
        catch (cleanupError) { console.warn('[dsh-home-sync] 临时目录清理失败，可稍后删除：', temp, cleanupError.message) }
      }
    }
  }
  async function operation(label, fn) {
    checkActive()
    if (active) fail('busy', '另一个同步操作正在执行，请稍后重试。')
    fs.mkdirSync(path.dirname(home), { recursive: true })
    try { fs.mkdirSync(lockDir) } catch (e) { if (e.code === 'EEXIST') fail('busy', `同步锁已存在：${lockDir}。若上次进程异常退出，请确认没有任务运行后移除该锁目录。`); throw e }
    active = { id: crypto.randomUUID(), kind: label, startedAt: new Date().toISOString() }
    try {
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, ...active }))
      const result = await fn(); lastResult = { ...result, kind: label, at: new Date().toISOString() }; recordResult(lastResult); return { ...result, historyWarning }
    } catch (error) {
      lastResult = { ok: false, kind: label, at: new Date().toISOString(), reason: error.reason || 'error', message: error.message }; recordResult(lastResult); throw error
    } finally {
      active = null
      if (exists(path.join(lockDir, 'owner.json'))) fs.unlinkSync(path.join(lockDir, 'owner.json'))
      fs.rmdirSync(lockDir)
    }
  }
  async function status() {
    const history = readHistory()
    const base = { home, hasRepo: !!exists(path.join(home, '.git')), branch: null, remote: null, dirty: null, ahead: null, behind: null, operation: active, lastResult: lastResult || history[0] || null, history, historyWarning }
    try {
      const cfg = readConfig(); base.config = cfg
      if (!base.hasRepo) return { ...base, ok: true }
      base.branch = await ensureRepo(cfg, false)
      const remote = await git(['remote', 'get-url', 'origin'])
      if (remote.ok) base.remote = remote.stdout.trim().replace(/(https?:\/\/)[^/@]+@/gi, '$1[redacted]@')
      const st = await git(['status', '--porcelain', '--untracked-files=all', '-z'])
      if (!st.ok) fail('status-failed', st.stderr.trim())
      const records = split0(st.stdout), dirty = []
      let excludedCount = 0
      for (let i = 0; i < records.length; i++) {
        if (allowedFile(records[i].slice(3))) dirty.push(records[i]); else excludedCount++
        if (/^[RC]|^.[RC]/.test(records[i])) i++
      }
      base.dirty = dirty
      base.excludedCount = excludedCount
      base.branchMatches = base.branch === cfg.branch
      const ref = await git(['rev-parse', '--verify', trackingRef(cfg)])
      if (ref.ok) Object.assign(base, await aheadBehind(ref.stdout.trim()))
      return { ...base, ok: true }
    } catch (error) { return { ...base, ok: false, reason: error.reason || 'error', error: error.message } }
  }
  return { home, readConfig, status, get active() { return active },
    saveConfig: patch => operation('config', async () => { const cfg = validateConfig(patch, readConfig()); atomicConfig(cfg); return { ok: true, config: cfg } }),
    pull: () => operation('pull', () => sync(true)), push: () => operation('sync', () => sync()),
    init: body => operation('init', () => initialize(body)), dispose() { disposed = true } }
}
