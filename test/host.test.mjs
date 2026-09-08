// Optional compatibility test against the locally installed host implementation.
// Auth cookie validation is synthetic; route matching and Host/Origin checks are real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const modules = process.env.DSH_HOST_MODULES || 'E:/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const connectionPath = path.join(modules, 'dsh-client-connection/lib/index.js')
const webPath = path.join(modules, 'dsh-host-webserver/lib/index.js')
test('installed host dispatch and trust checks protect real HTTP requests, including reload', { skip: !fs.existsSync(connectionPath) || !fs.existsSync(webPath) }, async () => {
  const { HostConnectionService } = await import(pathToFileURL(connectionPath).href)
  const { WebServer } = await import(pathToFileURL(webPath).href)
  const webServer = Object.assign(Object.create(WebServer.prototype), { exact: new Map(), prefixes: new Map(), indexTaps: [] })
  const connection = Object.assign(Object.create(HostConnectionService.prototype), {
    trustedHosts: [], browserAuth: { isAuthenticated(req) { return req.headers.cookie === 'synthetic-session=valid' } },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-sync-http-'))
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'dsh-home-sync.json'), JSON.stringify({ autoSync: false, autoPullOnStartup: false }))
  const cleanup = []
  const ctx = { webServer, connection, setTimeout() { return () => {} }, setInterval() { return () => {} }, effect(fn) { cleanup.push(fn()) } }
  apply(ctx)
  const server = http.createServer((req, res) => {
    const route = webServer.match(new URL(req.url, 'http://localhost').pathname)
    if (!route) { res.writeHead(404); res.end(); return }
    Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  async function request(endpoint, { headers = {}, chunks = [] } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/dsh-home-sync/api/' + endpoint,
        method: endpoint === 'status' ? 'GET' : 'POST', headers }, res => {
        let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode, text }))
      })
      req.on('error', reject); for (const chunk of chunks) req.write(chunk); req.end()
    })
  }
  try {
    assert.equal((await request('status')).status, 401)
    assert.equal((await request('status', { headers: { host: 'foreign.invalid', cookie: 'synthetic-session=valid' } })).status, 403)
    assert.equal((await request('config', { headers: { origin: 'https://foreign.invalid', cookie: 'synthetic-session=valid' } })).status, 403)
    assert.equal((await request('config', { headers: { cookie: 'synthetic-session=valid', 'content-type': 'text/plain' }, chunks: ['{}'] })).status, 415)
    const body = Buffer.from(JSON.stringify({ commitMessage: '中文😀' })), split = body.indexOf(Buffer.from('中')) + 1
    const valid = await request('config', { headers: { cookie: 'synthetic-session=valid', 'content-type': 'application/json' }, chunks: [body.subarray(0, split), body.subarray(split)] })
    assert.equal(valid.status, 200); assert.equal(JSON.parse(valid.text).config.commitMessage, '中文😀')
    assert.equal(webServer.exact.size, 6)
    cleanup.splice(0).forEach(fn => fn()); assert.equal(webServer.exact.size, 0); assert.equal(webServer.indexTaps.length, 0)
    assert.equal((await request('status')).status, 404)
    apply(ctx); assert.equal(webServer.exact.size, 6)
    assert.equal((await request('status', { headers: { cookie: 'synthetic-session=valid' } })).status, 200)
  } finally {
    cleanup.splice(0).forEach(fn => fn())
    await new Promise(resolve => server.close(resolve))
  }
})
