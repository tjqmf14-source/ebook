"""Local-only flipbook studio. Original documents are never modified."""
from __future__ import annotations
import argparse, base64, hashlib, io, json, os, posixpath, re, secrets, shutil, subprocess
import sys, threading, time, urllib.parse, uuid, zipfile
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET
import pymupdf as fitz
from PIL import Image
from cropmarks import detect_crop_marks
from toc import infer_front_toc, infer_split_column_toc

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ['FLIPBOOK_DATA_DIR']).expanduser() if os.environ.get('FLIPBOOK_DATA_DIR') else (
    Path.home() / 'Library/Application Support/Flipbook Studio' if sys.platform == 'darwin' else ROOT / '.data')
WEB = ROOT / 'web'
TOKEN = secrets.token_urlsafe(32)
DOCS = {}
ENGINE_LOCK = threading.Lock()  # MuPDF documents must not be used concurrently.
SETTINGS_LOCK = threading.Lock()
RENDERER = None
BASE = ''
MAX_UPLOAD = 1024 * 1024 * 1024
DEFAULTS = dict(title='나의 플립북', subtitle='WEB FLIPBOOK', headerColor='#172648',
                logo='', allowTextSelection=False, cropMarks=True)
fitz.TOOLS.mupdf_display_errors(False)
fitz.TOOLS.mupdf_display_warnings(False)


def browser_path():
    if sys.platform == 'darwin':
        candidates = [base / app / 'Contents/MacOS' / binary
                      for base in [Path('/Applications'), Path.home() / 'Applications']
                      for app, binary in [('Google Chrome.app','Google Chrome'), ('Microsoft Edge.app','Microsoft Edge')]]
    else:
        candidates = [Path(os.environ.get('PROGRAMFILES(X86)', '')) / 'Microsoft/Edge/Application/msedge.exe',
                      Path(os.environ.get('PROGRAMFILES', '')) / 'Google/Chrome/Application/chrome.exe']
    for p in candidates:
        if p.is_file(): return str(p)
    raise RuntimeError('Microsoft Edge 또는 Google Chrome을 찾을 수 없습니다.')


def safe_settings(raw):
    import re
    if not isinstance(raw, dict): raise ValueError('설정 형식이 올바르지 않습니다.')
    result = DEFAULTS.copy()
    for key, limit in [('title', 80), ('subtitle', 100)]:
        value = raw.get(key, result[key])
        if not isinstance(value, str) or len(value) > limit: raise ValueError('제목 길이를 확인해 주세요.')
        result[key] = value.strip()
    if not result['title']: raise ValueError('제목을 입력해 주세요.')
    color = raw.get('headerColor', result['headerColor'])
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color): raise ValueError('색상 코드가 올바르지 않습니다.')
    result['headerColor'] = color
    result['allowTextSelection'] = raw.get('allowTextSelection') is True
    result['cropMarks'] = raw.get('cropMarks') is True
    logo = raw.get('logo', '')
    if not isinstance(logo, str): raise ValueError('PNG 아이콘이 올바르지 않습니다.')
    if logo:
        if not logo.startswith('data:image/png;base64,') or len(logo) > 3_000_000: raise ValueError('PNG는 2MB 이하만 사용할 수 있습니다.')
        image = Image.open(io.BytesIO(base64.b64decode(logo.split(',', 1)[1], validate=True)))
        if image.format != 'PNG' or max(image.size) > 4096: raise ValueError('4096px 이하의 PNG를 사용해 주세요.')
        image.verify()
    result['logo'] = logo
    return result


def settings():
    try: return safe_settings(json.loads((DATA / 'settings.json').read_text('utf-8')))
    except (OSError, ValueError): return DEFAULTS.copy()


def epub_info(path):
    ns = {'o': 'http://www.idpf.org/2007/opf'}
    with zipfile.ZipFile(path) as z:
        entries = z.infolist()
        if len(entries) > 25000 or sum(i.file_size for i in entries) > 2 * MAX_UPLOAD:
            raise ValueError('EPUB 압축 해제 크기가 허용 범위를 초과합니다.')
        for info in entries:
            if info.file_size > 128 * 1024 * 1024 or info.flag_bits & 1:
                raise ValueError('암호화되었거나 너무 큰 EPUB 구성 파일입니다.')
        container = ET.fromstring(z.read('META-INF/container.xml'))
        opf = next(e.attrib['full-path'] for e in container.iter() if e.tag.endswith('rootfile'))
        root = ET.fromstring(z.read(opf))
        folder = posixpath.dirname(opf)
        items = {e.attrib['id']: posixpath.normpath(posixpath.join(folder, urllib.parse.unquote(e.attrib['href'])))
                 for e in root.findall('o:manifest/o:item', ns)}
        refs = root.findall('o:spine/o:itemref', ns)
        spine = [items[e.attrib['idref']] for e in refs if e.attrib.get('linear') != 'no']
        fixed = any(e.attrib.get('property') == 'rendition:layout' and e.text == 'pre-paginated' for e in root.iter())
        if not spine: raise ValueError('EPUB에서 읽을 페이지를 찾지 못했습니다.')
        if len(spine) > 10000: raise ValueError('최대 10,000쪽까지 지원합니다.')
        toc = []
        nav = next((e for e in root.findall('o:manifest/o:item', ns)
                    if 'nav' in e.attrib.get('properties', '').split()), None)
        if nav is not None:
            navpath = items[nav.attrib['id']]
            doc = ET.fromstring(z.read(navpath))
            tocnav = next((e for e in doc.iter() if e.tag.endswith('nav') and 'toc' in e.attrib.get('{http://www.idpf.org/2007/ops}type', '')), None)
            for e in (tocnav.iter() if tocnav is not None else []):
                if e.tag.endswith('}a') and e.attrib.get('href'):
                    dest = posixpath.normpath(posixpath.join(posixpath.dirname(navpath), urllib.parse.unquote(e.attrib['href'].split('#')[0])))
                    if dest in spine: toc.append([''.join(e.itertext()).strip(), spine.index(dest) + 1])
        if fixed and not toc:
            cache = {}
            rows_cache = {}
            def rows_at(page):
                if page not in rows_cache:
                    document = ET.fromstring(z.read(spine[page - 1]))
                    rows_cache[page] = [(re.sub(r'\s+', ' ', ''.join(e.itertext())).strip(), e.attrib.get('class',''))
                                        for e in document.iter() if e.tag.endswith(('}p', '}h1', '}h2', '}h3'))]
                return rows_cache[page]
            def spine_text(page):
                if page not in cache:
                    cache[page] = '\n'.join(text for text, _ in rows_at(page))
                return cache[page]
            toc = infer_front_toc(len(spine), spine_text, max_front_pages=120)
            if not toc:
                toc = infer_split_column_toc(len(spine), rows_at, spine_text)
        return fixed, spine, toc


def prepare(doc):
    try:
        with ENGINE_LOCK:
            if doc['ext'] == '.epub':
                fixed, spine, toc = epub_info(doc['path'])
            else: fixed, spine, toc = False, [], []
            if fixed:
                doc.update(kind='fixed', spine=spine, toc=toc, count=len(spine), ratio=609 / 822)
            else:
                pdf = fitz.open(doc['path'])
                if pdf.needs_pass:
                    pdf.close(); raise ValueError('암호가 걸린 PDF입니다. 암호를 해제한 사본을 넣어 주세요.')
                if pdf.is_reflowable: pdf.layout(width=609, height=822, fontsize=12)
                if not 0 < pdf.page_count <= 10000:
                    pdf.close(); raise ValueError('1~10,000쪽 문서를 사용해 주세요.')
                toc = [[t[1], t[2]] for t in pdf.get_toc() if 1 <= t[2] <= pdf.page_count]
                if not toc:
                    cache = {}
                    def page_text(number):
                        if number not in cache:
                            cache[number] = pdf.load_page(number - 1).get_text('text', sort=True)
                        return cache[number]
                    toc = infer_front_toc(pdf.page_count, page_text)
                rect = pdf.load_page(0).rect
                doc.update(kind='mupdf', pdf=pdf, count=pdf.page_count, toc=toc, ratio=rect.width / rect.height)
            doc['sourceRatio'] = doc['ratio']
        if doc['cropMarks']:
            image, _ = render(doc, 1)
            with Image.open(image) as preview:
                doc['ratio'] = preview.width / preview.height
        doc['state'] = 'ready'
    except Exception as exc:
        doc.update(state='error', error=str(exc)[:300] or '파일을 읽을 수 없습니다.')


def render(doc, number):
    global RENDERER
    out = doc['dir'] / f'page-{number}.png'
    txt = doc['dir'] / f'page-{number}.json'
    with ENGINE_LOCK:
        if out.is_file() and txt.is_file(): return out, txt
        if doc['kind'] == 'fixed':
            if RENDERER is None or RENDERER.poll() is not None:
                bundled_node = ROOT / 'runtime/node'
                node = str(bundled_node) if bundled_node.is_file() else shutil.which('node')
                if not node: raise RuntimeError('고정 지면 EPUB에는 Node.js가 필요합니다.')
                RENDERER = subprocess.Popen([node, str(ROOT / 'tools/render-epub.mjs'), browser_path(), str(DATA / 'renderer'), BASE],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(DATA / 'renderer.log').open('a', encoding='utf-8'),
                    text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            payload = dict(url=f"{BASE}/render/{doc['id']}/{urllib.parse.quote(doc['spine'][number-1])}", output=str(out), text=str(txt))
            RENDERER.stdin.write(json.dumps(payload) + '\n'); RENDERER.stdin.flush()
            reply = RENDERER.stdout.readline()
            if not reply: raise RuntimeError('EPUB 렌더러가 종료되었습니다. 파일을 다시 열어 주세요.')
            result = json.loads(reply)
            if not result.get('ok'): raise RuntimeError(result.get('error', 'EPUB 페이지 변환 실패'))
        else:
            page = doc['pdf'].load_page(number - 1)
            rect = page.rect
            # All pages share the cover's aspect ratio; mixed sizes are letterboxed.
            width, height = 1218, round(1218 / doc['sourceRatio'])
            scale = min(width / rect.width, height / rect.height, 3)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            canvas = Image.new('RGB', (width, height), 'white')
            bitmap = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
            ox, oy = (width - pix.width) // 2, (height - pix.height) // 2
            canvas.paste(bitmap, (ox, oy)); canvas.save(out, 'PNG')
            trim_pixels = None
            if doc['cropMarks']:
                trim = page.trimbox
                crop = page.cropbox
                inset = max(abs(trim.x0-crop.x0), abs(trim.y0-crop.y0),
                            abs(crop.x1-trim.x1), abs(crop.y1-trim.y1))
                if (inset > min(crop.width, crop.height) * .005
                    and crop.contains(trim) and trim.width > crop.width * .65
                    and trim.height > crop.height * .65):
                    local = fitz.Rect(trim.x0-crop.x0, trim.y0-crop.y0,
                                      trim.x1-crop.x0, trim.y1-crop.y0) * page.rotation_matrix
                    trim_pixels = (round(ox + local.x0*scale), round(oy + local.y0*scale),
                                   round(ox + local.x1*scale), round(oy + local.y1*scale))
            words = []
            for word in page.get_text('words', sort=True):
                r = fitz.Rect(word[:4]) * page.rotation_matrix
                words.append([word[4], (ox+r.x0*scale)/width, (oy+r.y0*scale)/height,
                              r.width*scale/width, r.height*scale/height])
            txt.write_text(json.dumps(words, ensure_ascii=False), 'utf-8')
        if doc['cropMarks']:
            with Image.open(out) as source:
                image = source.convert('RGB')
            rect = trim_pixels if doc['kind'] == 'mupdf' and trim_pixels else detect_crop_marks(image)
            if number == 1:
                doc['cropMethod'] = 'trimbox' if doc['kind'] == 'mupdf' and trim_pixels else ('marks' if rect else 'none')
            if rect:
                original_width, original_height = image.size
                image = image.crop(rect)
                words = json.loads(txt.read_text('utf-8'))
                left, top, right, bottom = rect
                remapped = []
                for value, x, y, w, h in words:
                    px, py, pw, ph = x * original_width, y * original_height, w * original_width, h * original_height
                    if px + pw <= left or py + ph <= top or px >= right or py >= bottom:
                        continue
                    remapped.append([value, (px-left)/image.width, (py-top)/image.height,
                                     pw/image.width, ph/image.height])
                txt.write_text(json.dumps(remapped, ensure_ascii=False), 'utf-8')
                image.save(out, 'PNG')
    return out, txt


def export_book(doc, config):
    """Build a self-contained HTML flipbook ZIP without exposing the source file."""
    try:
        destination = doc['dir'] / 'flipbook.zip'
        temp = doc['dir'] / 'flipbook.zip.tmp'
        index = (WEB / 'index.html').read_text('utf-8')
        index = index.replace('<script src="js/studio.js" defer></script>', '<script src="js/export.js" defer></script>')
        index = index.replace('<section class="reader" id="reader" aria-label="웹 전자책 뷰어" hidden>',
                              '<section class="reader" id="reader" aria-label="웹 전자책 뷰어">')
        index = index.replace('<section id="emptyState"', '<section id="emptyState" hidden')
        index = index.replace('<button id="newBook"', '<button id="newBook" hidden').replace('<button id="settingsToggle"', '<button id="settingsToggle" hidden').replace('<button id="exportBook"', '<button id="exportBook" hidden')
        index = index.replace('<title>플립북 스튜디오</title>', '<title>' + html.escape(config['title']) + '</title>')
        index = index.replace('<footer>플립북 스튜디오 · 파일을 열면 이 컴퓨터에서 처리합니다.</footer>', '<footer>WEB FLIPBOOK</footer>')
        # This inline notice also works when Windows opens only index.html from a ZIP.
        notice = ('<div id="packageNotice" role="alert" style="padding:20px;background:#fff4d6;color:#332800;font:16px/1.7 sans-serif">'
                  '<strong>플립북 구성 파일을 불러오는 중입니다.</strong><br>'
                  '이 안내가 계속 보이면 ZIP 파일 전체를 먼저 압축 해제한 뒤 index.html을 열어 주세요. '
                  'index.html과 css, js, pages 폴더가 같은 위치에 있어야 합니다. '
                  '웹관리자는 ZIP 안의 배포안내.txt를 확인해 주세요.</div>')
        index = index.replace('<body>', '<body>' + notice)
        book = {k:doc[k] for k in ['id','name','count','ratio','toc']}
        book['static'] = True
        book['imageFormat'] = 'webp'
        script = 'window.studioSettings=' + json.dumps(config,ensure_ascii=False) + ';\n'
        script += 'window.studioTitle=window.studioSettings.title;\n'
        script += 'window.FLIPBOOK_TEXT='  # JSON object is written after all pages are rendered.
        texts = {}
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
            for n in range(1,doc['count']+1):
                image, text = render(doc,n)
                # Lossless WebP preserves small type and artwork pixel-for-pixel.
                with Image.open(image) as page_image:
                    encoded = io.BytesIO()
                    page_image.save(encoded, format='WEBP', lossless=True, method=4, exact=True)
                    z.writestr(f'pages/page_{n:04}.webp', encoded.getvalue(), compress_type=zipfile.ZIP_STORED)
                texts[str(n)] = json.loads(text.read_text('utf-8'))
                doc['exportProgress'] = n
            z.writestr('index.html', index)
            z.writestr('배포안내.txt', ('웹관리자 전달용 E-book 배포 패키지\n\n'
                '도서: ' + config['title'] + '\n페이지 수: ' + str(doc['count']) + '\n\n'
                '1. ZIP 파일 전체를 압축 해제합니다. ZIP 안에서 index.html만 실행하면 안 됩니다.\n'
                '2. index.html, css/, js/, pages/ 및 라이선스 파일을 같은 구조로 서버에 업로드합니다.\n'
                '   예: 홈페이지 /ebook/도서명/ 폴더에 압축 해제한 내용물을 업로드합니다.\n'
                '3. 홈페이지에 /ebook/도서명/index.html 링크를 추가합니다.\n'
                '4. 해당 주소에서 지면, 목차, 페이지 넘김, 확대 기능을 확인합니다.\n\n'
                '별도 Python, Node.js, 데이터베이스, API 서버 또는 외부 CDN은 필요하지 않습니다.\n'
                '서버는 .html, .css, .js, .webp 정적 파일 제공을 허용해야 합니다.\n'
                '페이지 이미지는 무손실 WebP입니다. .webp의 MIME 형식은 image/webp입니다.\n'
                '원본 PDF/EPUB은 포함되지 않으며 페이지 이미지와 뷰어 설정이 포함됩니다.\n'
                '원본 보기 버튼은 해당 페이지 이미지를 엽니다.\n'
                '로컬 검수: 압축 해제한 폴더의 index.html을 Edge 또는 Chrome에서 엽니다.\n'
                '구성 파일 누락 시 압축을 다시 풀고 css/, js/, pages/ 폴더 유무를 확인합니다.\n').encode('utf-8-sig'))
            z.write(WEB/'css/style.css','css/style.css')
            z.write(WEB/'js/viewer.js','js/viewer.js')
            z.write(WEB/'js/page-flip.browser.js','js/page-flip.browser.js')
            z.write(WEB/'StPageFlip-LICENSE.txt','StPageFlip-LICENSE.txt')
            script += json.dumps(texts,ensure_ascii=False) + ';\n'
            script += 'document.getElementById("brandName").textContent=window.studioTitle;\n'
            script += 'document.getElementById("brandSubtitle").textContent=window.studioSettings.subtitle;\n'
            script += 'document.documentElement.style.setProperty("--studio-header",window.studioSettings.headerColor);\n'
            script += 'document.getElementById("brandLogo").hidden=!window.studioSettings.logo;\n'
            script += 'if(window.studioSettings.logo)document.getElementById("brandLogo").src=window.studioSettings.logo;\n'
            script += 'window.startViewer(' + json.dumps(book,ensure_ascii=False) + ');\n'
            script += 'document.title=window.studioTitle;\n'
            script += 'document.getElementById("packageNotice").hidden=true;\n'
            z.writestr('js/export.js',script)
        temp.replace(destination)
        doc['exportState'] = 'ready'
    except Exception as exc:
        doc['exportState'] = 'error';doc['exportError'] = str(exc)[:300]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def response(self, data, status=200, mime='application/json; charset=utf-8'):
        if isinstance(data, (dict, list)): data = json.dumps(data, ensure_ascii=False).encode()
        if isinstance(data, str): data = data.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'")
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass

    def authorized_host(self):
        return self.headers.get('Host') == urllib.parse.urlsplit(BASE).netloc

    def do_GET(self):
        if not self.authorized_host(): return self.response({'error':'Invalid host'},403)
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        try:
            if path == '/api/bootstrap': return self.response(dict(token=TOKEN, settings=settings()))
            parts = path.strip('/').split('/')
            if len(parts) == 3 and parts[:2] == ['api', 'book']:
                d = DOCS[parts[2]]
                return self.response({k:v for k,v in d.items() if k in ['id','state','error','name','count','ratio','toc','cropMethod','exportState','exportError','exportProgress']})
            if len(parts) == 3 and parts[:2] == ['api', 'download']:
                d = DOCS[parts[2]]
                if d.get('exportState') != 'ready': raise KeyError()
                p = d['dir']/'flipbook.zip'
                self.send_response(200)
                self.send_header('Content-Type','application/zip')
                self.send_header('Content-Disposition',"attachment; filename*=UTF-8''" + urllib.parse.quote(d['name'] + '-flipbook.zip'))
                self.send_header('Content-Length',str(p.stat().st_size))
                self.end_headers()
                with p.open('rb') as f: shutil.copyfileobj(f,self.wfile)
                return
            if len(parts) == 4 and parts[0] == 'book':
                d = DOCS[parts[1]]; n = int(parts[2])
                if d['state'] != 'ready' or not 1 <= n <= d['count']: raise ValueError('페이지 범위를 벗어났습니다.')
                if parts[3] not in ['image','text']: raise KeyError()
                image, text = render(d,n)
                p, mime = (image,'image/png') if parts[3]=='image' else (text,'application/json; charset=utf-8')
                return self.response(p.read_bytes(),mime=mime)
            if len(parts) >= 3 and parts[0] == 'render':
                d = DOCS[parts[1]]; entry = '/'.join(parts[2:])
                if d.get('kind') != 'fixed' or '..' in parts: raise KeyError()
                with zipfile.ZipFile(d['path']) as z: raw = z.read(entry)
                ext = posixpath.splitext(entry)[1].lower()
                mime = {'.xhtml':'text/html; charset=utf-8','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
                        '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml',
                        '.otf':'font/otf','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2'}.get(ext,'application/octet-stream')
                # CSP on EPUB resources blocks scripts, external network and active embeds.
                self.send_response(200); self.send_header('Content-Type',mime)
                self.send_header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
                self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw); return
            if path == '/': path = '/index.html'
            p = (WEB / path.lstrip('/')).resolve()
            if not p.is_relative_to(WEB) or not p.is_file(): raise KeyError()
            mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8', '.txt':'text/plain; charset=utf-8'}.get(p.suffix,'application/octet-stream')
            return self.response(p.read_bytes(),mime=mime)
        except (KeyError, FileNotFoundError): return self.response({'error':'찾을 수 없는 파일입니다.'},404)
        except Exception as exc: return self.response({'error':str(exc)[:300]},400)

    def do_POST(self):
        if not self.authorized_host() or self.headers.get('X-Flipbook-Token') != TOKEN:
            return self.response({'error':'요청을 허용할 수 없습니다.'},403)
        if self.headers.get('Origin',BASE) != BASE: return self.response({'error':'Invalid origin'},403)
        try:
            size = int(self.headers.get('Content-Length','0'))
            if self.path == '/api/settings':
                if not 0 < size <= 3_100_000: raise ValueError('설정 파일이 너무 큽니다.')
                cfg = safe_settings(json.loads(self.rfile.read(size)))
                with SETTINGS_LOCK:
                    tmp = DATA / 'settings.tmp'; tmp.write_text(json.dumps(cfg, ensure_ascii=False),'utf-8')
                    tmp.replace(DATA / 'settings.json')
                return self.response(cfg)
            if self.path.startswith('/api/export/'):
                ident = self.path.removeprefix('/api/export/')
                d = DOCS[ident]
                if d.get('state') != 'ready': raise ValueError('문서가 준비되지 않았습니다.')
                if d.get('exportState') == 'running': return self.response({'state':'running'})
                if not 0 < size <= 3_100_000: raise ValueError('설정 형식이 올바르지 않습니다.')
                cfg = safe_settings(json.loads(self.rfile.read(size)))
                d['exportState']='running';d['exportProgress']=0
                threading.Thread(target=export_book,args=(d,cfg),daemon=True).start()
                return self.response({'state':'running'})
            if self.path != '/api/import': return self.response({'error':'Not found'},404)
            name = Path(urllib.parse.unquote(self.headers.get('X-Filename',''))).name
            ext = Path(name).suffix.lower()
            if ext not in ['.pdf','.epub']: raise ValueError('PDF 또는 EPUB 파일을 넣어 주세요.')
            if not 0 < size <= MAX_UPLOAD: raise ValueError('파일은 1GB 이하만 지원합니다.')
            ident = uuid.uuid4().hex; folder = DATA / 'books' / ident; folder.mkdir(parents=True)
            source = folder / ('source' + ext)
            remaining = size
            with source.open('wb') as f:
                while remaining:
                    chunk = self.rfile.read(min(1024*1024,remaining))
                    if not chunk: raise ValueError('파일 전송이 중단되었습니다.')
                    f.write(chunk); remaining -= len(chunk)
            doc = dict(id=ident,dir=folder,path=source,name=Path(name).stem,ext=ext,state='loading',
                       cropMarks=self.headers.get('X-Crop-Marks') == '1')
            DOCS[ident] = doc
            threading.Thread(target=prepare,args=(doc,),daemon=True).start()
            return self.response({'id':ident})
        except Exception as exc: return self.response({'error':str(exc)[:300]},400)


def main():
    global BASE
    parser=argparse.ArgumentParser();parser.add_argument('--open',action='store_true');parser.add_argument('--no-open',action='store_true');parser.add_argument('--port',type=int,default=0)
    args=parser.parse_args(); DATA.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    BASE=f'http://127.0.0.1:{server.server_port}'
    (DATA/'server.json').write_text(json.dumps({'url':BASE,'pid':os.getpid()}),'utf-8')
    if args.open and not args.no_open:
        window = subprocess.Popen([browser_path(),f'--app={BASE}',f'--user-data-dir={DATA / "window-profile"}', '--no-first-run','--window-size=1440,1000'])
        if getattr(sys,'frozen',False) and sys.platform == 'darwin':
            def close_with_window():
                window.wait()
                server.shutdown()
            threading.Thread(target=close_with_window,daemon=True).start()
    print(BASE,flush=True)
    try: server.serve_forever()
    finally:
        server.server_close()
        if RENDERER and RENDERER.poll() is None: RENDERER.stdin.close(); RENDERER.wait(timeout=15)

if __name__=='__main__': main()
