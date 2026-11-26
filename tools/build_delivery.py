"""Build and structurally verify a static delivery ZIP for local QA."""
import json
from pathlib import Path
import sys
import zipfile
from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

source = Path(sys.argv[1]).resolve()
folder = Path(sys.argv[2]).resolve()
folder.mkdir(parents=True, exist_ok=True)
doc = dict(id='delivery-qa', dir=folder, path=source, name=source.stem,
           ext=source.suffix.lower(), state='loading', cropMarks=True)
server.prepare(doc)
assert doc['state'] == 'ready', doc.get('error')
config = server.settings()
config['title'] = source.stem
server.export_book(doc, config)
assert doc['exportState'] == 'ready', doc.get('exportError')
with zipfile.ZipFile(folder / 'flipbook.zip') as z:
    assert z.testzip() is None
    expected = ['index.html', '배포안내.txt', 'css/style.css', 'js/viewer.js',
                'js/export.js', 'js/page-flip.browser.js', 'StPageFlip-LICENSE.txt']
    assert all(p in z.namelist() for p in expected)
    assert len([p for p in z.namelist() if p.startswith('pages/')]) == doc['count']
    assert not any(p.endswith('.png') for p in z.namelist() if p.startswith('pages/'))
    for n in range(1, doc['count'] + 1):
        with z.open(f'pages/page_{n:04}.webp') as encoded, Image.open(encoded) as actual, Image.open(folder / f'page-{n}.png') as original:
            assert actual.format == 'WEBP'
            assert actual.size == original.size
            assert all(hi == 0 for lo, hi in ImageChops.difference(actual.convert('RGBA'), original.convert('RGBA')).getextrema())
    assert 'js/studio.js' not in z.read('index.html').decode()
    assert not any(p.endswith(('.pdf', '.epub')) for p in z.namelist())
    z.extractall(folder / 'unpacked')
print(json.dumps(dict(zip=str(folder / 'flipbook.zip'), pages=doc['count'], verified=True,
    png_bytes=sum(p.stat().st_size for p in folder.glob('page-*.png')),
    zip_bytes=(folder / 'flipbook.zip').stat().st_size, lossless_pixels_verified=True), ensure_ascii=False))
