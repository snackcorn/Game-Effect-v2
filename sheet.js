// ==========================================
// 📊 SHEET MODULE: 스프레드시트 수신 및 전송
// ==========================================

const SPREADSHEET_HEADERS = ['이름', '시작일', '종료일', '플랫폼', '시간', '엔딩여부', '메모', '한줄평', 'Steam AppID', 'Steam 누적시간'];

function saveWebAppUrlFromInput() {
    let urlVal = document.getElementById('webAppUrlInput').value.trim();
    if (!urlVal) {
        alert("연동할 구글 웹 앱 URL 주소를 올바르게 입력해 주세요!");
        return;
    }
    localStorage.setItem('user_local_web_app_url', urlVal);
    alert("구글 시트 저장 주소가 이 브라우저에 저장되었습니다. 🔒");
    document.getElementById('webAppUrlInput').value = urlVal;
}

function toggleSpreadsheetGuide() {
    let guide = document.getElementById('spreadsheetGuide');
    let button = document.getElementById('spreadsheetGuideButton');
    let isVisible = guide.classList.toggle('is-visible');
    button.setAttribute('aria-expanded', String(isVisible));
    button.innerText = isVisible ? '📕 처음 설정하기 닫기' : '📋 처음 설정하기';
}

function getSavedWebAppUrl() {
    let targetUrl = localStorage.getItem('user_local_web_app_url');
    if (!targetUrl) {
        alert("먼저 '기록 저장하기'에 구글 웹 앱 URL 주소를 저장해 주세요.");
        return '';
    }
    return targetUrl;
}

function postWebAppData(targetUrl, payload) {
    return fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload)
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
        game.steamTotal ?? ''
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
            { wch: 28 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 10 },
            { wch: 12 }, { wch: 36 }, { wch: 30 }, { wch: 14 }, { wch: 16 }
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
        cleanedEvents.push(createGameObj(title, startDate, endDate, platform, time, endingStatus, memo, review, isEnding, game.steamAppId, game.steamTotal));
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

// 시트에 같은 제목이 여러 행으로 있는 경우, 누적 시간이 가장 큰 행 하나만 사용합니다.
// Steam 제목 통일 후에도 다시 실행되므로 한국어/영어로 겹친 행도 한 번에 정리됩니다.
function deduplicateIncomingSheetRecords(records) {
    const bestByTitle = new Map();
    records.forEach(record => {
        const game = record.extendedProps || record || {};
        const titleKey = String(game.title || record.title || '').trim().toLocaleLowerCase();
        if (!titleKey) return;
        const current = bestByTitle.get(titleKey);
        if (!current) {
            bestByTitle.set(titleKey, record);
            return;
        }

        const candidateTotal = getIncomingRecordTotal(record);
        const currentTotal = getIncomingRecordTotal(current);
        const candidateHasAppId = /^\d+$/.test(String((record.extendedProps || record).steamAppId || ''));
        const currentHasAppId = /^\d+$/.test(String((current.extendedProps || current).steamAppId || ''));
        if (candidateTotal > currentTotal || (candidateTotal === currentTotal && candidateHasAppId && !currentHasAppId)) {
            bestByTitle.set(titleKey, record);
        }
    });
    return [...bestByTitle.values()];
}

function applyIncomingSheetRecords(records, sourceLabel) {
    records = deduplicateIncomingSheetRecords(records);
    const localRecords = getComparableGameRecords(localEvents);
    const sheetRecords = getComparableGameRecords(records);
    const isSame = JSON.stringify(localRecords) === JSON.stringify(sheetRecords);

    if (localEvents.length > 0 && !isSame) {
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

        if (!name || (!startDate && !endDate)) continue;
        if (memo === '기록된 메모가 없습니다.' || memo === '-') memo = '';

        let isEndMark = (endingStatus === 'o' || endingStatus.includes('엔딩') || endingStatus.includes('%'));
        parsedEvents.push(createGameObj(name, startDate, endDate, platform, time, endingStatus, memo, review, isEndMark, steamAppId, steamTotal));
    }
    applyIncomingSheetRecords(parsedEvents, 'CSV');
}

window.handleGoogleSheetResponse = function(rawJson) {
    let oldScript = document.getElementById('googlesheet-jsonp-script');
    if (oldScript) oldScript.remove();

    if (!rawJson || !rawJson.table) return;

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
    let startIdx = cols.indexOf('시작일');
    let endIdx = cols.indexOf('종료일');
    let platformIdx = cols.indexOf('플랫폼');
    let timeIdx = cols.indexOf('시간');
    let endingIdx = cols.indexOf('엔딩여부') !== -1 ? cols.indexOf('엔딩여부') : cols.indexOf('트로피');
    let memoIdx = cols.indexOf('메모');
    let reviewIdx = cols.indexOf('한줄평');
    let steamAppIdIdx = cols.indexOf('Steam AppID');
    let steamTotalIdx = cols.indexOf('Steam 누적시간');

    if (nameIdx === -1 || (startIdx === -1 && endIdx === -1)) return;

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

        if (!name || (!startDate && !endDate)) continue;
        if (memo === '기록된 메모가 없습니다.' || memo === '-') memo = '';

        let isEndMark = (endingStatus === 'o' || endingStatus.toString().includes('엔딩') || endingStatus.toString().includes('%'));
        parsedEvents.push(createGameObj(name, startDate, endDate, platform, time, endingStatus, memo, review, isEndMark, steamAppId, steamTotal));
    }

    applyIncomingSheetRecords(parsedEvents, '구글 시트');
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
        parsedEvents.push(createGameObj(name, startDate, endDate, record.platform || '-', Number(record.time || 0), endingStatus, memo, record.review || '', isEndMark, record.steamAppId || '', steamTotal));
    });
    return parsedEvents;
}

window.handleGameRecordsResponse = function(payload) {
    let oldScript = document.getElementById('game-records-jsonp-script');
    if (oldScript) oldScript.remove();
    const parsedEvents = parseGameRecordsPayload(payload);
    if (!parsedEvents) {
        alert(`시트를 불러오지 못했습니다. ${payload?.message || '기존 기록은 유지됩니다.'}`);
        return false;
    }
    return applyIncomingSheetRecords(parsedEvents, '구글 시트');
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
        script.src = `${webAppUrl}?action=gameRecords&callback=${callbackName}`;
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
    script.src = `${webAppUrl}?action=gameRecords&callback=handleGameRecordsResponse`;
    script.onerror = () => {
        script.remove();
        alert('시트를 불러오지 못했습니다. Apps Script 코드를 새 코드로 바꾼 뒤 새 배포했는지 확인해 주세요.');
    };
    document.body.appendChild(script);
}

function forceFetchSpreadsheetData() {
    let rawUrlInput = document.getElementById('spreadsheetUrlInput').value.trim();
    let sheetId = extractSpreadsheetId(rawUrlInput);

    if (!sheetId) {
        alert("구글 스프레드시트 주소를 복사해 주세요!");
        return;
    }

    localStorage.setItem('saved_game_sheet_url', rawUrlInput);

    let webAppUrl = localStorage.getItem('user_local_web_app_url');
    if (webAppUrl) {
        fetchAllYearTabs(webAppUrl);
        return;
    }

    if (rawUrlInput.includes("2PACX-")) {
        let csvCleanUrl = rawUrlInput.split("/pubhtml")[0].split("?")[0] + "/pub?output=csv";
        fetch(csvCleanUrl)
            .then(response => { if (!response.ok) throw new Error(); return response.text(); })
            .then(csvText => { parseAndRenderCSV(csvText); })
            .catch(() => alert("시트를 불러오지 못했습니다. 기존 기록은 유지됩니다."));
    } else {
        let oldScript = document.getElementById('googlesheet-jsonp-script');
        if (oldScript) oldScript.remove();

        let generatedTargetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=responseHandler:handleGoogleSheetResponse&headers=1`;
        let script = document.createElement('script');
        script.id = 'googlesheet-jsonp-script';
        script.src = generatedTargetUrl;
        document.body.appendChild(script);
    }
}

function syncAllRecordsToGoogleSheet() {
    let targetUrl = localStorage.getItem('user_local_web_app_url');
    if (!targetUrl) return Promise.resolve();

    const records = localEvents.map(event => ({ ...event.extendedProps }));
    return postWebAppData(targetUrl, { action: 'replaceAll', records })
        .then(result => {
            if (result.result !== 'success') throw new Error(result.message || '전체 기록 동기화에 실패했습니다.');
        })
        .catch(error => console.error('구글 시트 동기화 오류:', error));
}

function sendDataToGoogleSheet() {
    return syncAllRecordsToGoogleSheet();
}

