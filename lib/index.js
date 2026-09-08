// Authenticated DSH host adapter. Repository mutations live in sync.js.
import fs from 'node:fs'
import { createHomeSync, SyncError } from './sync.js'

const name = 'dsh-home-sync'
const inject = ['webServer', 'timer', 'connection']

export function readBody(req, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      req.removeListener('data', data); req.removeListener('end', end)
      req.removeListener('error', errorHandler); req.removeListener('aborted', aborted); req.removeListener('close', closed)
      if (error) { req.once('error', () => {}); req.resume?.(); reject(error) } else resolve(value)
    }
    const data = chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1024 * 1024) return finish(new SyncError('body-too-large', '请求体超过 1 MiB。', 413))
      chunks.push(Buffer.from(chunk))
    }
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        const value = text ? JSON.parse(text) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
        finish(null, value)
      } catch { finish(new SyncError('invalid-json', '请求体必须是有效的 UTF-8 JSON 对象。', 400)) }
    }
    const errorHandler = () => finish(new SyncError('body-error', '读取请求体失败。', 400))
    const aborted = () => finish(new SyncError('body-aborted', '请求已中断。', 400))
    const closed = () => { if (!settled) aborted() }
    const timer = setTimeout(() => finish(new SyncError('body-timeout', '读取请求体超时。', 408)), timeoutMs)
    timer.unref?.()
    req.on('data', data); req.on('end', end); req.on('error', errorHandler); req.on('aborted', aborted); req.on('close', closed)
  })
}
function json(res, value, code = 200) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
function apply(ctx) {
  const disposers = []
  let service, timerDisposers = [], stopped = false
  const clearTimers = () => { for (const fn of timerDisposers.splice(0)) fn() }
  const dispose = () => {
    stopped = true; service?.dispose(); clearTimers()
    for (const fn of disposers.splice(0).reverse()) { try { fn() } catch { /* best-effort cleanup */ } }
  }
  try {
    if (typeof ctx.connection?.requestRejection !== 'function') throw new Error('需要支持 connection.requestRejection 的 DSH 宿主。')
    service = createHomeSync()
    const reconcile = (startup = false) => {
      clearTimers()
      let cfg
      try { cfg = service.readConfig() } catch (error) { console.error('[dsh-home-sync]', error.message); return }
      const run = async (startupOnly = false) => {
        if (stopped || service.active) return
        try {
          const latest = service.readConfig()
          if (latest.autoSync) await service.push()
          else if (startupOnly && latest.autoPullOnStartup) await service.pull()
        } catch (error) { console.error('[dsh-home-sync]', error.message) }
      }
      if (cfg.autoSync) timerDisposers.push(ctx.setInterval(() => run(), cfg.syncIntervalSeconds * 1000))
      if (startup && (cfg.autoSync || cfg.autoPullOnStartup)) timerDisposers.push(ctx.setTimeout(() => run(true), 3000))
    }
    function route(method, endpoint, handler) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: '/dsh-home-sync/api/' + endpoint,
        handler: async (req, res) => {
          try {
            if (stopped) throw new SyncError('stopped', '插件已停止。', 503)
            const rejection = ctx.connection.requestRejection(req)
            if (rejection !== undefined) return json(res, { ok: false, error: rejection === 401 ? '请先登录 DSH。' : '请求来源不受信任。' }, rejection)
            if (req.method !== method) return json(res, { ok: false, error: '请求方法不支持。' }, 405)
            if (method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, { ok: false, error: '仅接受 application/json。' }, 415)
            const body = method === 'POST' ? await readBody(req) : undefined
            const result = await handler(body)
            json(res, result, result.ok === false ? 503 : 200)
          } catch (error) { json(res, { ok: false, reason: error.reason || 'error', error: error.message }, error.status || 500) }
        } }))
    }
    route('GET', 'status', () => service.status())
    route('POST', 'pull', () => service.pull())
    route('POST', 'push', () => service.push())
    route('POST', 'init', async body => { const result = await service.init(body); reconcile(); return result })
    route('POST', 'config', async body => { const result = await service.saveConfig(body); reconcile(); return result })
    const uiUrl = new URL('./ui.js', import.meta.url)
    if (fs.existsSync(uiUrl)) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: '/dsh-home-sync/ui.js', handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(fs.readFileSync(uiUrl, 'utf8'))
      } }))
      disposers.push(ctx.webServer.tapIndex(html => {
        if (html.includes('/dsh-home-sync/ui.js')) return html
        const tag = '<script defer src="/dsh-home-sync/ui.js"></script>'
        return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
      }))
    }
    ctx.effect(() => dispose)
    reconcile(true)
  } catch (error) { dispose(); console.error('[dsh-home-sync] 插件未启用：', error.message) }
}
export { name, inject, apply }
