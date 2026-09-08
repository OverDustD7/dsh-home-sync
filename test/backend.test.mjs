import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHomeSync, validateConfig, allowedFile } from '../lib/sync.js'
import { apply, readBody, inject } from '../lib/index.js'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-sync-regression-')))
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const emptyConfig = path.join(root, 'gitconfig')
fs.writeFileSync(emptyConfig, '')
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' })
let seq = 0
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function write(dir, rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
function commit(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-m', msg) }
function fixture(files = {}, branch = 'main') {
  const base = path.join(root, String(++seq)), seed = path.join(base, 'seed'), home = path.join(base, 'home'), remote = path.join(base, 'remote.git')
  fs.mkdirSync(seed, { recursive: true }); git(seed, 'init', '-b', branch)
  for (const [rel, data] of Object.entries({ 'settings.yaml': 'value: base\n', ...files })) write(seed, rel, data)
  write(seed, '.gitignore', 'dsh-home-sync.json\n')
  commit(seed, 'base'); git(base, 'clone', '--bare', seed, remote); git(base, 'clone', remote, home); git(seed, 'remote', 'add', 'origin', remote)
  write(home, 'dsh-home-sync.json', JSON.stringify({ branch, autoSync: false, autoPullOnStartup: false }))
  return { base, seed, home, remote, service: createHomeSync(home) }
}
function host(home, rejection = req => req.headers.origin === 'https://foreign.invalid' ? 403 : req.headers.cookie === 'session=test' ? undefined : 401) {
  process.env.DSH_HOME = home
  const routes = new Map(), intervals = [], timeouts = [], cleanup = []
  const ctx = {
    connection: { requestRejection: rejection },
    webServer: { register(r) { if (routes.has(r.path)) throw new Error('duplicate'); routes.set(r.path, r); return () => routes.delete(r.path) }, tapIndex() { return () => {} } },
    setInterval(fn, ms) { const t = { fn, ms, active: true }; intervals.push(t); return () => { t.active = false } },
    setTimeout(fn, ms) { const t = { fn, ms, active: true }; timeouts.push(t); return () => { t.active = false } },
    effect(fn) { cleanup.push(fn()) },
  }
  apply(ctx)
  async function request(endpoint, body, extra = {}) {
    const req = new EventEmitter(); req.headers = { cookie: 'session=test', 'content-type': 'application/json', ...extra }
    req.method = endpoint === 'status' ? 'GET' : 'POST'
    let code, data
    const res = { writeHead(n) { code = n }, end(text) { data = JSON.parse(text) } }
    const promise = routes.get('/dsh-home-sync/api/' + endpoint).handler(req, res)
    queueMicrotask(() => { if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); req.emit('end') })
    await promise
    return { code, ...data }
  }
  return { request, routes, intervals, timeouts, dispose() { cleanup.forEach(fn => fn()) }, ctx }
}

test('configuration schema rejects invalid input and migrates the legacy switch', () => {
  for (const patch of [null, [], { branch: '--upload-pack=bad' }, { branch: 'a..b' }, { autoSync: 'false' }, { syncIntervalSeconds: 0 }, { unknown: true }]) assert.throws(() => validateConfig(patch))
  assert.equal(validateConfig({ autoSyncOnStartup: true }).autoSync, true)
  assert.equal(validateConfig({ autoSync: false, autoSyncOnStartup: true }).autoSync, false)
  for (const rel of ['.credentials.yaml', 'mnemon/../x', 'mnemon/data/a', 'mnemon/a.log', 'mnemon/con', 'mnemon/a:stream', 'mnemon/.git/config']) assert.equal(allowedFile(rel), false)
})
test('all push destinations are protected against secrets already in fetch history', async () => {
  const f = fixture()
  write(f.seed, '.credentials.yaml', 'SYNTHETIC SECRET'); commit(f.seed, 'old secret')
  fs.unlinkSync(path.join(f.seed, '.credentials.yaml')); commit(f.seed, 'remove secret'); git(f.seed, 'push', 'origin', 'main')
  git(f.home, 'pull', '--ff-only')
  const destination = path.join(f.base, 'new.git'); git(f.base, 'init', '--bare', destination)
  git(f.home, 'remote', 'set-url', '--push', 'origin', f.remote)
  git(f.home, 'remote', 'set-url', '--add', '--push', 'origin', destination)
  await assert.rejects(f.service.push(), { reason: 'unsafe-tree' })
  assert.equal(git(destination, 'for-each-ref'), '')
})
test('clean history can be published to multiple push destinations without following tags', async () => {
  const f = fixture(), destination = path.join(f.base, 'new.git')
  git(f.base, 'init', '--bare', destination)
  git(f.home, 'tag', '-a', 'local-only', '-m', 'local metadata')
  git(f.home, 'config', 'push.followTags', 'true')
  git(f.home, 'remote', 'set-url', '--push', 'origin', f.remote)
  git(f.home, 'remote', 'set-url', '--add', '--push', 'origin', destination)
  await f.service.push()
  assert.equal(git(destination, 'rev-parse', 'main'), git(f.home, 'rev-parse', 'HEAD'))
  assert.equal(git(destination, 'tag'), '')
})
test('pull disables inherited autostash and preserves conflicting uncommitted content', async () => {
  const f = fixture(), before = git(f.home, 'rev-parse', 'HEAD')
  git(f.home, 'config', 'merge.autoStash', 'true')
  write(f.seed, 'settings.yaml', 'remote\n'); commit(f.seed, 'remote'); git(f.seed, 'push', 'origin', 'main')
  write(f.home, 'settings.yaml', 'local\n')
  await assert.rejects(f.service.pull(), { reason: 'sync-conflict' })
  assert.equal(git(f.home, 'rev-parse', 'HEAD'), before)
  assert.equal(fs.readFileSync(path.join(f.home, 'settings.yaml'), 'utf8'), 'local\n')
  assert.equal(git(f.home, 'ls-files', '--unmerged'), '')
  assert.equal(git(f.home, 'stash', 'list'), '')
})
test('initialization accepts an unborn repository and backs up its staged files', async () => {
  const f = fixture(), home = path.join(f.base, 'unborn')
  fs.mkdirSync(home); git(home, 'init', '-b', 'main')
  write(home, 'mnemon/local.json', 'local'); git(home, 'add', 'mnemon/local.json')
  const result = await createHomeSync(home).init({ remote: f.remote, branch: 'main', confirm: true, mode: 'merge' })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'files/mnemon/local.json'), 'utf8'), 'local')
  assert.match(git(path.join(result.backupDir, 'repository'), 'ls-files', '--stage'), /mnemon\/local.json/)
  assert.equal(git(home, 'show', 'HEAD:settings.yaml'), 'value: base')
})
test('repeat initialization can switch to unrelated history and persists backup records', async () => {
  const f = fixture(), other = fixture()
  git(other.seed, 'checkout', '--orphan', 'unrelated')
  write(other.seed, 'settings.yaml', 'unrelated'); commit(other.seed, 'independent root')
  git(other.seed, 'push', '--force', 'origin', 'HEAD:main')
  await f.service.init({ remote: f.remote, branch: 'main', confirm: true, mode: 'reset' })
  const result = await f.service.init({ remote: other.remote, branch: 'main', confirm: true, mode: 'reset' })
  assert.equal(git(f.home, 'show', 'HEAD:settings.yaml'), 'unrelated')
  assert.equal(result.config.autoSync, false); assert.equal(result.config.autoPullOnStartup, false)
  const status = await createHomeSync(f.home).status()
  assert.equal(status.history[0].backupDir, result.backupDir)
  assert.equal(status.history.length, 2)
  assert.equal(status.lastResult.kind, 'init')
})
test('new nested memory files count individually while excluded files stay excluded', async () => {
  const f = fixture()
  write(f.home, 'mnemon/new/a.json', 'a'); write(f.home, 'mnemon/new/b.json', 'b'); write(f.home, 'mnemon/data/private', 'private')
  const status = await f.service.status()
  assert.equal(status.dirty.length, 2); assert.equal(status.excludedCount, 1)
  await f.service.push()
  assert.equal(git(f.remote, 'show', 'main:mnemon/new/a.json'), 'a')
})
test('operation history persists failures and a broken history file does not undo config saves', async () => {
  const f = fixture()
  git(f.home, 'remote', 'set-url', 'origin', path.join(f.base, 'missing.git'))
  await assert.rejects(f.service.pull())
  assert.equal((await createHomeSync(f.home).status()).history[0].ok, false)
  const file = f.home + '.home-sync-history.json'
  fs.writeFileSync(file, JSON.stringify(Array.from({ length: 93 }, () => ({ message: '记'.repeat(3500), ok: false }))))
  await f.service.saveConfig({ autoSync: false })
  assert.ok(fs.statSync(file).size <= 900 * 1024)
  assert.equal((await createHomeSync(f.home).status()).history[0].kind, 'config')
  fs.writeFileSync(file, 'broken')
  const result = await f.service.saveConfig({ autoSync: false })
  assert.equal(result.ok, true); assert.match(result.historyWarning, /记录读取失败/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken')
})

test('normal push, clean retry, and accurate ahead count', async () => {
  const f = fixture(); write(f.home, 'settings.yaml', 'value: local\n')
  assert.equal((await f.service.push()).ok, true)
  assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'value: local')
  assert.equal((await f.service.push()).ok, true)
  assert.equal((await f.service.status()).ahead, 0)
})
test('failed push retries a clean but unpushed commit', async () => {
  const f = fixture(), before = git(f.remote, 'rev-parse', 'main')
  git(f.home, 'remote', 'set-url', '--push', 'origin', path.join(f.base, 'missing.git'))
  write(f.home, 'settings.yaml', 'value: local\n')
  await assert.rejects(f.service.push())
  assert.notEqual(git(f.home, 'rev-parse', 'HEAD'), before)
  assert.equal((await f.service.status()).ahead, 1)
  git(f.home, 'remote', 'set-url', '--push', 'origin', f.remote)
  await f.service.push(); assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.home, 'rev-parse', 'HEAD'))
})
test('network fetch failure leaves local changes uncommitted', async () => {
  const f = fixture(), before = git(f.home, 'rev-parse', 'HEAD')
  git(f.home, 'remote', 'set-url', 'origin', path.join(f.base, 'missing.git'))
  write(f.home, 'settings.yaml', 'value: local\n')
  await assert.rejects(f.service.push()); assert.equal(git(f.home, 'rev-parse', 'HEAD'), before)
  assert.match(git(f.home, 'status', '--porcelain'), /settings.yaml/)
})
test('two devices changing separate files converge', async () => {
  const f = fixture({ 'mnemon/note.json': 'base\n' })
  write(f.seed, 'settings.yaml', 'value: remote\n'); commit(f.seed, 'remote'); git(f.seed, 'push', 'origin', 'main')
  write(f.home, 'mnemon/note.json', 'local\n'); await f.service.push()
  assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'value: remote')
  assert.equal(git(f.remote, 'show', 'main:mnemon/note.json'), 'local')
})
test('same-file conflict stops publication and preserves local content', async () => {
  const f = fixture()
  write(f.seed, 'settings.yaml', 'value: remote\n'); commit(f.seed, 'remote'); git(f.seed, 'push', 'origin', 'main')
  const remoteHead = git(f.remote, 'rev-parse', 'main')
  write(f.home, 'settings.yaml', 'value: local\n')
  await assert.rejects(f.service.push(), { reason: 'sync-conflict' })
  assert.equal(fs.readFileSync(path.join(f.home, 'settings.yaml'), 'utf8'), 'value: local\n')
  assert.equal(fs.existsSync(path.join(f.home, '.git/MERGE_HEAD')), false)
  assert.equal(git(f.remote, 'rev-parse', 'main'), remoteHead)
  assert.equal((await f.service.status()).lastResult.reason, 'sync-conflict')
})
test('wrong branch cannot publish', async () => {
  const f = fixture(); git(f.home, 'checkout', '-b', 'experiment'); write(f.home, 'settings.yaml', 'experiment\n')
  await assert.rejects(f.service.push(), { reason: 'branch-mismatch' })
  assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'value: base')
})
test('untracked credentials stay local; pre-staged credentials block push', async () => {
  const f = fixture(); write(f.home, '.credentials.yaml', 'FAKE SECRET\n'); write(f.home, 'settings.yaml', 'value: local\n')
  await f.service.push()
  assert.throws(() => git(f.remote, 'show', 'main:.credentials.yaml'))
  git(f.home, 'add', '.credentials.yaml')
  await assert.rejects(f.service.push(), { reason: 'unsafe-index' })
})
test('secret in outgoing history is blocked even when deleted at HEAD', async () => {
  const f = fixture(); write(f.home, '.credentials.yaml', 'FAKE SECRET\n'); commit(f.home, 'secret')
  fs.unlinkSync(path.join(f.home, '.credentials.yaml')); commit(f.home, 'remove')
  const before = git(f.remote, 'rev-parse', 'main')
  await assert.rejects(f.service.push(), { reason: 'unsafe-tree' }); assert.equal(git(f.remote, 'rev-parse', 'main'), before)
})
test('remote-only changes are synchronized by a clean client', async () => {
  const f = fixture(); write(f.seed, 'settings.yaml', 'value: remote\n'); commit(f.seed, 'remote'); git(f.seed, 'push', 'origin', 'main')
  await f.service.push(); assert.equal(fs.readFileSync(path.join(f.home, 'settings.yaml'), 'utf8'), 'value: remote\n')
})
test('pull refuses to overwrite an ignored untracked collision', async () => {
  const f = fixture(); write(f.home, '.git/info/exclude', 'mnemon/new.json\n'); write(f.home, 'mnemon/new.json', 'LOCAL\n')
  write(f.seed, 'mnemon/new.json', 'REMOTE\n'); commit(f.seed, 'new'); git(f.seed, 'push', 'origin', 'main')
  await assert.rejects(f.service.pull(), { reason: 'local-collision' })
  assert.equal(fs.readFileSync(path.join(f.home, 'mnemon/new.json'), 'utf8'), 'LOCAL\n')
})
test('linked local files cannot redirect initialization writes', async () => {
  const f = fixture(), protectedFile = path.join(f.base, 'protected.txt')
  fs.writeFileSync(protectedFile, 'PROTECTED\n'); fs.unlinkSync(path.join(f.home, 'settings.yaml'))
  fs.linkSync(protectedFile, path.join(f.home, 'settings.yaml'))
  await assert.rejects(f.service.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true }), { reason: 'path-collision' })
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'PROTECTED\n')
})
test('remote symlink entries are refused before materialization', async () => {
  const f = fixture()
  const blob = git(f.seed, 'hash-object', '-w', '--stdin')
  git(f.seed, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',mnemon/link')
  git(f.seed, 'commit', '-m', 'symlink tree'); git(f.seed, 'push', 'origin', 'main')
  await assert.rejects(f.service.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true }), { reason: 'unsafe-tree' })
  assert.equal(fs.existsSync(path.join(f.home, 'mnemon/link')), false)
})
test('initialization refuses repositories whose history lives outside .git', async () => {
  const f = fixture(); write(f.home, '.git/objects/info/alternates', path.join(f.seed, '.git/objects') + '\n')
  await assert.rejects(f.service.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true }), { reason: 'unsupported-repo' })
})
test('init backs up all affected files and switches/saves the chosen branch', async () => {
  const f = fixture({ 'mnemon/extra.json': 'remote\n' }, 'sync')
  git(f.home, 'checkout', '-b', 'other')
  write(f.home, 'mnemon/extra.json', 'LOCAL\n'); write(f.home, '.gitignore', 'local-ignore\n')
  const result = await f.service.init({ remote: f.remote, branch: 'sync', mode: 'merge', confirm: true })
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'files/mnemon/extra.json'), 'utf8'), 'LOCAL\n')
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'files/.gitignore'), 'utf8'), 'local-ignore\n')
  assert.ok(fs.existsSync(path.join(result.backupDir, 'repository/HEAD')))
  assert.equal(git(f.home, 'branch', '--show-current'), 'sync')
  assert.equal(f.service.readConfig().branch, 'sync'); assert.equal(f.service.readConfig().autoSync, false)
  assert.equal((await f.service.pull()).ok, true)
})
test('fresh device init succeeds and always creates a backup', async () => {
  const f = fixture(), home = path.join(f.base, 'fresh'), s = createHomeSync(home)
  const r = await s.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true })
  assert.ok(fs.existsSync(path.join(r.backupDir, 'manifest.json')))
  assert.equal(git(home, 'show', 'HEAD:settings.yaml'), 'value: base')
})
test('init rejects remote credentials before overwriting ignored local data', async () => {
  const f = fixture(); write(f.home, '.git/info/exclude', '.credentials.yaml\n'); write(f.home, '.credentials.yaml', 'LOCAL FAKE\n')
  write(f.seed, '.credentials.yaml', 'REMOTE FAKE\n'); commit(f.seed, 'unsafe'); git(f.seed, 'push', 'origin', 'main')
  const before = git(f.home, 'rev-parse', 'HEAD')
  await assert.rejects(f.service.init({ remote: f.remote, branch: 'main', mode: 'merge', confirm: true }), { reason: 'unsafe-tree' })
  assert.equal(fs.readFileSync(path.join(f.home, '.credentials.yaml'), 'utf8'), 'LOCAL FAKE\n')
  assert.equal(git(f.home, 'rev-parse', 'HEAD'), before)
})
test('failed init fetch preserves the existing origin', async () => {
  const f = fixture()
  await assert.rejects(f.service.init({ remote: path.join(f.base, 'missing.git'), branch: 'main', mode: 'merge', confirm: true }))
  assert.equal(git(f.home, 'remote', 'get-url', 'origin'), f.remote)
})
test('late initialization failure restores files, index, HEAD and origin', async () => {
  const f = fixture(); write(f.home, 'settings.yaml', 'LOCAL\n'); git(f.home, 'add', 'settings.yaml')
  const beforeHead = git(f.home, 'rev-parse', 'HEAD'), beforeIndex = git(f.home, 'diff', '--cached')
  const rename = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => {
    if (to === path.join(f.home, 'dsh-home-sync.json') && !injected) { injected = true; throw new Error('synthetic atomic-write failure') }
    return rename(from, to)
  }
  try { await assert.rejects(f.service.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true }), /synthetic/) }
  finally { fs.renameSync = rename }
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(path.join(f.home, 'settings.yaml'), 'utf8'), 'LOCAL\n')
  assert.equal(git(f.home, 'rev-parse', 'HEAD'), beforeHead)
  assert.equal(git(f.home, 'diff', '--cached'), beforeIndex)
  assert.equal(git(f.home, 'remote', 'get-url', 'origin'), f.remote)
})
test('operations on the same home are mutually exclusive across service instances', async () => {
  const f = fixture(), second = createHomeSync(f.home)
  const pending = f.service.push()
  await assert.rejects(second.pull(), { reason: 'busy' })
  await assert.rejects(f.service.saveConfig({ branch: 'other' }), { reason: 'busy' })
  await pending; assert.equal((await second.pull()).ok, true)
})
test('unloading cancels subsequent steps and releases the operation lock', async () => {
  const f = fixture(); write(f.home, 'settings.yaml', 'LOCAL\n')
  const pending = f.service.push(); f.service.dispose()
  await assert.rejects(pending, { reason: 'stopped' })
  assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'value: base')
  assert.equal(fs.existsSync(f.home + '.home-sync-lock'), false)
})
test('temporary cleanup failure does not hide a completed initialization', async () => {
  const f = fixture(), rm = fs.rmSync
  fs.rmSync = (target, options) => {
    if (path.basename(target).startsWith('dsh-home-sync-init-')) throw new Error('synthetic file-in-use')
    return rm(target, options)
  }
  try {
    const result = await f.service.init({ remote: f.remote, branch: 'main', mode: 'reset', confirm: true })
    assert.equal(result.ok, true); assert.ok(fs.existsSync(path.join(result.backupDir, 'manifest.json')))
  } finally { fs.rmSync = rm }
})
test('status reports invalid repositories and corrupt config as errors', async () => {
  const f = fixture(); write(f.home, 'dsh-home-sync.json', '{broken')
  assert.equal((await f.service.status()).ok, false)
  await assert.rejects(f.service.push(), { reason: 'config-corrupt' })
  const bad = path.join(f.base, 'bad'); fs.mkdirSync(path.join(bad, '.git'), { recursive: true })
  assert.equal((await createHomeSync(bad).status()).ok, false)
})
test('HTTP requires host authentication, trusted source, JSON and valid schema', async () => {
  const f = fixture(), h = host(f.home)
  assert.ok(inject.includes('connection'))
  assert.equal((await h.request('config', { autoSync: true }, { cookie: '' })).code, 401)
  assert.equal((await h.request('config', {}, { origin: 'https://foreign.invalid' })).code, 403)
  assert.equal((await h.request('config', {}, { 'content-type': 'text/plain' })).code, 415)
  assert.equal((await h.request('config', '{broken')).code, 400)
  assert.equal((await h.request('config', { autoSync: 'false' })).code, 400)
  assert.equal((await h.request('config', { autoSync: true })).ok, true)
  h.dispose()
})
test('saving switches reconciles timers; disabled callbacks cannot push', async () => {
  const f = fixture(), h = host(f.home)
  await h.request('config', { autoSync: true })
  const timer = h.intervals.at(-1); assert.equal(timer.active, true)
  await h.request('config', { autoSync: false }); assert.equal(timer.active, false)
  write(f.home, 'settings.yaml', 'LOCAL\n'); await timer.fn()
  assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'value: base')
  await h.request('config', { autoSync: true, syncIntervalSeconds: 20 })
  assert.equal(h.intervals.at(-1).ms, 20000)
  await h.intervals.at(-1).fn(); assert.equal(git(f.remote, 'show', 'main:settings.yaml'), 'LOCAL')
  h.dispose(); assert.equal(h.routes.size, 0); assert.equal(h.intervals.at(-1).active, false)
})
test('missing authentication service fails closed without registered routes', () => {
  const f = fixture(), h = host(f.home)
  h.dispose(); h.ctx.connection = undefined; apply(h.ctx); assert.equal(h.routes.size, 0)
})
test('UTF-8 JSON survives every possible byte split', async () => {
  const buffer = Buffer.from(JSON.stringify({ commitMessage: '同步配置😀' }))
  for (let split = 1; split < buffer.length; split++) {
    const req = new EventEmitter(), result = readBody(req)
    req.emit('data', buffer.subarray(0, split)); req.emit('data', buffer.subarray(split)); req.emit('end')
    assert.equal((await result).commitMessage, '同步配置😀')
  }
})
test('invalid, aborted, oversized, and timed-out request bodies fail explicitly', async () => {
  for (const body of ['null', '[]', '{broken']) {
    const req = new EventEmitter(), result = readBody(req); req.emit('data', Buffer.from(body)); req.emit('end')
    await assert.rejects(result, { status: 400 })
  }
  for (const event of ['aborted', 'close', 'error']) {
    const req = new EventEmitter(), result = readBody(req); req.emit(event, new Error('synthetic'))
    await assert.rejects(result, { status: 400 })
  }
  const req = new EventEmitter(), tooLarge = readBody(req); req.emit('data', Buffer.alloc(1024 * 1024 + 1)); await assert.rejects(tooLarge, { status: 413 })
  const idle = new EventEmitter(), timed = readBody(idle, 10)
  const assertion = assert.rejects(timed, { status: 408 })
  await new Promise(resolve => setTimeout(resolve, 20))
  await assertion
})
