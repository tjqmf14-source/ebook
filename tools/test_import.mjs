import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/tjqmf/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright');
const base=JSON.parse(fs.readFileSync(new URL('../.data/server.json',import.meta.url))).url;
const sample=process.argv[2]||fileURLToPath(new URL('../output/playwright/wheel-fixture.pdf',import.meta.url));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(()=>!!window.studioSettings);
  // A disconnected window must show a useful error and allow retry.
  await page.route('**/api/bootstrap',route=>route.abort('connectionrefused'));
  await page.locator('#fileInput').setInputFiles(sample);
  await page.waitForFunction(()=>document.querySelector('#importStatus').textContent.includes('실행.cmd'));
  assert.equal(await page.locator('#chooseFile').isEnabled(),true);
  await page.unroute('**/api/bootstrap');
  // Exercise the visible file picker and select the same file after failure.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#chooseFile').click()]);
  await chooser.setFiles(sample);
  await page.locator('#reader').waitFor({state:'visible',timeout:90000});
  await page.waitForFunction(()=>document.querySelector('#imgRight').naturalWidth>0||document.querySelector('#stPageRoot img')?.naturalWidth>0,{},{timeout:60000});
  assert.equal(await page.locator('#exportBook').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: disconnected error, same-file retry via file chooser, PDF reader image loaded, ZIP button visible');
} finally {await browser.close();}
