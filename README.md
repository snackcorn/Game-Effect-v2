# 🎮 Game Effect

내가 한 게임과 플레이 시간을 기록하는 간단한 게임 기록장입니다.

## 할 수 있는 일

- 게임 기록하기
- 기록 찾기
- 달력, 모든 기록, 연도별 요약 보기
- 최근 7일에 시작한 게임 중 플레이 시간이 많은 게임 10개 보기
- Steam 플레이 시간 가져오기
- 구글 시트에서 모든 연도 기록 가져오기
- CSV 또는 시작일 연도별 탭 Excel 파일(.xlsx) 저장하기
- 잘못되거나 똑같이 겹친 기록 정리하기

## 처음 사용하기

### 1. 바로 기록하기

웹페이지의 **게임 기록하기**에서 게임 이름, 플레이 시간, 시작한 날을 입력하고 **기록하기**를 누릅니다.

시작한 날을 비워 두면 오늘 날짜로 기록합니다.

### 2. 구글 시트에서 기록 가져오기

1. **구글 시트 연결하기**를 엽니다.
2. `기록 가져오기` 칸에 구글 스프레드시트 주소를 넣습니다.
3. **기록 가져오기**를 누릅니다.

기록은 시작한 날의 연도별 탭(예: `2026`)에 자동으로 저장됩니다. 불러올 때는 모든 연도 탭을 함께 읽습니다.

종료일이 비어 있는 기록은 시작일 하루에만 달력 블록으로 표시됩니다.

로컬 기록과 시트 기록이 다를 때 기록을 불러오면, 시트 데이터로 로컬 기록을 교체할지 현재 로컬 기록을 유지할지 선택할 수 있습니다.

기록을 수정·삭제하거나 Steam 제목을 변환하면 현재 브라우저의 전체 기록이 연도별 시트에 다시 저장됩니다. 처음 연결할 때는 반드시 **기록 가져오기**로 시트 데이터를 먼저 불러오고, 중요한 시트는 사본을 만들어 두세요.

시트 주소, Apps Script의 `/exec` 저장 주소, SteamID64를 모두 설정했다면 **처음 데이터 통합 동기화**를 사용할 수 있습니다. 이 기능은 시트와 Steam 라이브러리를 함께 불러온 뒤 Steam AppID를 연결하고, Steam 상점의 한국어 이름으로 제목을 정리한 다음 최신 플레이 정보를 비교합니다. AppID를 확인하지 못한 기존 Steam 기록은 중복 생성을 막기 위해 이번 Steam 반영에서 제외하고, AppID가 연결된 게임은 계속 반영합니다. 완료 후에는 자동 연결 재시도·제목 정리 후보 보기·마침 중 다음 작업을 고를 수 있습니다.

시트의 첫 번째 줄에는 아래 항목이 필요합니다.

| 이름 | 시작일 |
| --- | --- |

더 많은 내용을 함께 저장하려면 아래처럼 첫 줄을 만드세요.

| 이름 | 시작일 | 종료일 | 플랫폼 | 시간 | 엔딩여부 | 메모 | 한줄평 | Steam AppID | Steam 누적시간 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 새 기록을 구글 시트에 저장하기

게임을 기록할 때마다 구글 시트에도 자동으로 추가하고 싶다면 아래 설정을 한 번만 하면 됩니다.

시트를 직접 만들기 어렵다면 웹페이지의 **CSV로 저장** 또는 **Excel로 저장**을 누르세요. CSV는 가볍고 한 장짜리라 다른 서비스로 옮길 때 편합니다. Excel 파일은 시작일 연도에 따라 탭이 나뉘어 Excel에서 계속 정리할 때 편합니다.

### 연결 코드 넣기

1. 구글 스프레드시트에서 **확장 프로그램 → Apps Script**를 엽니다.
2. 화면에 있는 코드를 모두 지우고 아래 코드를 붙여 넣습니다.
3. 저장 버튼을 누릅니다.

```javascript
const HEADERS = ['이름', '시작일', '종료일', '플랫폼', '시간', '엔딩여부', '메모', '한줄평', 'Steam AppID', 'Steam 누적시간'];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'createTemplate') {
      getYearSheet(new Date().getFullYear());
      return json({ result: 'success' });
    }
    if (data.action === 'replaceAll') {
      const records = Array.isArray(data.records) ? data.records : [];
      replaceAllRecords(records);
      return json({ result: 'success', count: records.length });
    }
    const sheet = getYearSheet(getYear(data.startDate));
    sheet.appendRow(toRow(data));

    return json({ result: 'success' });
  } catch (error) {
    return json({ result: 'error', message: String(error) });
  }
}

function getYear(dateText) {
  const match = String(dateText || '').match(/^(\d{4})/);
  return match ? match[1] : String(new Date().getFullYear());
}

function getYearSheet(year) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const name = String(year);
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  return sheet;
}

function toRow(data) {
  return [data.title || '', data.startDate || '', data.endDate || '', data.platform || '', Number(data.time || 0), data.isEnding || 'x', data.memo || '', data.review || '', data.steamAppId || '', data.steamTotal ?? ''];
}

function replaceAllRecords(records) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const groups = {};
  records.forEach(record => {
    const year = getYear(record.startDate);
    if (!groups[year]) groups[year] = [];
    groups[year].push(record);
  });
  spreadsheet.getSheets().forEach(sheet => {
    if (/^\d{4}$/.test(sheet.getName())) {
      sheet.clearContents();
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
  });
  Object.keys(groups).forEach(year => {
    const sheet = getYearSheet(year);
    const rows = groups[year].map(toRow);
    if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  });
}

function doGet(e) {
  const p = e.parameter || {};
  if (p.action === 'gameRecords') return jsonp({ result: 'success', records: getAllRecords() }, p.callback);
  return jsonp({ error: '잘못된 요청입니다.' }, p.callback);
}

function getAllRecords() {
  const records = [];
  const allSheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  const yearSheets = allSheets.filter(sheet => /^\d{4}$/.test(sheet.getName()));
  // v2가 만든 연도별 탭이 있으면 기존 원본 탭은 중복 수신하지 않습니다.
  const sourceSheets = yearSheets.length ? yearSheets : allSheets;
  sourceSheets.forEach(sheet => {
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return;
    const headers = values[0].map(String);
    const value = (row, name) => {
      const index = headers.indexOf(name);
      const item = index > -1 ? row[index] : '';
      return item instanceof Date ? Utilities.formatDate(item, Session.getScriptTimeZone(), 'yyyy-MM-dd') : item;
    };
    values.slice(1).forEach(row => records.push({
      title: value(row, '이름'), startDate: value(row, '시작일'), endDate: value(row, '종료일'),
      platform: value(row, '플랫폼'), time: value(row, '시간'), isEnding: value(row, '엔딩여부'),
      memo: value(row, '메모'), review: value(row, '한줄평'), steamAppId: value(row, 'Steam AppID'), steamTotal: value(row, 'Steam 누적시간')
    }));
  });
  return records;
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonp(data, callback) {
  const text = JSON.stringify(data);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + text + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(data);
}
```

### 저장 주소 만들기

1. Apps Script 오른쪽 위에서 **배포 → 새 배포**를 누릅니다.
2. 유형은 **웹 앱**을 선택합니다.
3. 실행 계정은 **나**, 사용할 수 있는 사람은 **모든 사용자**로 선택합니다.
4. 배포 후 나오는 `/exec` 주소를 복사합니다.
5. Game Effect의 **기록 저장하기** 칸에 붙여 넣고 **저장 주소 입력**을 누릅니다.

## 기록 도구

- **처음 설정하기**: 시트 첫 줄에 무엇을 적는지와 연결 코드를 확인합니다.
- **기록 정리**: 날짜나 시간이 잘못된 기록, 완전히 같은 기록을 지웁니다.
- **CSV로 저장**: 현재 기록을 한 장짜리 CSV 파일로 내려받습니다.
- **Excel로 저장**: 현재 기록을 시작일 연도별 탭으로 나눈 Excel 파일로 내려받습니다.

## Steam 연결하기

화면에는 SteamID64만 입력하고 저장합니다. Steam API 키는 Vercel 서버의 환경 변수에만 보관되므로 브라우저·구글 시트·GitHub에 저장되지 않습니다. 게임 이름을 입력하면 플레이 시간 계산에 활용할 수 있고, **최근 플레이 동기화**로 새 플레이 시간을 기록할 수 있습니다. AppID가 같은 기존 기록의 종료일보다 Steam 마지막 실행일이 더 최신이면 그 게임의 가장 최근 기록 종료일도 갱신합니다. 처음 동기화하는 게임은 Steam의 실제 마지막 실행일이 있는 경우에만 기록하며, 날짜 정보가 없는 게임은 오늘 날짜로 임의 추가하지 않습니다. 이후 동기화는 동기화한 날짜에 기록합니다. 총 플레이 시간이 0.3시간(18분) 미만인 게임은 제외합니다.

- **Steam 기록 한꺼번에 연결**: 기존 Steam 기록과 라이브러리를 비교해 이름이 확실히 일치하는 기록에 AppID를 연결합니다. 영어 API 이름과 다르면 Steam 상점의 한국어 검색 결과와 내 라이브러리 AppID를 대조합니다.
- **Steam 상점 이름으로 제목 정리**: Steam 상점의 한국어 검색 결과로 AppID 연결과 제목 정리 후보를 한꺼번에 보여 주며, 선택한 항목만 변경합니다.
- **Steam 날짜 재정렬**: 한 날짜에 잘못 몰린 Steam 기록을 게임별 Steam 마지막 실행일로 이동합니다. 마지막 실행일을 Steam이 제공하지 않는 게임은 현재 날짜를 유지합니다.
- **Steam 최초 동기화 되돌리기**: 특정 날짜에 한꺼번에 추가된 최초 동기화 기록만 삭제합니다. 실수로 대량 가져온 경우 사용합니다.
- Steam 상점의 한국어 이름과 API의 영어 이름이 다르면 자동 이름 비교만으로는 안전하게 연결할 수 없습니다. 게임 상세의 **Steam 게임 연결**에서 상점 주소를 한 번 붙여 넣으면 AppID로 정확하게 같은 게임을 인식합니다.

Steam AppID가 연결된 달력 기록에 마우스를 올리면 Steam 썸네일, 누적 플레이시간, 업적 진행도(획득/전체)를 볼 수 있습니다. 업적을 지원하지 않거나 비공개 게임 세부 정보에서는 업적 진행도가 표시되지 않을 수 있습니다.

### Vercel 연결하기

1. 이 폴더를 GitHub 저장소에 올린 뒤 [Vercel](https://vercel.com/new)에서 저장소를 Import합니다. 별도 빌드 설정은 필요 없습니다.
2. Vercel 프로젝트의 **Settings → Environment Variables**에서 아래 값을 추가합니다.

| 이름 | 값 | 적용 환경 |
| --- | --- | --- |
| `STEAM_WEB_API_KEY` | Steam Web API Key | Production, Preview, Development |

3. 환경 변수를 저장한 뒤 다시 배포합니다.
4. 배포된 웹사이트에서 Steam 프로필 주소의 17자리 SteamID64만 입력하고 **SteamID 저장**을 누릅니다.

Steam API 키는 [Steam Web API Key 페이지](https://steamcommunity.com/dev/apikey)에서 만들 수 있습니다. Vercel에만 입력하고, 게임 웹사이트의 입력칸이나 Git 저장소에는 절대 넣지 마세요.

## 데이터 초기화

설정의 **게임 기록 데이터 초기화**는 현재 브라우저의 게임 기록, 편집 기록, Steam 제목 연결만 삭제합니다. 구글 시트 기록, SteamID64, 구글 시트 주소는 유지됩니다. 초기화 뒤에도 구글 시트에서 기록을 다시 가져올 수 있습니다.
