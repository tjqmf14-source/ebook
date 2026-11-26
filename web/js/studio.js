(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let token, saved, draft, currentBook, importing=false;
  const defaultLogo='';
  function message(value){$('importStatus').textContent=value;}
  function apply(config){
    window.studioSettings=config;window.studioTitle=config.title;
    $('brandName').textContent=config.title;$('brandSubtitle').textContent=config.subtitle;
    $('brandLogo').hidden=!config.logo;
    if(config.logo)$('brandLogo').src=config.logo;else $('brandLogo').removeAttribute('src');
    document.documentElement.style.setProperty('--studio-header',config.headerColor);
    document.querySelector('meta[name="theme-color"]').content=config.headerColor;
    document.title=config.title;
    window.dispatchEvent(new CustomEvent('studio-settings-change',{detail:config}));
  }
  function form(config){
    $('titleInput').value=config.title;$('subtitleInput').value=config.subtitle;
    $('headerColor').value=config.headerColor;$('colorValue').textContent=config.headerColor;
    $('allowTextSelection').checked=config.allowTextSelection;
    $('cropMarks').checked=config.cropMarks;
    $('settingsError').textContent='';
  }
  function openSettings(){draft={...saved};form(draft);$('settingsPanel').hidden=false;$('settingsToggle').setAttribute('aria-expanded','true');$('titleInput').focus();}
  function closeSettings(commit=false){$('settingsPanel').hidden=true;$('settingsToggle').setAttribute('aria-expanded','false');if(!commit)apply(saved);$('settingsToggle').focus();}
  async function request(path,options={}){
    let response;
    try{response=await fetch(path,{...options,headers:{...(options.headers||{}),'X-Flipbook-Token':token}});}
    catch{throw Error('프로그램 서버 연결이 끊겼습니다. 플립북 폴더의 실행.cmd를 실행하고 새로 열린 창에서 파일을 선택해 주세요.');}
    const data=await response.json();if(!response.ok)throw Error(data.error||'요청에 실패했습니다.');return data;
  }
  async function connect(){
    if(location.protocol==='file:')throw Error('파일을 가져오려면 플립북 폴더의 실행.cmd를 실행하고 새로 열린 프로그램 창을 사용해 주세요.');
    const bootstrap=await request('/api/bootstrap');
    token=bootstrap.token;saved=bootstrap.settings;apply(saved);
  }
  async function importFile(file){
    if(!file||importing)return;
    if(!/\.(pdf|epub)$/i.test(file.name)){message('PDF 또는 EPUB 파일을 선택해 주세요.');return;}
    if(file.size>1024*1024*1024){message('1GB 이하의 파일을 선택해 주세요.');return;}
    importing=true;
    message(`${file.name} 가져오는 중…`);
    $('chooseFile').disabled=true;
    try{
      await connect();
      const created=await request('/api/import',{method:'POST',headers:{'X-Filename':encodeURIComponent(file.name),'X-Crop-Marks':window.studioSettings?.cropMarks?'1':'0'},body:file});
      let book;
      for(let i=0;i<120;i++){
        book=await request(`/api/book/${created.id}`);
        if(book.state==='ready')break;
        if(book.state==='error')throw Error(book.error);
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(book.state!=='ready')throw Error('파일 처리 시간이 초과되었습니다.');
      showBook(book);
    }catch(error){message(error.message);}
    finally{importing=false;$('chooseFile').disabled=false;$('fileInput').value='';}
  }
  function showBook(book){
    currentBook=book;
    $('emptyState').hidden=true;$('reader').hidden=false;
    $('exportBook').hidden=false;
    if(saved.title==='나의 플립북'){
      const copy={...saved,title:book.name};apply(copy);
    }
    window.startViewer(book);
    if(window.studioSettings.cropMarks){
      $('statusMessage').textContent=book.cropMethod==='trimbox'?'PDF 재단 영역을 적용했습니다.':book.cropMethod==='marks'?'사방 재단선을 감지해 잘랐습니다.':'재단 영역을 확인하지 못해 원본 크기로 표시합니다.';
    }
  }
  function bind(){
    $('chooseFile').onclick=()=>$('fileInput').click();
    $('fileInput').onchange=event=>importFile(event.target.files[0]);
    $('newBook').onclick=()=>location.assign('/');
    $('exportBook').onclick=async()=>{
      if(!currentBook)return;
      const button=$('exportBook');button.disabled=true;
      try{
        // Open while the click still has user activation, before generating the ZIP.
        let destination=null;
        const filename=`${currentBook.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')}-flipbook.zip`;
        if(typeof window.showSaveFilePicker==='function'){
          destination=await window.showSaveFilePicker({
            id:'flipbook-zip',startIn:'downloads',suggestedName:filename,
            types:[{description:'플립북 웹 배포 ZIP',accept:{'application/zip':['.zip']}}]
          });
        }
        button.textContent='ZIP 생성 중…';
        $('statusMessage').textContent='웹 배포 패키지를 생성하고 있습니다.';
        await request(`/api/export/${currentBook.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(window.studioSettings)});
        for(;;){
          await new Promise(resolve=>setTimeout(resolve,700));
          const state=await request(`/api/book/${currentBook.id}`);
          if(state.exportState==='error')throw Error(state.exportError||'ZIP 생성에 실패했습니다.');
          if(state.exportState==='ready')break;
          button.textContent=`ZIP 생성 ${state.exportProgress||0}/${currentBook.count}`;
        }
        if(destination){
          button.textContent='파일 저장 중…';
          const response=await fetch(`/api/download/${currentBook.id}`);
          if(!response.ok||!response.body)throw Error('ZIP 파일을 가져오지 못했습니다. 다시 저장해 주세요.');
          const writable=await destination.createWritable();
          await response.body.pipeTo(writable);
          $('statusMessage').textContent=`${destination.name} 저장 완료. 선택한 폴더를 확인해 주세요.`;
        }else{
          const a=document.createElement('a');a.href=`/api/download/${currentBook.id}`;a.download=filename;a.click();
          $('statusMessage').textContent='브라우저 다운로드를 시작했습니다. 저장 위치를 직접 선택하려면 실행.cmd로 Edge 또는 Chrome에서 열어 주세요.';
        }
      }catch(error){$('statusMessage').textContent=error.name==='AbortError'?'ZIP 저장을 취소했습니다.':`ZIP 저장 실패: ${error.message}`;}
      finally{button.textContent='ZIP 저장';button.disabled=false;}
    };
    const empty=$('emptyState');
    document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();empty.classList.add('drag-over');}});
    document.addEventListener('dragleave',event=>{if(!event.relatedTarget)empty.classList.remove('drag-over');});
    document.addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();empty.classList.remove('drag-over');if(currentBook){location.assign('/');return;}importFile(event.dataTransfer.files[0]);}});
    $('settingsToggle').onclick=openSettings;$('settingsClose').onclick=()=>closeSettings();$('settingsCancel').onclick=()=>closeSettings();
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('settingsPanel').hidden)closeSettings();});
    for(const [id,key] of [['titleInput','title'],['subtitleInput','subtitle'],['headerColor','headerColor']]){
      $(id).addEventListener('input',event=>{draft[key]=event.target.value;if(id==='headerColor')$('colorValue').textContent=draft[key];if(draft.title.trim())apply(draft);});
    }
    $('allowTextSelection').onchange=event=>{draft.allowTextSelection=event.target.checked;apply(draft);};
    $('cropMarks').onchange=event=>{draft.cropMarks=event.target.checked;apply(draft);};
    $('chooseLogo').onclick=()=>$('logoInput').click();
    $('clearLogo').onclick=()=>{draft.logo=defaultLogo;apply(draft);};
    $('logoInput').onchange=async event=>{
      const file=event.target.files[0];if(!file)return;
      if(file.type!=='image/png'||file.size>2_000_000){$('settingsError').textContent='2MB 이하 PNG를 선택해 주세요.';return;}
      const url=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file);});
      const image=new Image();image.onload=()=>{if(Math.max(image.width,image.height)>4096){$('settingsError').textContent='4096px 이하 PNG를 선택해 주세요.';return;}draft.logo=url;apply(draft);$('settingsError').textContent='';};
      image.onerror=()=>{$('settingsError').textContent='PNG 파일을 읽을 수 없습니다.';};image.src=url;
    };
    $('settingsSave').onclick=async()=>{
      $('settingsSave').disabled=true;
      try{saved=await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});apply(saved);closeSettings(true);}
      catch(error){$('settingsError').textContent=error.message;}
      finally{$('settingsSave').disabled=false;}
    };
  }
  async function init(){
    bind();
    try{await connect();}
    catch(error){message(error.message);}
  }
  init();
})();
