// ==========================================
// 👑 MAIN APP: 상태 캐시, 달력 및 UI 제어
// ==========================================
let localEvents = []; 
let uniqueTitles = []; 
let currentSelectedEventId = null;
let currentSelectedGameTitle = ""; 
let calendar = null;
let shortPlaytimeCollapseScheduled = false;
let calendarHoverCard = null;
const steamAchievementCache = new Map();
const DEFAULT_PLATFORM_SETTINGS = [
    ['steam', '#1044a0'], ['xbox gamepass', '#107c10'], ['Switch', '#ffb0b0'], ['Switch2', '#e60012'], ['ps4', '#b0b0ff'], ['ps5', '#4a148c'], ['stove', '#ffa259'], ['epic', '#00a3ff'], ['mobile', '#2d2d2d'], ['DLC', '#888888'], ['기타', '#b0bec5']
].map(([name, color]) => ({ name, color }));

function getBetaSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('game_effect_beta_settings') || '{}');
        return {
            platforms: Array.isArray(saved.platforms) ? saved.platforms : DEFAULT_PLATFORM_SETTINGS,
            calendarBlockStyle: saved.calendarBlockStyle || 'merged',
            showSteamTotalOnCalendar: Boolean(saved.showSteamTotalOnCalendar),
            themeMode: saved.themeMode || 'dark'
        };
    } catch { return { platforms: DEFAULT_PLATFORM_SETTINGS, calendarBlockStyle: 'merged', showSteamTotalOnCalendar: false, themeMode: 'dark' }; }
}
function saveBetaSettings(settings) { localStorage.setItem('game_effect_beta_settings', JSON.stringify(settings)); }
function recordEditHistory(action, title, snapshot = localEvents, details = []) {
    let history = JSON.parse(localStorage.getItem('game_effect_edit_history') || '[]');
    history.unshift({ action, title, at: new Date().toLocaleString('ko-KR'), snapshot: JSON.stringify(snapshot), details });
    localStorage.setItem('game_effect_edit_history', JSON.stringify(history.slice(0, 5)));
}

function describeRecordChanges(before, after) {
    const display = (value, fallback = '없음') => String(value || fallback);
    const changes = [];
    const fields = [
        ['title', '게임 이름'], ['startDate', '시작 날짜'], ['endDate', '끝낸 날짜'], ['platform', '플랫폼'], ['time', '플레이 시간'], ['isEnding', '엔딩 상태']
    ];
    fields.forEach(([key, label]) => {
        if (String(before[key] ?? '') !== String(after[key] ?? '')) {
            const suffix = key === 'time' ? '시간' : '';
            changes.push(`${label}: ${display(before[key])}${suffix} → ${display(after[key])}${suffix}`);
        }
    });
    let beforeMemo = String(before.memo || '');
    if (beforeMemo.startsWith('[{') && beforeMemo.endsWith('}]')) {
        try { beforeMemo = JSON.parse(beforeMemo).map(item => `[${item.date}] ${item.text}`).join('\n'); } catch (_) {}
    }
    if (beforeMemo.trim() !== String(after.memo || '').trim()) changes.push('메모 내용 변경');
    return changes;
}

function saveToLocalStorage() {
    localStorage.setItem('cached_game_events', JSON.stringify(localEvents));
}

function syncAllRecordsSafely() {
    if (typeof syncAllRecordsToGoogleSheet !== 'function') {
        console.warn('최신 sheet.js가 아직 배포되지 않아 구글 시트 동기화를 건너뜁니다.');
        return Promise.resolve();
    }
    return syncAllRecordsToGoogleSheet();
}

function saveConnectionSettings() {
    const sheetUrl = document.getElementById('spreadsheetUrlInput')?.value.trim() || '';
    const webAppUrl = document.getElementById('webAppUrlInput')?.value.trim() || '';
    const steamId = document.getElementById('steamIdInput')?.value.trim() || '';
    const saved = [];

    if (sheetUrl) {
        localStorage.setItem('saved_game_sheet_url', sheetUrl);
        saved.push('스프레드시트 주소');
    }
    if (webAppUrl) {
        localStorage.setItem('user_local_web_app_url', webAppUrl);
        saved.push('시트 저장 주소');
    }
    if (steamId) {
        if (!/^\d{17}$/.test(steamId)) {
            alert('SteamID64는 17자리 숫자로 입력해 주세요.');
            return;
        }
        localStorage.setItem('user_steam_id', steamId);
        localStorage.removeItem('user_steam_api_key');
        saved.push('SteamID64');
    }
    if (saved.length === 0) {
        alert('저장할 연결 정보를 하나 이상 입력해 주세요.');
        return;
    }
    alert(`${saved.join(', ')}를 이 브라우저에 저장했습니다.`);
}

async function copySpreadsheetGuideCode() {
    const code = document.getElementById('spreadsheetAppsScriptCode')?.textContent?.trim();
    const button = document.getElementById('copySpreadsheetGuideButton');
    if (!code || !button) return;

    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(code);
    } catch (_) {
        const temporary = document.createElement('textarea');
        temporary.value = code;
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        document.body.appendChild(temporary);
        temporary.select();
        const copied = document.execCommand('copy');
        temporary.remove();
        if (!copied) {
            alert('자동 복사에 실패했습니다. 코드를 직접 선택해 복사해 주세요.');
            return;
        }
    }

    const originalText = button.textContent;
    button.textContent = '✅ 복사 완료';
    setTimeout(() => { button.textContent = originalText; }, 1800);
}

function getSteamTitleLinks() {
    try { return JSON.parse(localStorage.getItem('steam_title_appid_links') || '{}'); }
    catch (error) { return {}; }
}

function getSteamAppIdForTitle(title) {
    return getSteamTitleLinks()[String(title || '').trim().toLocaleLowerCase()] || '';
}

function saveSteamTitleLink(title, steamAppId) {
    const links = getSteamTitleLinks();
    links[String(title || '').trim().toLocaleLowerCase()] = String(steamAppId || '');
    localStorage.setItem('steam_title_appid_links', JSON.stringify(links));
}

function getGameIdentity(gameOrEvent) {
    const game = gameOrEvent?.extendedProps || gameOrEvent || {};
    const steamAppId = String(game.steamAppId || '').trim();
    if (steamAppId) return `steam:${steamAppId}`;
    return `title:${String(game.title || '').trim().toLocaleLowerCase()}`;
}

function getRecordStartYear(gameOrEvent) {
    const game = gameOrEvent?.extendedProps || gameOrEvent || {};
    return String(game.startDate || '').split('-')[0];
}

function isGameFinished(endingStatus) {
    const status = String(endingStatus || '').trim();
    return status === 'o' || status.includes('엔딩') || status.includes('%');
}

function getSameGameEvents(gameOrEvent) {
    const identity = getGameIdentity(gameOrEvent);
    return localEvents.filter(event => getGameIdentity(event) === identity);
}

function getMemoEntriesForSteamMerge(event) {
    const game = event.extendedProps || {};
    const memo = String(game.memo || '').trim();
    if (!memo) return [];
    if (memo.startsWith('[{') && memo.endsWith('}]')) {
        try {
            const entries = JSON.parse(memo);
            if (Array.isArray(entries)) {
                return entries
                    .filter(entry => entry && String(entry.text || '').trim())
                    .map(entry => ({ date: String(entry.date || game.startDate), text: String(entry.text).trim() }));
            }
        } catch { /* 일반 메모 형식으로 이어서 처리 */ }
    }
    return memo.split('\n').filter(Boolean).map(line => {
        const matched = line.match(/^\[(.*?)\]\s*(.*)$/);
        return matched
            ? { date: matched[1], text: matched[2] }
            : { date: game.startDate, text: line };
    }).filter(entry => entry.text.trim());
}

function mergeSameDaySteamRecords() {
    const groups = new Map();
    localEvents.forEach(event => {
        const game = event.extendedProps || {};
        const appId = String(game.steamAppId || '').trim();
        const startDate = String(game.startDate || '');
        const endDate = String(game.rawEndDate || game.endDate || startDate);
        const isSingleDaySteamRecord = String(game.platform || '').toLocaleLowerCase() === 'steam'
            && /^\d+$/.test(appId)
            && startDate
            && startDate === endDate;
        if (!isSingleDaySteamRecord) return;
        const key = `${appId}\u001F${startDate}`;
        const records = groups.get(key) || [];
        records.push(event);
        groups.set(key, records);
    });

    const duplicateGroups = [...groups.values()].filter(records => records.length > 1);
    if (duplicateGroups.length === 0) {
        alert('합칠 같은 날짜의 Steam 기록이 없습니다. Steam AppID가 연결된 하루 기록만 처리합니다.');
        return;
    }
    const extraRecordCount = duplicateGroups.reduce((count, records) => count + records.length - 1, 0);
    if (!confirm(`같은 Steam AppID·같은 날짜로 겹친 기록 ${duplicateGroups.length}묶음을 합칠까요?\n\n${extraRecordCount}개 기록이 합쳐집니다. 플레이시간은 더하고, 가장 최신 Steam 누적시간과 기존 메모는 보존합니다.`)) return;

    recordEditHistory('같은 날짜 Steam 기록 합치기', `${duplicateGroups.length}묶음`, localEvents);
    const removedIds = new Set();
    duplicateGroups.forEach(records => {
        const ordered = [...records].sort((left, right) => {
            const leftTotal = Number(left.extendedProps.steamTotal);
            const rightTotal = Number(right.extendedProps.steamTotal);
            const leftHasTotal = Number.isFinite(leftTotal);
            const rightHasTotal = Number.isFinite(rightTotal);
            if (leftHasTotal !== rightHasTotal) return Number(rightHasTotal) - Number(leftHasTotal);
            if (leftHasTotal && leftTotal !== rightTotal) return rightTotal - leftTotal;
            return Number(right.extendedProps.time || 0) - Number(left.extendedProps.time || 0);
        });
        const target = ordered[0];
        const targetGame = target.extendedProps;
        const totalTime = records.reduce((sum, event) => sum + (Number(event.extendedProps.time) || 0), 0);
        const steamTotals = records
            .map(event => Number(event.extendedProps.steamTotal))
            .filter(Number.isFinite);
        const memos = records.flatMap(getMemoEntriesForSteamMerge);
        const uniqueMemos = [...new Map(memos.map(entry => [`${entry.date}\u001F${entry.text}`, entry])).values()];

        targetGame.time = Number(totalTime.toFixed(1));
        targetGame.steamTotal = steamTotals.length ? Math.max(...steamTotals) : null;
        targetGame.isEnding = records.some(event => isGameFinished(event.extendedProps.isEnding)) ? 'o' : targetGame.isEnding;
        targetGame.memo = uniqueMemos.length ? JSON.stringify(uniqueMemos) : '';
        targetGame.endDate = '';
        targetGame.rawEndDate = targetGame.startDate;
        target.backgroundColor = determineEventColor(targetGame);
        ordered.slice(1).forEach(event => removedIds.add(event.id));
    });

    localEvents = localEvents.filter(event => !removedIds.has(event.id));
    uniqueTitles = [];
    saveToLocalStorage();
    refreshUI();
    syncAllRecordsSafely();
    alert(`같은 날짜 Steam 기록을 ${duplicateGroups.length}묶음으로 합쳤습니다.`);
}

function getSmartGameColor(title) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash % 360)}, 65%, 45%)`;
}

function determineEventColor(gameObj) {
    let p = gameObj.platform ? gameObj.platform.trim().toLowerCase() : '';
    const setting = getBetaSettings().platforms.find(item => String(item.name).trim().toLowerCase() === p);
    if (setting?.color) return setting.color;
    return getSmartGameColor(gameObj.title);     
}

function renderPlatformOptions(selectId, selected = '') {
    const select = document.getElementById(selectId); if (!select) return;
    select.innerHTML = getBetaSettings().platforms.map(item => `<option value="${item.name}" ${item.name === selected ? 'selected' : ''}>${item.name}</option>`).join('');
}

function addDays(dateStr, days) {
    let d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

function getDatesInRange(startDate, endDate) {
    const dates = [];
    let current = new Date(`${startDate}T00:00:00`);
    const last = new Date(`${endDate}T00:00:00`);
    while (!isNaN(current.getTime()) && current <= last) {
        dates.push(formatLocalDate(current));
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

function getGameTotalPlayTime(games) {
    const steamTotals = games
        .filter(event => event.extendedProps.steamTotal !== null && event.extendedProps.steamTotal !== '' && Number.isFinite(Number(event.extendedProps.steamTotal)))
        .sort((left, right) => String(left.extendedProps.startDate || '').localeCompare(String(right.extendedProps.startDate || '')));
    if (steamTotals.length) return Number(steamTotals[steamTotals.length - 1].extendedProps.steamTotal);
    return games.reduce((sum, event) => sum + Number(event.extendedProps.time || 0), 0);
}

function buildDailyCalendarEvents() {
    const gamesByIdentity = new Map();
    localEvents.forEach(event => {
        const key = getGameIdentity(event);
        const games = gamesByIdentity.get(key) || [];
        games.push(event);
        gamesByIdentity.set(key, games);
    });

    const calendarEvents = [];
    gamesByIdentity.forEach(games => {
        games.sort((first, second) => {
            const firstDate = first.extendedProps.startDate || '';
            const secondDate = second.extendedProps.startDate || '';
            return firstDate.localeCompare(secondDate) || first.id.localeCompare(second.id);
        });
        const totalPlayTime = getGameTotalPlayTime(games);

        games.forEach(event => {
            const game = event.extendedProps;
            const dates = getDatesInRange(game.startDate, game.rawEndDate || game.endDate || game.startDate);
            if (dates.length === 0) return;
            const hasExactDailySteamTime = game.steamTotal !== null && game.steamTotal !== '' && Number.isFinite(Number(game.steamTotal)) && dates.length === 1;
            if (hasExactDailySteamTime) {
                calendarEvents.push({
                    id: `${event.id}_${dates[0]}`,
                    title: event.title,
                    start: dates[0],
                    end: addDays(dates[0], 1),
                    backgroundColor: event.backgroundColor || determineEventColor(game),
                    extendedProps: {
                        ...game,
                        originalEventId: event.id,
                        totalPlayTime,
                        displayTotalTime: Number(game.steamTotal),
                        dailyIncrease: Number(game.time || 0),
                        hasExactDailySteamTime: true
                    }
                });
            } else {
                if (getBetaSettings().calendarBlockStyle === 'separate' && dates.length > 1) {
                    dates.forEach(date => calendarEvents.push({ ...event, id: `${event.id}_${date}`, start: date, end: addDays(date, 1), extendedProps: { ...game, originalEventId: event.id, totalPlayTime } }));
                } else {
                    calendarEvents.push({ ...event, extendedProps: { ...game, originalEventId: event.id, totalPlayTime } });
                }
            }
        });
    });
    return calendarEvents;
}

function hideCalendarHoverCard() {
    calendarHoverCard?.remove();
    calendarHoverCard = null;
}

function getSteamAchievementProgress(steamId, steamAppId) {
    const cacheKey = `${steamId}:${steamAppId}`;
    if (!steamAchievementCache.has(cacheKey)) {
        const request = fetch(`/api/steam-achievements?steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(steamAppId)}`)
            .then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '업적 정보를 불러오지 못했습니다.');
                return data;
            });
        steamAchievementCache.set(cacheKey, request);
    }
    return steamAchievementCache.get(cacheKey);
}

function showCalendarHoverCard(info) {
    const game = info.event.extendedProps;
    const steamAppId = String(game.steamAppId || '').trim();
    const steamId = getSteamCredentials?.().steamId || '';
    hideCalendarHoverCard();

    const card = document.createElement('div');
    card.className = 'calendar-hover-card';
    card.dataset.eventId = info.event.id;
    const rect = info.el.getBoundingClientRect();
    card.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    card.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 180)}px`;

    if (/^\d+$/.test(steamAppId)) {
        const thumbnail = document.createElement('img');
        thumbnail.className = 'calendar-hover-thumbnail';
        thumbnail.src = `https://cdn.akamai.steamstatic.com/steam/apps/${steamAppId}/header.jpg`;
        thumbnail.alt = '';
        thumbnail.onerror = () => thumbnail.remove();
        card.appendChild(thumbnail);
    }

    const title = document.createElement('strong');
    title.textContent = info.event.title;
    const playtime = document.createElement('span');
    playtime.textContent = `누적 플레이시간: ${Number(game.totalPlayTime ?? game.steamTotal ?? game.time ?? 0).toFixed(1)}시간`;
    const achievement = document.createElement('span');
    achievement.className = 'calendar-hover-achievement';
    card.append(title, playtime);
    document.body.appendChild(card);
    calendarHoverCard = card;

    if (!/^\d+$/.test(steamAppId) || !/^\d{17}$/.test(steamId)) {
        return;
    }

    getSteamAchievementProgress(steamId, steamAppId)
        .then(data => {
            if (calendarHoverCard !== card) return;
            if (!data.available || !data.totalCount) {
                return;
            }
            achievement.textContent = `업적 진행도: ${data.achievedCount} / ${data.totalCount}`;
            card.appendChild(achievement);
        })
        .catch(() => {});
}

function scheduleShortPlaytimeCollapse() {
    if (shortPlaytimeCollapseScheduled) return;
    shortPlaytimeCollapseScheduled = true;
    requestAnimationFrame(() => {
        shortPlaytimeCollapseScheduled = false;
        document.querySelectorAll('.fc-daygrid-day').forEach(day => {
            day.querySelector('.short-playtime-toggle')?.remove();
            day.querySelectorAll('.fc-daygrid-event-harness').forEach(harness => harness.classList.remove('is-short-playtime-hidden'));

            const shortHarnesses = [...day.querySelectorAll('.fc-daygrid-event-harness[data-short-playtime="true"]')];
            if (shortHarnesses.length < 3) return;

            let expanded = false;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'short-playtime-toggle';
            const update = () => {
                shortHarnesses.forEach(harness => harness.classList.toggle('is-short-playtime-hidden', !expanded));
                button.innerText = expanded
                    ? `▴ 1시간 이하 기록 ${shortHarnesses.length}개 접기`
                    : `▾ 1시간 이하 기록 ${shortHarnesses.length}개 보기`;
            };
            button.addEventListener('click', () => { expanded = !expanded; update(); });
            day.querySelector('.fc-daygrid-day-events')?.appendChild(button);
            update();
        });
    });
}

function SmartDateFormatter(inputStr) {
    if (!inputStr || !inputStr.trim()) return '';
    let clean = inputStr.replace(/[^0-9]/g, '-').replace(/-+/g, '-');
    if (clean.endsWith('-')) clean = clean.slice(0, -1);
    let parts = clean.split('-');
    let currentYear = new Date().getFullYear();
    if (parts.length === 2) {
        return `${currentYear}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    } else if (parts.length === 3) {
        let yy = parts[0].length === 2 ? '20' + parts[0] : parts[0];
        return `${yy}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
    return inputStr;
}

function getValidatedDate(inputStr) {
    let formatted = SmartDateFormatter(inputStr);
    if (!formatted) return '';

    let matches = formatted.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!matches) return null;

    let year = Number(matches[1]);
    let month = Number(matches[2]);
    let day = Number(matches[3]);
    let date = new Date(Date.UTC(year, month - 1, day));
    let isValid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return isValid ? formatted : null;
}

function switchTab(viewId) {
    document.querySelectorAll('.content-view').forEach(view => view.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(viewId)) {
            btn.classList.add('active');
        }
    });
    
    if (viewId === 'calendar-view' && calendar) { 
        calendar.updateSize();
    }
    if ((viewId === 'report-view' || viewId === 'list-view') && localEvents.length > 0) { refreshUI(); }
}

function searchGameTitles(keyword) {
    let listEl = document.getElementById('autocompleteList');
    listEl.innerHTML = '';
    if (!keyword.trim()) { listEl.style.display = 'none'; return; }
    let matches = uniqueTitles.filter(title => title.toLowerCase().includes(keyword.trim().toLowerCase()));
    if (matches.length > 0) {
        matches.forEach(match => {
            let item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.innerText = match;
            item.onclick = function() {
                document.getElementById('gameName').value = match;
                listEl.style.display = 'none';
                autoFillPrevTime(match);
            };
            listEl.appendChild(item);
        });
        listEl.style.display = 'block';
    } else { listEl.style.display = 'none'; }
}

function executeLiveGameSearch() {
    let titleKeyword = document.getElementById('searchTitleInput').value.trim().toLowerCase();
    let steamAppIdKeyword = document.getElementById('searchSteamAppIdInput').value.trim();
    let dateKeyword = document.getElementById('searchDateInput').value.trim();

    if (titleKeyword || steamAppIdKeyword || dateKeyword) {
        document.querySelectorAll('.content-view').forEach(view => view.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('list-view').classList.add('active');
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes('list-view')) {
                btn.classList.add('active');
            }
        });
    }

    buildAggregatedCards('list-container', null, titleKeyword, dateKeyword, steamAppIdKeyword);
}

function isGameInSearchDate(gStart, gEnd, query) {
    gStart = gStart.trim();
    gEnd = gEnd.trim() !== '' ? gEnd.trim() : '9999-12-31'; 
    query = query.trim();

    if (query.includes('~')) {
        let parts = query.split('~');
        let qStart = SmartDateFormatter(parts[0].trim());
        let qEnd = SmartDateFormatter(parts[1].trim());
        if (!qStart || !qEnd) return false;
        return (gStart <= qEnd && gEnd >= qStart);
    } else {
        let qStart = query;
        let qEnd = query;
        if (query.length === 4) {
            qStart = `${query}-01-01`; qEnd = `${query}-12-31`;
        } else if (query.length === 7) {
            qStart = `${query}-01`; qEnd = `${query}-31`;
        }
        return (gStart <= qEnd && gEnd >= qStart);
    }
}

function clearSearchFilters() {
    document.getElementById('searchTitleInput').value = '';
    document.getElementById('searchSteamAppIdInput').value = '';
    document.getElementById('searchDateInput').value = '';
    refreshUI();
}

function handleGameSubmit(event) {
    event.preventDefault();
    let name = document.getElementById('gameName').value.trim();
    let inputTime = parseFloat(document.getElementById('gameTime').value);
    let startDate = getValidatedDate(document.getElementById('gameStart').value);
    let endDate = getValidatedDate(document.getElementById('gameEnd').value);
    let platform = document.getElementById('gamePlatform').value;
    let checkEnding = document.getElementById('gameIsEnding').checked;

    if (startDate === null || endDate === null) {
        alert("날짜를 올바르게 입력해 주세요. (예: 2026-07-01 또는 07-01)");
        return;
    }

    let todayStr = new Date().toISOString().split('T')[0];
    let endingStatusValue = checkEnding ? 'o' : 'x';

    if (checkEnding) {
        let submittedGame = { title: name, steamAppId: platform === 'steam' ? getSteamAppIdForTitle(name) : '' };
        let previousEndingsCount = getSameGameEvents(submittedGame).filter(e => e.extendedProps.isEnding === 'o' || e.extendedProps.isEnding.includes('엔딩')).length;
        if (previousEndingsCount > 0) endingStatusValue = `엔딩 ${previousEndingsCount + 1}`;
    }

    let calculatedEnd = todayStr;
    let isTimeOnly = !startDate;

    if (isTimeOnly) {
        let existEvents = getSameGameEvents({ title: name, steamAppId: platform === 'steam' ? getSteamAppIdForTitle(name) : '' });
        if (existEvents.length > 0) {
            let lastEvent = existEvents.reduce((prev, current) => {
                let prevEnd = prev.extendedProps.rawEndDate || prev.extendedProps.startDate;
                let currEnd = current.extendedProps.rawEndDate || current.extendedProps.startDate;
                return (new Date(prevEnd) > new Date(currEnd)) ? prev : current;
            });
            let baseLastDate = lastEvent.extendedProps.rawEndDate || lastEvent.extendedProps.startDate;
            startDate = addDays(baseLastDate, 1);
            if (new Date(startDate) > new Date(todayStr)) { startDate = todayStr; }
        } else {
            startDate = todayStr;
        }
        calculatedEnd = endDate ? SmartDateFormatter(endDate) : todayStr;
    } else {
        calculatedEnd = endDate ? SmartDateFormatter(endDate) : startDate;
    }

    if (calculatedEnd < startDate) {
        alert("종료 날짜는 시작 날짜보다 빠를 수 없습니다.");
        return;
    }

    let newGame = createGameObj(name, startDate, calculatedEnd, platform, inputTime, endingStatusValue, '', '', checkEnding, platform === 'steam' ? getSteamAppIdForTitle(name) : '');
    recordEditHistory('기록 추가', name, localEvents, [`시작 날짜: ${startDate}`, `플랫폼: ${platform}`, `플레이 시간: ${inputTime}시간`]);
    localEvents.push(newGame);

    refreshUI();
    saveToLocalStorage();
    
    sendDataToGoogleSheet(newGame.extendedProps);
    
    document.getElementById('gameForm').reset();
    document.getElementById('autocompleteList').style.display = 'none';
}

function createGameObj(name, start, end, platform, time, endingStatus, memo, review, isCheckEnding = false, steamAppId = '', steamTotal = null) {
    let uniqueId = 'evt_' + Math.random().toString(36).substr(2, 9);
    // 가져온 기록은 시작일을 기준으로 표시합니다. 시작일이 비어 있을 때만 종료일을
    // 시작일로 사용하며, 종료일이 비어 있으면 시작일 하루짜리 기록으로 처리합니다.
    let normalizedStart = start || end;
    let normalizedEnd = end || normalizedStart;
    let displayEnd = normalizedEnd === normalizedStart ? '' : normalizedEnd; 
    
    let gameObj = {
        id: uniqueId, title: name, startDate: normalizedStart, endDate: displayEnd, rawEndDate: normalizedEnd,
        platform: platform, time: parseFloat(time || 0), isEnding: endingStatus, memo: memo || '', review: review || '',
        steamAppId: String(steamAppId || (String(platform).toLocaleLowerCase() === 'steam' ? getSteamAppIdForTitle(name) : '')),
        steamTotal: steamTotal !== null && steamTotal !== '' && Number.isFinite(Number(steamTotal)) ? Number(steamTotal) : null
    };

    let eventObj = { id: uniqueId, title: name, start: normalizedStart, extendedProps: gameObj };
    eventObj.backgroundColor = determineEventColor(gameObj);

    let calcEnd = new Date(normalizedEnd);
    if (!isNaN(calcEnd.getTime())) {
        calcEnd.setDate(calcEnd.getDate() + 1);
        eventObj.end = calcEnd.toISOString().split('T')[0];
    } else {
        eventObj.end = normalizedStart;
    }
    return eventObj;
}

function buildAggregatedCards(targetContainerId, targetYear = null, titleFilter = "", dateFilter = "", steamAppIdFilter = "", sortMode = "playtime") {
    let container = document.getElementById(targetContainerId);
    container.innerHTML = '';
    let sourceList = localEvents;
    
    // 연도별 요약과 시트 저장은 모두 기록의 시작일을 기준으로 합니다.
    if (targetYear) { sourceList = localEvents.filter(evt => getRecordStartYear(evt) === targetYear); }
    
    if (titleFilter || dateFilter || steamAppIdFilter) {
        sourceList = sourceList.filter(evt => {
            let game = evt.extendedProps;
            let matchTitle = titleFilter ? game.title.toLowerCase().includes(titleFilter) : true;
            let matchDate = dateFilter ? isGameInSearchDate(game.startDate, game.rawEndDate || game.startDate, dateFilter) : true;
            let matchSteamAppId = steamAppIdFilter ? String(game.steamAppId || '').includes(steamAppIdFilter) : true;
            return matchTitle && matchDate && matchSteamAppId;
        });
    }

    if (sourceList.length === 0) { container.innerHTML = '<div style="color:#9ca3af; padding:10px;">기록된 플레이 목록이 없습니다.</div>'; return; }

    let gameSummaries = new Map();

    sourceList.forEach(evt => {
        let game = evt.extendedProps;
        let key = getGameIdentity(game);
        let summary = gameSummaries.get(key) || {
            title: game.title, time: 0, platform: game.platform, hasEnded: false,
            eventId: evt.id, startDate: game.startDate || ''
        };
        summary.time += Number(game.time) || 0;
        if (isGameFinished(game.isEnding)) summary.hasEnded = true;
        if (game.startDate && (!summary.startDate || game.startDate < summary.startDate)) summary.startDate = game.startDate;
        gameSummaries.set(key, summary);
    });

    let timeLabelText = targetYear ? "해당 연도 플레이 시간" : "총 플레이타임";
    const summaries = [...gameSummaries.values()].sort((left, right) => {
        if (sortMode === 'startDate') {
            const dateOrder = String(right.startDate || '').localeCompare(String(left.startDate || ''));
            if (dateOrder) return dateOrder;
        } else if (sortMode === 'ending') {
            const endingOrder = Number(right.hasEnded) - Number(left.hasEnded);
            if (endingOrder) return endingOrder;
        }
        const timeOrder = right.time - left.time;
        return timeOrder || left.title.localeCompare(right.title, 'ko');
    });

    for (let summary of summaries) {
        let title = summary.title;
        let aggregatedTime = summary.time;
        let platform = summary.platform;
        let cardColor = determineEventColor({ title: title, platform: platform });
        let hasEnded = summary.hasEnded;

        let card = document.createElement('div');
        card.className = 'game-card';
        card.style.borderLeft = `6px solid ${cardColor}`;
        
        let badgeHTML = hasEnded ? '<div class="card-ending-badge">🏆 엔딩 완료</div>' : '';
        let startInfoHTML = targetYear ? '<div class="card-info">📅 첫 시작일: ' + (summary.startDate || '-') + '</div>' : '';
        card.innerHTML = `
            ${badgeHTML}
            <div class="card-title">${title}</div>
            <div class="card-info" style="font-size: 1.1em; margin-top: 10px;">⏱ ${timeLabelText}: <span style="color:#818cf8; font-size:1.2em;">${aggregatedTime.toFixed(1)}</span> 시간</div>
            ${startInfoHTML}
        `;
        card.addEventListener('click', () => { openDetailModalById(summary.eventId); });
        container.appendChild(card);
    }
}

function calculateYearlyReport(targetYear) {
    let filteredEvents = localEvents.filter(evt => getRecordStartYear(evt) === targetYear);
    if (filteredEvents.length === 0) {
        document.getElementById('statTotalTime').innerText = '0 시간';
        document.getElementById('statEndingCount').innerText = '0 개';
        document.getElementById('statMostPlayedGame').innerText = '-';
        document.getElementById('statMostPlayedTime').innerText = '0h 플레이';
        document.getElementById('statLongestMemo').innerText = '-';
        document.getElementById('year-list-container').innerHTML = '';
        return;
    }

    let totalTime = 0; let gameTimeMap = new Map(); let uniqueEndedGamesInYear = new Set(); let latestReviewText = "-"; let maxStartDate = "";

    filteredEvents.forEach(evt => {
        let game = evt.extendedProps; let t = Number(game.time) || 0; totalTime += t;
        let key = getGameIdentity(game);
        let summary = gameTimeMap.get(key) || { title: game.title, time: 0 };
        summary.time += t;
        gameTimeMap.set(key, summary);
        if (isGameFinished(game.isEnding)) { uniqueEndedGamesInYear.add(key); }
        if (game.review && game.review.trim() !== '') {
            if (game.startDate > maxStartDate) { maxStartDate = game.startDate; latestReviewText = `[${game.title}] ${game.review}`; }
        }
    });

    let mostPlayedGame = '-'; let mostPlayedTime = 0;
    for (let summary of gameTimeMap.values()) { if (summary.time > mostPlayedTime) { mostPlayedTime = summary.time; mostPlayedGame = summary.title; } }

    document.getElementById('statTotalTime').innerText = totalTime.toFixed(1) + ' 시간';
    document.getElementById('statEndingCount').innerText = uniqueEndedGamesInYear.size + ' 개';
    document.getElementById('statMostPlayedGame').innerText = mostPlayedGame;
    document.getElementById('statMostPlayedTime').innerText = mostPlayedTime.toFixed(1) + 'h 올해 순수 플레이';
    document.getElementById('statLongestMemo').innerText = latestReviewText;

    const sortMode = document.getElementById('reportSortSelect')?.value || 'playtime';
    buildAggregatedCards('year-list-container', targetYear, '', '', '', sortMode);
}

function formatLocalDate(date) {
    let year = date.getFullYear();
    let month = String(date.getMonth() + 1).padStart(2, '0');
    let day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function renderTopGames() {
    let container = document.getElementById('recentWeekGames');
    if (!container) return;

    let today = new Date();
    today.setHours(0, 0, 0, 0);
    let weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);
    let todayText = formatLocalDate(today);
    let weekStartText = formatLocalDate(weekStart);

    let gamesByTitle = new Map();
    localEvents.forEach(event => {
        let game = event.extendedProps;
        let title = (game.title || event.title || '').trim();
        let startDate = game.startDate || '';
        if (!title || startDate < weekStartText || startDate > todayText) return;

        let key = getGameIdentity(game);
        let current = gamesByTitle.get(key) || { title: title, time: 0, event: event };
        current.time += Number(game.time) || 0;
        if ((game.rawEndDate || game.startDate || '') >= (current.event.extendedProps.rawEndDate || current.event.extendedProps.startDate || '')) {
            current.event = event;
        }
        gamesByTitle.set(key, current);
    });

    let topGames = [...gamesByTitle.values()].sort((a, b) => b.time - a.time || a.title.localeCompare(b.title, 'ko'));

    container.innerHTML = '';
    if (topGames.length === 0) {
        let empty = document.createElement('div');
        empty.className = 'recent-week-empty';
        empty.innerText = '최근 7일에 기록한 게임이 없습니다.';
        container.appendChild(empty);
        return;
    }

    topGames.slice(0, 10).forEach((game, index) => {
        let item = document.createElement('div');
        item.className = 'recent-week-item';
        item.addEventListener('click', () => openDetailModalById(game.event.id));

        let title = document.createElement('span');
        title.className = 'recent-week-game';
        title.innerText = `${index + 1}. ${game.title}`;

        let meta = document.createElement('span');
        meta.className = 'recent-week-meta';
        meta.innerText = `${game.time.toFixed(1)}h`;

        item.append(title, meta);
        container.appendChild(item);
    });
}

function refreshUI() {
    let yearSelect = document.getElementById('reportYearSelect');
    let currentSelectedYear = yearSelect.value;
    let yearsFound = [];

    localEvents.forEach(e => {
        let t = e.title.trim();
        if (t && !uniqueTitles.includes(t)) uniqueTitles.push(t);
        let startY = getRecordStartYear(e);
        if (startY && !yearsFound.includes(startY)) yearsFound.push(startY);
    });

    yearsFound.sort((a,b) => b - a);
    yearSelect.innerHTML = '';
    yearsFound.forEach(y => {
        let opt = document.createElement('option'); opt.value = y; opt.innerText = y + ' 년';
        yearSelect.appendChild(opt);
    });

    if (currentSelectedYear && yearsFound.includes(currentSelectedYear)) yearSelect.value = currentSelectedYear;
    else if (yearsFound.length > 0) yearSelect.value = yearsFound[0];

    if (calendar) { calendar.refetchEvents(); }
    let activeTitleKeyword = document.getElementById('searchTitleInput').value.trim().toLowerCase();
    let activeSteamAppIdKeyword = document.getElementById('searchSteamAppIdInput').value.trim();
    let activeDateKeyword = document.getElementById('searchDateInput').value.trim();
    buildAggregatedCards('list-container', null, activeTitleKeyword, activeDateKeyword, activeSteamAppIdKeyword);
    if (yearSelect.value) calculateYearlyReport(yearSelect.value);
    renderTopGames();
}

function openDetailModalById(id) {
    let targetEvent = localEvents.find(e => e.id === id);
    if (!targetEvent) return;
    
    let gameObj = targetEvent.extendedProps;
    currentSelectedEventId = id;
    currentSelectedGameTitle = gameObj.title;
    
    let sameGames = getSameGameEvents(gameObj);
    let totalAggTime = sameGames.reduce((acc, curr) => acc + curr.extendedProps.time, 0);
    
    document.getElementById('modalInfoGrid').style.display = 'grid';
    document.getElementById('modalGameTitle').innerHTML = gameObj.title;
    document.getElementById('modalGameTimeZone').innerHTML = `<span id="modalGameTime">${gameObj.time.toFixed(1)}</span> 시간 (전체 누적합: ${totalAggTime.toFixed(1)}h)`;
    document.getElementById('modalGameStartZone').innerHTML = `<span id="modalGameStart">${gameObj.startDate}</span>`;
    document.getElementById('modalGameEndZone').innerHTML = `<span id="modalGameEnd">${gameObj.endDate ? gameObj.endDate : '진행 중'}</span>`;
    document.getElementById('modalGameTrophyZone').innerHTML = `<span id="modalGameTrophy">${gameObj.isEnding && gameObj.isEnding !== 'x' ? '🏆 엔딩 완료' : '진행 중'}</span>`;
    document.getElementById('modalGamePlatformZone').innerHTML = `<span id="modalGamePlatform">${gameObj.platform}</span>`;
    document.getElementById('modalSteamLinkZone').innerHTML = gameObj.steamAppId
        ? `연결됨 (AppID: ${gameObj.steamAppId})`
        : '아직 연결하지 않았습니다.';
    
    let commonReview = "";
    let foundReviewNode = sameGames.find(e => e.extendedProps.review && e.extendedProps.review.trim() !== "");
    if (foundReviewNode) commonReview = foundReviewNode.extendedProps.review;
    
    let reviewBox = document.getElementById('modalGameReviewBox');
    reviewBox.innerText = commonReview ? commonReview : "";
    reviewBox.contentEditable = "true";
    reviewBox.onblur = function() {
        let updatedReviewText = this.innerText.trim();
        getSameGameEvents(gameObj).forEach(evt => { evt.extendedProps.review = updatedReviewText; });
        saveToLocalStorage();
        syncAllRecordsSafely();
    };

    rebuildTimelineUI(sameGames);
    
    document.getElementById('quickMemoZone').style.display = 'block';
    document.getElementById('btnEdit').style.display = 'inline-block';
    document.getElementById('btnDelete').style.display = 'inline-block';
    document.getElementById('btnSteamLink').style.display = 'inline-block';
    document.getElementById('btnSave').style.display = 'none';
    document.getElementById('gameModal').style.display = "flex";
}

function openDetailModalByTitle(title) {
    let sameGames = localEvents.filter(e => e.title.toLowerCase() === title.toLowerCase());
    if (sameGames.length === 0) return;
    sameGames.sort((a,b) => new Date(a.extendedProps.startDate) - new Date(b.extendedProps.startDate));
    let latestEvent = sameGames[sameGames.length - 1];
    openDetailModalById(latestEvent.id);
}

function rebuildTimelineUI(gamesArray) {
    let timelineContainer = document.getElementById('modalGameMemoTimeline');
    timelineContainer.innerHTML = '';
    let allStructuredMemos = [];

    gamesArray.forEach(g => {
        let p = g.extendedProps;
        if (p.memo && p.memo.trim() !== '') {
            if (p.memo.startsWith('[{') && p.memo.endsWith('}]')) {
                try { let parsedArr = JSON.parse(p.memo); allStructuredMemos.push(...parsedArr); } catch(e) { allStructuredMemos.push({ date: p.startDate, text: p.memo }); }
            } else {
                let lines = p.memo.split('\n');
                lines.forEach(line => {
                    if (!line.trim()) return;
                    let match = line.match(/^\[(.*?)\]\s*(.*)$/);
                    if (match) { allStructuredMemos.push({ date: match[1], text: match[2] }); } else { allStructuredMemos.push({ date: p.startDate, text: line }); }
                });
            }
        }
    });

    allStructuredMemos.sort((a,b) => new Date(a.date.split('~')[0].trim()) - new Date(b.date.split('~')[0].trim()));

    let validMemoCount = 0;
    allStructuredMemos.forEach(m => {
        validMemoCount++;
        let item = document.createElement('div'); item.className = 'timeline-item';
        item.innerHTML = `<div class="timeline-date">📅 기록 기간: ${m.date}</div><div class="timeline-text">${m.text}</div>`;
        timelineContainer.appendChild(item);
    });

    if (validMemoCount === 0) { timelineContainer.innerHTML = '<div style="color:#9ca3af; padding:5px; font-size:0.9em;">아직 연동되어 쌓인 세션 메모 기록이 없습니다.</div>'; }
}

function submitInstantMemo() {
    let memoText = document.getElementById('modalInstantMemoInput').value.trim();
    let dateInput = document.getElementById('modalMemoDateInput').value.trim();
    if (!memoText) { alert("내용을 타이핑해 주세요!"); return; }

    let targetStartDate = ''; let activeRecord = localEvents.find(e => e.id === currentSelectedEventId);

    if (!dateInput) {
        if (activeRecord) { let p = activeRecord.extendedProps; targetStartDate = p.startDate + (p.endDate ? ` ~ ${p.endDate}` : ''); }
        else { targetStartDate = new Date().toISOString().split('T')[0]; }
    } else { targetStartDate = dateInput; }

    if (activeRecord) {
        let currentMemoArr = []; let oldMemo = activeRecord.extendedProps.memo ? activeRecord.extendedProps.memo.trim() : '';
        if (oldMemo.startsWith('[{') && oldMemo.endsWith('}]')) { try { currentMemoArr = JSON.parse(oldMemo); } catch(e){} }
        else if (oldMemo !== '') {
            let lines = oldMemo.split('\n');
            lines.forEach(line => {
                if (!line.trim()) return;
                let match = line.match(/^\[(.*?)\]\s*(.*)$/);
                if (match) currentMemoArr.push({ date: match[1], text: match[2] });
                else currentMemoArr.push({ date: activeRecord.extendedProps.startDate, text: line });
            });
        }
        currentMemoArr.push({ date: targetStartDate, text: memoText });
        activeRecord.extendedProps.memo = JSON.stringify(currentMemoArr);
        alert("한줄평 메모가 결합되었습니다!");
    }
    refreshUI();
    saveToLocalStorage();
    syncAllRecordsSafely();
    let selectedRecord = localEvents.find(event => event.id === currentSelectedEventId);
    rebuildTimelineUI(selectedRecord ? getSameGameEvents(selectedRecord) : []);
}

function enableEditMode() {
    let target = localEvents.find(e => e.id === currentSelectedEventId); let gameObj = target.extendedProps;
    document.getElementById('quickMemoZone').style.display = 'none';
    document.getElementById('btnSteamLink').style.display = 'none';
    document.getElementById('modalGameTitle').innerHTML = `<input type="text" id="editTitle" class="edit-input" value="${gameObj.title}">`;
    document.getElementById('modalGameTimeZone').innerHTML = `<input type="number" step="0.1" id="editTime" class="edit-input" value="${gameObj.time}"> 시간`;
    document.getElementById('modalGameStartZone').innerHTML = `<input type="text" id="editStart" class="edit-input" value="${gameObj.startDate}">`;
    document.getElementById('modalGameEndZone').innerHTML = `<input type="text" id="editEnd" class="edit-input" value="${gameObj.endDate}">`;
    
    document.getElementById('modalGameTrophyZone').innerHTML = `
        <select id="editEnding" class="edit-input">
            <option value="x" ${gameObj.isEnding === 'x'?'selected':''}>진행 중 (x)</option>
            <option value="o" ${gameObj.isEnding === 'o'?'selected':''}>엔딩 완료 (o)</option>
        </select>`;
        
    document.getElementById('modalGamePlatformZone').innerHTML = '<select id="editPlatform" class="edit-input"></select>';
    renderPlatformOptions('editPlatform', gameObj.platform);

    let rawTextForEdit = gameObj.memo || '';
    if (rawTextForEdit.startsWith('[{') && rawTextForEdit.endsWith('}]')) { try { let arr = JSON.parse(rawTextForEdit); rawTextForEdit = arr.map(m => `[${m.date}] ${m.text}`).join('\n'); } catch(e){} }
    document.getElementById('modalGameMemoTimeline').innerHTML = `<textarea id="editMemo" class="edit-input" style="height:60px; resize:none;">${rawTextForEdit}</textarea>`;
    document.getElementById('btnEdit').style.display = 'none'; document.getElementById('btnSave').style.display = 'inline-block';
}

function saveEditedData() {
    let target = localEvents.find(e => e.id === currentSelectedEventId); if (!target) return;
    let newTitle = document.getElementById('editTitle').value.trim(); let newTime = parseFloat(document.getElementById('editTime').value || 0);
    let newStart = getValidatedDate(document.getElementById('editStart').value); let newEnd = getValidatedDate(document.getElementById('editEnd').value);

    if (!newTitle || !Number.isFinite(newTime) || newStart === null || !newStart || newEnd === null) {
        alert("게임 이름, 플레이 시간, 시작 날짜을 올바르게 입력해 주세요.");
        return;
    }
    if (newEnd && newEnd < newStart) {
        alert("종료 날짜는 시작 날짜보다 빠를 수 없습니다.");
        return;
    }

    const beforeEdit = { ...target.extendedProps };
    const selectedPlatform = document.getElementById('editPlatform').value;
    const editDetails = describeRecordChanges(beforeEdit, {
        title: newTitle, time: newTime, startDate: newStart, endDate: newEnd || '',
        platform: selectedPlatform, isEnding: document.getElementById('editEnding').value,
        memo: document.getElementById('editMemo').value.trim()
    });
    if (String(beforeEdit.platform || '') !== String(selectedPlatform) && !editDetails.some(detail => detail.startsWith('플랫폼:'))) {
        editDetails.push(`플랫폼: ${beforeEdit.platform || '없음'} → ${selectedPlatform || '없음'}`);
    }
    if (editDetails.length === 0) {
        alert('변경한 내용이 없습니다.');
        return;
    }
    recordEditHistory('기록 수정', target.title, localEvents, editDetails);
    target.title = newTitle; target.start = newStart;
    let calcEnd = new Date(newEnd ? newEnd : newStart); calcEnd.setDate(calcEnd.getDate() + 1);
    target.end = calcEnd.toISOString().split('T')[0];

    target.extendedProps.title = newTitle; target.extendedProps.time = newTime; target.extendedProps.startDate = newStart;
    target.extendedProps.endDate = newEnd ? newEnd : ''; target.extendedProps.rawEndDate = newEnd ? newEnd : newStart;
    target.extendedProps.isEnding = document.getElementById('editEnding').value; target.extendedProps.platform = document.getElementById('editPlatform').value;
    
    let lines = document.getElementById('editMemo').value.trim().split('\n'); let recompiledArr = [];
    lines.forEach(line => {
        if (!line.trim()) return; let match = line.match(/^\[(.*?)\]\s*(.*)$/);
        if (match) recompiledArr.push({ date: match[1], text: match[2] }); else recompiledArr.push({ date: newStart, text: line });
    });
    target.extendedProps.memo = JSON.stringify(recompiledArr);
    target.backgroundColor = determineEventColor(target.extendedProps);
    
    saveToLocalStorage();
    syncAllRecordsSafely();
    alert("저장되었습니다."); 
    closeGameModal();
}

function deleteCurrentGame() { 
    if (confirm("삭제하시겠습니까?")) { 
        const deleted = localEvents.find(e => e.id === currentSelectedEventId);
        recordEditHistory('기록 삭제', deleted?.title || '이름 없음', localEvents, deleted ? [`시작 날짜: ${deleted.extendedProps.startDate}`, `플랫폼: ${deleted.extendedProps.platform}`] : []);
        localEvents = localEvents.filter(e => e.id !== currentSelectedEventId); 
        saveToLocalStorage();
        syncAllRecordsSafely();
        closeGameModal(); 
    } 
}

function closeGameModal() { document.getElementById('gameModal').style.display = "none"; if (currentSelectedGameTitle) { refreshUI(); } }

function openUsageGuide() {
    const guide = document.getElementById('usageGuideModal');
    guide.style.display = 'flex';
    guide.setAttribute('aria-hidden', 'false');
    document.getElementById('closeUsageGuide').focus();
}

function closeUsageGuide() {
    const guide = document.getElementById('usageGuideModal');
    guide.style.display = 'none';
    guide.setAttribute('aria-hidden', 'true');
    document.getElementById('usageGuideButton').focus();
}

function renderBetaSettings() {
    const settings = getBetaSettings();
    document.getElementById('calendarBlockStyle').value = settings.calendarBlockStyle;
    document.getElementById('showSteamTotalOnCalendar').value = String(settings.showSteamTotalOnCalendar);
    document.getElementById('themeMode').value = settings.themeMode;
    document.getElementById('platformSettingsList').innerHTML = settings.platforms.map((item, index) => `<div class="platform-setting-row"><span>${item.name}</span><input type="color" value="${item.color}" data-platform-index="${index}"><button type="button" data-remove-platform="${index}">제거</button></div>`).join('');
    document.getElementById('platformSettingsList').querySelectorAll('[data-remove-platform]').forEach(button => button.addEventListener('click', () => {
        settings.platforms.splice(Number(button.dataset.removePlatform), 1); saveBetaSettings(settings); renderBetaSettings();
    }));
    const history = JSON.parse(localStorage.getItem('game_effect_edit_history') || '[]');
    document.getElementById('editHistoryList').innerHTML = history.length ? history.map((item, index) => {
        const details = (item.details || []).filter(detail => detail !== '변경한 내용 없음');
        const detailHtml = details.length ? details.map(detail => `<small>${detail}</small>`).join('') : '<small>이전 버전에서 남은 기록이라 상세 변경값이 없습니다.</small>';
        return `<div class="edit-history-item"><span><strong>${item.at} · ${item.action}: ${item.title}</strong>${detailHtml}</span>${item.snapshot ? `<button type="button" data-undo-history="${index}">되돌리기</button>` : ''}</div>`;
    }).join('') : '아직 편집 기록이 없습니다.';
    document.getElementById('editHistoryList').querySelectorAll('[data-undo-history]').forEach(button => button.addEventListener('click', () => undoBetaHistory(Number(button.dataset.undoHistory))));
}

function undoBetaHistory(index) {
    const history = JSON.parse(localStorage.getItem('game_effect_edit_history') || '[]');
    const target = history[index];
    if (!target?.snapshot) return alert('이전 상태 정보가 없어 되돌릴 수 없습니다.');
    const detailText = (target.details || []).join('\n');
    if (!confirm(`${target.action} 기록을 되돌릴까요?${detailText ? `\n\n되돌리는 내용\n${detailText}` : ''}`)) return;
    try {
        localEvents = JSON.parse(target.snapshot);
        uniqueTitles = [];
        history.splice(index, 1);
        localStorage.setItem('game_effect_edit_history', JSON.stringify(history));
        saveToLocalStorage();
        syncAllRecordsSafely();
        refreshUI();
        renderBetaSettings();
    } catch {
        alert('되돌리지 못했습니다.');
    }
}

function applyBetaTheme() { document.body.classList.toggle('light-theme', getBetaSettings().themeMode === 'light'); }
function openSettings() { renderBetaSettings(); document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('settingsModal').setAttribute('aria-hidden', 'false'); }
function closeSettings() { document.getElementById('settingsModal').style.display = 'none'; document.getElementById('settingsModal').setAttribute('aria-hidden', 'true'); }
function saveSettingsFromModal() {
    const settings = getBetaSettings();
    settings.calendarBlockStyle = document.getElementById('calendarBlockStyle').value;
    settings.showSteamTotalOnCalendar = document.getElementById('showSteamTotalOnCalendar').value === 'true';
    settings.themeMode = document.getElementById('themeMode').value;
    document.querySelectorAll('[data-platform-index]').forEach(input => { settings.platforms[Number(input.dataset.platformIndex)].color = input.value; });
    saveBetaSettings(settings);
    localEvents.forEach(event => { event.backgroundColor = determineEventColor(event.extendedProps); });
    saveToLocalStorage(); applyBetaTheme(); renderPlatformOptions('gamePlatform'); refreshUI();
}

function resetPlatformColorsToDefaults() {
    if (!confirm('기본 플랫폼 색을 처음 색으로 되돌릴까요? 새로 추가한 플랫폼은 그대로 유지됩니다.')) return;
    const settings = getBetaSettings();
    const defaultColors = new Map(DEFAULT_PLATFORM_SETTINGS.map(item => [item.name.toLowerCase(), item.color]));
    settings.platforms.forEach(item => {
        const defaultColor = defaultColors.get(String(item.name).toLowerCase());
        if (defaultColor) item.color = defaultColor;
    });
    saveBetaSettings(settings);
    renderBetaSettings();
}

function resetAllGameData() {
    if (!confirm('이 브라우저의 게임 기록을 모두 초기화할까요?\n\n구글 시트의 기록은 삭제되지 않으며, 나중에 다시 가져올 수 있습니다.')) return;
    if (!confirm('게임 기록, 편집 기록, Steam 게임 연결 정보까지 삭제됩니다. 계속할까요?')) return;

    localEvents = [];
    uniqueTitles = [];
    currentSelectedEventId = null;
    currentSelectedGameTitle = null;
    localStorage.removeItem('cached_game_events');
    localStorage.removeItem('game_effect_edit_history');
    localStorage.removeItem('steam_title_appid_links');
    document.getElementById('gameForm').reset();
    renderPlatformOptions('gamePlatform');
    refreshUI();
    renderBetaSettings();
    alert('이 브라우저에 저장된 게임 기록 데이터를 초기화했습니다.');
}

document.addEventListener('DOMContentLoaded', function() {
    var calendarEl = document.getElementById('calendar');
    var modal = document.getElementById('gameModal');
    renderPlatformOptions('gamePlatform');
    applyBetaTheme();
    
    let savedUrl = localStorage.getItem('saved_game_sheet_url');
    if (savedUrl) { document.getElementById('spreadsheetUrlInput').value = savedUrl; }

    let savedWebAppUrl = localStorage.getItem('user_local_web_app_url');
    if (savedWebAppUrl) { document.getElementById('webAppUrlInput').value = savedWebAppUrl; }

    const savedSteamId = localStorage.getItem('user_steam_id');
    if (savedSteamId && document.getElementById('steamIdInput')) {
        document.getElementById('steamIdInput').value = savedSteamId;
    }

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth', locale: 'ko',
        events: function(fetchInfo, successCallback, failureCallback) { successCallback(buildDailyCalendarEvents()); },
        eventContent: function(arg) {
            let isEnd = arg.event.extendedProps.isEnding && arg.event.extendedProps.isEnding !== 'x';
            let customEl = document.createElement('div'); customEl.className = 'game-bar'; customEl.style.backgroundColor = arg.event.backgroundColor;
            let textSpan = document.createElement('span'); textSpan.className = 'game-bar-text';
            if (arg.event.extendedProps.hasExactDailySteamTime) {
                let totalTime = Number(arg.event.extendedProps.displayTotalTime);
                let dailyIncrease = Number(arg.event.extendedProps.dailyIncrease);
                const totalText = getBetaSettings().showSteamTotalOnCalendar ? ` · 총 ${totalTime.toFixed(1)}h` : '';
                textSpan.innerText = `${arg.event.title} (+${dailyIncrease.toFixed(1)}h${totalText})`;
            } else {
                textSpan.innerText = `${arg.event.title} (${Number(arg.event.extendedProps.time || 0).toFixed(1)}h)`;
            }
            customEl.appendChild(textSpan);
            if (isEnd) { let trophySpan = document.createElement('span'); trophySpan.className = 'game-bar-trophy'; trophySpan.innerText = '🏆'; customEl.appendChild(trophySpan); }
            return { domNodes: [customEl] };
        },
        eventDidMount: function(info) {
            const harness = info.el.closest('.fc-daygrid-event-harness');
            if (harness && Number(info.event.extendedProps.time || 0) <= 1) harness.dataset.shortPlaytime = 'true';
            info.el.addEventListener('mouseenter', () => showCalendarHoverCard(info));
            info.el.addEventListener('mouseleave', hideCalendarHoverCard);
            scheduleShortPlaytimeCollapse();
        },
        eventWillUnmount: hideCalendarHoverCard,
        eventClick: function(info) { openDetailModalById(info.event.extendedProps.originalEventId || info.event.id); }
    });
    calendar.render();

    let cachedEvents = localStorage.getItem('cached_game_events');
    if (cachedEvents) {
        try {
            localEvents = JSON.parse(cachedEvents);
            refreshUI();
        } catch(e) {
            if (savedUrl) { forceFetchSpreadsheetData(); }
        }
    } else if (savedUrl) {
        forceFetchSpreadsheetData();
    }

    document.getElementById('searchTitleInput').addEventListener('input', executeLiveGameSearch);
    document.getElementById('searchSteamAppIdInput').addEventListener('input', executeLiveGameSearch);
    document.getElementById('searchDateInput').addEventListener('input', executeLiveGameSearch);
    document.getElementById('gameForm').addEventListener('submit', handleGameSubmit);
    document.getElementById('usageGuideButton').addEventListener('click', openUsageGuide);
    document.getElementById('closeUsageGuide').addEventListener('click', closeUsageGuide);
    document.getElementById('openSettingsButton').addEventListener('click', openSettings);
    document.getElementById('closeSettingsButton').addEventListener('click', closeSettings);
    document.getElementById('saveSettingsButton').addEventListener('click', saveSettingsFromModal);
    document.getElementById('addPlatformButton').addEventListener('click', () => {
        const name = document.getElementById('newPlatformName').value.trim(); if (!name) return;
        const settings = getBetaSettings();
        if (settings.platforms.some(item => item.name.toLowerCase() === name.toLowerCase())) return alert('같은 플랫폼이 이미 있습니다.');
        settings.platforms.push({ name, color: document.getElementById('newPlatformColor').value }); saveBetaSettings(settings); document.getElementById('newPlatformName').value = ''; renderBetaSettings();
    });
    document.getElementById('resetPlatformColorsButton').addEventListener('click', resetPlatformColorsToDefaults);
    document.getElementById('resetAllGameDataButton').addEventListener('click', resetAllGameData);

    window.addEventListener('click', (e) => { 
        if (e.target == modal) { closeGameModal(); }
        if (e.target === document.getElementById('usageGuideModal')) { closeUsageGuide(); }
        if (e.target === document.getElementById('settingsModal')) { closeSettings(); }
        if (e.target === document.getElementById('steamTitleConverterModal')) { closeSteamTitleConverter(); }
        if (e.target === document.getElementById('initialSyncNextStepsModal')) { closeInitialSyncNextSteps(); }
        if (e.target === document.getElementById('initialSyncDataChoiceModal')) { selectInitialSyncDataMode('cancel'); }
        if (e.target.id !== 'gameName') { document.getElementById('autocompleteList').style.display = 'none'; }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('usageGuideModal').style.display === 'flex') closeUsageGuide();
    });
});
