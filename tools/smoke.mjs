import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/tjqmf/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright');
const base=JSON.parse(fs.readFileSync(new URL('../.data/server.json',import.meta.url))).url;
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1400,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto(base);
await page.getByRole('heading',{name:'책을 여기에 놓아 주세요'}).waitFor();
await page.getByRole('button',{name:'뷰어 설정'}).click();
await page.locator('#titleInput').fill('테스트 플립북');
await page.locator('#headerColor').fill('#334455');
await page.locator('#allowTextSelection').check();
await page.getByRole('button',{name:'설정 저장'}).click();
assert.equal(await page.locator('#brandName').textContent(),'테스트 플립북');
const sample=process.argv[2];
if(sample){
  await page.locator('#fileInput').setInputFiles(sample);
  await page.locator('#reader').waitFor({state:'visible',timeout:30000});
  await page.locator('#imgRight').waitFor({state:'attached'});
  await page.locator('#textTool').click();
  await page.locator('.text-layer span').first().waitFor({timeout:20000});
  assert(await page.locator('.text-layer span').count()>0);
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:30000}),
    page.locator('#exportBook').click()
  ]);
  await download.saveAs(fileURLToPath(new URL('../output/playwright/smoke-export.zip',import.meta.url)));
  console.log('ZIP saved:',download.suggestedFilename());
}
assert.deepEqual(errors,[]);
console.log('UI smoke passed');
await browser.close();
