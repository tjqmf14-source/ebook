"""Finder entry point. Keep resources read-only and logs in Application Support."""
import os
from pathlib import Path
import subprocess
import sys
import traceback
import signal
import faulthandler

data = Path(os.environ.get('FLIPBOOK_DATA_DIR', Path.home() / 'Library/Application Support/Flipbook Studio'))
data.mkdir(parents=True, exist_ok=True)
if sys.stdout is None:
    sys.stdout = (data / 'application.log').open('a', encoding='utf-8', buffering=1)
if sys.stderr is None:
    sys.stderr = sys.stdout
if os.environ.get('FLIPBOOK_DEBUG') == '1':
    faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)

try:
    import server
    if '--no-open' not in sys.argv:
        sys.argv.append('--open')
    server.main()
except Exception:
    traceback.print_exc()
    # Pass text as argv, never interpolate file paths into AppleScript code.
    if '--no-open' not in sys.argv:
        subprocess.run(['osascript', '-e', 'on run argv', '-e',
                        'display alert "Flipbook Studio" message (item 1 of argv) as critical',
                        '-e', 'end run',
                        '프로그램을 시작하지 못했습니다. Google Chrome 또는 Microsoft Edge 설치 여부를 확인해 주세요.\n로그: ' + str(data / 'application.log')], check=False)
    raise
