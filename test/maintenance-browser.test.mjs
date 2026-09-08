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
test('open panel follows theme, initialization resets switches, and history survives remount', { skip: !chrome, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-maintenance-browser-'))
  const ui = fs.readFileSync(path.join(project, 'lib/ui.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
  const page = path.join(root, 'test.html')
  fs.writeFileSync(page, `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><pre id="result">PENDING</pre>
  <script>
  let cfg={branch:'main',autoSync:true,autoPullOnStartup:true,commitMessage:'test'},history=[],saves=[];
  window.fetch=async(url,opts={})=>{
    if(url.endsWith('/init')){cfg={...cfg,autoSync:false,autoPullOnStartup:false};history=[{at:'2026-09-07',kind:'init',ok:true,message:'初始化完成',backupDir:'SYNTHETIC-BACKUP'}];return {ok:true,json:async()=>({ok:true,config:{...cfg},backupDir:'SYNTHETIC-BACKUP'})}}
    if(url.endsWith('/config')){saves.push(JSON.parse(opts.body));cfg={...cfg,...saves.at(-1)}}
    return {ok:true,json:async()=>({ok:true,hasRepo:true,branch:'main',remote:'synthetic',dirty:[],history,config:{...cfg}})};
  };
  </script><script id="plugin">${ui}</script><script>
  setTimeout(async()=>{try{
    const check=(v,m)=>{if(!v)throw Error(m)},wait=()=>new Promise(r=>setTimeout(r,100));
    let fab=document.getElementById('dhs8-fab');fab.click();await wait();
    let pop=document.getElementById('dhs8-pop'),shadow=pop.shadowRoot;
    const stable=s=>{const style=document.createElement('style');style.textContent='*{transition:none!important;animation:none!important}';s.append(style)};stable(shadow);
    let buttons=[...shadow.querySelectorAll('button')];
    const inputs=[...shadow.querySelectorAll('input[type=checkbox]')];check(inputs[0].checked,'initial config missing');
    const msg=shadow.querySelector('input[placeholder="commit message"]');msg.value='unsaved draft';
    const light=getComputedStyle(shadow.querySelector('.card')).backgroundColor;
    document.documentElement.setAttribute('data-theme','dark');await wait();
    check(document.getElementById('dhs8-pop')===pop,'theme recreated panel');
    check(getComputedStyle(shadow.querySelector('.card')).backgroundColor!==light,'theme unchanged');
    check(msg.value==='unsaved draft','theme lost draft');
    shadow.querySelector('input[placeholder="git@… 或 https://…"]').value='git@example.invalid:review/repo.git';inputs.at(-1).checked=true;
    buttons.find(b=>b.textContent==='执行').click();await wait();
    check(!inputs[0].checked&&!inputs[1].checked,'stale automatic switches');
    buttons.find(b=>b.textContent==='保存').click();await wait();
    check(!saves.at(-1).autoSync&&!saves.at(-1).autoPullOnStartup,'save reenabled automation');
    const historyButton=buttons.find(b=>b.textContent.includes('操作记录'));
    check(historyButton.getAttribute('aria-expanded')==='false','history auto-opened');
    check(getComputedStyle(shadow.getElementById('log')).left==='-9999px','inline feedback restored');
    historyButton.click();await wait();
    let record=shadow.getElementById('history');check(record.textContent.includes('SYNTHETIC-BACKUP'),'backup missing');
    check(record.getBoundingClientRect().height>0&&getComputedStyle(record).userSelect==='text','history unreadable');
    window.__dshHomeSyncCleanup();(0,eval)(document.getElementById('plugin').textContent);
    fab=document.getElementById('dhs8-fab');fab.click();await wait();
    shadow=document.getElementById('dhs8-pop').shadowRoot;
    stable(shadow);
    check(shadow.getElementById('history').textContent.includes('SYNTHETIC-BACKUP'),'remount lost history');
    [...shadow.querySelectorAll('button')].find(b=>b.textContent.includes('操作记录')).click();await wait();
    record=shadow.getElementById('history');check(record.parentElement.getBoundingClientRect().height>=record.getBoundingClientRect().height,'history clipped by closed section');
    document.getElementById('result').textContent='PASS: live theme, draft preservation, reset switches, collapsed history, backup after remount';
  }catch(e){document.getElementById('result').textContent='FAIL: '+e.stack}},100);
  </script></body></html>`)
  const { stdout } = await promisify(execFile)(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--user-data-dir=' + path.join(root, 'profile'),
    '--window-size=1200,800', '--virtual-time-budget=3000', '--dump-dom', '--screenshot=' + path.join(project, 'audit/maintenance-browser.png'), pathToFileURL(page).href],
  { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 })
  const result = /<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)?.[1]
  assert.match(result || '', /^PASS:/)
  fs.writeFileSync(path.join(project, 'audit/maintenance-browser-result.json'), JSON.stringify({ passed: true, result, syntheticDataOnly: true }, null, 2))
})
