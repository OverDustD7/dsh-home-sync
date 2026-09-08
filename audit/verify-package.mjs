// Offline package inspection: only extract the expected files into a fresh temporary directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const archive = path.join(project, 'dist/dsh-home-sync-0.2.1.tgz')
const expected = ['README.md', 'README.zh-CN.md', 'cordis.patch.yml', 'lib/index.js', 'lib/sync.js', 'lib/ui.js', 'package.json'].sort()
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).sort()
assert.deepEqual(entries, expected.map(f => 'package/' + f).sort())
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-sync-package-'))
execFileSync('tar', ['-xzf', archive, '-C', root], { windowsHide: true })
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
const files = {}
for (const file of expected) {
  const unpacked = fs.readFileSync(path.join(root, 'package', file))
  assert.deepEqual(unpacked, fs.readFileSync(path.join(project, file)))
  files[file] = sha256(unpacked)
}
const main = await import(pathToFileURL(path.join(root, 'package/lib/index.js')))
const core = await import(pathToFileURL(path.join(root, 'package/lib/sync.js')))
assert.equal(typeof main.apply, 'function'); assert.equal(typeof core.createHomeSync, 'function')
const result = { passed: true, version: '0.2.1', archiveSha256: sha256(fs.readFileSync(archive)), files,
  validation: 'All archive entries match source bytes; extracted ES modules import successfully without third-party dependencies.', isolatedExtraction: true }
fs.writeFileSync(path.join(project, 'audit/package-verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
