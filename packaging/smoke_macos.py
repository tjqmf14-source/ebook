"""Test the executable mounted from the read-only DMG, with no external Node."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
import signal

import pymupdf as fitz
from PIL import Image

def run(executable):
    with tempfile.TemporaryDirectory(prefix='flipbook-smoke-') as temp:
        data = Path(temp) / 'data'
        env = dict(os.environ, FLIPBOOK_DATA_DIR=str(data), FLIPBOOK_DEBUG='1', PATH='/usr/bin:/bin:/usr/sbin:/sbin')
        process = subprocess.Popen([executable, '--no-open'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            for _ in range(120):
                if process.poll() is not None:
                    raise RuntimeError(process.stdout.read().decode(errors='replace'))
                if (data / 'server.json').exists(): break
                time.sleep(.5)
            base = json.loads((data / 'server.json').read_text())['url']
            with urllib.request.urlopen(base + '/api/bootstrap') as response:
                bootstrap = json.load(response)
            def request(path, payload=None, headers=None):
                with urllib.request.urlopen(urllib.request.Request(base + path, data=payload,
                     headers={'X-Flipbook-Token': bootstrap['token'], **(headers or {})}), timeout=120) as response:
                    return response.read()
            with fitz.open() as doc:
                for i in range(2): doc.new_page().insert_text((60,60), f'Native Mac page {i+1}')
                pdf = doc.tobytes()
            epub = io.BytesIO()
            with zipfile.ZipFile(epub,'w') as z:
                z.writestr('mimetype','application/epub+zip')
                z.writestr('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
                z.writestr('content.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="p" href="page.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="p"/></spine></package>')
                z.writestr('page.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="viewport" content="width=609,height=822"/></head><body><p style="position:absolute;left:60px;top:60px">Native EPUB text</p></body></html>')
            for extension, payload, count in [('pdf', pdf, 2), ('epub', epub.getvalue(), 1)]:
                ident = json.loads(request('/api/import',payload,{'X-Filename':f'smoke.{extension}'}))['id']
                for _ in range(120):
                    state = json.loads(request('/api/book/' + ident))
                    if state['state'] == 'error': raise AssertionError(state)
                    if state['state'] == 'ready': break
                    time.sleep(.5)
                assert state['state'] == 'ready' and state['count'] == count, state
                request('/api/export/' + ident,json.dumps(bootstrap['settings']).encode(),{'Content-Type':'application/json'})
                for _ in range(240):
                    state=json.loads(request('/api/book/' + ident))
                    if state.get('exportState') == 'error': raise AssertionError(state)
                    if state.get('exportState') == 'ready': break
                    time.sleep(.5)
                assert state.get('exportState') == 'ready', state
                with zipfile.ZipFile(io.BytesIO(request('/api/download/' + ident))) as z:
                    assert z.testzip() is None
                    assert Image.open(z.open('pages/page_0001.webp')).format == 'WEBP'
                    assert 'js/export.js' in z.namelist()
                print(f'PASS mounted app: {extension} import and WebP ZIP export, no external Python/Node runtime')
        finally:
            process.terminate()
            try: process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.send_signal(signal.SIGUSR1)
                time.sleep(1)
                print('Shutdown timeout process tree:')
                listing=subprocess.check_output(['ps','-ax','-o','pid,ppid,command'],text=True)
                print('\n'.join(line for line in listing.splitlines() if str(data) in line or 'Flipbook Studio.app' in line))
                process.kill(); process.wait()
                print(process.stdout.read().decode(errors='replace'))
                raise AssertionError('Packaged process did not stop gracefully')
            print(process.stdout.read().decode(errors='replace'))

if __name__ == '__main__': run(sys.argv[1])
