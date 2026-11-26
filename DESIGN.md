# 플립북 스튜디오 현재 설계

## 목적

Windows에서 PDF 또는 EPUB을 가져와 내용을 검수하고, 대학교·공공기관 웹관리자에게 전달할 정적 E-book ZIP을 만든다. 원본 문서는 수정하지 않는다.

## 구성

- `실행.cmd`: Python 서버와 Edge/Chrome 독립 창 실행.
- `server.py`: 루프백 HTTP API, 문서 처리, 이미지·텍스트 추출, 설정 저장, ZIP 생성.
- `cropmarks.py`: 인쇄물의 사방 재단선 감지.
- `toc.py`: 앞쪽 목차 페이지를 분석해 제목과 실제 본문 위치 대조.
- `tools/render-epub.mjs`: 고정 지면 EPUB의 브라우저 렌더링과 텍스트 위치 추출.
- `web/js/studio.js`: 파일 선택·드롭, 외형 설정, 저장 위치 선택 및 ZIP 저장.
- `web/js/viewer.js`: StPageFlip 및 CSS 페이지 넘김, 목차, 확대·이동, 텍스트 선택.

## 제작 흐름

1. 루프백 서버에서 세션 토큰과 저장된 설정을 읽는다.
2. 파일을 선택하거나 드롭하면 `.data/books/`에 원본 사본을 보관한다.
3. PDF 책갈피·EPUB 내장 목차를 우선 사용하고, 없으면 앞쪽 목차 페이지 분석을 시도한다.
4. 자동 크롭은 PDF TrimBox 또는 확인 가능한 사방 재단선을 적용하며, 불확실하면 원본 영역을 유지한다.
5. 지면 이미지와 텍스트를 불러와 뷰어에서 확인한다.
6. ZIP 저장 클릭 시 지원 브라우저의 저장 창에서 폴더와 파일 이름을 선택한다. 취소 시 생성을 시작하지 않는다.
7. 전체 지면을 무손실 WebP로 변환해 패키지를 만들고 선택한 파일로 스트리밍한다.

## 뷰어 기능

- 제목·보조 제목·헤더 색상·투명 PNG 로고 설정.
- 본문 텍스트 선택 허용 여부 설정.
- 한쪽/두쪽 보기, 목차, 페이지 번호·슬라이더·처음/마지막 이동.
- 기본 배율에서 세로 휠로 페이지 넘김. 연속 입력과 관성 입력의 중복 넘김 억제.
- 확대 상태의 드래그·휠 이동, 원본 지면 이미지 열기, 전체 화면, 링크 복사.
- 기존 PNG 정적 패키지를 위한 이미지 경로 호환 처리.

## 웹관리자 전달 패키지

```text
index.html
css/style.css
js/viewer.js
js/page-flip.browser.js
js/export.js
pages/page_0001.webp ...
배포안내.txt
StPageFlip-LICENSE.txt
```

`export.js`는 뷰어 설정, 페이지 수·비율·목차, 추출된 텍스트를 포함한다. 본문 페이지는 무손실 WebP이며 로고는 설정에 포함된 PNG일 수 있다. 제작 UI와 원본 PDF/EPUB은 배포 기능에서 제외한다.

관리자는 ZIP 전체를 압축 해제해 폴더 구조 그대로 웹서버에 업로드하고 `index.html`을 연결한다. 별도 Python·Node.js·DB·외부 CDN 없이 열람할 수 있다. 서버는 `.webp`를 `image/webp`로 제공해야 한다. `index.html`만 열려 구성 파일이 누락되면 압축 해제 안내를 표시한다.

## 로컬 데이터와 접근 범위

서버는 `127.0.0.1`에만 연결한다. 변경 API는 Host, Origin 및 세션 토큰을 확인한다. EPUB 리소스는 스크립트·외부 네트워크 접근을 차단한 상태로 렌더링한다. 원본 사본·설정·브라우저 프로필·생성 파일은 `.data/`와 `output/`에 두며 Git에서 제외한다.

## 검증과 현재 한계

- `tools/test_cropmarks.py`: 외곽 재단선과 내부 장식 오탐 회귀 검사.
- `tools/build_delivery.py`: ZIP 구조, 실제 WebP 형식, 페이지 수 및 PNG와의 픽셀 일치 확인.
- `tools/test_delivery.mjs`: 압축 해제본의 로컬·웹 하위 경로 실행, CSS·이미지·목차·휠·제작 버튼 숨김 확인.
- `tools/test_import.mjs`: 연결 실패 안내와 파일 선택 재시도 확인.
- `tools/test_save.mjs`: 저장 창 API를 대체한 자동검증으로 취소·스트리밍 ZIP·쓰기 실패·생성 실패 확인.
- `tools/test_wheel.mjs`: 휠 이동·연속 입력 억제·확대 이동·WebP ZIP 확인.

브라우저 자동검증 도구는 현재 개발 PC의 Playwright 캐시와 Edge 경로를 사용하므로 다른 PC에서는 해당 경로 조정이 필요하다. 제작 프로그램의 런타임 의존성은 `requirements.txt`를 따른다. 고정 지면 EPUB 렌더러는 Node.js의 내장 WebSocket 사용을 위해 Node.js 22 이상을 권장한다.

실제 Windows 저장 창에서 위치를 선택해 저장을 끝내는 수동 검수는 미완료다. 기관의 실제 CMS·서버 배포는 검증하지 않았다. 스캔 이미지의 OCR은 제공하지 않으며, 실제 텍스트가 없는 목차는 자동 분석하지 못할 수 있다. UI에서 파일 등록 상태 확인은 최대 약 60초 대기하므로 큰 문서는 제한에 걸릴 수 있다.

## 복구

소스 변경은 Git 이력으로 추적한다. 실행 중인 프로그램은 메모리에 로드한 서버 코드를 사용하므로 업데이트 후 다시 실행한다. 기존 배포 ZIP은 자동 변경되지 않으며 새 버전이 필요하면 다시 생성한다.

## macOS 패키징

`packaging/build_macos.py`는 macOS에서 PyInstaller로 Python·필수 라이브러리·Node 실행파일·뷰어 리소스를 묶어 `.app`과 DMG를 만든다. Windows에서 macOS 바이너리를 교차 빌드하지 않는다. GitHub Actions에서 Apple Silicon/Intel 아키텍처를 각각 빌드하며 DMG 검증, 번들 코드서명 검증, 읽기 전용 DMG에서 PDF·고정 지면 EPUB의 WebP ZIP 생성을 실행한다.

Mac 앱은 `/Applications` 또는 사용자 `Applications`의 Chrome/Edge를 사용한다. 앱 폴더에 데이터를 쓰지 않고 사용자 `Library/Application Support/Flipbook Studio`에 저장한다. 앱 전용 브라우저 프로세스가 종료되면 패키지 서버를 종료한다. 빌드의 코드는 ad-hoc 서명이며 Apple Developer ID 인증서·Apple 공증은 포함하지 않는다. 회사 관리 정책에서 실행을 허용하는지 별도 확인이 필요하다.
