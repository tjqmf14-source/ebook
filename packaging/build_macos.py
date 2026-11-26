"""Build a native .app and DMG on macOS; no cross compilation."""
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
if sys.platform != 'darwin':
    raise SystemExit('This build must run on macOS.')
runtime = ROOT / 'packaging/runtime'
runtime.mkdir(parents=True, exist_ok=True)
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 22+ is required on the build machine.')
shutil.copy2(node, runtime / 'node')
node_license = Path(node).resolve().parent.parent / 'LICENSE'
if not node_license.is_file():
    raise SystemExit('The bundled Node.js LICENSE file is missing.')
shutil.copy2(node_license, runtime / 'NODE-LICENSE.txt')
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
    '--windowed', '--name', 'Flipbook Studio', '--osx-bundle-identifier', 'com.tjqmf14.flipbookstudio',
    '--paths', str(ROOT), '--add-data', 'web:web',
    '--add-data', 'tools/render-epub.mjs:tools', '--add-binary', 'packaging/runtime/node:runtime',
    '--add-data', 'packaging/runtime/NODE-LICENSE.txt:runtime',
    '--collect-all', 'pymupdf', 'packaging/mac_launcher.py'], check=True)
app = ROOT / 'dist/Flipbook Studio.app'
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
stage = ROOT / 'dist/dmg-stage'
stage.mkdir(parents=True, exist_ok=False)
shutil.copytree(app, stage / app.name, symlinks=True)
(stage / 'Applications').symlink_to('/Applications', target_is_directory=True)
shutil.copy2(ROOT / 'packaging/INSTALL-MAC.txt', stage / '설치안내.txt')
architecture = 'AppleSilicon' if platform.machine() == 'arm64' else 'Intel'
dmg = ROOT / f'dist/FlipbookStudio-macOS-{architecture}.dmg'
subprocess.run(['hdiutil', 'create', '-volname', 'Flipbook Studio', '-srcfolder', str(stage),
                '-ov', '-format', 'UDZO', str(dmg)], check=True)
subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
print(dmg)
