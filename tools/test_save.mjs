import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/tjqmf/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright');
const base=JSON.parse(fs.readFileSync(new URL('../.data/server.json',import.meta.url))).url;
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.__saveMode='cancel';window.__saved=[];window.__closed=false;
    window.showSaveFilePicker=async options=>{
      window.__options=options;
      if(window.__saveMode==='cancel')throw new DOMException('Cancelled','AbortError');
      return {name:'custom-location.zip',createWritable:async()=>{
        if(window.__saveMode==='denied')throw new DOMException('Write denied','NotAllowedError');
        return new WritableStream({write(chunk){window.__saved.push(...chunk);},close(){window.__closed=true;}});
      }};
    };
  });
  await page.goto(base);
  await page.locator('#fileInput').setInputFiles(fileURLToPath(new URL('../output/playwright/wheel-fixture.pdf',import.meta.url)));
  await page.locator('#reader').waitFor({state:'visible',timeout:30000});
  let exports=0;page.on('request',r=>{if(r.url().includes('/api/export/'))exports++;});
  const save=page.locator('#exportBook');
  await save.click();
  await page.waitForFunction(()=>document.querySelector('#statusMessage').textContent.includes('취소'));
  assert.equal(exports,0,'cancel must not create a ZIP');
  assert.equal(await save.isEnabled(),true);
  await page.evaluate(()=>{window.__saveMode='save';});
  await save.click();
  await page.waitForFunction(()=>document.querySelector('#statusMessage').textContent.includes('저장 완료'),null,{timeout:30000});
  const result=await page.evaluate(()=>({bytes:window.__saved,closed:window.__closed,options:window.__options}));
  assert.equal(result.closed,true);
  assert.equal(result.options.types[0].accept['application/zip'][0],'.zip');
  assert.equal(result.options.suggestedName.endsWith('.zip'),true);
  const target=fileURLToPath(new URL('../output/playwright/custom-location.zip',import.meta.url));
  fs.writeFileSync(target,Buffer.from(result.bytes));
  execFileSync('python',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert 'pages/page_0001.webp' in z.namelist()",target]);
  await page.evaluate(()=>{window.__saveMode='denied';});
  await save.click();
  await page.waitForFunction(()=>document.querySelector('#statusMessage').textContent.includes('Write denied'),null,{timeout:30000});
  assert.equal(await save.isEnabled(),true);
  await page.route('**/api/export/*',r=>r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Test export error'})}));
  await page.evaluate(()=>{window.__saveMode='save';});
  await save.click();
  await page.waitForFunction(()=>document.querySelector('#statusMessage').textContent.includes('Test export error'));
  assert.equal(await save.isEnabled(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS picker contract, streamed valid WebP ZIP, cancel before export, write failure, export failure, button recovery (picker mocked)');
}finally{await browser.close();}
