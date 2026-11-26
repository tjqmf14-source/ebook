import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/tjqmf/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright');
const output=path.resolve(process.argv[2]||'output/delivery-museum');
const root=path.join(output,'unpacked');
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(req.url.split('?')[0]).replace(/^\/ebook\/museum\//,'');
  const target=path.resolve(root,relative);
  if(!target.startsWith(root+path.sep)||!fs.existsSync(target)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.webp':'image/webp'})[path.extname(target)]||'text/plain');
  res.end(fs.readFileSync(target));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
  for(const mode of ['file','web']){
    const context=await browser.newContext({viewport:{width:1400,height:900},offline:mode==='file'});
    const page=await context.newPage();
    const errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>requests.push(r.url()));
    await page.goto(mode==='file'?pathToFileURL(path.join(root,'index.html')).href:`http://127.0.0.1:${server.address().port}/ebook/museum/index.html`);
    await page.waitForFunction(()=>document.querySelector('#packageNotice').hidden);
    await page.waitForFunction(()=>[...document.querySelectorAll('#reader img')].some(i=>i.naturalWidth>0));
    assert.equal(await page.locator('#newBook').isVisible(),false);
    assert.equal(await page.locator('#settingsToggle').isVisible(),false);
    assert.equal(await page.locator('#exportBook').isVisible(),false);
    assert.notEqual(await page.locator('header').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
    await page.locator('#readerStage').hover();
    await page.mouse.wheel(0,120);
    await page.waitForFunction(()=>Number(document.querySelector('#pageNumber').value)>1);
    await page.locator('#tocToggle').click();
    assert.equal(await page.locator('#tocPanel').getAttribute('aria-hidden'),'false');
    assert.deepEqual(errors,[]);
    assert.equal(requests.some(u=>u.includes('/api/')||/^https:/.test(u)),false);
    if(fs.existsSync(path.join(root,'pages/page_0001.webp')))assert.equal(requests.some(u=>/page_\d+\.webp/.test(u)),true);
    await page.locator('#tocClose').click();
    await page.waitForTimeout(400);
    if(mode==='web')await page.screenshot({path:path.join(output,'web-preview.png')});
    console.log(`PASS ${mode}: CSS, images, wheel, TOC, reader-only UI, no API/external requests`);
    await context.close();
  }
  const isolated=path.join(output,'html-only');fs.mkdirSync(isolated,{recursive:true});
  fs.copyFileSync(path.join(root,'index.html'),path.join(isolated,'index.html'));
  const page=await browser.newPage();
  await page.goto(pathToFileURL(path.join(isolated,'index.html')).href);
  assert.equal(await page.locator('#packageNotice').isVisible(),true);
  assert.match(await page.locator('#packageNotice').innerText(),/전체를 먼저 압축 해제/);
  console.log('PASS missing assets: extraction instructions remain visible');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
