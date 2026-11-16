# 작업 지침

## 사이트와 로컬 데이터 업데이트 도구

- 사이트 버전을 변경하면 `desktop-updater/release.json`의 대상 사이트 버전과 도구 버전도 함께 갱신합니다.
- 데이터 형식을 변경하면 `desktop-updater/migrator.py`에 순서대로 적용되는 새 변환 규칙과 회귀 검증을 추가합니다. 기존 규칙의 의미를 바꾸지 않습니다.
- 데이터 변경 없는 업데이트에서는 사용자 데이터를 변환할 이유를 만들지 않습니다.
- 원본 덮어쓰기, 행 삭제·합산, 시간·날짜·게임 ID 추측을 자동 변환에 추가하지 않습니다. 불명확한 값은 보존하고 확인 항목으로 표시합니다.
- 릴리스 전에 `python desktop-updater/app.py --check-release`와 `python -m unittest discover -s desktop-updater/tests -v`를 통과시킵니다. 사이트 수정 시 기존 JavaScript 검사도 수행합니다.
- 테스트에는 합성 데이터를 사용합니다. 실제 연결 정보·기록·엑셀·변환 결과는 공개 소스에 포함하지 않습니다. 변환 결과 기본 위치는 `.local-only/data-updates`입니다.
- 웹 배포에서 도구 폴더를 제외하되, 사이트와 대응하는 로컬 도구 소스는 함께 관리합니다. 실행 및 유지보수 지침은 `desktop-updater/README.md`를 따릅니다.
- 사이트와 도구 소스는 프로젝트의 원래 위치에서 관리합니다. 별도 업로드 묶음이나 실행용 소스 사본을 만들지 않습니다. 개인 데이터·백업·분석 결과·라이브러리 연결 등 업로드 대상이 아닌 파일만 `.local-only` 아래로 분리합니다. 바탕화면 도구 바로가기는 `desktop-updater/app.py` 원본을 실행합니다.
- Python 검증은 `PYTHONDONTWRITEBYTECODE=1` 환경 변수로 실행해 공개 소스 폴더에 `__pycache__`를 남기지 않습니다.
