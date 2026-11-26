/* 부산대학교 80년사 · HTML5 웹 플립북
 * - 로컬 StPageFlip 2.0.7 로드 시 실제 곡면 페이지 넘김 사용
 * - 외부 라이브러리를 사용할 수 없을 때 CSS 3D 페이지 넘김으로 동작
 * - 페이지 이미지는 현재 지점 주변만 지연 로드
 */
window.startViewer = book => {
  'use strict';
  const TOTAL = book.count;
  const PAGE_RATIO = book.ratio;
  const imageFormat = book.imageFormat === 'webp' ? 'webp' : 'png';
  const SOURCE = n => book.static ? `pages/page_${String(n).padStart(4,'0')}.${imageFormat}` : `/book/${book.id}/${n}/image`;
  const CHAPTERS = book.toc || [];
  const $ = id => document.getElementById(id);
  const ui = {
    stage:$('readerStage'), root:$('stPageRoot'), book:$('fallbackBook'),
    sheet:$('turnSheet'), front:$('sheetFront'), back:$('sheetBack'),
    left:$('imgLeft'), right:$('imgRight'),
    leftBase:$('baseLeft'), rightBase:$('baseRight'),
    pageNumber:$('pageNumber'), range:$('pageRange'), status:$('statusMessage'),
    toc:$('tocPanel'), tocToggle:$('tocToggle'), tocNav:$('tocNav'), backdrop:$('tocBackdrop'),
    hint:$('stageHint'), curl:$('curlSheet'), castShadow:$('curlCastShadow'),
    zoomOut:$('zoomOutButton'),zoomIn:$('zoomInButton'),zoomReset:$('zoomResetButton')
  };
  let mode = 'css';
  let current = 0; // PDF 페이지(0부터 계산)
  let mobile = false;
  let viewPreference = null;
  let activeTool = null;
  let textEnabled = window.studioSettings?.allowTextSelection === true;
  const singlePage = () => viewPreference ?? (ui.stage.clientWidth < 730);
  function updateViewButtons(){
    $('singleView').setAttribute('aria-pressed',String(singlePage()));
    $('spreadView').setAttribute('aria-pressed',String(!singlePage()));
  }
  function selectTool(tool){
    if(tool==='text' && !textEnabled)return;
    const leavingText=activeTool==='text' && tool!=='text';
    if(tool==='text' && mode==='st' && lib){
      lib.getRender().finishAnimation();
      mode='css'; current=singlePage()?current:normalizeSpread(current);
      ui.root.classList.add('pageflip-parked'); ui.book.hidden=false;
      fitFallback();
    }
    activeTool=tool;
    ui.stage.classList.toggle('selecting-text',tool==='text');
    $('textTool').setAttribute('aria-pressed',String(tool==='text'));
    if(leavingText && zoom===1 && lib){
      ui.book.hidden=true;ui.root.classList.remove('pageflip-parked');mode='st';fitViewer();jump(current);
    }
    if(mode==='css')renderFallback();
    for(const [id,name] of [['magnifier','in'],['magnifierOut','out'],['handTool','hand']]){
      $(id).setAttribute('aria-pressed',String(tool===name));
    }
    ui.stage.classList.toggle('magnifying',tool==='in'||tool==='out');
    ui.stage.classList.toggle('magnifying-out',tool==='out');
    ui.stage.classList.toggle('hand-tool',tool==='hand');
  }
  let busy = false;
  let lib = null;
  let libImages = [];
  let zoom=1;const MIN_ZOOM=.75,MAX_ZOOM=2.25;
  const STRIPS=28; let curling=null;let rafId=0;
  let panX=0,panY=0;
  let fitFrame=0;
  const clamp = n => Math.max(0,Math.min(TOTAL-1,n));
  let tipTimer;
  const status = (msg,ms=4200) => {
    ui.status.textContent = msg;
    if (tipTimer) clearTimeout(tipTimer);
    if (ms) tipTimer = setTimeout(() => {ui.status.textContent='';},ms);
  };
  function setImg(node,index) {
    if (index == null || index < 0 || index >= TOTAL) {
      node.removeAttribute('src');
      node.style.visibility = 'hidden';
      return;
    }
    const url = SOURCE(index+1);
    if (!node.getAttribute('src') || !node.getAttribute('src').endsWith(url)) node.setAttribute('src',url);
    node.style.visibility = 'visible';
  }
  function chapterRender() {
    if(!CHAPTERS.length){
      const empty=document.createElement('p');empty.className='toc-empty';
      empty.textContent='연결할 수 있는 목차 항목을 찾지 못했습니다.';
      ui.tocNav.appendChild(empty);
      return;
    }
    CHAPTERS.forEach(([name,page],i) => {
      const btn=document.createElement('button');
      const label=document.createElement('span');label.textContent=name;
      const number=document.createElement('small');number.textContent=`${page}쪽`;
      btn.append(label,number);btn.dataset.page=String(page);
      btn.addEventListener('click',() => {jump(page-1);setToc(false);});
      ui.tocNav.appendChild(btn);
    });
  }
  function setToc(open) {
    const restoreFocus=!open && ui.toc.contains(document.activeElement);
    ui.toc.classList.toggle('open',open);
    ui.toc.inert=!open;
    ui.toc.setAttribute('aria-hidden',String(!open));
    ui.tocToggle.setAttribute('aria-expanded',String(open));
    ui.tocToggle.setAttribute('aria-label',open?'목차 닫기':'목차 열기');
    ui.backdrop.hidden=!open;
    if(open){
      (ui.tocNav.querySelector('.selected') || ui.tocNav.querySelector('button'))?.focus();
    } else if(restoreFocus){
      ui.tocToggle.focus();
    }
  }
  function updatePageIndicator() {
    const index = current;
    const spread = !singlePage() && index>0 && index<TOTAL-1;
    ui.stage.classList.toggle('open-spread',spread);
    if(spread){
      const progress=normalizeSpread(index)/(TOTAL-1);
      ui.stage.style.setProperty('--left-paper-depth',`${3+progress*7}px`);
      ui.stage.style.setProperty('--right-paper-depth',`${10-progress*7}px`);
    }
    const display = index+1;
    ui.pageNumber.value=String(display);
    ui.range.value=String(display);
    document.title=`${window.studioTitle || book.name} · ${display}쪽`;
    const last = index>=TOTAL-1;
    for(const id of ['nextButton','stageNext','lastButton']) $(id).disabled=last;
    for(const id of ['prevButton','stagePrev','firstButton']) $(id).disabled=index===0;
    ui.tocNav.querySelectorAll('button').forEach(b=>b.classList.toggle('selected',Number(b.dataset.page)===display));
    const url=new URL(window.location.href);
    url.searchParams.set('page',String(display));
    try{if(location.protocol!=='about:')history.replaceState(null,'',url.pathname+url.search+url.hash);}catch{ /* 내장 브라우저/미리보기 제한 */ }
  }
  function lazyImages(center) {
    if (!libImages.length) return;
    const start=Math.max(0,center-9),end=Math.min(TOTAL-1,center+13);
    for (let i=start;i<=end;i++) {
      const el=libImages[i];if(!el.src) el.src=SOURCE(i+1);
    }
    // 메모리 절감: 멀리 떨어진 페이지의 이미지 디코딩 데이터 해제
    for (let i=0;i<libImages.length;i++) {
      if(Math.abs(i-center)>26 && libImages[i].getAttribute('src'))libImages[i].removeAttribute('src');
    }
  }
  function initStPageFlip() {
    if(!(window.St && window.St.PageFlip))return false;
    try {
      ui.root.hidden=false;ui.book.hidden=true;
      const fragment=document.createDocumentFragment();
      for(let i=0;i<TOTAL;i++) {
        const page=document.createElement('div');page.className='page';
        const inside=document.createElement('div');inside.className='page-inner';
        const img=document.createElement('img');img.alt=`${book.name} ${i+1}쪽`;
        img.loading='eager';img.decoding='async';
        img.addEventListener('error',()=>{if(Math.abs(i-current)<3)status(`${i+1}쪽 이미지가 없습니다. 해당 페이지 이미지 ZIP을 설치해 주세요.`);});
        inside.appendChild(img);page.appendChild(inside);fragment.appendChild(page);libImages.push(img);
      }
      ui.root.appendChild(fragment);
      sizeLibraryRoot();
      const startIndex=readRequestedPage();
      lazyImages(startIndex);
      lib=new window.St.PageFlip(ui.root,{
        width:609,height:Math.round(609/PAGE_RATIO),size:'stretch',minWidth:singlePage()?ui.root.clientWidth:1,maxWidth:10000,
        minHeight:1,maxHeight:10000,showCover:true,usePortrait:true,
        mobileScrollSupport:false,drawShadow:true,maxShadowOpacity:0.24,
        flippingTime:730,disableFlipByClick:true,showPageCorners:false,useMouseEvents:true,startPage:startIndex,
        autoSize:false
      });
      const pages=ui.root.querySelectorAll('.page');
      lib.on('flip',e=>{if(mode!=='st')return;current=clamp(Number(e.data));lazyImages(current);updatePageIndicator();});
      lib.on('changeOrientation',()=>{lazyImages(current);});
      let receivingFrame=0;
      lib.on('changeState',event=>{
        cancelAnimationFrame(receivingFrame);
        setReceivingShade(ui.root,0,0);
        if(event.data==='read')return;
        const sync=()=>{
          if(mode==='st' && !singlePage()){
            const renderer=lib.getRender();
            // StPageFlip 2.0.7 expresses its shadow progress on a 0–200 scale.
            const progress=Math.min(1,Math.max(0,(renderer.shadow?.progress ?? 0)/200));
            setReceivingShade(ui.root,renderer.getDirection(),progress);
          }
          receivingFrame=requestAnimationFrame(sync);
        };
        receivingFrame=requestAnimationFrame(sync);
      });
      lib.loadFromHTML(pages);
      // 페이지 시작 위치가 미적용되는 라이브러리 버전 대비
      if(startIndex!==0)lib.turnToPage(startIndex);
      current=startIndex;mode='st';
      ui.hint.textContent='책 모서리를 넘기거나 마우스 휠로 페이지를 이동하세요.';
      updatePageIndicator();
      return true;
    } catch(err) {
      console.warn('[PNU 80] StPageFlip 시작 실패, CSS 3D 대체 뷰어 사용:',err);
      if(lib){try{lib.destroy();}catch{}}lib=null;libImages=[];
      ui.root.replaceChildren();ui.root.hidden=true;ui.book.hidden=false;
      return false;
    }
  }
  function normalizeSpread(n) {
    n=clamp(n);return n===0?0:(n%2===1?n:n-1);
  }
  function fitFallback() {
    if(mode!=='css')return;
    if(busy)endCurl(false);
    const oldMobile=mobile;
    mobile = singlePage();
    updateViewButtons();
    if(oldMobile && !mobile)current=normalizeSpread(current);
    ui.book.classList.toggle('single-page',mobile);
    const aw=Math.max(1,ui.stage.clientWidth-(mobile?36:120));
    const ah=Math.max(1,ui.stage.clientHeight-46);
    const pageWidth=Math.min(ah*PAGE_RATIO,aw/(mobile?1:2))*zoom;
    const h=pageWidth/PAGE_RATIO;
    ui.book.style.width=`${(mobile?1:2)*pageWidth}px`;
    ui.book.style.height=`${h}px`;
    ui.stage.classList.toggle('zoomed',zoom!==1);
    applyPan();
    renderFallback();updatePageIndicator();
  }
  function sizeLibraryRoot(){
    const single=singlePage();
    updateViewButtons();
    const aw=Math.max(1,ui.stage.clientWidth-(single?36:120));
    const ah=Math.max(1,ui.stage.clientHeight-46);
    const pageWidth=Math.max(1,Math.floor(Math.min(ah*PAGE_RATIO,aw/(single?1:2))));
    ui.root.style.width=`${pageWidth*(single?1:2)}px`;
    ui.root.style.height=`${Math.ceil(pageWidth/PAGE_RATIO)}px`;
    // Keep the engine's interaction surface equal to the fitted book, so its
    // built-in next/previous corner coordinates stay inside the pages.
    if(lib)lib.getSettings().minWidth=single?pageWidth:1;
  }
  function fitViewer(){
    if(mode==='st' && lib){sizeLibraryRoot();lib.update();}
    else fitFallback();
  }
  function scheduleFit(){
    cancelAnimationFrame(fitFrame);
    fitFrame=requestAnimationFrame(fitViewer);
  }
  function applyPan(){
    const maxX=zoom>1?Math.max(ui.book.offsetWidth*(1-1/zoom)/2,(ui.book.offsetWidth-ui.stage.clientWidth)/2+18):0;
    const maxY=zoom>1?Math.max(ui.book.offsetHeight*(1-1/zoom)/2,(ui.book.offsetHeight-ui.stage.clientHeight)/2+23):0;
    panX=Math.max(-maxX,Math.min(maxX,panX));
    panY=Math.max(-maxY,Math.min(maxY,panY));
    ui.book.style.transform=`translate(${panX}px,${panY}px)`;
    ui.hint.textContent=zoom>1?'확대한 지면은 드래그·휠로 이동하고, 모서리를 잡아 넘기세요.':'책 모서리를 드래그하거나 마우스 휠로 넘기세요.';
  }
  async function updateText(parent,index){
    let layer=parent.querySelector('.text-layer');
    if(!layer){layer=document.createElement('div');layer.className='text-layer';parent.appendChild(layer);}
    const key=activeTool==='text' && index!=null && index>=0 && index<TOTAL?String(index+1):'';
    if(layer.dataset.page===key)return;
    layer.dataset.page=key;layer.replaceChildren();
    if(!key)return;
    try{
      let words;
      if(book.static)words=window.FLIPBOOK_TEXT?.[key] || [];
      else{
        const response=await fetch(`/book/${book.id}/${key}/text`);
        if(!response.ok)throw Error('텍스트를 불러오지 못했습니다.');
        words=await response.json();
      }
      if(layer.dataset.page!==key)return;
      for(const [value,x,y,w,h] of words){
        if(!value || x<0 || y<0 || x>1 || y>1)continue;
        const span=document.createElement('span');span.textContent=value+' ';
        span.style.cssText=`left:${x*100}%;top:${(y+h*.18)*100}%;font-size:${Math.max(4,h*66)}cqh`;
        layer.appendChild(span);
        const range=document.createRange();range.selectNodeContents(span);
        const actual=range.getBoundingClientRect().width;
        const target=w*layer.clientWidth;
        if(actual>0 && target>0)span.style.transform=`scaleX(${Math.min(3,Math.max(.2,target/actual))})`;
      }
    }catch(err){if(layer.dataset.page===key)status(err.message);}
  }
  function base(left,right) {
    ui.leftBase.classList.toggle('empty',left==null || mobile);
    ui.rightBase.classList.toggle('empty',right==null);
    setImg(ui.left,left);setImg(ui.right,right);
    updateText(ui.leftBase,left);updateText(ui.rightBase,right);
  }
  function renderFallback() {
    if(mode!=='css')return;
    if(mobile)base(null,current);
    else if(current===0)base(null,0);
    else base(current,current+1<TOTAL?current+1:null);
  }
  // 내장 페이지 말림 엔진: 28개 세그먼트를 각각 3D 회전하여
  // 모서리를 드래그할 때 굽어지는 곡면, 양면 이미지, 그림자를 표현합니다.
  function beginCurl(direction) {
    if(mode!=='css'||busy)return false;
    if(direction>0 && current>=(mobile?TOTAL-1:TOTAL-2))return false;
    if(direction<0 && current===0)return false;
    const from=current;let to,frontIndex,backIndex;
    if(mobile){
      to=clamp(from+direction);frontIndex=from;backIndex=to;
      base(null,to);
    } else if(direction>0){
      const oldRight=from===0?0:from+1;
      if(oldRight>=TOTAL-1)return false;
      to=oldRight+1;frontIndex=oldRight;backIndex=to;
      base(from===0?null:from,to+1<TOTAL?to+1:null);
    } else {
      to=from===1?0:from-2;
      frontIndex=from;backIndex=to===0?0:from-1;
      base(to===0?null:to,from+1<TOTAL?from+1:null);
      if(to===0)base(null,0);
    }
    const w=ui.book.clientWidth/(mobile?1:2);
    const h=ui.book.clientHeight;
    const stripWidth=w/STRIPS;
    ui.curl.replaceChildren();
    const frontUrl=SOURCE(frontIndex+1),backUrl=SOURCE(backIndex+1);
    const elements=[];
    for(let i=0;i<STRIPS;i++){
      const strip=document.createElement('div');strip.className='curl-strip';
      strip.style.width=`${stripWidth+0.85}px`;
      const face=document.createElement('div');face.className='curl-face curl-front';
      const reverse=document.createElement('div');reverse.className='curl-face curl-back';
      const fx=direction>0?i:STRIPS-1-i;
      const bx=direction>0?STRIPS-1-i:i;
      const bgSize=`${w}px ${h}px`;
      face.style.backgroundImage=`url("${frontUrl}")`;
      face.style.backgroundSize=bgSize;
      face.style.backgroundPosition=`${-fx*stripWidth}px 0px`;
      reverse.style.backgroundImage=`url("${backUrl}")`;
      reverse.style.backgroundSize=bgSize;
      reverse.style.backgroundPosition=`${-bx*stripWidth}px 0px`;
      strip.append(face,reverse);ui.curl.append(strip);elements.push(strip);
    }
    ui.curl.style.left=mobile?(direction>0?'0%':'100%'):'50%';
    ui.curl.style.width=`${w}px`;
    ui.curl.style.height=`${h}px`;
    ui.curl.classList.add('active');ui.book.classList.add('curl-active');
    busy=true;curling={from,to,direction,elements,w,stripWidth,progress:0};
    drawCurl(0);
    return true;
  }
  function setReceivingShade(book,direction,progress){
    const lift=Math.sin(Math.PI*progress);
    const strength=lift*lift*progress*.19;
    book.classList.toggle('receiving-left',strength>.001 && direction===0);
    book.classList.toggle('receiving-right',strength>.001 && direction===1);
    book.style.setProperty('--receiving-shade',String(strength));
    book.style.setProperty('--receiving-width',`${24+lift*44}%`);
  }
  function drawCurl(progress){
    if(!curling)return;
    const data=curling;data.progress=Math.max(0,Math.min(1,progress));
    let distance=0;
    for(let i=0;i<STRIPS;i++){
      const local=data.progress+.095*Math.sin(Math.PI*(i+.5)/STRIPS)*Math.sin(Math.PI*data.progress);
      const angle=Math.PI*Math.max(0,Math.min(1,local));
      const projected=data.stripWidth*Math.cos(angle);
      const x=data.direction>0?distance:-(distance+projected);
      const deg=angle*180/Math.PI*(data.direction>0?-1:1);
      const element=data.elements[i];
      element.style.transform=`translate3d(${x}px,0,0) rotateY(${deg}deg)`;
      element.style.setProperty('--curl-shadow',String(.08+.44*Math.sin(Math.PI*data.progress)));
      distance+=projected;
    }
    if(!mobile)setReceivingShade(ui.book,data.direction>0?0:1,data.progress);
    const lift=Math.sin(Math.PI*data.progress);
    const hinge=mobile?(data.direction>0?0:data.w):data.w;
    const edge=Math.max(0,Math.min(ui.book.clientWidth,hinge+data.direction*distance));
    ui.castShadow.style.left=`${edge}px`;
    ui.castShadow.style.width=`${Math.min(80,data.w*.19)*(0.30+lift*.70)}px`;
    ui.castShadow.style.opacity=String(lift*lift*.34);
  }
  function endCurl(commit){
    if(!curling)return;
    if(rafId)cancelAnimationFrame(rafId);
    const to=commit?curling.to:curling.from;
    curling=null;busy=false;
    ui.curl.classList.remove('active');ui.book.classList.remove('curl-active');setReceivingShade(ui.book,0,0);
    ui.curl.replaceChildren();current=clamp(to);renderFallback();updatePageIndicator();
  }
  function settleCurl(commit){
    if(!curling)return;
    const start=curling.progress,target=commit?1:0;
    const started=performance.now();
    function frame(time){
      if(!curling)return;
      const t=Math.min(1,(time-started)/Math.max(220,640*Math.abs(target-start)));
      const eased=t*t*(3-2*t);
      drawCurl(start+(target-start)*eased);
      if(t<1)rafId=requestAnimationFrame(frame);
      else endCurl(commit);
    }
    rafId=requestAnimationFrame(frame);
  }
  function animateFlip(direction){if(beginCurl(direction))settleCurl(true);}
  function setZoom(value,anchor){
    const oldBox=anchor && (mode==='st'?ui.root:ui.book).getBoundingClientRect();
    const point=oldBox && {
      x:(anchor.clientX-oldBox.left)/oldBox.width,
      y:(anchor.clientY-oldBox.top)/oldBox.height
    };
    const next=Math.round(Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,value))*100)/100;
    if(anchor && next===zoom)return;
    if(mode==='st' && next!==1){
      // 페이지 크기 확대 후에도 모서리 드래그 좌표를 정확히 유지하기 위해
      // 확대된 상태에서는 내장 3D 엔진을 사용합니다.
      lib.getRender().finishAnimation();
      const page=singlePage()?current:normalizeSpread(current);
      mode='css';current=page;
      ui.root.classList.add('pageflip-parked');ui.book.hidden=false;

    }
    if(busy)endCurl(false);
    zoom=next;
    panX=0;panY=0;
    ui.zoomReset.textContent=`${Math.round(zoom*100)}%`;
    ui.zoomOut.disabled=zoom<=MIN_ZOOM;ui.zoomIn.disabled=zoom>=MAX_ZOOM;
    if(zoom===1){
      selectTool(null);
      if(mode==='css' && lib){
        const page=current;
        ui.stage.classList.remove('zoomed');
        ui.book.hidden=true;
        ui.root.classList.remove('pageflip-parked');
        mode='st';
        fitViewer();
        jump(page);

        ui.hint.textContent='책 모서리를 넘기거나 마우스 휠로 페이지를 이동하세요.';
        return;
      }
    }
    if(mode==='css')fitFallback();
    if(point && zoom>1){
      const box=ui.book.getBoundingClientRect();
      panX=anchor.clientX-box.left-point.x*box.width;
      panY=anchor.clientY-box.top-point.y*box.height;
      applyPan();
    }
  }
  function next() {
    if(mode==='st') {lazyImages(clamp(current+5));lib.flipNext();}
    else animateFlip(1);
  }
  function prev() {
    if(mode==='st') {lazyImages(clamp(current-5));lib.flipPrev();}
    else animateFlip(-1);
  }
  function jump(index) {
    index=clamp(index);
    if(mode==='st') {lib.getRender().finishAnimation();lazyImages(index);lib.turnToPage(index);current=index;updatePageIndicator();}
    else {if(busy)endCurl(false);current=mobile?index:normalizeSpread(index);renderFallback();updatePageIndicator();}
  }
  function readRequestedPage() {
    const requested=Number(new URL(location.href).searchParams.get('page'));
    return Number.isInteger(requested)&&requested>=1&&requested<=TOTAL?requested-1:0;
  }
  function doJumpFromInput() {
    const n=Number(ui.pageNumber.value);
    if(!Number.isInteger(n)||n<1||n>TOTAL){status(`1부터 ${TOTAL} 사이의 페이지 번호를 입력해 주세요.`);ui.pageNumber.value=current+1;return;}
    jump(n-1);
  }
  function bind() {
    for(const [id,single] of [['singleView',true],['spreadView',false]]){
      $(id).addEventListener('click',()=>{
        const page=current;
        viewPreference=single;
        fitViewer();
        jump(page);
      });
    }
    for(const type of ['mousedown','touchstart']){
      ui.stage.addEventListener(type,event=>{
        if(activeTool && event.target.closest('.page'))event.stopPropagation();
      },true);
    }
    $('textTool').addEventListener('click',()=>selectTool(activeTool==='text'?null:'text'));
    window.addEventListener('studio-settings-change',e=>{textEnabled=e.detail.allowTextSelection; if(!textEnabled && activeTool==='text')selectTool(null);$('textTool').hidden=!textEnabled;});
    $('textTool').hidden=!textEnabled;
    for(const [id,tool] of [['magnifier','in'],['magnifierOut','out'],['handTool','hand']]){
      $(id).addEventListener('click',()=>selectTool(activeTool===tool?null:tool));
    }
    ui.stage.addEventListener('click',event=>{
      if((activeTool!=='in' && activeTool!=='out') || !event.target.closest('.base-page:not(.empty), .page'))return;
      event.stopPropagation();
      setZoom(zoom+(activeTool==='in'?.25:-.25),event);
    },true);
    for(const id of ['prevButton','stagePrev'])$(id).addEventListener('click',e=>{e.stopPropagation();prev();});
    for(const id of ['nextButton','stageNext'])$(id).addEventListener('click',e=>{e.stopPropagation();next();});
    $('firstButton').addEventListener('click',()=>jump(0));
    $('lastButton').addEventListener('click',()=>jump(TOTAL-1));
    $('jumpButton').addEventListener('click',doJumpFromInput);
    ui.zoomOut.addEventListener('click',()=>setZoom(zoom-.25));
    ui.zoomIn.addEventListener('click',()=>setZoom(zoom+.25));
    ui.zoomReset.addEventListener('click',()=>setZoom(1));
    ui.pageNumber.addEventListener('keydown',e=>{if(e.key==='Enter')doJumpFromInput();});
    ui.range.addEventListener('change',e=>jump(Number(e.target.value)-1));
    ui.tocToggle.addEventListener('click',()=>setToc(!ui.toc.classList.contains('open')));
    $('tocClose').addEventListener('click',()=>setToc(false));
    ui.backdrop.addEventListener('click',()=>setToc(false));
    $('fullPageButton').addEventListener('click',()=>window.open(SOURCE(current+1),'_blank','noopener,noreferrer'));
    $('fullscreenButton').addEventListener('click',async()=>{
      try {if(document.fullscreenElement)await document.exitFullscreen(); else await document.querySelector('.app').requestFullscreen();}
      catch {status('현재 브라우저나 홈페이지 설정에서 전체 화면을 사용할 수 없습니다.');}
    });
    $('shareButton').addEventListener('click',async()=>{
      try {await navigator.clipboard.writeText(window.location.href);status('현재 페이지 링크를 복사했습니다.');}
      catch {status('링크 복사를 지원하지 않는 환경입니다. 주소창 URL을 복사해 주세요.');}
    });
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'){setToc(false);selectTool(null);return;}
      if(e.target instanceof HTMLElement && (['INPUT','TEXTAREA','BUTTON'].includes(e.target.tagName) || e.target.isContentEditable))return;
      if(e.key==='ArrowRight'){e.preventDefault();next();}
      else if(e.key==='ArrowLeft'){e.preventDefault();prev();}
      else if(e.key==='Home'){e.preventDefault();jump(0);}
      else if(e.key==='End'){e.preventDefault();jump(TOTAL-1);}
      else if(e.key==='+' || e.key==='='){e.preventDefault();setZoom(zoom+.25);}
      else if(e.key==='-'){e.preventDefault();setZoom(zoom-.25);}
    });
    // 책의 바깥 위·아래 모서리를 잡으면 실제 굽힘을 실시간 추적합니다.
    let pointer=null,panPointer=null;
    ui.book.addEventListener('pointerdown',e=>{
      if(mode!=='css'||busy||(activeTool && activeTool!=='hand')||e.button!==0)return;
      const r=ui.book.getBoundingClientRect();
      const edge=Math.min(100,Math.max(45,r.width*(mobile?.16:.095)));
      const cornerH=Math.min(185,Math.max(75,r.height*.25));
      let direction=0;
      const nearCorner=e.clientY>=r.top&&e.clientY<=r.bottom&&
        (e.clientY<r.top+cornerH || e.clientY>r.bottom-cornerH);
      if(nearCorner && e.clientX>=r.right-edge&&e.clientX<=r.right)direction=1;
      else if(nearCorner && e.clientX>=r.left&&e.clientX<=r.left+edge)direction=-1;
      if(activeTool==='hand')direction=0;
      if(!direction && zoom>1){
        panPointer={id:e.pointerId,x:e.clientX,y:e.clientY,panX,panY};
        ui.book.setPointerCapture(e.pointerId);
        ui.book.classList.add('panning');e.preventDefault();return;
      }
      if(!direction||!beginCurl(direction))return;
      pointer={id:e.pointerId,x:e.clientX,y:e.clientY,rect:r,direction,moved:false};
      try{ui.book.setPointerCapture(e.pointerId);}catch{}
      e.preventDefault();
    });
    ui.book.addEventListener('pointermove',e=>{
      if(panPointer && panPointer.id===e.pointerId){
        panX=panPointer.panX+e.clientX-panPointer.x;
        panY=panPointer.panY+e.clientY-panPointer.y;
        applyPan();e.preventDefault();return;
      }
      if(!pointer||pointer.id!==e.pointerId||!curling)return;
      const dx=(pointer.x-e.clientX)*pointer.direction;
      const dy=Math.abs(pointer.y-e.clientY);
      if(Math.abs(dx)>6||dy>8)pointer.moved=true;
      const pw=pointer.rect.width/(mobile?1:2);
      drawCurl(Math.max(0,dx)/(pw*1.45));
      e.preventDefault();
    });
    function finishPointer(e,cancel){
      if(panPointer && panPointer.id===e.pointerId){
        panPointer=null;ui.book.classList.remove('panning');return;
      }
      if(!pointer||pointer.id!==e.pointerId)return;
      const wasMoved=pointer.moved;
      pointer=null;
      if(!curling)return;
      settleCurl(!cancel && (!wasMoved||curling.progress>.22));
    }
    ui.book.addEventListener('pointerup',e=>finishPointer(e,false));
    ui.book.addEventListener('pointercancel',e=>finishPointer(e,true));
    ui.book.addEventListener('lostpointercapture',e=>finishPointer(e,true));
    ui.book.addEventListener('dragstart',e=>e.preventDefault());
    let wheelDistance=0,wheelDirection=0,wheelHandled=false,wheelReset=0,lastWheelFlip=-Infinity;
    ui.stage.addEventListener('wheel',e=>{
      if(e.ctrlKey)return; // 브라우저의 Ctrl+휠 확대는 유지
      if(zoom>1 && mode==='css'){
        e.preventDefault();
        const unit=e.deltaMode===1?16:e.deltaMode===2?ui.stage.clientHeight:1;
        panX-=(e.shiftKey?e.deltaY:e.deltaX)*unit;
        panY-=(e.shiftKey?0:e.deltaY)*unit;
        applyPan();
        return;
      }
      if(e.shiftKey || Math.abs(e.deltaY)<Math.abs(e.deltaX) || !e.deltaY)return;
      e.preventDefault();
      const direction=Math.sign(e.deltaY);
      if(direction!==wheelDirection){wheelDistance=0;wheelDirection=direction;wheelHandled=false;}
      clearTimeout(wheelReset);
      wheelReset=setTimeout(()=>{wheelDistance=0;wheelDirection=0;wheelHandled=false;},220);
      if(wheelHandled || busy)return;
      const unit=e.deltaMode===1?16:e.deltaMode===2?ui.stage.clientHeight:1;
      wheelDistance+=Math.abs(e.deltaY)*unit;
      if(wheelDistance<65 || performance.now()-lastWheelFlip<750)return;
      wheelHandled=true;lastWheelFlip=performance.now();
      if(direction>0 && current<TOTAL-1)next();
      else if(direction<0 && current>0)prev();
    },{passive:false});
    window.addEventListener('resize',scheduleFit);
    document.addEventListener('fullscreenchange',scheduleFit);
    if(window.visualViewport)window.visualViewport.addEventListener('resize',scheduleFit);
    window.addEventListener('popstate',()=>jump(readRequestedPage()));
    if(window.ResizeObserver) new ResizeObserver(scheduleFit).observe(ui.stage);
  }
  function init() {
    document.querySelectorAll('.page-total').forEach(el=>el.textContent=`/ ${TOTAL.toLocaleString()}`);
    for(const el of [ui.pageNumber,ui.range])el.max=String(TOTAL);
    document.querySelector('.range-row span:last-child').textContent=String(TOTAL);
    chapterRender();bind();
    if(!initStPageFlip()){
      mode='css';current=readRequestedPage();
      ui.hint.textContent='책 모서리를 드래그하거나 마우스 휠로 넘기세요.';
      fitFallback();
      jump(current);
    }
  }
  init();
};
