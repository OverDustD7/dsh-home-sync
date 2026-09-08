// Minimal DOM/event model for logic checks. This is not a real-browser layout test.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(project, 'lib/ui.js'), 'utf8')
function fixture(failStyle = false) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = { setProperty(k, v) { this[k] = v } }; this.handlers = {}; this.attrs = {}; this.offsetWidth = tag === 'button' ? 38 : 320; this.offsetHeight = tag === 'button' ? 38 : 160; this.className = '' }
    append(...els) { for (const el of els) { this.children.push(el); el.parent = this } }
    appendChild(el) { this.append(el); return el }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) }
    setAttribute(k, v) { this.attrs[k] = v }
    getAttribute(k) { return this.attrs[k] }
    removeAttribute(k) { if (k === 'id') this.id = ''; delete this.attrs[k] }
    addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn) }
    removeEventListener(k, fn) { this.handlers[k] = (this.handlers[k] || []).filter(f => f !== fn) }
    focus() {}
    emit(k, e = {}) { for (const fn of this.handlers[k] || []) fn(e) }
    contains(el) { return el === this || this.children.some(c => c.contains(el)) }
    find(fn) { if (fn(this)) return this; for (const c of this.children) { const x = c.find(fn); if (x) return x } return null }
    querySelector(q) { return this.find(el => el.tag === 'input' && (q === 'input:checked' ? el.checked : el.value === /value="([^"]+)"/.exec(q)?.[1])) }
    attachShadow() { return this.shadowRoot = new Element('shadow') }
    getBoundingClientRect() { const left = parseFloat(this.style.left) || 48, top = parseFloat(this.style.top) || 300; return { left, top, right: left + this.offsetWidth, bottom: top + this.offsetHeight, height: this.offsetHeight } }
  }
  const document = new Element('document')
  document.documentElement = new Element('html'); document.body = new Element('body')
  document.documentElement.append(document.body)
  document.readyState = 'complete'
  document.createElement = tag => new Element(tag)
  document.createElementNS = (_, tag) => new Element(tag)
  document.getElementById = id => document.documentElement.find(el => el.id === id)
  document.querySelectorAll = () => []
  const window = new Element('window')
  window.matchMedia = () => ({ matches: false })
  const sandbox = { document, window, innerWidth: 1200, innerHeight: 800,
    localStorage: { getItem() { return null }, setItem() {} },
    getComputedStyle() { if (failStyle) throw new Error('synthetic mounting failure'); return { backgroundColor: 'rgb(255,255,255)', fontFamily: 'sans-serif', getPropertyValue() { return '' } } },
    console: { log() {}, error() {} }, MutationObserver: class { observe() {} disconnect() {} }, AbortController,
    requestAnimationFrame() { return 1 }, setInterval() {}, clearInterval() {}, setTimeout() { return 1 }, clearTimeout() {},
    performance: { now() { return 0 } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, dirty: [], config: {} }) }),
  }
  vm.runInNewContext(source, sandbox)
  return { document, window, sandbox, q: id => document.getElementById('dhs8-' + id) }
}

test('clicking the SVG opens the panel and bubbling does not close it', () => {
  const f = fixture(), fab = f.q('fab'), icon = f.q('ico')
  fab.emit('pointerdown', { clientX: 48, clientY: 400, pointerId: 1 }); fab.emit('pointerup')
  assert.equal(f.q('pop'), null)
  fab.emit('click', { target: icon }); f.document.emit('click', { target: icon })
  const pop = f.q('pop'); assert.ok(pop)
  const card = pop.shadowRoot.children.find(el => el.className === 'card')
  assert.notEqual(card.style.opacity, '0')
  assert.equal(fab.getAttribute('aria-expanded'), 'true')
})
test('keyboard-generated click opens and Escape closes', () => {
  const f = fixture(), fab = f.q('fab')
  fab.emit('click', { target: fab }); f.document.emit('click', { target: fab })
  assert.ok(f.q('pop')); assert.equal(fab.getAttribute('aria-expanded'), 'true')
  f.document.emit('keydown', { key: 'Escape' }); assert.equal(fab.getAttribute('aria-expanded'), 'false')
})
test('a drag suppresses the following click', () => {
  const f = fixture(), fab = f.q('fab')
  fab.emit('pointerdown', { clientX: 48, clientY: 400, pointerId: 1 })
  fab.emit('pointermove', { clientX: 150, clientY: 400, movementX: 102, movementY: 0 })
  fab.emit('pointerup'); fab.emit('click', { target: fab }); assert.equal(f.q('pop'), null)
})
test('fallback opens without a primary button after a mounting failure', () => {
  const f = fixture(true), fallback = f.q('fb')
  assert.ok(fallback); assert.equal(f.q('fab'), null)
  fallback.emit('click', { target: fallback }); assert.ok(f.q('pop'))
})
test('outside click closes and script cleanup removes UI and document listeners', () => {
  const f = fixture(), fab = f.q('fab'); fab.emit('click', { target: fab })
  f.document.emit('click', { target: f.document.body }); assert.equal(fab.getAttribute('aria-expanded'), 'false')
  f.window.__dshHomeSyncCleanup(); assert.equal(f.q('fab'), null)
  assert.equal(f.document.handlers.click.length, 0); assert.equal(f.document.handlers.keydown.length, 0)
})

