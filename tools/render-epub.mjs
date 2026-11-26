import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

const [browser, profile, base] = process.argv.slice(2);
fs.mkdirSync(profile,{recursive:true});
const child=spawn(browser,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--disable-extensions','--disable-background-networking','--hide-scrollbars','about:blank'],{stdio:'ignore',windowsHide:true});
let socket, pending=new Map(), seq=1;
async function connect(){
  const portFile=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<120&&!fs.existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
  if(!fs.existsSync(portFile))throw Error('브라우저 렌더러를 시작하지 못했습니다.');
  const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab=targets.find(t=>t.type==='page');
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(!message.id)return;
    const p=pending.get(message.id);if(!p)return;
    pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);
  };
  await send('Page.enable');await send('Runtime.enable');
}
function send(method,params={}){
  const id=seq++;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error(`${method} timed out`));}},45000);
    timer.unref();
    pending.set(id,{resolve,reject,timer});
    try{socket.send(JSON.stringify({id,method,params}));}
    catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
}
async function job(item){
  if(!socket)await connect();
  if(!item.url.startsWith(base+'/render/'))throw Error('렌더링 주소가 올바르지 않습니다.');
  await send('Emulation.setDeviceMetricsOverride',{width:609,height:822,deviceScaleFactor:2,mobile:false});
  await send('Page.navigate',{url:item.url});
  for(let i=0;i<100;i++){
    const result=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});
    if(result.result.value==='complete')break;
    await new Promise(r=>setTimeout(r,80));
  }
  await send('Runtime.evaluate',{expression:'document.fonts.ready',awaitPromise:true});
  const result=await send('Runtime.evaluate',{returnByValue:true,expression:`(() => {
    const viewport=document.querySelector('meta[name="viewport"]')?.content||'';
    const w=Number(viewport.match(/width=(\\d+)/)?.[1]||609),h=Number(viewport.match(/height=(\\d+)/)?.[1]||822);
    const words=[];
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode;if(!node.textContent.trim())continue;
      const parent=node.parentElement;if(!parent||['SCRIPT','STYLE'].includes(parent.tagName))continue;
      for(const m of node.textContent.matchAll(/\\S+/g)){
        const range=document.createRange();range.setStart(node,m.index);range.setEnd(node,m.index+m[0].length);
        const r=range.getBoundingClientRect();if(r.width>0&&r.height>0&&r.x<w&&r.y<h)words.push([m[0],r.x/w,r.y/h,r.width/w,r.height/h]);
      }
    }
    return {width:w,height:h,words};
  })()`});
  const info=result.result.value;
  if(!info||!info.width)throw Error('EPUB 페이지 크기를 읽지 못했습니다.');
  // Match the source viewer's fixed 1218px page canvas.
  await send('Emulation.setDeviceMetricsOverride',{width:info.width,height:info.height,deviceScaleFactor:1218/info.width,mobile:false});
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(item.output,Buffer.from(shot.data,'base64'));
  fs.writeFileSync(item.text,JSON.stringify(info.words));
}
for await(const line of readline.createInterface({input:process.stdin})){
  try{await job(JSON.parse(line));process.stdout.write('{"ok":true}\n');}
  catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error.message).slice(0,300)})+'\n');}
}
socket?.close();child.kill();
