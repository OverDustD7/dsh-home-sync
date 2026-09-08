// Draggable, keyboard-accessible synchronization panel with bounded scrolling.

(function () {
  if (window.__dshHomeSyncCleanup) window.__dshHomeSyncCleanup()
  const API = '/dsh-home-sync/api'
  const NS = 'dhs8'
  const POS_KEY = 'dshome-sync-pos'
  const globalListeners = []
  const actionButtons = new Set()
  let pendingActions = 0
  const listen = (el, type, fn) => { el.addEventListener(type, fn); globalListeners.push(() => el.removeEventListener(type, fn)) }

  const PALETTES = {
    light: {
      accent: '#2f6feb', accentFg: '#ffffff', text: '#1f2328', muted: '#5f6b7a',
      border: '#c9d2dc', panelBg: '#ffffff', headBg: '#f6f8fa', fieldBg: '#f3f5f7',
      hoverBg: '#e8f0fe', danger: '#d1242f', logBg: '#f6f8fa', dotRing: '#ffffff',
      shadow: 'rgba(16,24,40,.16)',
    },
    dark: {
      accent: '#6ea0ff', accentFg: '#0b1220', text: '#e6e9f0', muted: '#9aa4b2',
      border: '#3a414c', panelBg: '#20242b', headBg: '#262b34', fieldBg: '#161a20',
      hoverBg: '#2c3547', danger: '#ff7b72', logBg: '#15181d', dotRing: '#20242b',
      shadow: 'rgba(0,0,0,.55)',
    },
  }

  let currentPalette = PALETTES.light
  const pal = Object.fromEntries(Object.keys(PALETTES.light).map(key => [key, 'var(--dhs-' + key + ')']))
  let historyRows = []
  let design = { accent: '', radius: 10, font: '' }
  let dirtyCount = 0
  let pos = { x: 48, y: null, docked: false }
  let docWired = false
  let observerRef = null
  let ctx = null // open popover context
  let followId = null

  const EDGE = 90
  const GAP = 10

  function q(id) { return document.getElementById(id) }

  // ---------- theme / design ----------
  function luminance(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 }
  function parseRgb(str) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(str || '')
    if (!m) return null
    const a = m[4] === undefined ? 1 : Number(m[4])
    return a < 0.5 ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  function detectTheme() {
    const hay =
      ((document.documentElement.getAttribute('data-theme') || '') + ' ' + (document.documentElement.className || '') +
        ' ' + (document.body.getAttribute('data-theme') || '') + ' ' + (document.body.className || '')).toLowerCase()
    if (/\bdark\b/.test(hay)) return 'dark'
    if (/\blight\b/.test(hay)) return 'light'
    for (const el of [document.body, document.documentElement]) {
      const rgb = parseRgb(getComputedStyle(el).backgroundColor)
      if (rgb) return luminance(rgb) < 0.35 ? 'dark' : 'light'
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  function readVar(names) {
    const cs = getComputedStyle(document.documentElement)
    for (const n of names) {
      const v = (cs.getPropertyValue(n) || '').trim()
      if (v && v !== 'inherit' && v !== 'unset') return v
    }
    return ''
  }
  function hexOk(v) { return /^#?[0-9a-f]{6}$/i.test(String(v).trim()) }
  function sampleDesign() {
    let accent = readVar(['--accent', '--accent-color', '--brand', '--primary', '--dsh-accent', '--color-accent'])
    if (!hexOk(accent)) {
      accent = ''
      for (const el of Array.from(document.querySelectorAll('button'))) {
        if (el.id?.startsWith(NS + '-')) continue
        const rgb = parseRgb(getComputedStyle(el).backgroundColor)
        if (rgb && luminance(rgb) < 0.55 && luminance(rgb) > 0.08) { accent = 'rgb(' + rgb.join(',') + ')'; break }
      }
    }
    const radius = parseInt(String(readVar(['--radius', '--radius-lg', '--border-radius', '--dsh-radius']) || '').replace(/px$/, ''), 10)
    design = { accent, radius: isNaN(radius) ? 10 : radius, font: getComputedStyle(document.body).fontFamily || '' }
  }
  function accent() { return pal.accent }
  function applyPalette(el) {
    if (!el) return
    for (const [key, value] of Object.entries(currentPalette)) el.style.setProperty('--dhs-' + key, key === 'accent' ? design.accent || value : value)
  }
  function radius() { return isNaN(design.radius) || !design.radius ? 10 : design.radius }
  function uiFont() { return design.font || 'system-ui,sans-serif' }

  function loadPos() {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p.x === 'number' && typeof p.y === 'number') pos = { x: p.x, y: p.y, docked: !!p.docked }
      }
    } catch { /* ignore */ }
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
  }

  // ---------- fab ----------
  function setThemeColors() {
    for (const suffix of ['fab', 'fb', 'pop', 'toast']) applyPalette(q(NS + '-' + suffix))
    const fab = q(NS + '-fab')
    if (!fab) return
    fab.style.background = pal.panelBg
    fab.style.borderColor = pal.border
    fab.style.color = pal.text
    const ico = q(NS + '-ico')
    if (ico && ico.setAttribute) ico.setAttribute('stroke', accent())
    const dot = q(NS + '-dot')
    if (dot) { dot.style.background = pal.danger; dot.style.borderColor = pal.dotRing }
  }
  function applyPos(animate) {
    const fab = q(NS + '-fab')
    if (!fab) return
    const w = fab.offsetWidth || 84
    const h = fab.offsetHeight || 34
    let y = pos.y
    if (y === null) y = Math.round(innerHeight / 2 - h / 2)
    y = Math.max(8, Math.min(innerHeight - h - 8, y))
    const x = Math.max(4, Math.min(innerWidth - w - 4, pos.x))
    fab.style.transition = animate ? 'left .24s cubic-bezier(.2,.8,.3,1), top .24s cubic-bezier(.2,.8,.3,1)' : 'none'
    fab.style.left = x + 'px'
    fab.style.top = y + 'px'
    pos.x = x
    pos.y = y
  }

  function pressDown() {
    const fab = q(NS + '-fab')
    if (!fab || !fab.animate) return
    try { fab.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.93)' }], { duration: 80, easing: 'ease-out' }) } catch { /* ignore */ }
  }
  function pressUp() {
    const fab = q(NS + '-fab')
    if (!fab || !fab.animate) return
    try {
      fab.animate(
        [{ transform: 'scale(0.93)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' },
      )
    } catch { /* ignore */ }
  }

  // ---------- api ----------
  async function api(path, body) {
    const mutating = body !== undefined
    if (mutating) { pendingActions++; actionButtons.forEach(b => { b.disabled = true }) }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)
    try {
      const res = await fetch(API + path, {
        method: mutating ? 'POST' : 'GET',
        headers: mutating ? { 'Content-Type': 'application/json' } : {},
        body: mutating ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const result = await res.json().catch(() => ({ ok: false, error: '响应格式错误（HTTP ' + res.status + '）' }))
      if (!res.ok) return { ...result, ok: false, error: result.error || result.message || 'HTTP ' + res.status }
      return result
    } finally {
      clearTimeout(timeout)
      if (mutating) { pendingActions--; actionButtons.forEach(b => { b.disabled = pendingActions > 0 }) }
    }
  }
  // Floating toast feedback (replaces the old inline log box).
  function showToast(txt, ok) {
    let el = q(NS + '-toast')
    if (!el) {
      el = document.createElement('div')
      el.id = NS + '-toast'
      document.body.appendChild(el)
    }
    const kind = ok ? pal.accent : pal.danger
    el.style.cssText =
      'position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(10px);z-index:2147483003;' +
      'background:' + pal.panelBg + ';color:' + pal.text + ';border:1px solid ' + pal.border + ';border-left:3px solid ' + kind + ';' +
      'padding:9px 16px;border-radius:10px;font:13px/1.4 ' + uiFont() + ';box-shadow:0 10px 28px ' + pal.shadow + ';' +
      'opacity:0;max-width:min(420px,84vw);text-align:center'
    applyPalette(el)
    el.textContent = txt
    requestAnimationFrame(() => {
      el.style.transition = 'opacity .18s ease, transform .18s ease'
      el.style.opacity = '1'
      el.style.transform = 'translateX(-50%) translateY(0)'
    })
    clearTimeout(el.__t)
    el.__t = setTimeout(() => {
      if (el) {
        el.style.transition = 'opacity .18s ease, transform .18s ease'
        el.style.opacity = '0'
        el.style.transform = 'translateX(-50%) translateY(10px)'
        setTimeout(() => el.remove(), 200)
      }
    }, 2400)
  }
  function logLine(txt, ok) {
    if (ctx && ctx.logEl) ctx.logEl.textContent = txt
    historyRows = [{ at: new Date().toISOString(), ok: ok !== false, message: txt }, ...historyRows].slice(0, 100)
    renderHistory()
    showToast(txt, ok === false ? false : true)
  }
  function renderHistory(warning) {
    if (!ctx?.historyEl) return
    const labels = { init: '初始化', sync: '同步', pull: '拉取', config: '设置' }
    ctx.historyEl.textContent = (warning ? warning + '\n\n' : '') + (historyRows.map(row =>
      (row.at || '') + ' ' + (labels[row.kind] || '') + (row.ok ? ' 成功' : ' 失败') + '\n' + row.message +
      (row.backupDir ? '\n备份：' + row.backupDir + '\n恢复指引：备份目录中的 MERGE.md' : '')).join('\n\n') || '暂无操作记录。')
  }
  function setBadge() {
    const fab = q(NS + '-fab')
    if (fab) fab.title = dirtyCount === null ? 'Home Sync · 状态读取失败' : dirtyCount > 0 ? 'Home Sync · ' + dirtyCount + ' 个文件待提交' : 'Home Sync · 点击打开'
    const dot = q(NS + '-dot')
    if (dot) dot.style.display = dirtyCount === null || dirtyCount > 0 ? 'block' : 'none'
  }
  async function fetchStatus() {
    try {
      const r = await api('/status')
      if (Array.isArray(r.history)) historyRows = r.history
      renderHistory(r.historyWarning)
      dirtyCount = r.ok && Array.isArray(r.dirty) ? r.dirty.length : null
      setBadge()
      return r
    } catch (error) {
      dirtyCount = null; setBadge()
      return { ok: false, error: '状态读取失败：' + error.message }
    }
  }
  function renderStatus(r) {
    if (!ctx) return
    const el = ctx.statusEl
    el.innerHTML = ''
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font:12px/1.6 ' + uiFont() + ';color:' + pal.text
    const add = (k, v) => {
      const a = document.createElement('div'); a.textContent = k; a.style.color = pal.muted
      const b = document.createElement('div'); b.textContent = v
      b.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; b.title = v
      grid.append(a, b)
    }
    add('分支', r.branch || '-')
    add('远端', r.remote || '未设置')
    add('待提交', Array.isArray(r.dirty) ? String(r.dirty.length) : '未知')
    if (r.ahead !== null && r.ahead !== undefined) add('待推送 / 待拉取', r.ahead + ' / ' + r.behind)
    if (r.branchMatches === false) add('分支不一致', '请切换到 ' + r.config.branch)
    if (!r.ok) add('状态错误', r.error || r.reason || '无法读取仓库')
    if (r.operation) add('正在执行', r.operation.kind)
    if (r.lastResult && !r.lastResult.ok) add('最近失败', r.lastResult.message || r.lastResult.reason)
    el.append(grid)
  }

  // ---------- popover layout (follows pill, direction aware, smooth) ----------
  function relayout(smooth) {
    if (!ctx) return
    const fab = ctx.anchor || q(NS + '-fab') || q(NS + '-fb')
    if (!fab) return
    const pop = ctx.host
    const card = ctx.card
    const W = 320
    card.style.maxHeight = 'none'
    card.style.overflow = 'visible'
    const need = Math.max(120, card.offsetHeight)
    const r = fab.getBoundingClientRect()
    const vw = innerWidth
    const vh = innerHeight
    const belowSpace = vh - r.bottom - GAP
    const aboveSpace = r.top - GAP
    const rightSpace = vw - r.right - GAP
    const leftSpace = r.left - GAP

    // Cap the card at a fixed maximum height; overflow scrolls INSIDE the
    // card (wheel) when content exceeds it.
    const MAX = Math.max(240, Math.min(460, vh - 24))
    // Direction decision must use the CAPPED height (what will actually be
    // shown), not the full content height — overflow scrolls anyway.
    const want = Math.min(need, MAX)

    // Re-evaluate direction on EVERY layout from the pill's LIVE position:
    // near an edge -> open sideways; otherwise default below, flipping above
    // only when the bottom is too tight. Using proximity (not the persisted
    // docked flag) keeps the transition smooth while dragging off an edge.
    const size = fab.offsetWidth || 38
    const nearEdge = pos.x <= EDGE || pos.x >= innerWidth - size - EDGE
    let dir
    if (nearEdge && (rightSpace >= W || leftSpace >= W)) {
      dir = r.left < innerWidth / 2 ? 'right' : 'left'
      if (dir === 'right' && rightSpace < W) dir = 'left'
      if (dir === 'left' && leftSpace < W) dir = 'right'
    } else if (belowSpace >= want) {
      dir = 'below'
    } else if (aboveSpace >= want) {
      dir = 'above'
    } else {
      // Neither side fits the capped height: pick the side with more room.
      dir = belowSpace >= aboveSpace ? 'below' : 'above'
    }
    const ease = 'cubic-bezier(.2,.8,.3,1)'
    pop.style.transition = smooth ? 'left .3s ' + ease + ', top .3s ' + ease : 'none'
    card.style.transition = smooth ? 'max-height .24s ' + ease : 'none'
    let left = 0
    let top = 0
    let h = want
    if (dir === 'below') {
      const space = Math.max(120, vh - 8 - (r.bottom + GAP))
      h = Math.min(h, space)
      left = Math.max(8, Math.min(r.left, vw - W - 8))
      top = r.bottom + GAP
    } else if (dir === 'above') {
      const space = Math.max(120, r.top - GAP - 8)
      h = Math.min(h, space)
      left = Math.max(8, Math.min(r.left, vw - W - 8))
      top = Math.max(8, r.top - GAP - h)
    } else if (dir === 'right') {
      h = Math.min(h, vh - 16)
      left = r.right + GAP
      top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, vh - h - 8))
    } else {
      h = Math.min(h, vh - 16)
      left = Math.max(8, r.left - W - GAP)
      top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, vh - h - 8))
    }
    pop.style.left = left + 'px'
    pop.style.top = top + 'px'
    card.style.maxHeight = h + 'px'
    card.style.overflow = h < need - 0.5 ? 'auto' : 'hidden'
    ctx.dir = dir
  }

  // Frame-level follower: while the popover is open, watch the pill every
  // animation frame and re-lay the card whenever the pill moves (manual drag
  // or its own snap transition), so the card never lags behind / stays put.
  function followTick() {
    if (!ctx) {
      followId = null
      return
    }
    const fab = ctx.anchor || q(NS + '-fab') || q(NS + '-fb')
    if (fab) {
      const r = fab.getBoundingClientRect()
      if (ctx.fx === undefined || Math.abs(r.left - ctx.fx) > 0.4 || Math.abs(r.top - ctx.fy) > 0.4) {
        ctx.fx = r.left
        ctx.fy = r.top
        relayout(true)
      }
    }
    followId = requestAnimationFrame(followTick)
  }
  function startFollow() {
    if (followId === null) followId = requestAnimationFrame(followTick)
  }
  // While a section is expanding/collapsing, re-lay every frame so the card
  // grows (or shrinks) together with the content instead of jumping at the end.
  function animateGrow() {
    const t0 = performance.now()
    const step = (now) => {
      if (!ctx) return
      relayout(true)
      if (now - t0 < 400) requestAnimationFrame(step)
      else relayout(true)
    }
    requestAnimationFrame(step)
  }

  // ---------- popover build ----------
  function makeBtn(label, kind, onClick) {
    const b = document.createElement('button')
    b.textContent = label
    const base =
      'padding:6px 12px;border-radius:' + Math.round(radius() * 0.7) + 'px;font:500 13px/1 ' + uiFont() + ';' +
      'cursor:pointer;outline:none;white-space:nowrap;'
    if (kind === 'primary') b.style.cssText = base + 'background:' + accent() + ';border:1px solid ' + accent() + ';color:' + pal.accentFg + ';'
    else if (kind === 'danger') b.style.cssText = base + 'background:transparent;border:1px solid ' + pal.danger + ';color:' + pal.danger + ';'
    else b.style.cssText = base + 'background:' + pal.panelBg + ';border:1px solid ' + pal.border + ';color:' + pal.text + ';'
    b.disabled = pendingActions > 0
    actionButtons.add(b)
    b.addEventListener('click', () => { if (!b.disabled) onClick() })
    return b
  }
  function field(label, input) {
    const w = document.createElement('div')
    w.style.cssText = 'margin:7px 0'
    const l = document.createElement('label')
    l.textContent = label
    l.style.cssText = 'display:block;font:500 11.5px/1.4 ' + uiFont() + ';color:' + pal.muted + ';margin-bottom:3px'
    w.append(l, input)
    return w
  }
  function textInput(placeholder) {
    const i = document.createElement('input')
    i.type = 'text'
    i.style.cssText =
      'width:100%;box-sizing:border-box;background:' + pal.fieldBg + ';border:1px solid ' + pal.border + ';color:' + pal.text + ';' +
      'border-radius:' + Math.round(radius() * 0.7) + 'px;padding:5px 8px;font:12.5px ' + uiFont() + ';outline:none'
    if (placeholder) i.placeholder = placeholder
    return i
  }
  // Smooth section: grid-rows 0fr <-> 1fr expansion.
  function section(title, innerEl) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'margin:8px 0 0;border-top:1px solid ' + pal.border + ';padding-top:6px'
    const head = document.createElement('button')
    head.type = 'button'
    head.setAttribute('aria-expanded', 'false')
    head.style.cssText =
      'display:flex;width:100%;align-items:center;gap:6px;background:none;border:none;cursor:pointer;' +
      'font:600 12.5px/1.4 ' + uiFont() + ';color:' + pal.text + ';padding:4px 2px;outline:none'
    const chev = document.createElement('span')
    chev.textContent = '▸'
    chev.style.cssText = 'transition:transform .22s cubic-bezier(.2,.8,.3,1);font-size:10px;color:' + pal.muted
    const t = document.createElement('span')
    t.textContent = title
    head.append(chev, t)
    const track = document.createElement('div')
    track.style.cssText = 'display:grid;grid-template-rows:0fr;transition:grid-template-rows .26s cubic-bezier(.2,.8,.3,1)'
    const inner = document.createElement('div')
    inner.style.cssText = 'overflow:hidden;min-height:0'
    inner.append(innerEl)
    track.append(inner)
    let open = false
    head.addEventListener('click', () => {
      open = !open
      head.setAttribute('aria-expanded', String(open))
      chev.style.transform = open ? 'rotate(90deg)' : ''
      track.style.gridTemplateRows = open ? '1fr' : '0fr'
      relayout(true)
      animateGrow()
    })
    wrap.append(head, track)
    return { wrapEl: wrap, open: () => open }
  }

  function wireDocument() {
    if (docWired) return
    docWired = true
    listen(document, 'keydown', (e) => { if (e.key === 'Escape') closePop() })
    listen(document, 'click', (e) => {
      const pop = ctx && ctx.host
      const anchor = ctx && ctx.anchor
      if (pop && !pop.contains(e.target) && !(anchor && anchor.contains(e.target))) closePop()
    })
  }
  function openPop(anchor) {
    if (ctx) return closePop()
    wireDocument()
    const fab = anchor || q(NS + '-fab') || q(NS + '-fb')
    if (!fab) return

    const host = document.createElement('div')
    host.id = NS + '-pop'
    host.setAttribute('role', 'dialog')
    host.setAttribute('aria-label', 'Home Sync')
    host.style.cssText = 'position:fixed;z-index:2147483002;width:320px;max-width:min(320px,88vw);visibility:hidden;opacity:0;'
    applyPalette(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent =
      ':host{all:initial}*{box-sizing:border-box;margin:0}' +
      '.card{background:' + pal.panelBg + ';color:' + pal.text + ';border:1px solid ' + pal.border + ';' +
      'border-radius:' + radius() + 'px;box-shadow:0 8px 28px ' + pal.shadow + ';overflow:hidden;' +
      'font:13px/1.5 ' + uiFont() + ';animation:pop .18s cubic-bezier(.2,.9,.3,1.05)}' +
      '@keyframes pop{from{opacity:0;transform:scale(.97) translateY(-3px)}to{opacity:1;transform:none}}' +
      '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid ' + pal.border + ';background:' + pal.headBg + ';' +
      'border-top-left-radius:' + radius() + 'px;border-top-right-radius:' + radius() + 'px;}' +
      '.title{font:600 13px/1 ' + uiFont() + ';color:' + pal.text + '}' +
      '.body{padding:10px 12px 12px}' +
      '.btns{display:flex;gap:8px;flex-wrap:wrap;margin:9px 0}' +
      '#log{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}#log:empty{display:none}' +
      'p.hint{color:' + pal.muted + ';font:11.5px/1.5 ' + uiFont() + ';margin:4px 0}' +
      'button:focus-visible,input:focus-visible{outline:2px solid ' + accent() + '!important;outline-offset:2px}button:disabled{opacity:.5;cursor:wait}'
    shadow.append(style)

    const card = document.createElement('div')
    card.className = 'card'
    const head = document.createElement('div')
    head.className = 'head'
    const ic = document.createElement('span'); ic.textContent = '⟳'; ic.style.cssText = 'color:' + accent()
    const tt = document.createElement('span'); tt.className = 'title'; tt.textContent = 'Home Sync'
    const bs = document.createElement('span'); bs.id = NS + '-busy'; bs.textContent = '…'
    bs.style.cssText = 'display:none;color:' + accent()
    const x = document.createElement('button')
    x.textContent = '✕'
    x.title = '关闭 (Esc)'
    x.style.cssText = 'margin-left:auto;background:none;border:none;color:' + pal.muted + ';cursor:pointer;font-size:13px;padding:1px 6px;border-radius:6px'
    x.addEventListener('click', closePop)
    head.append(ic, tt, bs, x)
    card.append(head)

    const body = document.createElement('div')
    body.className = 'body'
    const status = document.createElement('div')
    body.append(status)
    const log = document.createElement('div')
    log.id = 'log'
    log.setAttribute('role', 'status')
    log.setAttribute('aria-live', 'polite')
    body.append(log)

    const btns = document.createElement('div')
    btns.className = 'btns'
    const act = (name, p) => () => {
      bs.style.display = 'inline'
      api(p.path, p.body)
        .then((r) => {
          const okR = !!(r && r.ok)
          logLine(name + ' → ' + (okR ? '成功' + (r.message ? '：' + r.message : '') : '失败：' + ((r && (r.error || r.message || r.reason)) || '无响应')), okR)
          if (p.path !== '/config') fetchStatus().then((st) => st && renderStatus(st))
        })
        .catch((e) => logLine(name + ' 异常: ' + e, false))
        .finally(() => { bs.style.display = 'none' })
    }
    btns.append(
      makeBtn('拉取', '', act('拉取', { path: '/pull', body: {} })),
      makeBtn('同步到远端', 'primary', act('推送', { path: '/push', body: {} })),
      makeBtn('刷新', '', () => fetchStatus().then((st) => { if (st) renderStatus(st) })),
    )
    body.append(btns)

    // Settings section
    const row = (input, label) => {
      const w = document.createElement('div')
      w.style.cssText = 'display:flex;gap:7px;align-items:center;margin:5px 0;font:12.5px ' + uiFont() + ';color:' + pal.text
      const s = document.createElement('span')
      s.textContent = label
      w.append(input, s)
      return w
    }
    const as2 = document.createElement('input'); as2.type = 'checkbox'; as2.style.cssText = 'accent-color:' + accent()
    const ap = document.createElement('input'); ap.type = 'checkbox'; ap.style.cssText = 'accent-color:' + accent()
    const msg = textInput('commit message')
    const br = textInput('main')
    const applyConfig = config => {
      if (!config) return
      as2.checked = !!(config.autoSync ?? config.autoSyncOnStartup)
      ap.checked = !!config.autoPullOnStartup
      msg.value = config.commitMessage || ''
      br.value = config.branch || 'main'
    }
    const cfgInner = document.createElement('div')
    cfgInner.append(
      row(as2, '自动同步（定期拉取并推送改动）'),
      row(ap, '启动时仅拉取'),
      field('commit 信息', msg),
      field('分支', br),
    )
    const saveBtn = makeBtn('保存', '', () => {
      const p = {
        path: '/config',
        body: {
          autoSync: as2.checked,
          autoPullOnStartup: ap.checked,
          commitMessage: msg.value.trim() || 'sync: home config & memory',
          branch: br.value.trim() || 'main',
        },
      }
      bs.style.display = 'inline'
      api(p.path, p.body)
        .then((r) => {
          logLine('设置 → ' + (r && r.ok ? '已保存' : '失败：' + ((r && (r.error || r.message || r.reason)) || '')), !!(r && r.ok))
          fetchStatus().then((st) => st && renderStatus(st))
        })
        .catch((e) => logLine('设置 异常: ' + e, false))
        .finally(() => { bs.style.display = 'none' })
    })
    cfgInner.append(saveBtn)
    body.append(section('设置', cfgInner).wrapEl)

    // Init section
    const mkMode = (value, label) => {
      const lab = document.createElement('label')
      lab.style.cssText = 'display:flex;gap:6px;align-items:flex-start;margin:2px 0;font:12px/1.4 ' + uiFont() + ';color:' + pal.text + ';cursor:pointer'
      const inp = document.createElement('input')
      inp.type = 'radio'
      inp.name = NS + '-init-mode'
      inp.value = value
      inp.style.cssText = 'accent-color:' + pal.accent + ';margin-top:2px'
      const sp = document.createElement('span')
      sp.textContent = label
      lab.append(inp, sp)
      return lab
    }
    const modeSel = document.createElement('div')
    modeSel.style.cssText = 'margin:6px 0'
    modeSel.append(
      mkMode('reset', '全新覆盖：以远端为准（适合新装机器）'),
      mkMode('merge', '迁移合并：先备份本机内容再重置，随后手动合并'),
    )
    const selReset = modeSel.querySelector('input[value="reset"]')
    if (selReset) selReset.checked = true
    const remote = textInput('git@… 或 https://…')
    const ck = document.createElement('input'); ck.type = 'checkbox'; ck.style.cssText = 'accent-color:' + pal.danger
    const ckw = document.createElement('label')
    ckw.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0;font:12.5px ' + uiFont() + ';color:' + pal.text
    const ckl = document.createElement('span'); ckl.textContent = '我确认执行'
    ckw.append(ck, ckl)
    const hint = document.createElement('p'); hint.className = 'hint'
    hint.textContent = '先检查远端文件范围，再备份受影响文件和 Git 历史后覆盖。备份保存在主目录旁，初始化后自动任务暂停。迁移合并需手动比较备份并保留所需内容。'
    const initInner = document.createElement('div')
    initInner.append(hint, modeSel, field('远端 URL', remote), ckw)
    const initBtn = makeBtn('执行', 'danger', () => {
      const rv = remote.value.trim()
      const modeIn = modeSel.querySelector('input:checked')
      const mode = modeIn ? modeIn.value : 'reset'
      if (!rv) return logLine('请填写远端 URL', false)
      if (!ck.checked) return logLine('请先勾选确认', false)
      ck.checked = false
      bs.style.display = 'inline'
      api('/init', { remote: rv, branch: br.value.trim() || 'main', confirm: true, mode })
        .then((r) => {
          bs.style.display = 'none'
          if (r && r.ok) {
            // Initialization is an explicit configuration reset; discard stale form switches immediately.
            applyConfig(r.config || { autoSync: false, autoPullOnStartup: false, commitMessage: msg.value, branch: br.value })
            if (mode === 'merge') {
              logLine('已备份并重置。备份：' + (r.backupDir || '') + '（含 MERGE.md 指引）——请按指引合并本机旧内容后重启。', true)
            } else {
              logLine('初始化完成。备份：' + (r.backupDir || '') + '。自动任务已暂停，请检查后重启 dsh web 并安装插件依赖。', true)
            }
            fetchStatus().then((st) => st && renderStatus(st))
          } else {
            logLine('初始化失败：' + ((r && (r.error || r.message || r.reason || r.step)) || '无响应'), false)
          }
        })
        .catch((e) => logLine('初始化 异常: ' + e, false))
        .finally(() => { bs.style.display = 'none' })
    })
    initInner.append(initBtn)
    body.append(section('设备初始化', initInner).wrapEl)
    const history = document.createElement('div')
    history.id = 'history'
    history.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;max-height:220px;overflow:auto;background:' + pal.logBg + ';color:' + pal.text + ';padding:8px;font:12px/1.5 ' + uiFont()
    body.append(section('操作记录', history).wrapEl)

    card.append(body)
    shadow.append(card)
    document.body.appendChild(host)

    ctx = { host, card, statusEl: status, logEl: log, historyEl: history, anchor: fab, dir: null, fx: undefined, fy: undefined }
    renderHistory()
    fab.setAttribute('aria-expanded', 'true')
    x.focus?.()
    relayout(false)
    host.style.visibility = 'visible'
    // Re-trigger the open animation reliably (hidden->visible may otherwise
    // swallow the first run).
    card.style.animation = 'none'
    void card.offsetWidth
    card.style.animation = 'pop .18s cubic-bezier(.2,.9,.3,1.05)'
    requestAnimationFrame(() => { host.style.opacity = '1' })
    startFollow()

    const owner = ctx
    fetchStatus().then((st) => {
      if (!st || ctx !== owner) return
      renderStatus(st)
      applyConfig(st.config)
      relayout(true)
    })
  }

  function closePop() {
    if (!ctx) return
    const host = ctx.host
    host.removeAttribute('id')
    const anchor = ctx.anchor
    const card = ctx.card
    ctx = null // stop follower
    actionButtons.clear()
    anchor?.setAttribute('aria-expanded', 'false')
    anchor?.focus?.()
    // Fade + fold out, then remove from the DOM.
    try {
      card.style.transition = 'opacity .13s ease, transform .15s ease'
      card.style.animation = 'none'
      card.style.opacity = '0'
      card.style.transform = 'translateY(-5px) scale(.97)'
    } catch { /* ignore */ }
    setTimeout(() => {
      try { host.remove() } catch { /* ignore */ }
    }, 160)
  }

  // ---------- mount ----------
  function mount() {
    loadPos()
    sampleDesign()
    currentPalette = PALETTES[detectTheme() === 'dark' ? 'dark' : 'light']

    const fab = document.createElement('button')
    fab.id = NS + '-fab'
    fab.type = 'button'
    fab.setAttribute('aria-label', '打开 Home Sync')
    fab.setAttribute('aria-expanded', 'false')
    fab.style.cssText =
      'position:fixed;z-index:2147483000;display:flex;align-items:center;justify-content:center;cursor:grab;border:1px solid ' + pal.border + ';' +
      'background:' + pal.panelBg + ';color:' + pal.text + ';width:38px;height:38px;padding:0;border-radius:50%;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.06), 0 4px 14px ' + pal.shadow + ';' +
      'user-select:none;touch-action:none;will-change:transform,left,top;'
    const SVGNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(SVGNS, 'svg')
    svg.id = NS + '-ico'
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', accent())
    svg.setAttribute('stroke-width', '2.2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.style.cssText = 'width:20px;height:20px;display:block;flex:none'
    svg.innerHTML =
      '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'
    const dot = document.createElement('span')
    dot.id = NS + '-dot'
    dot.style.cssText = 'position:absolute;top:-1px;right:-1px;width:9px;height:9px;border-radius:50%;display:none;' +
      'pointer-events:none;border:1.5px solid ' + pal.dotRing + ';background:' + pal.danger
    fab.append(svg, dot)
    document.body.appendChild(fab)
    applyPalette(fab)
    applyPos(false)

    let dragging = false
    let moved = 0
    let sx = 0
    let sy = 0
    let suppressClick = false
    fab.addEventListener('pointerdown', (e) => {
      dragging = true
      moved = 0
      suppressClick = false
      sx = e.clientX - pos.x
      sy = e.clientY - pos.y
      try { fab.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      fab.style.cursor = 'grabbing'
      fab.style.transition = 'none'
      pressDown()
    })
    fab.addEventListener('pointermove', (e) => {
      if (!dragging) return
      moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0)
      pos.x = Math.max(4, Math.min(innerWidth - (fab.offsetWidth || 38) - 4, e.clientX - sx))
      pos.y = Math.max(4, Math.min(innerHeight - (fab.offsetHeight || 38) - 4, e.clientY - sy))
      fab.style.left = pos.x + 'px'
      fab.style.top = pos.y + 'px'
      // No direct relayout here: the rAF follower moves the card smoothly.
    })
    fab.addEventListener('pointerup', () => {
      if (!dragging) return
      dragging = false
      fab.style.cursor = 'grab'
      const w = fab.offsetWidth || 80
      const nearL = pos.x <= EDGE
      const nearR = pos.x >= innerWidth - w - EDGE
      if (nearL || nearR) {
        pos.docked = true
        pos.x = nearL ? 4 : Math.max(4, innerWidth - (fab.offsetWidth || 38) - 4)
      } else {
        pos.docked = false
      }
      savePos()
      applyPos(true)
      if (ctx) relayout(true)
      pressUp()
      suppressClick = moved >= 5
    })
    fab.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return }
      openPop(fab)
    })
    fab.addEventListener('pointercancel', () => { if (dragging) { dragging = false; fab.style.cursor = 'grab' } })
    fab.addEventListener('dblclick', () => {
      pos.docked = !pos.docked
      if (pos.docked) pos.x = pos.x < innerWidth / 2 ? 4 : Math.max(4, innerWidth - (fab.offsetWidth || 38) - 4)
      savePos()
      applyPos(true)
      if (ctx) relayout(true)
    })

    wireDocument()
    if (!observerRef) {
      observerRef = new MutationObserver(() => {
        const next = PALETTES[detectTheme() === 'dark' ? 'dark' : 'light']
        currentPalette = next
        sampleDesign()
        setThemeColors()
      })
      observerRef.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
      observerRef.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
      const media = window.matchMedia?.('(prefers-color-scheme: dark)')
      if (media?.addEventListener) listen(media, 'change', () => {
        currentPalette = PALETTES[detectTheme() === 'dark' ? 'dark' : 'light']
        sampleDesign(); setThemeColors()
      })
    }

    listen(window, 'resize', () => { applyPos(false); if (ctx) relayout(false) })
    setBadge()
    fetchStatus()
  }

  function createFallback() {
    if (q(NS + '-fb')) return
    const b = document.createElement('button')
    b.id = NS + '-fb'
    b.textContent = '⟳ 同步'
    b.style.cssText =
      'position:fixed;left:16px;top:50%;transform:translateY(-50%);z-index:2147483647;background:#2f6feb;color:#fff;' +
      'border:none;border-radius:999px;padding:9px 16px;font:600 14px/1 system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(16,24,40,.3)'
    b.setAttribute('aria-expanded', 'false')
    b.addEventListener('click', () => { try { openPop(b) } catch (e) { console.error(e) } })
    document.body.appendChild(b)
    console.error('[dsh-home-sync] fallback trigger created')
  }
  function runMount() {
    try {
      if (!q(NS + '-fab')) mount()
    } catch (e) {
      console.error('[dsh-home-sync] mount failed:', e)
      createFallback()
    }
    if (!q(NS + '-fab') && !q(NS + '-fb')) createFallback()
  }

  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', runMount)
  else runMount()
  listen(window, 'load', () => { if (!q(NS + '-fab') && !q(NS + '-fb')) runMount() })
  const mountTimer = setInterval(() => { if (!q(NS + '-fab') && !q(NS + '-fb')) runMount() }, 2500)
  const statusTimer = setInterval(() => fetchStatus().then(st => { if (ctx) renderStatus(st) }), 15000)
  window.__dshHomeSyncCleanup = () => {
    closePop(); clearInterval(mountTimer); clearInterval(statusTimer)
    observerRef?.disconnect()
    for (const remove of globalListeners) remove()
    for (const suffix of ['fab', 'fb', 'pop', 'toast']) q(NS + '-' + suffix)?.remove()
  }
})()
