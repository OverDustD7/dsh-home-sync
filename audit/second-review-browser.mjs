// Real-browser review using synthetic API responses and a fresh temporary profile.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-second-review-browser-'))
const ui = fs.readFileSync(path.join(project, 'lib/ui.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
const page = path.join(root, 'review.html')
fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="result">PENDING</pre>
<script>
window.mockConfig={branch:'main',autoSync:true,autoPullOnStartup:true,commitMessage:'test'};
window.fetch=async(url,opts={})=>{
 if(url.endsWith('/init')){mockConfig={...mockConfig,autoSync:false,autoPullOnStartup:false};return {ok:true,json:async()=>({ok:true,backupDir:'SYNTHETIC-BACKUP'})}}
 return {ok:true,json:async()=>({ok:true,hasRepo:true,branch:'main',remote:'synthetic',dirty:[],config:{...mockConfig}})};
};
</script><script>${ui}</script><script>
setTimeout(async()=>{try{
 const fab=document.getElementById('dhs8-fab');fab.click();await new Promise(r=>setTimeout(r,100));
 const shadow=document.getElementById('dhs8-pop').shadowRoot;
 const checks=[...shadow.querySelectorAll('input[type=checkbox]')];
 const initiallyChecked=checks[0].checked;
 shadow.querySelector('input[placeholder="git@… 或 https://…"]').value='git@example.invalid:review/repo.git';
 checks.at(-1).checked=true;
 [...shadow.querySelectorAll('button')].find(b=>b.textContent==='执行').click();
 await new Promise(r=>setTimeout(r,100));
 const staleAutoSync=checks[0].checked,staleStartupPull=checks[1].checked;
 const log=shadow.getElementById('log');const logStyle=getComputedStyle(log);
 const result={initiallyChecked,backendAutoSync:mockConfig.autoSync,backendAutoPullOnStartup:mockConfig.autoPullOnStartup,
 displayedAutoSync:staleAutoSync,displayedAutoPullOnStartup:staleStartupPull,logHasBackup:log.textContent.includes('SYNTHETIC-BACKUP'),logLeft:logStyle.left,logWidth:logStyle.width};
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));fab.click();await new Promise(r=>setTimeout(r,50));
 result.autoSyncAfterReopen=document.getElementById('dhs8-pop').shadowRoot.querySelector('input[type=checkbox]').checked;
 document.getElementById('result').textContent=JSON.stringify(result);
}catch(e){document.getElementById('result').textContent='FAIL: '+e.stack}},100);
</script></body></html>`)
const { stdout } = await promisify(execFile)(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-extensions', '--disable-sync', '--user-data-dir=' + path.join(root, 'profile'),
  '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(page).href], { windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 })
const evidence = JSON.parse(/<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)[1])
assert.equal(evidence.backendAutoSync, false); assert.equal(evidence.displayedAutoSync, true)
assert.equal(evidence.backendAutoPullOnStartup, false); assert.equal(evidence.displayedAutoPullOnStartup, true)
assert.equal(evidence.autoSyncAfterReopen, false)
fs.writeFileSync(path.join(project, 'audit/second-review-browser-results.json'), JSON.stringify({ confirmed: true, syntheticDataOnly: true, evidence }, null, 2))
console.log(JSON.stringify(evidence, null, 2))
