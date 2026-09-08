// Independent 0.2.0 review probes. Assertions describe observed defects, not correctness.
// Synthetic files, isolated Git config, and local temporary remotes only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHomeSync } from '../lib/sync.js'
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-second-review-')))
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
const config = path.join(root, 'gitconfig'); fs.writeFileSync(config, '')
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Review', GIT_AUTHOR_EMAIL: 'review@example.invalid', GIT_COMMITTER_NAME: 'Review', GIT_COMMITTER_EMAIL: 'review@example.invalid' })
let count = 0
const results = []
function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function write(dir, rel, text) { const target = path.join(dir, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text) }
function commit(dir, message) { git(dir, 'add', '-A'); git(dir, 'commit', '-m', message) }
function fixture() {
  const base = path.join(root, String(++count)), seed = path.join(base, 'seed'), home = path.join(base, 'home'), remote = path.join(base, 'remote.git')
  fs.mkdirSync(seed, { recursive: true }); git(seed, 'init', '-b', 'main')
  write(seed, 'settings.yaml', 'value: base\n'); write(seed, '.gitignore', 'dsh-home-sync.json\n'); commit(seed, 'base')
  git(base, 'clone', '--bare', seed, remote); git(base, 'clone', remote, home); git(seed, 'remote', 'add', 'origin', remote)
  write(home, 'dsh-home-sync.json', JSON.stringify({ autoSync: false, autoPullOnStartup: false }))
  return { base, seed, home, remote, service: createHomeSync(home) }
}
async function probe(id, fn) {
  try { const evidence = await fn(); results.push({ id, confirmed: true, evidence }); console.log(id + ': confirmed') }
  catch (error) { results.push({ id, confirmed: false, error: error.message }); console.log(id + ': not confirmed: ' + error.message) }
}
await probe('S01-history-leaks-to-separate-push-destination', async () => {
  const f = fixture()
  write(f.seed, '.credentials.yaml', 'SYNTHETIC HISTORICAL SECRET\n'); commit(f.seed, 'historical secret')
  const secretCommit = git(f.seed, 'rev-parse', 'HEAD')
  fs.unlinkSync(path.join(f.seed, '.credentials.yaml')); commit(f.seed, 'remove secret'); git(f.seed, 'push', 'origin', 'main')
  git(f.home, 'pull', '--ff-only')
  const destination = path.join(f.base, 'different-destination.git'); git(f.base, 'init', '--bare', destination)
  git(f.home, 'remote', 'set-url', '--push', 'origin', destination)
  const result = await f.service.push()
  assert.equal(result.ok, true)
  assert.equal(git(destination, 'show', secretCommit + ':.credentials.yaml'), 'SYNTHETIC HISTORICAL SECRET')
  return { result, currentTreeHasNoSecret: true, historicalSecretArrivedAtNewDestination: true }
})
await probe('S02-pull-autostash-conflict-reports-success', async () => {
  const f = fixture()
  git(f.home, 'config', 'merge.autoStash', 'true')
  write(f.seed, 'settings.yaml', 'value: remote\n'); commit(f.seed, 'remote edit'); git(f.seed, 'push', 'origin', 'main')
  write(f.home, 'settings.yaml', 'value: local\n')
  const result = await f.service.pull()
  const status = git(f.home, 'status', '--porcelain')
  assert.equal(result.ok, true); assert.match(status, /UU settings.yaml/)
  return { result, gitStatus: status, containsConflictMarkers: fs.readFileSync(path.join(f.home, 'settings.yaml'), 'utf8').includes('<<<<<<<'), stashCount: git(f.home, 'stash', 'list').split('\n').filter(Boolean).length }
})
await probe('S03-unborn-repository-cannot-initialize', async () => {
  const f = fixture(), home = path.join(f.base, 'unborn')
  fs.mkdirSync(home); git(home, 'init', '-b', 'main')
  const s = createHomeSync(home)
  let failure
  try { await s.init({ remote: f.remote, branch: 'main', confirm: true, mode: 'merge' }) } catch (error) { failure = { reason: error.reason, message: error.message } }
  assert.ok(failure); assert.match(failure.message, /revision|argument|single|HEAD/i)
  return { validEmptyRepository: true, failure }
})
await probe('S04-untracked-memory-directory-displays-zero', async () => {
  const f = fixture(); write(f.home, 'mnemon/runtime/new.json', 'NEW MEMORY\n')
  const status = await f.service.status()
  assert.equal(status.ok, true); assert.equal(status.dirty.length, 0)
  assert.match(git(f.home, 'ls-files', '--others', '--exclude-standard'), /mnemon\/runtime\/new.json/)
  return { actualNewMemoryFiles: 1, reportedDirty: status.dirty, excludedCount: status.excludedCount }
})
await probe('S05-repeat-init-non-fast-forward-probe', async () => {
  const f = fixture(), other = fixture()
  git(other.seed, 'checkout', '--orphan', 'unrelated')
  write(other.seed, 'settings.yaml', 'value: unrelated root\n'); commit(other.seed, 'independent root')
  git(other.seed, 'push', '--force', 'origin', 'HEAD:main')
  await f.service.init({ remote: f.remote, branch: 'main', confirm: true, mode: 'reset' })
  const oldHead = git(f.home, 'rev-parse', 'HEAD')
  let failure
  try { await f.service.init({ remote: other.remote, branch: 'main', confirm: true, mode: 'reset' }) }
  catch (error) { failure = { reason: error.reason, message: error.message } }
  assert.ok(failure); assert.match(failure.message, /non-fast-forward/)
  assert.equal(git(f.home, 'rev-parse', 'HEAD'), oldHead)
  assert.equal(git(f.home, 'show', 'HEAD:settings.yaml'), 'value: base')
  return { unrelatedRemoteRoot: true, failure, originalHeadRestored: true }
})
const sources = Object.fromEntries(['lib/sync.js', 'lib/index.js', 'lib/ui.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex')]))
fs.writeFileSync(path.join(project, 'audit/second-review-results.json'), JSON.stringify({ at: new Date().toISOString(), root, sources, syntheticDataOnly: true, results }, null, 2) + '\n')
