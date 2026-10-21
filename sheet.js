// ==========================================
// 📊 SHEET MODULE: 스프레드시트 수신 및 전송
// ==========================================

// 기존 10개 열을 유지하고, v2.29의 식별·정확도 열은 뒤에만 추가합니다.
const SPREADSHEET_HEADERS = ['이름', '시작일', '종료일', '플랫폼', '시간', '엔딩여부', '메모', '한줄평', 'Steam AppID', 'Steam 누적시간', '기록 ID', '플레이시간(분)', '런처 부모 AppID', '런처 배분 기록', '달력 연결 시작일'];

function saveWebAppUrlFromInput() {
    let urlVal = document.getElementById('webAppUrlInput').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(urlVal)) {
        alert("구글 시트 저장 주소는 Apps Script의 https://script.google.com/macros/s/.../exec 주소만 사용할 수 있습니다.");
        return;
    }
    const token = document.getElementById('sheetSyncTokenInput')?.value.trim() || localStorage.getItem('user_local_sheet_sync_token') || '';
    if (token.length < 12) {
        alert('시트 동기화 키를 12자 이상 입력하고 연결 정보를 저장해 주세요.');
        return;
    }
    localStorage.setItem('user_local_web_app_url', urlVal);
    localStorage.setItem('user_local_sheet_sync_token', token);
    alert("구글 시트 저장 주소가 이 브라우저에 저장되었습니다. 🔒");
    document.getElementById('webAppUrlInput').value = urlVal;
}

function toggleSpreadsheetGuide() {
    let guide = document.getElementById('spreadsheetGuide');
    let button = document.getElementById('spreadsheetGuideButton');
    let isVisible = guide.classList.toggle('is-visible');
    button.setAttribute('aria-expanded', String(isVisible));
    button.innerText = isVisible ? '📕 구글 시트 처음 설정 ▴' : '📋 구글 시트 처음 설정 ▾';
}

function getSavedWebAppUrl() {
    let targetUrl = localStorage.getItem('user_local_web_app_url');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(targetUrl || '')) {
        alert("구글 시트 저장 주소는 Apps Script의 https://script.google.com/macros/s/.../exec 주소만 사용할 수 있습니다.");
        return '';
    }
    return targetUrl;
}

function getSheetSyncToken() {
    const token = localStorage.getItem('user_local_sheet_sync_token') || '';
    if (token.length < 12) {
        alert('먼저 연결 정보의 시트 동기화 키를 12자 이상 입력하고 저장해 주세요.');
        return '';
    }
    return token;
}

function buildAuthorizedWebAppUrl(targetUrl, params = {}) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(targetUrl || '')) {
        alert('허용되지 않은 시트 저장 주소입니다. Apps Script의 /exec 주소를 다시 저장해 주세요.');
        return '';
    }
    const token = getSheetSyncToken();
    if (!token) return '';
    const url = new URL(targetUrl);
    Object.entries({ ...params, token }).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
}

function postWebAppData(targetUrl, payload) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(targetUrl || '')) {
        return Promise.reject(new Error('허용되지 않은 시트 저장 주소입니다.'));
    }
    const token = getSheetSyncToken();
    if (!token) return Promise.reject(new Error('시트 동기화 키가 없습니다.'));
    return fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ ...payload, token })
    }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    });
}

function createSpreadsheetTemplate() {
    let targetUrl = getSavedWebAppUrl();
    if (!targetUrl) return;
    if (!confirm("비어 있는 시트에 기본 헤더를 만듭니다. 이미 데이터가 있는 시트는 변경하지 않습니다. 계속할까요?")) return;

    postWebAppData(targetUrl, { action: 'createTemplate', headers: SPREADSHEET_HEADERS })
        .then(result => {
            if (result.result !== 'success') throw new Error(result.message || '시트 기본 틀 생성에 실패했습니다.');
            alert("시트 기본 틀이 만들어졌습니다. 이제 시트 URL을 입력하고 불러오기를 실행해 주세요.");
        })
        .catch(error => alert(`시트 기본 틀 생성 실패: ${error.message}`));
}

function recordToSpreadsheetRow(game) {
    return [
        game.title || '',
        game.startDate || '',
        game.endDate || '',
        game.platform || '',
        Number(game.time || 0),
        game.isEnding || 'x',
        game.memo || '',
        game.review || '',
        game.steamAppId || '',
        game.steamTotal ?? '',
        game.recordId || game.id || createRecordId(),
        getRecordMinutes(game),
        game.parentAppId || '',
        game.isLauncherAllocation ? 'Y' : '',
        game.calendarLinkStart || ''
    ];
}

function createCsvText(records) {
    let escapeValue = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    let rows = [SPREADSHEET_HEADERS, ...records.map(recordToSpreadsheetRow)];
    return '\uFEFF' + rows.map(row => row.map(escapeValue).join(',')).join('\r\n');
}

function downloadRecordsAsCsv() {
    if (!confirm('CSV 파일로 저장합니다.\n\nCSV: 가볍고 단순한 한 장짜리 파일입니다. 다른 서비스에 기록을 옮길 때 편합니다.\nExcel: 시작일 연도별 탭이 나뉜 .xlsx 파일입니다. Excel에서 계속 정리할 때 편합니다.\n\nCSV 파일을 저장할까요?')) return;

    let records = localEvents.map(event => ({ ...event.extendedProps }));
    let csvText = createCsvText(records);
    let blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    let downloadUrl = URL.createObjectURL(blob);
    let link = document.createElement('a');
    let today = new Date().toISOString().split('T')[0];

    link.href = downloadUrl;
    link.download = `game-effect-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
}

function downloadRecordsAsXlsx() {
    if (!confirm('Excel 파일로 저장합니다.\n\nCSV: 가볍고 단순한 한 장짜리 파일입니다. 다른 서비스에 기록을 옮길 때 편합니다.\nExcel: 시작일 연도별 탭이 나뉜 .xlsx 파일입니다. Excel에서 계속 정리할 때 편합니다.\n\nExcel 파일을 저장할까요?')) return;

    if (!window.XLSX) {
        alert('엑셀 파일 기능을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
        return;
    }

    let recordsByYear = new Map();
    localEvents.forEach(event => {
        let record = { ...event.extendedProps };
        let match = String(record.startDate || '').match(/^(\d{4})/);
        let year = match ? match[1] : '날짜 없음';
        let records = recordsByYear.get(year) || [];
        records.push(record);
        recordsByYear.set(year, records);
    });

    if (recordsByYear.size === 0) recordsByYear.set('기록 없음', []);

    let workbook = XLSX.utils.book_new();
    [...recordsByYear.keys()].sort((left, right) => right.localeCompare(left)).forEach(year => {
        let records = recordsByYear.get(year).sort((left, right) => String(left.startDate || '').localeCompare(String(right.startDate || '')));
        let worksheet = XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ...records.map(recordToSpreadsheetRow)]);
        worksheet['!cols'] = [
            { wch: 24 }, { wch: 28 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 10 },
            { wch: 14 }, { wch: 12 }, { wch: 36 }, { wch: 30 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 14 }
        ];
        XLSX.utils.book_append_sheet(workbook, worksheet, year);
    });

    let today = new Date().toISOString().split('T')[0];
    XLSX.writeFile(workbook, `game-effect-${today}.xlsx`);
}

function cleanLocalGameData() {
    if (localEvents.length === 0) {
        alert("정리할 기록이 없습니다.");
        return;
    }
    if (!confirm("잘못된 날짜·시간 기록과 완전히 같은 중복 기록을 제거하고 날짜순으로 정리합니다. 계속할까요?")) return;

    let cleanedEvents = [];
    let seenRecords = new Set();
    let removedCount = 0;

    localEvents.forEach(event => {
        let game = event.extendedProps || {};
        let title = (game.title || event.title || '').trim();
        let startDate = getValidatedDate(game.startDate || '');
        let rawEndDate = game.rawEndDate || game.endDate || startDate;
        let endDate = getValidatedDate(rawEndDate || '');
        let time = Number(game.time);

        if (!title || !startDate || !endDate || endDate < startDate || !Number.isFinite(time) || time < 0) {
            removedCount++;
            return;
        }

        let platform = (game.platform || '기타').trim() || '기타';
        let endingStatus = game.isEnding || 'x';
        let memo = game.memo || '';
        let review = game.review || '';
        let key = [title.toLowerCase(), startDate, endDate, platform.toLowerCase(), time, endingStatus, memo, review].join('\u001F');

        if (seenRecords.has(key)) {
            removedCount++;
            return;
        }

        seenRecords.add(key);
        let isEnding = endingStatus !== 'x';
        cleanedEvents.push(createGameObj(title, startDate, endDate, platform, time, endingStatus, memo, review, isEnding, game.steamAppId, game.steamTotal, game));
    });

    cleanedEvents.sort((a, b) => {
        let dateOrder = a.extendedProps.startDate.localeCompare(b.extendedProps.startDate);
        return dateOrder || a.title.localeCompare(b.title, 'ko');
    });

    localEvents = cleanedEvents;
    uniqueTitles = [];
    refreshUI();
    saveToLocalStorage();
    syncAllRecordsToGoogleSheet();
    alert(`데이터 정리가 완료되었습니다. ${removedCount}개 기록을 제거했고, ${cleanedEvents.length}개 기록을 유지했습니다.`);
}

function extractSpreadsheetId(urlText) {
    if (!urlText) return null;
    urlText = urlText.trim();
    if (urlText.includes("/d/e/")) {
        let parts = urlText.split("/d/e/");
        if (parts[1]) return parts[1].split("/")[0].split("?")[0].trim();
    }
    if (urlText.includes("/d/")) {
        let parts = urlText.split("/d/");
        if (parts[1]) return parts[1].split("/")[0].split("?")[0].trim();
    }
    return urlText;
}

function cleanGoogleDate(val) {
    if (!val) return '';
    let str = val.toString();
    if (str.includes('Date(')) {
        let matches = str.match(/Date\((\d+),(\d+),(\d+)\)/);
        if (matches) {
            let y = matches[1];
            let m = (parseInt(matches[2]) + 1).toString().padStart(2, '0');
            let d = matches[3].padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
    }
    return str.trim();
}

function getComparableGameRecords(events) {
    return events.map(event => {
        const game = event.extendedProps || event;
        return {
            title: String(game.title || event.title || ''), startDate: String(game.startDate || ''), endDate: String(game.endDate || ''),
            platform: String(game.platform || ''), time: Number(game.time || 0), isEnding: String(game.isEnding || 'x'),
            memo: String(game.memo || ''), review: String(game.review || ''), steamAppId: String(game.steamAppId || ''),
            steamTotal: game.steamTotal === null || game.steamTotal === '' || game.steamTotal === undefined ? null : Number(game.steamTotal)
        };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function getIncomingRecordTotal(record) {
    const game = record.extendedProps || record || {};
    const steamTotal = Number(game.steamTotal);
    if (game.steamTotal !== null && game.steamTotal !== '' && Number.isFinite(steamTotal)) return steamTotal;
    const time = Number(game.time);
    return Number.isFinite(time) ? time : 0;
}

// 날짜가 다른 같은 게임 기록은 모두 유지합니다. 같은 제목·같은 날짜가 중복된 경우에만
// 누적 시간이 가장 큰 행 하나를 사용합니다.
function deduplicateIncomingSheetRecords(records) {
    const bestByTitleAndDate = new Map();
    records.forEach(record => {
        const game = record.extendedProps || record || {};
        const titleKey = String(game.title || record.title || '').trim().toLocaleLowerCase();
        if (!titleKey) return;
        const dateKey = String(game.startDate || game.rawEndDate || game.endDate || '').trim();
        const key = `${titleKey}\u001F${dateKey}`;
        const current = bestByTitleAndDate.get(key);
        if (!current) {
            bestByTitleAndDate.set(key, record);
            return;
        }

        const candidateTotal = getIncomingRecordTotal(record);
        const currentTotal = getIncomingRecordTotal(current);
        const candidateHasAppId = /^\d+$/.test(String((record.extendedProps || record).steamAppId || ''));
        const currentHasAppId = /^\d+$/.test(String((current.extendedProps || current).steamAppId || ''));
        if (candidateTotal > currentTotal || (candidateTotal === currentTotal && candidateHasAppId && !currentHasAppId)) {
            bestByTitleAndDate.set(key, record);
        }
    });
    return [...bestByTitleAndDate.values()];
}

function applyIncomingSheetRecords(records, sourceLabel, options = {}) {
    records = deduplicateIncomingSheetRecords(records);
    const localRecords = getComparableGameRecords(localEvents);
    const sheetRecords = getComparableGameRecords(records);
    const isSame = JSON.stringify(localRecords) === JSON.stringify(sheetRecords);

    if (localEvents.length > 0 && !isSame && !options.forceReplace) {
        const useSheet = confirm(
            `${sourceLabel} 데이터(${records.length}개)와 이 브라우저의 로컬 데이터(${localEvents.length}개)가 서로 다릅니다.\n\n` +
            `확인: 시트 데이터를 사용해 로컬 기록을 교체합니다.\n` +
            `취소: 현재 로컬 기록을 그대로 유지합니다.`
        );
        if (!useSheet) {
            alert('로컬 기록을 유지했습니다. 시트 데이터는 변경하지 않았습니다.');
            return false;
        }
    }

    localEvents = records;
    uniqueTitles = [];
    // 시트/CSV 복원은 로컬 데이터의 기준점을 바꾸는 작업입니다. 이전 Steam 동기화 시각을
    // 유지하면 과거 게임을 새 게임으로 오인할 수 있으므로 다음 최근 동기화에서 새 기준을 잡습니다.
    if (typeof resetSteamRecentSyncBaseline === 'function') resetSteamRecentSyncBaseline();
    refreshUI();
    saveToLocalStorage();
    return true;
}

function parseCSVTextToRows(text) {
    let lines = [];
    let row = [""], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        let el = text[i];
        let nextEl = text[i+1];
        if (el === '"') {
            if (inQuotes && nextEl === '"') { row[row.length - 1] += '"'; i++; }
            else { inQuotes = !inQuotes; }
        } else if (el === ',' && !inQuotes) {
            row.push("");
        } else if ((el === '\r' || el === '\n') && !inQuotes) {
            if (el === '\r' && nextEl === '\n') { i++; }
            lines.push(row);
            row = [""];
        } else {
            row[row.length - 1] += el;
        }
    }
    if (row.length > 1 || row[0] !== "") lines.push(row);
    return lines;
}

function parseAndRenderCSV(csvText) {
    let allRows = parseCSVTextToRows(csvText);
    if (allRows.length < 1) return;
    let parsedEvents = [];

    let cols = allRows[0].map(c => c.trim().replace(/^"|"$/g, ''));
    let recordIdIdx = cols.indexOf('기록 ID');
    let nameIdx = cols.indexOf('이름');
    let startIdx = cols.indexOf('시작일');
    let endIdx = cols.indexOf('종료일');
    let platformIdx = cols.indexOf('플랫폼');
    let timeIdx = cols.indexOf('시간');
    let endingIdx = cols.indexOf('엔딩여부') !== -1 ? cols.indexOf('엔딩여부') : cols.indexOf('트로피');
    let memoIdx = cols.indexOf('메모');
    let reviewIdx = cols.indexOf('한줄평');
    let steamAppIdIdx = cols.indexOf('Steam AppID');
    let steamTotalIdx = cols.indexOf('Steam 누적시간');
    let minutesIdx = cols.indexOf('플레이시간(분)');
    let parentAppIdIdx = cols.indexOf('런처 부모 AppID');
    let launcherAllocationIdx = cols.indexOf('런처 배분 기록');
    let calendarLinkStartIdx = cols.indexOf('달력 연결 시작일');

    if (nameIdx === -1 || (startIdx === -1 && endIdx === -1)) return;

    for (let i = 1; i < allRows.length; i++) {
        let row = allRows[i].map(r => r.trim().replace(/^"|"$/g, ''));
        if (row.length <= nameIdx || !row[nameIdx]) continue;

        let name = row[nameIdx];
        let startDate = row[startIdx];
        let endDate = row[endIdx] || '';
        let platform = row[platformIdx] || '-';
        let time = parseFloat(row[timeIdx] || 0);
        let endingStatus = row[endingIdx] || 'x';
        let memo = row[memoIdx] || '';
        let review = reviewIdx !== -1 ? (row[reviewIdx] || '') : '';
        let steamAppId = steamAppIdIdx !== -1 ? (row[steamAppIdIdx] || '') : '';
        let steamTotalText = steamTotalIdx !== -1 ? String(row[steamTotalIdx] || '').trim() : '';
        let steamTotal = steamTotalText === '' ? null : Number(steamTotalText);
        let recordId = recordIdIdx !== -1 ? String(row[recordIdIdx] || '').trim() : '';
        let minutes = minutesIdx !== -1 ? Number(row[minutesIdx]) : null;
        let parentAppId = parentAppIdIdx !== -1 ? String(row[parentAppIdIdx] || '').trim() : '';
        let isLauncherAllocation = launcherAllocationIdx !== -1 && String(row[launcherAllocationIdx] || '').trim().toUpperCase() === 'Y';
        let calendarLinkStart = calendarLinkStartIdx !== -1 ? String(row[calendarLinkStartIdx] || '').trim() : '';

        if (!name || (!startDate && !endDate)) continue;
        if (memo === '기록된 메모가 없습니다.' || memo === '-') memo = '';

        let isEndMark = (endingStatus === 'o' || endingStatus.includes('엔딩') || endingStatus.includes('%'));
        parsedEvents.push(createGameObj(name, startDate, endDate, platform, time, endingStatus, memo, review, isEndMark, steamAppId, steamTotal, { recordId, playtimeMinutes: minutes, parentAppId, isLauncherAllocation, calendarLinkStart }));
    }
    applyIncomingSheetRecords(parsedEvents, 'CSV');
}

window.handleGoogleSheetResponse = function(rawJson) {
    let oldScript = document.getElementById('googlesheet-jsonp-script');
    if (oldScript) oldScript.remove();

    if (!rawJson || !rawJson.table) { endWorkProgress(); return; }

    let parsedEvents = [];

    let rows = rawJson.table.rows;
    let cols = rawJson.table.cols.map(c => c.label ? c.label.trim() : '');

    let isHeaderInRows = false;
    if ((cols.indexOf('이름') === -1 || cols.indexOf('시작일') === -1) && rows.length > 0) {
        let firstRow = rows[0].c;
        let tempCols = firstRow.map(cell => cell && (cell.v !== undefined ? cell.v : (cell.f !== undefined ? cell.f : '')).toString().trim());
        if (tempCols.indexOf('이름') !== -1) { cols = tempCols; isHeaderInRows = true; }
    }

    let nameIdx = cols.indexOf('이름');
    let recordIdIdx = cols.indexOf('기록 ID');
    let startIdx = cols.indexOf('시작일');
    let endIdx = cols.indexOf('종료일');
    let platformIdx = cols.indexOf('플랫폼');
    let timeIdx = cols.indexOf('시간');
    let endingIdx = cols.indexOf('엔딩여부') !== -1 ? cols.indexOf('엔딩여부') : cols.indexOf('트로피');
    let memoIdx = cols.indexOf('메모');
    let reviewIdx = cols.indexOf('한줄평');
    let steamAppIdIdx = cols.indexOf('Steam AppID');
    let steamTotalIdx = cols.indexOf('Steam 누적시간');
    let minutesIdx = cols.indexOf('플레이시간(분)');
    let parentAppIdIdx = cols.indexOf('런처 부모 AppID');
    let launcherAllocationIdx = cols.indexOf('런처 배분 기록');
    let calendarLinkStartIdx = cols.indexOf('달력 연결 시작일');

    if (nameIdx === -1 || (startIdx === -1 && endIdx === -1)) { endWorkProgress(); return; }

    let startIndex = isHeaderInRows ? 1 : 0;

    for (let i = startIndex; i < rows.length; i++) {
        let row = rows[i].c;
        if (!row || !row[nameIdx]) continue;

        let name = row[nameIdx]?.v ? row[nameIdx].v.toString().trim() : '';
        let startDate = row[startIdx] ? cleanGoogleDate(row[startIdx].f || row[startIdx].v) : '';
        let endDate = row[endIdx] ? cleanGoogleDate(row[endIdx].f || row[endIdx].v) : '';
        let platform = row[platformIdx]?.v ? row[platformIdx].v.toString().trim() : '-';
        let time = row[timeIdx]?.v ? parseFloat(row[timeIdx].v) : 0;
        let endingStatus = row[endingIdx]?.v ? row[endingIdx].v.toString().trim() : 'x';
        let memo = row[memoIdx]?.v ? row[memoIdx].v.toString().trim() : '';
        let review = reviewIdx !== -1 && row[reviewIdx]?.v ? row[reviewIdx].v.toString().trim() : '';
        let steamAppId = steamAppIdIdx !== -1 && row[steamAppIdIdx]?.v ? row[steamAppIdIdx].v.toString().trim() : '';
        let steamTotalText = steamTotalIdx !== -1 && row[steamTotalIdx]?.v !== undefined ? String(row[steamTotalIdx].v).trim() : '';
        let steamTotal = steamTotalText === '' ? null : Number(steamTotalText);
        let recordId = recordIdIdx !== -1 && row[recordIdIdx]?.v ? String(row[recordIdIdx].v).trim() : '';
        let minutes = minutesIdx !== -1 && row[minutesIdx]?.v !== undefined ? Number(row[minutesIdx].v) : null;
        let parentAppId = parentAppIdIdx !== -1 && row[parentAppIdIdx]?.v ? String(row[parentAppIdIdx].v).trim() : '';
        let isLauncherAllocation = launcherAllocationIdx !== -1 && String(row[launcherAllocationIdx]?.v || '').trim().toUpperCase() === 'Y';
        let calendarLinkStart = calendarLinkStartIdx !== -1 && row[calendarLinkStartIdx]?.v ? String(row[calendarLinkStartIdx].v).trim() : '';

        if (!name || (!startDate && !endDate)) continue;
        if (memo === '기록된 메모가 없습니다.' || memo === '-') memo = '';

        let isEndMark = (endingStatus === 'o' || endingStatus.toString().includes('엔딩') || endingStatus.toString().includes('%'));
        parsedEvents.push(createGameObj(name, startDate, endDate, platform, time, endingStatus, memo, review, isEndMark, steamAppId, steamTotal, { recordId, playtimeMinutes: minutes, parentAppId, isLauncherAllocation, calendarLinkStart }));
    }

    applyIncomingSheetRecords(parsedEvents, '구글 시트');
    endWorkProgress();
};

function parseGameRecordsPayload(payload) {
    if (!payload || payload.result !== 'success' || !Array.isArray(payload.records)) return null;
    let parsedEvents = [];
    payload.records.forEach(record => {
        let name = String(record.title || '').trim();
        let startDate = cleanGoogleDate(record.startDate);
        let endDate = cleanGoogleDate(record.endDate);
        if (!name || (!startDate && !endDate)) return;
        let endingStatus = String(record.isEnding || 'x');
        let memo = record.memo === '기록된 메모가 없습니다.' || record.memo === '-' ? '' : (record.memo || '');
        let isEndMark = endingStatus === 'o' || endingStatus.includes('엔딩') || endingStatus.includes('%');
        let steamTotalText = String(record.steamTotal ?? '').trim();
        let steamTotal = steamTotalText === '' ? null : Number(steamTotalText);
        parsedEvents.push(createGameObj(name, startDate, endDate, record.platform || '-', Number(record.time || 0), endingStatus, memo, record.review || '', isEndMark, record.steamAppId || '', steamTotal, record));
    });
    return parsedEvents;
}

window.handleGameRecordsResponse = function(payload) {
    let oldScript = document.getElementById('game-records-jsonp-script');
    if (oldScript) oldScript.remove();
    const parsedEvents = parseGameRecordsPayload(payload);
    if (!parsedEvents) {
        alert(`시트를 불러오지 못했습니다. ${payload?.message || '기존 기록은 유지됩니다.'}`);
        endWorkProgress();
        return false;
    }
    const result = applyIncomingSheetRecords(parsedEvents, '구글 시트');
    endWorkProgress();
    return result;
};

function fetchAllYearTabsForInitialSync(webAppUrl) {
    return new Promise((resolve, reject) => {
        const callbackName = `gameEffectInitialSheetCallback${Date.now()}`;
        const script = document.createElement('script');
        const cleanup = () => {
            script.remove();
            delete window[callbackName];
        };
        window[callbackName] = payload => {
            try {
                const records = parseGameRecordsPayload(payload);
                cleanup();
                if (!records) throw new Error(payload?.message || '시트 기록을 읽지 못했습니다.');
                resolve(records);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        const authorizedUrl = buildAuthorizedWebAppUrl(webAppUrl, { action: 'gameRecords', callback: callbackName });
        if (!authorizedUrl) { cleanup(); reject(new Error('시트 동기화 키를 먼저 저장해 주세요.')); return; }
        script.src = authorizedUrl;
        script.onerror = () => {
            cleanup();
            reject(new Error('시트를 불러오지 못했습니다. Apps Script를 새 코드로 배포했는지 확인해 주세요.'));
        };
        document.body.appendChild(script);
    });
}

function fetchAllYearTabs(webAppUrl) {
    let oldScript = document.getElementById('game-records-jsonp-script');
    if (oldScript) oldScript.remove();
    let script = document.createElement('script');
    script.id = 'game-records-jsonp-script';
    const authorizedUrl = buildAuthorizedWebAppUrl(webAppUrl, { action: 'gameRecords', callback: 'handleGameRecordsResponse' });
    if (!authorizedUrl) return false;
    script.src = authorizedUrl;
    script.onerror = () => {
        script.remove();
        endWorkProgress();
        alert('시트를 불러오지 못했습니다. Apps Script 코드를 새 코드로 바꾼 뒤 새 배포했는지 확인해 주세요.');
    };
    document.body.appendChild(script);
    return true;
}

function forceFetchSpreadsheetData() {
    let rawUrlInput = document.getElementById('spreadsheetUrlInput').value.trim();
    let sheetId = extractSpreadsheetId(rawUrlInput);

    if (!sheetId) {
        alert("구글 스프레드시트 주소를 복사해 주세요!");
        return;
    }

    localStorage.setItem('saved_game_sheet_url', rawUrlInput);
    beginWorkProgress('시트 기록을 불러오는 중입니다…');

    let webAppUrl = localStorage.getItem('user_local_web_app_url');
    if (webAppUrl) {
        if (!fetchAllYearTabs(webAppUrl)) endWorkProgress();
        return;
    }

    if (rawUrlInput.includes("2PACX-")) {
        let csvCleanUrl = rawUrlInput.split("/pubhtml")[0].split("?")[0] + "/pub?output=csv";
        fetch(csvCleanUrl)
            .then(response => { if (!response.ok) throw new Error(); return response.text(); })
            .then(csvText => { parseAndRenderCSV(csvText); })
            .catch(() => alert("시트를 불러오지 못했습니다. 기존 기록은 유지됩니다."))
            .finally(endWorkProgress);
    } else {
        let oldScript = document.getElementById('googlesheet-jsonp-script');
        if (oldScript) oldScript.remove();

        let generatedTargetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=responseHandler:handleGoogleSheetResponse&headers=1`;
        let script = document.createElement('script');
        script.id = 'googlesheet-jsonp-script';
        script.src = generatedTargetUrl;
        script.onerror = () => { endWorkProgress(); alert('시트를 불러오지 못했습니다. 기존 기록은 유지됩니다.'); };
        document.body.appendChild(script);
    }
}

function confirmGoogleSheetWrite(actionLabel, recordCount) {
    return confirm(
        `⚠️ 구글 스프레드시트 변경 경고\n\n` +
        `“${actionLabel}” 작업은 현재 로컬 기록 ${recordCount}개를 시트에 병합·수정합니다.\n` +
        `동일한 기록 ID는 최신 내용으로 업데이트되며, 시트에만 있는 다른 기록은 삭제하지 않습니다.\n\n계속할까요?`
    );
}

function syncRecordsToGoogleSheet(records, options = {}) {
    let targetUrl = localStorage.getItem('user_local_web_app_url');
    if (!targetUrl) return Promise.resolve();

    const normalizedRecords = (Array.isArray(records) ? records : [])
        .map(record => ({ ...(record?.extendedProps || record || {}) }))
        .filter(record => record.recordId || record.id);
    if (normalizedRecords.length === 0) {
        if (!options.silent) alert('로컬 기록이 없어 시트에 저장하지 않았습니다. 먼저 시트 기록을 불러오거나 게임 기록을 추가해 주세요.');
        return Promise.resolve({ skipped: true });
    }
    if (!options.skipConfirm && !confirmGoogleSheetWrite(options.actionLabel || '사이트 기록 저장', normalizedRecords.length)) return Promise.resolve({ cancelled: true });
    return postWebAppData(targetUrl, { action: 'upsertRecords', records: normalizedRecords })
        .then(result => {
            if (result.result !== 'success' || Number(result.count) !== normalizedRecords.length) {
                throw new Error(result.message || '시트가 최신 병합 저장을 확인하지 못했습니다. 사이트의 전체 Apps Script 코드를 다시 붙여 넣고 새 버전으로 배포해 주세요.');
            }
            return result;
        })
        .catch(error => {
            console.error('구글 시트 동기화 오류:', error);
            if (!options.silent) alert(`시트에 저장하지 못했습니다. ${error.message}`);
            return { error };
        });
}

function syncAllRecordsToGoogleSheet(options = {}) {
    return syncRecordsToGoogleSheet(localEvents, options);
}

function syncChangedRecordsToGoogleSheet(records, options = {}) {
    return syncRecordsToGoogleSheet(records, { ...options, actionLabel: options.actionLabel || '최근 Steam 플레이 동기화' });
}

async function manuallySyncAllRecordsToGoogleSheet() {
    const targetUrl = localStorage.getItem('user_local_web_app_url');
    if (!targetUrl) {
        alert('먼저 “구글 시트 저장 주소”에 Apps Script의 /exec 주소를 입력하고 연결 정보를 저장해 주세요.');
        return;
    }

    const records = localEvents.map(event => ({ ...event.extendedProps }));
    if (records.length === 0) {
        const loadFirst = confirm('로컬 기록이 없습니다. 빈 기록으로 시트를 덮어쓰지 않습니다.\n\n확인: 시트 기록을 먼저 불러오기\n취소: 아무 작업도 하지 않기');
        if (loadFirst) forceFetchSpreadsheetData();
        return;
    }
    if (!confirmGoogleSheetWrite('수동 시트 동기화', records.length)) return;
    const button = document.getElementById('manualSheetSyncButton');
    if (button) {
        button.disabled = true;
        button.innerText = '⏳ 시트에 저장 중...';
    }
    try {
        const result = await syncAllRecordsToGoogleSheet({ skipConfirm: true, actionLabel: '수동 시트 동기화' });
        if (result?.error) throw result.error;
        alert(`시트 수동 동기화 완료\n\n현재 기록 ${records.length}개를 연도별 시트에 병합 저장했습니다.`);
    } catch (error) {
        alert(`시트 수동 동기화 실패: ${error.message}`);
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = '☁️ 시트 수동 동기화';
        }
    }
}

function sendDataToGoogleSheet(record) {
    return record
        ? syncChangedRecordsToGoogleSheet([record], { actionLabel: '게임 기록 추가' })
        : syncAllRecordsToGoogleSheet();
}

