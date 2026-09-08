// Real browser smoke test, using a fresh headless profile and synthetic fetch data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p))
test('headless browser opens from SVG, saves Unicode settings and reopens cleanly', { skip: !chrome, timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-sync-browser-'))
  const ui = fs.readFileSync(path.join(project, 'lib/ui.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
  const page = path.join(dir, 'test.html')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Home Sync regression</title></head><body>
  <h1>Home Sync browser regression</h1><pre id="result">PENDING</pre>
  <script>
  const calls=[]; window.fetch=async(url,opts={})=>{calls.push({url,...opts});return {ok:true,status:200,json:async()=>({ok:true,hasRepo:true,branch:'main',remote:'local test remote',dirty:[],ahead:0,behind:0,config:{branch:'main',autoSync:false,autoPullOnStartup:false,commitMessage:'test'}})}};
  </script><script>${ui}</script><script>
  setTimeout(async()=>{try{
    const assert=(v,m)=>{if(!v)throw Error(m)};
    const fab=document.getElementById('dhs8-fab');
    fab.querySelector('path').dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true}));
    await new Promise(r=>setTimeout(r,100));
    assert(fab.getAttribute('aria-expanded')==='true','SVG click closed panel');
    let pop=document.getElementById('dhs8-pop');assert(pop,'No panel');
    const buttons=[...pop.shadowRoot.querySelectorAll('button')];
    buttons.find(b=>b.textContent.includes('设置')).click();
    const input=pop.shadowRoot.querySelector('input[placeholder="commit message"]');input.value='同步配置😀';
    buttons.find(b=>b.textContent==='保存').click();
    await new Promise(r=>setTimeout(r,50));
    assert(calls.some(c=>c.url.endsWith('/config')&&JSON.parse(c.body).commitMessage==='同步配置😀'),'Unicode save failed');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert(fab.getAttribute('aria-expanded')==='false','Escape failed');
    fab.click();assert(document.querySelectorAll('#dhs8-pop').length===1,'Duplicate panel IDs after reopen');
    await new Promise(r=>setTimeout(r,300));
    document.getElementById('result').textContent='PASS: SVG click, Unicode save, Escape, reopen';
  }catch(e){document.getElementById('result').textContent='FAIL: '+e.stack}},100);
  </script></body></html>`
  fs.writeFileSync(page, html)
  const { stdout } = await promisify(execFile)(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--user-data-dir=' + path.join(dir, 'profile'),
    '--window-size=1200,800', '--virtual-time-budget=2500', '--dump-dom', '--screenshot=' + path.join(project, 'audit/browser-regression.png'), pathToFileURL(page).href],
  { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 })
  const result = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)?.[1]
  assert.match(result || '', /^PASS:/)
  fs.writeFileSync(path.join(project, 'audit/browser-regression-result.json'), JSON.stringify({ passed: true, browser: chrome, result, syntheticDataOnly: true }, null, 2))
})
