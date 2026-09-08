// Run current correctness tests; historical 0.1.0 evidence remains in reproduction-results.json.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('../test/backend.test.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
