// ==========================================
// 👑 MAIN APP: 상태 캐시, 달력 및 UI 제어
// ==========================================
let localEvents = []; 
let uniqueTitles = []; 
let currentSelectedEventId = null;
let currentSelectedGameTitle = ""; 
let isAllRecordsDetailMode = false;
let calendar = null;
let shortPlaytimeCollapseScheduled = false;
let calendarHoverCard = null;
let workProgressDepth = 0;
let steamSearchResultAppIds = new Set();
let activeSteamTitleSearchToken = 0;
let activeSteamTitleSearchKeyword = '';
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
            calendarMonthDisplay: saved.calendarMonthDisplay || 'current-month',
            showSteamTotalOnCalendar: Boolean(saved.showSteamTotalOnCalendar),
            themeMode: saved.themeMode || 'dark'
        };
    } catch { return { platforms: DEFAULT_PLATFORM_SETTINGS, calendarBlockStyle: 'merged', calendarMonthDisplay: 'current-month', showSteamTotalOnCalendar: false, themeMode: 'dark' }; }
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
}

function createRecordId() {
    return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function toPlaytimeMinutes(value) {
    // v2.42부터 플레이시간 계산은 다시 기존 "시간" 열의 0.1시간 단위를 기준으로 합니다.
    // 플레이시간(분) 열은 이전 데이터와의 호환을 위해 보관하지만 계산 기준으로 사용하지 않습니다.
    const hours = Number(value);
    return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 60) : 0;
}

function setRecordMinutes(record, minutes) {
    const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
    record.time = Number((safeMinutes / 60).toFixed(1));
    // 이전 시트 열과의 호환용 값입니다. 이후 계산은 time을 기준으로 합니다.
    record.playtimeMinutes = Math.round(record.time * 60);
    return record.playtimeMinutes;
}

function getRecordMinutes(recordOrEvent) {
    const record = recordOrEvent?.extendedProps || recordOrEvent || {};
    return toPlaytimeMinutes(record.time);
}

function formatPlaytime(minutes, mode = 'decimal') {
    const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
    if (mode === 'hm') {
        const hours = Math.floor(safeMinutes / 60);
        const rest = safeMinutes % 60;
        return hours > 0 ? `${hours}시간 ${rest}분` : `${rest}분`;
    }
    return `${(safeMinutes / 60).toFixed(1)}시간`;
}

function migrateRecordDataModel(events = localEvents) {
    let changed = false;
    events.forEach(event => {
        const record = event.extendedProps || event;
        if (!record.recordId) { record.recordId = event.id || createRecordId(); changed = true; }
        const minutes = toPlaytimeMinutes(record.time);
        if (record.playtimeMinutes !== minutes || Number(record.time) !== Number((minutes / 60).toFixed(1))) {
            setRecordMinutes(record, minutes);
            changed = true;
        }
        if (record.isLauncherParent === undefined) record.isLauncherParent = false;
        if (record.isAllocated === undefined) record.isAllocated = false;
        // 이전 버전에서 저장한 런처 하위 기록도 제목별로 분리 집계합니다.
        if (record.isLauncherAllocation === undefined) {
            record.isLauncherAllocation = Boolean(record.parentAppId);
            changed = true;
        }
    });
    return changed;
}

let bodyScrollLockDepth = 0;
let bodyOverflowBeforeModal = '';
function lockBodyScroll() {
    if (bodyScrollLockDepth++ === 0) {
        bodyOverflowBeforeModal = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }
}
function unlockBodyScroll() {
    if (bodyScrollLockDepth > 0 && --bodyScrollLockDepth === 0) document.body.style.overflow = bodyOverflowBeforeModal;
}
function setModalVisibility(modal, visible) {
    if (!modal) return;
    const isOpen = modal.style.display === 'flex';
    if (visible && !isOpen) lockBodyScroll();
    if (!visible && isOpen) unlockBodyScroll();
    modal.style.display = visible ? 'flex' : 'none';
    modal.setAttribute('aria-hidden', String(!visible));
}

function beginWorkProgress(message = '작업 중입니다. 잠시만 기다려 주세요…') {
    workProgressDepth += 1;
    const toast = document.getElementById('workProgressToast');
    const text = document.getElementById('workProgressMessage');
    if (!toast || !text) return;
    text.textContent = message;
    toast.hidden = false;
}

function updateWorkProgress(message) {
    const text = document.getElementById('workProgressMessage');
    if (text) text.textContent = message;
}

function endWorkProgress() {
    workProgressDepth = Math.max(0, workProgressDepth - 1);
    if (workProgressDepth === 0) {
        const toast = document.getElementById('workProgressToast');
        if (toast) toast.hidden = true;
    }
}

function syncAllRecordsSafely() {
    if (typeof syncAllRecordsToGoogleSheet !== 'function') {
        console.warn('최신 sheet.js가 아직 배포되지 않아 구글 시트 동기화를 건너뜁니다.');
        return Promise.resolve();
    }
    return syncAllRecordsToGoogleSheet();
}

function syncChangedRecordsSafely(records, options = {}) {
    if (typeof syncChangedRecordsToGoogleSheet !== 'function') {
        console.warn('최신 sheet.js가 아직 배포되지 않아 변경된 구글 시트 기록 저장을 건너뜁니다.');
        return Promise.resolve();
    }
    return syncChangedRecordsToGoogleSheet(records, options);
}

function saveConnectionSettings() {
    const sheetUrl = document.getElementById('spreadsheetUrlInput')?.value.trim() || '';
    const webAppUrl = document.getElementById('webAppUrlInput')?.value.trim() || '';
    const sheetSyncToken = document.getElementById('sheetSyncTokenInput')?.value.trim() || '';
    const steamId = document.getElementById('steamIdInput')?.value.trim() || '';
    const saved = [];

    if (sheetUrl) {
        localStorage.setItem('saved_game_sheet_url', sheetUrl);
        saved.push('스프레드시트 주소');
    }
    if (webAppUrl) {
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(webAppUrl)) {
            alert('시트 저장 주소는 https://script.google.com/macros/s/.../exec 형식만 사용할 수 있습니다.');
            return;
        }
        if (sheetSyncToken.length < 12) {
            alert('시트 동기화 키는 12자 이상으로 입력해 주세요.');
            return;
        }
        localStorage.setItem('user_local_web_app_url', webAppUrl);
        localStorage.setItem('user_local_sheet_sync_token', sheetSyncToken);
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

const CONNECTION_TRANSFER_PREFIX = 'GAME_EFFECT_CONNECTION_V1:';

function getConnectionTransferData() {
    const fieldValue = id => document.getElementById(id)?.value.trim() || '';
    return {
        version: 1,
        spreadsheetUrl: fieldValue('spreadsheetUrlInput') || localStorage.getItem('saved_game_sheet_url') || '',
        webAppUrl: fieldValue('webAppUrlInput') || localStorage.getItem('user_local_web_app_url') || '',
        steamId: fieldValue('steamIdInput') || localStorage.getItem('user_steam_id') || ''
    };
}

function isValidSpreadsheetUrl(value) {
    if (!value) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'docs.google.com' && /^\/spreadsheets\/d\/[^/]+/.test(url.pathname);
    } catch (_) {
        return false;
    }
}

function isValidWebAppUrl(value) {
    return !value || /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(value);
}

async function copyConnectionInfo() {
    const data = getConnectionTransferData();
    if (!data.spreadsheetUrl && !data.webAppUrl && !data.steamId) {
        alert('복사할 연결 정보가 없습니다. 먼저 연결 정보를 입력하거나 저장해 주세요.');
        return;
    }

    // 동기화 키는 이 객체에 넣지 않습니다. 클립보드·백업·공유에 노출되지 않게 합니다.
    const text = `${CONNECTION_TRANSFER_PREFIX}${JSON.stringify(data)}`;
    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
        await navigator.clipboard.writeText(text);
        alert('연결 정보를 복사했습니다.\n\n시트 주소·저장 주소·SteamID64만 포함되며, 시트 동기화 키는 복사되지 않습니다.');
    } catch (_) {
        window.prompt('자동 복사에 실패했습니다. 아래 내용을 직접 복사해 새 환경에 붙여넣어 주세요.\n(동기화 키는 포함되지 않습니다.)', text);
    }
}

function applyConnectionTransferText(text) {
    if (typeof text !== 'string' || !text.startsWith(CONNECTION_TRANSFER_PREFIX)) {
        throw new Error('Game Effect에서 복사한 연결 정보가 아닙니다.');
    }
    const data = JSON.parse(text.slice(CONNECTION_TRANSFER_PREFIX.length));
    const spreadsheetUrl = typeof data.spreadsheetUrl === 'string' ? data.spreadsheetUrl.trim() : '';
    const webAppUrl = typeof data.webAppUrl === 'string' ? data.webAppUrl.trim() : '';
    const steamId = typeof data.steamId === 'string' ? data.steamId.trim() : '';
    if (data.version !== 1 || !isValidSpreadsheetUrl(spreadsheetUrl) || !isValidWebAppUrl(webAppUrl) || (steamId && !/^\d{17}$/.test(steamId))) {
        throw new Error('연결 정보 형식이 올바르지 않습니다.');
    }

    document.getElementById('spreadsheetUrlInput').value = spreadsheetUrl;
    document.getElementById('webAppUrlInput').value = webAppUrl;
    document.getElementById('steamIdInput').value = steamId;
    // 동기화 키는 의도적으로 비워 둡니다. 새 환경에서 직접 입력해야 합니다.
    document.getElementById('sheetSyncTokenInput').value = '';
}

async function pasteConnectionInfo() {
    let text = '';
    try {
        if (!navigator.clipboard?.readText) throw new Error('Clipboard API unavailable');
        text = await navigator.clipboard.readText();
    } catch (_) {
        text = window.prompt('기존 환경에서 “연결 정보 복사”로 만든 내용을 붙여넣어 주세요.\n(동기화 키는 포함되지 않습니다.)', '') || '';
    }
    if (!text.trim()) return;

    try {
        applyConnectionTransferText(text.trim());
        alert('연결 정보를 입력칸에 채웠습니다.\n\n시트 동기화 키를 직접 입력한 뒤 “연결 정보 저장”을 눌러 주세요.');
    } catch (error) {
        alert(`연결 정보를 불러오지 못했습니다. ${error.message}`);
    }
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
    const title = String(game.title || '').trim().toLocaleLowerCase();
    // 통합 런처의 하위 게임은 AppID를 공유하므로, 제목까지 포함해 따로 집계합니다.
    if (steamAppId && (game.isLauncherAllocation || game.parentAppId)) {
        return `steam-launcher:${steamAppId}\u001F${title}`;
    }
    if (steamAppId) return `steam:${steamAppId}`;
    // Steam 연결이 없는 기록은 제목뿐 아니라 플랫폼까지 같아야 같은 게임입니다.
    const platform = String(game.platform || '').trim().toLocaleLowerCase();
    return `manual:${title}\u001F${platform}`;
}

function isSummaryRecord(event) {
    return !Boolean((event?.extendedProps || event || {}).isAllocated);
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
    // 플랫폼 이름은 사용자가 설정에서 직접 추가할 수 있으므로 HTML 문자열로 넣지 않습니다.
    select.replaceChildren();
    getBetaSettings().platforms.forEach(item => {
        const option = document.createElement('option');
        option.value = String(item.name || '');
        option.textContent = String(item.name || '');
        option.selected = option.value === String(selected || '');
        select.appendChild(option);
    });
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
    return games.reduce((sum, event) => sum + getRecordMinutes(event) / 60, 0);
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

        // 최근 Steam 기록을 여러 번 "바로 이어 보기"로 선택하면 각 기록이
        // 이전 기록부터 다시 그려져 바가 겹쳤습니다. 연결된 구간을 하나의
        // 연속 바(연결 체인)로 합쳐, 실제 기록은 그대로 두고 표시만 중복 없이 만듭니다.
        const linkedRanges = games
            .filter(event => {
                const game = event.extendedProps;
                return game.calendarLinkStart && game.calendarLinkStart < game.startDate;
            })
            .map(event => {
                const game = event.extendedProps;
                return {
                    start: game.calendarLinkStart,
                    end: addDays(game.rawEndDate || game.endDate || game.startDate, 1),
                    event
                };
            })
            .sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
        const linkedChains = [];
        linkedRanges.forEach(range => {
            const previous = linkedChains[linkedChains.length - 1];
            if (previous && range.start <= previous.end) {
                if (range.end >= previous.end) {
                    previous.end = range.end;
                    previous.event = range.event;
                }
            } else {
                linkedChains.push({ ...range });
            }
        });
        linkedChains.forEach(chain => {
            const game = chain.event.extendedProps;
            calendarEvents.push({
                ...chain.event,
                id: `${chain.event.id}_linked_chain_${chain.start}`,
                start: chain.start,
                end: chain.end,
                extendedProps: { ...game, originalEventId: chain.event.id, totalPlayTime, isCalendarLinkedDisplay: true }
            });
        });

        games.forEach(event => {
            const game = event.extendedProps;
            const dates = getDatesInRange(game.startDate, game.rawEndDate || game.endDate || game.startDate);
            if (dates.length === 0) return;
            const isPartOfLinkedChain = linkedChains.some(chain =>
                game.startDate >= chain.start && game.startDate < chain.end
            );
            if (isPartOfLinkedChain) return;
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
                        dailyIncrease: getRecordMinutes(game) / 60,
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
    // 기록이 많아도 일부를 접거나 내부 스크롤을 만들지 않습니다.
    // 달력 행 높이가 기록 수만큼 늘어나도록 모든 항목을 그대로 표시합니다.
    document.querySelectorAll('.short-playtime-toggle').forEach(button => button.remove());
    document.querySelectorAll('.fc-daygrid-event-harness').forEach(harness => harness.classList.remove('is-short-playtime-hidden'));
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

function downloadCalendarShareImage() {
    const includeRecentWeek = Boolean(document.getElementById('shareIncludeRecentWeek')?.checked);
    const button = document.querySelector('.calendar-share-actions button');
    if (!calendar || !button) return;

    hideCalendarHoverCard();
    button.disabled = true;
    button.textContent = '🖼 이미지 만드는 중…';

    requestAnimationFrame(() => {
        try {
            const lightTheme = document.body.classList.contains('light-theme');
            const settings = getBetaSettings();
            const view = calendar.view;
            const visibleMonth = calendar.getDate().getMonth();
            const visibleYear = calendar.getDate().getFullYear();
            const start = new Date(view.activeStart);
            const end = new Date(view.activeEnd);
            const days = [];
            for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
                days.push(new Date(cursor));
            }
            const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));
            const isCurrentMonthDay = date => date.getFullYear() === visibleYear && date.getMonth() === visibleMonth;
            const firstCurrentMonthDay = new Date(visibleYear, visibleMonth, 1);
            const firstNextMonthDay = new Date(visibleYear, visibleMonth + 1, 1);
            const eventEnd = event => event.end || new Date(event.start.getFullYear(), event.start.getMonth(), event.start.getDate() + 1);
            const weekLayouts = weeks.map(week => {
                const weekStart = new Date(week[0].getFullYear(), week[0].getMonth(), week[0].getDate());
                const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
                const visibleStart = settings.calendarMonthDisplay === 'current-month'
                    ? new Date(Math.max(weekStart.getTime(), firstCurrentMonthDay.getTime()))
                    : weekStart;
                const visibleEnd = settings.calendarMonthDisplay === 'current-month'
                    ? new Date(Math.min(weekEnd.getTime(), firstNextMonthDay.getTime()))
                    : weekEnd;
                const segments = calendar.getEvents()
                    .map(event => {
                        const segmentStart = new Date(Math.max(event.start.getTime(), visibleStart.getTime()));
                        const segmentEnd = new Date(Math.min(eventEnd(event).getTime(), visibleEnd.getTime()));
                        if (segmentStart >= segmentEnd) return null;
                        return {
                            event,
                            startIndex: Math.round((segmentStart - weekStart) / 86400000),
                            endIndex: Math.round((segmentEnd - weekStart) / 86400000)
                        };
                    })
                    .filter(Boolean)
                    .sort((left, right) => left.startIndex - right.startIndex || right.endIndex - left.endIndex || String(left.event.title).localeCompare(String(right.event.title), 'ko'));
                const laneEnds = [];
                segments.forEach(segment => {
                    let lane = laneEnds.findIndex(endIndex => endIndex <= segment.startIndex);
                    if (lane === -1) lane = laneEnds.length;
                    laneEnds[lane] = segment.endIndex;
                    segment.lane = lane;
                });
                return { segments, laneCount: laneEnds.length };
            });
            const weekHeights = weekLayouts.map(layout => Math.max(112, 34 + layout.laneCount * 24 + 8));
            const padding = 28;
            const sidebarWidth = includeRecentWeek ? 300 : 0;
            const columnGap = includeRecentWeek ? 24 : 0;
            const imageWidth = includeRecentWeek ? 1500 : 1200;
            const calendarWidth = imageWidth - padding * 2 - sidebarWidth - columnGap;
            const headerHeight = 104;
            const weekdayHeight = 34;
            const imageHeight = headerHeight + weekdayHeight + weekHeights.reduce((sum, height) => sum + height, 0) + padding;
            const canvas = document.createElement('canvas');
            canvas.width = imageWidth;
            canvas.height = imageHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('캔버스를 만들지 못했습니다.');

            const background = lightTheme ? '#f4f7fb' : '#1e1e24';
            const panel = lightTheme ? '#ffffff' : '#2b2b36';
            const line = lightTheme ? '#cbd5e1' : '#3f3f50';
            const text = lightTheme ? '#1f2937' : '#f8fafc';
            const muted = lightTheme ? '#64748b' : '#cbd5e1';
            const accent = '#818cf8';
            context.fillStyle = background;
            context.fillRect(0, 0, imageWidth, imageHeight);
            context.fillStyle = text;
            context.font = '700 30px "Noto Sans KR", Arial, sans-serif';
            context.fillText(`🎮 Game Effect · ${view.title}`, padding, 48);
            context.fillStyle = muted;
            context.font = '16px "Noto Sans KR", Arial, sans-serif';
            context.fillText('플레이 달력', padding, 78);

            const calendarX = padding;
            const calendarY = headerHeight;
            const dayWidth = calendarWidth / 7;
            context.fillStyle = panel;
            context.fillRect(calendarX, calendarY, calendarWidth, weekdayHeight + weekHeights.reduce((sum, height) => sum + height, 0));
            context.strokeStyle = line;
            context.lineWidth = 1;
            const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
            context.font = '700 15px "Noto Sans KR", Arial, sans-serif';
            context.textAlign = 'center';
            weekNames.forEach((name, index) => {
                context.fillStyle = muted;
                context.fillText(name, calendarX + dayWidth * index + dayWidth / 2, calendarY + 22);
            });
            context.beginPath();
            context.moveTo(calendarX, calendarY + weekdayHeight);
            context.lineTo(calendarX + calendarWidth, calendarY + weekdayHeight);
            context.stroke();

            let rowY = calendarY + weekdayHeight;
            weekLayouts.forEach((layout, weekIndex) => {
                const rowHeight = weekHeights[weekIndex];
                weeks[weekIndex].forEach((date, dayIndex) => {
                    const cellX = calendarX + dayWidth * dayIndex;
                    const isCurrent = isCurrentMonthDay(date);
                    context.strokeStyle = line;
                    context.strokeRect(cellX, rowY, dayWidth, rowHeight);
                    if (settings.calendarMonthDisplay === 'current-month' && !isCurrent) return;
                    context.fillStyle = isCurrent ? text : muted;
                    context.textAlign = 'right';
                    context.font = '700 14px "Noto Sans KR", Arial, sans-serif';
                    context.fillText(String(date.getDate()), cellX + dayWidth - 8, rowY + 19);
                });
                layout.segments.forEach(segment => {
                    const event = segment.event;
                    const game = event.extendedProps || {};
                    const eventX = calendarX + dayWidth * segment.startIndex + 4;
                    const eventY = rowY + 28 + segment.lane * 24;
                    const eventWidth = dayWidth * (segment.endIndex - segment.startIndex) - 8;
                    context.fillStyle = event.backgroundColor || game.backgroundColor || accent;
                    context.fillRect(eventX, eventY, eventWidth, 20);
                    const suffix = game.hasExactDailySteamTime
                        ? ` (+${Number(game.dailyIncrease || 0).toFixed(1)}h)`
                        : ` (${Number(game.time || 0).toFixed(1)}h)`;
                    const label = `${event.title}${suffix}${isGameFinished(game.isEnding) ? ' 🏆' : ''}`;
                    context.fillStyle = '#ffffff';
                    context.font = '700 11px "Noto Sans KR", Arial, sans-serif';
                    context.textAlign = 'left';
                    let clipped = label;
                    while (clipped.length && context.measureText(clipped).width > eventWidth - 10) clipped = `${clipped.slice(0, -2)}…`;
                    context.fillText(clipped, eventX + 4, eventY + 14);
                });
                rowY += rowHeight;
            });

            if (includeRecentWeek) {
                const sidebarX = calendarX + calendarWidth + columnGap;
                context.fillStyle = panel;
                context.fillRect(sidebarX, calendarY, sidebarWidth, Math.max(260, imageHeight - calendarY - padding));
                context.strokeStyle = accent;
                context.strokeRect(sidebarX, calendarY, sidebarWidth, Math.max(260, imageHeight - calendarY - padding));
                context.fillStyle = accent;
                context.font = '700 16px "Noto Sans KR", Arial, sans-serif';
                context.textAlign = 'left';
                context.fillText('🎮 최근 7일 플레이 시간 TOP 10', sidebarX + 16, calendarY + 28);
                const topItems = [...document.querySelectorAll('#recentWeekGames .recent-week-item')];
                if (topItems.length === 0) {
                    context.fillStyle = muted;
                    context.font = '14px "Noto Sans KR", Arial, sans-serif';
                    context.fillText('최근 7일에 기록한 게임이 없습니다.', sidebarX + 16, calendarY + 58);
                }
                topItems.slice(0, 10).forEach((item, index) => {
                    const name = item.querySelector('.recent-week-game')?.textContent?.trim() || '';
                    const time = item.querySelector('.recent-week-meta')?.textContent?.trim() || '';
                    const itemY = calendarY + 46 + index * 30;
                    context.fillStyle = lightTheme ? '#f8fafc' : '#1e1e24';
                    context.fillRect(sidebarX + 12, itemY, sidebarWidth - 24, 24);
                    context.fillStyle = text;
                    context.font = '700 12px "Noto Sans KR", Arial, sans-serif';
                    context.textAlign = 'left';
                    let clippedName = name;
                    while (clippedName.length && context.measureText(clippedName).width > sidebarWidth - 88) clippedName = `${clippedName.slice(0, -2)}…`;
                    context.fillText(clippedName, sidebarX + 20, itemY + 16);
                    context.fillStyle = muted;
                    context.textAlign = 'right';
                    context.fillText(time, sidebarX + sidebarWidth - 20, itemY + 16);
                });
            }

            canvas.toBlob(blob => {
                if (!blob) {
                    alert('공유 이미지를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
                    button.disabled = false;
                    button.textContent = '🖼 공유 이미지 저장';
                    return;
                }
                const link = document.createElement('a');
                const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
                link.href = URL.createObjectURL(blob);
                link.download = `game-effect-calendar-${date}.png`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(link.href);
                button.disabled = false;
                button.textContent = '🖼 공유 이미지 저장';
            }, 'image/png');
        } catch (error) {
            console.error('공유 이미지 저장 오류:', error);
            alert('공유 이미지를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            button.disabled = false;
            button.textContent = '🖼 공유 이미지 저장';
        }
    });
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
    updateSteamTitleSearchMatches(titleKeyword);
}

function normalizeSearchText(value) {
    return String(value || '')
        .toLocaleLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function getGameSearchAliases(game) {
    const aliases = [game.title || ''];
    const steamAppId = String(game.steamAppId || '');
    if (steamAppId && typeof getSteamLauncherRegistry === 'function') {
        const launcher = getSteamLauncherRegistry().find(item => item.appId === steamAppId);
        if (launcher) aliases.push(launcher.title, ...launcher.children.map(child => child.title));
    }
    return aliases;
}

function isGameTitleSearchMatch(game, keyword) {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (!normalizedKeyword) return true;
    const steamAppId = String(game.steamAppId || '');
    return getGameSearchAliases(game).some(alias => normalizeSearchText(alias).includes(normalizedKeyword))
        || (steamAppId && steamSearchResultAppIds.has(steamAppId));
}

function updateSteamTitleSearchMatches(keyword) {
    const normalizedKeyword = normalizeSearchText(keyword);
    const token = ++activeSteamTitleSearchToken;
    activeSteamTitleSearchKeyword = normalizedKeyword;
    if (normalizedKeyword.length < 2 || typeof searchSteamStoreKoreanTitles !== 'function') {
        steamSearchResultAppIds = new Set();
        return;
    }

    searchSteamStoreKoreanTitles(keyword).then(items => {
        if (token !== activeSteamTitleSearchToken || activeSteamTitleSearchKeyword !== normalizedKeyword) return;
        steamSearchResultAppIds = new Set((items || []).map(item => String(item.appid || '')).filter(Boolean));
        const titleKeyword = document.getElementById('searchTitleInput')?.value.trim().toLowerCase() || '';
        const dateKeyword = document.getElementById('searchDateInput')?.value.trim() || '';
        const steamAppIdKeyword = document.getElementById('searchSteamAppIdInput')?.value.trim() || '';
        buildAggregatedCards('list-container', null, titleKeyword, dateKeyword, steamAppIdKeyword);
    }).catch(() => {});
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
    activeSteamTitleSearchToken++;
    activeSteamTitleSearchKeyword = '';
    steamSearchResultAppIds = new Set();
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

function createGameObj(name, start, end, platform, time, endingStatus, memo, review, isCheckEnding = false, steamAppId = '', steamTotal = null, metadata = {}) {
    let uniqueId = metadata.recordId || 'evt_' + Math.random().toString(36).substr(2, 9);
    // 가져온 기록은 시작일을 기준으로 표시합니다. 시작일이 비어 있을 때만 종료일을
    // 시작일로 사용하며, 종료일이 비어 있으면 시작일 하루짜리 기록으로 처리합니다.
    let normalizedStart = start || end;
    let normalizedEnd = end || normalizedStart;
    let displayEnd = normalizedEnd === normalizedStart ? '' : normalizedEnd; 
    
    let gameObj = {
        id: uniqueId, title: name, startDate: normalizedStart, endDate: displayEnd, rawEndDate: normalizedEnd,
        recordId: metadata.recordId || uniqueId,
        platform: platform, time: 0, playtimeMinutes: 0, isEnding: endingStatus, memo: memo || '', review: review || '',
        steamAppId: String(steamAppId || (String(platform).toLocaleLowerCase() === 'steam' ? getSteamAppIdForTitle(name) : '')),
        steamTotal: steamTotal !== null && steamTotal !== '' && Number.isFinite(Number(steamTotal)) ? Number(steamTotal) : null,
        isLauncherParent: Boolean(metadata.isLauncherParent),
        parentAppId: String(metadata.parentAppId || ''),
        isAllocated: Boolean(metadata.isAllocated),
        isLauncherAllocation: Boolean(metadata.isLauncherAllocation || metadata.parentAppId),
        calendarLinkStart: String(metadata.calendarLinkStart || '')
    };
    setRecordMinutes(gameObj, toPlaytimeMinutes(time, metadata.playtimeMinutes));

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
    let sourceList = localEvents.filter(isSummaryRecord);
    
    // 연도별 요약과 시트 저장은 모두 기록의 시작일을 기준으로 합니다.
    if (targetYear) { sourceList = sourceList.filter(evt => getRecordStartYear(evt) === targetYear); }
    
    if (titleFilter || dateFilter || steamAppIdFilter) {
        sourceList = sourceList.filter(evt => {
            let game = evt.extendedProps;
            let matchTitle = titleFilter ? isGameTitleSearchMatch(game, titleFilter) : true;
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
        summary.time += getRecordMinutes(game) / 60;
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
        let startInfoHTML = targetYear ? '<div class="card-info">📅 첫 시작일: ' + escapeHtml(summary.startDate || '-') + '</div>' : '';
        card.innerHTML = `
            ${badgeHTML}
            <div class="card-title">${escapeHtml(title)}</div>
            <div class="card-info" style="font-size: 1.1em; margin-top: 10px;">⏱ ${timeLabelText}: <span style="color:#818cf8; font-size:1.2em;">${aggregatedTime.toFixed(1)}</span> 시간</div>
            ${startInfoHTML}
        `;
        card.addEventListener('click', () => { openDetailModalById(summary.eventId, { showAllRecords: !targetYear }); });
        container.appendChild(card);
    }
}

function calculateYearlyReport(targetYear) {
    let filteredEvents = localEvents.filter(evt => isSummaryRecord(evt) && getRecordStartYear(evt) === targetYear);
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
        let game = evt.extendedProps; let t = getRecordMinutes(game) / 60; totalTime += t;
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
    localEvents.filter(isSummaryRecord).forEach(event => {
        let game = event.extendedProps;
        let title = (game.title || event.title || '').trim();
        let startDate = game.startDate || '';
        if (!title || startDate < weekStartText || startDate > todayText) return;

        let key = getGameIdentity(game);
        let current = gamesByTitle.get(key) || { title: title, time: 0, event: event };
        current.time += getRecordMinutes(game) / 60;
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

function openDetailModalById(id, options = {}) {
    let targetEvent = localEvents.find(e => e.id === id);
    if (!targetEvent) return;

    let gameObj = targetEvent.extendedProps;
    let sameGames = getSameGameEvents(gameObj);
    const showAllRecords = Boolean(options.showAllRecords);
    isAllRecordsDetailMode = showAllRecords;
    if (showAllRecords) {
        targetEvent = [...sameGames].sort((left, right) => {
            const leftDate = String(left.extendedProps.rawEndDate || left.extendedProps.endDate || left.extendedProps.startDate || '');
            const rightDate = String(right.extendedProps.rawEndDate || right.extendedProps.endDate || right.extendedProps.startDate || '');
            return rightDate.localeCompare(leftDate) || right.id.localeCompare(left.id);
        })[0];
        gameObj = targetEvent.extendedProps;
    }
    currentSelectedEventId = targetEvent.id;
    currentSelectedGameTitle = gameObj.title;
    const totalAggTime = sameGames.reduce((acc, curr) => acc + getRecordMinutes(curr) / 60, 0);
    const firstStartDate = sameGames.reduce((first, event) => {
        const date = String(event.extendedProps.startDate || '');
        return !first || (date && date < first) ? date : first;
    }, '');
    const lastRecordedDate = sameGames.reduce((last, event) => {
        const date = String(event.extendedProps.rawEndDate || event.extendedProps.endDate || event.extendedProps.startDate || '');
        return date > last ? date : last;
    }, '');
    const platforms = [...new Set(sameGames.map(event => String(event.extendedProps.platform || '').trim()).filter(Boolean))];
    const hasEnded = sameGames.some(event => isGameFinished(event.extendedProps.isEnding));
    
    document.getElementById('modalInfoGrid').style.display = 'grid';
    const modeNotice = document.getElementById('modalDetailModeNotice');
    modeNotice.style.display = showAllRecords ? 'block' : 'none';
    if (showAllRecords) modeNotice.textContent = `모든 기록 ${sameGames.length}개를 합친 게임 전체 정보입니다.`;
    document.getElementById('modalGameTitle').innerHTML = showAllRecords ? `${escapeHtml(gameObj.title)} <small>모든 기록</small>` : escapeHtml(gameObj.title);
    document.getElementById('modalGameTimeLabel').textContent = showAllRecords ? '⏱️ 전체 누적 플레이타임' : '⏱️ 플레이타임';
    document.getElementById('modalGameStartLabel').textContent = showAllRecords ? '📅 처음 기록한 날' : '📅 시작한 날';
    document.getElementById('modalGameEndLabel').textContent = showAllRecords ? '📅 마지막 기록한 날' : '📅 끝낸 날';
    document.getElementById('modalGameTimeZone').innerHTML = showAllRecords
        ? `<span id="modalGameTime">${totalAggTime.toFixed(1)}</span> 시간`
        : `<span id="modalGameTime">${Number(gameObj.time || 0).toFixed(1)}</span> 시간 (전체 누적합: ${totalAggTime.toFixed(1)}h)`;
    document.getElementById('modalGameStartZone').innerHTML = `<span id="modalGameStart">${escapeHtml(showAllRecords ? firstStartDate : gameObj.startDate)}</span>`;
    document.getElementById('modalGameEndZone').innerHTML = `<span id="modalGameEnd">${escapeHtml(showAllRecords ? lastRecordedDate : (gameObj.endDate || '진행 중'))}</span>`;
    document.getElementById('modalGameTrophyZone').innerHTML = `<span id="modalGameTrophy">${(showAllRecords ? hasEnded : isGameFinished(gameObj.isEnding)) ? '🏆 엔딩 완료' : '진행 중'}</span>`;
    document.getElementById('modalGamePlatformZone').innerHTML = `<span id="modalGamePlatform">${escapeHtml(showAllRecords ? platforms.join(', ') : gameObj.platform)}</span>`;
    const steamAppId = String(gameObj.steamAppId || '').trim();
    document.getElementById('modalSteamLinkZone').textContent = /^\d+$/.test(steamAppId)
        ? `연결됨 (AppID: ${steamAppId})`
        : '아직 연결하지 않았습니다.';
    
    let commonReview = "";
    let foundReviewNode = sameGames.find(e => e.extendedProps.review && e.extendedProps.review.trim() !== "");
    if (foundReviewNode) commonReview = foundReviewNode.extendedProps.review;
    
    let reviewBox = document.getElementById('modalGameReviewBox');
    reviewBox.innerText = commonReview ? commonReview : "";
    reviewBox.contentEditable = "true";
    reviewBox.onblur = function() {
        let updatedReviewText = this.innerText.trim();
        const changedReviewRecords = getSameGameEvents(gameObj);
        changedReviewRecords.forEach(evt => { evt.extendedProps.review = updatedReviewText; });
        saveToLocalStorage();
        syncChangedRecordsSafely(changedReviewRecords, { actionLabel: '게임 한줄평 수정' });
    };

    rebuildTimelineUI(sameGames);
    
    document.getElementById('quickMemoZone').style.display = 'block';
    document.getElementById('btnEdit').style.display = 'inline-block';
    document.getElementById('btnDelete').style.display = 'inline-block';
    document.getElementById('btnSteamLink').style.display = 'inline-block';
    document.getElementById('btnSave').style.display = 'none';
    setModalVisibility(document.getElementById('gameModal'), true);
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
        item.innerHTML = `<div class="timeline-date">📅 기록 기간: ${escapeHtml(m.date)}</div><div class="timeline-text">${escapeHtml(m.text)}</div>`;
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
    if (activeRecord) syncChangedRecordsSafely([activeRecord], { actionLabel: '게임 메모 수정' });
    let selectedRecord = localEvents.find(event => event.id === currentSelectedEventId);
    rebuildTimelineUI(selectedRecord ? getSameGameEvents(selectedRecord) : []);
}

function enableEditMode() {
    let target = localEvents.find(e => e.id === currentSelectedEventId); let gameObj = target.extendedProps;
    document.getElementById('quickMemoZone').style.display = 'none';
    document.getElementById('btnSteamLink').style.display = 'none';
    document.getElementById('modalGameTitle').innerHTML = `<input type="text" id="editTitle" class="edit-input" value="${escapeHtml(gameObj.title)}">`;
    document.getElementById('modalGameTimeZone').innerHTML = `<input type="number" step="0.1" id="editTime" class="edit-input" value="${gameObj.time}"> 시간`;
    document.getElementById('modalGameStartZone').innerHTML = isAllRecordsDetailMode
        ? `<span id="editStart">${escapeHtml(gameObj.startDate)}</span><small> 모든 기록에서는 날짜를 수정할 수 없습니다.</small>`
        : `<input type="text" id="editStart" class="edit-input" value="${escapeHtml(gameObj.startDate)}">`;
    document.getElementById('modalGameEndZone').innerHTML = isAllRecordsDetailMode
        ? `<span id="editEnd">${escapeHtml(gameObj.endDate || '진행 중')}</span><small> 모든 기록에서는 날짜를 수정할 수 없습니다.</small>`
        : `<input type="text" id="editEnd" class="edit-input" value="${escapeHtml(gameObj.endDate)}">`;
    
    document.getElementById('modalGameTrophyZone').innerHTML = `
        <select id="editEnding" class="edit-input">
            <option value="x" ${gameObj.isEnding === 'x'?'selected':''}>진행 중 (x)</option>
            <option value="o" ${gameObj.isEnding === 'o'?'selected':''}>엔딩 완료 (o)</option>
        </select>`;
        
    document.getElementById('modalGamePlatformZone').innerHTML = '<select id="editPlatform" class="edit-input"></select>';
    renderPlatformOptions('editPlatform', gameObj.platform);

    let rawTextForEdit = gameObj.memo || '';
    if (rawTextForEdit.startsWith('[{') && rawTextForEdit.endsWith('}]')) { try { let arr = JSON.parse(rawTextForEdit); rawTextForEdit = arr.map(m => `[${m.date}] ${m.text}`).join('\n'); } catch(e){} }
    document.getElementById('modalGameMemoTimeline').innerHTML = `<textarea id="editMemo" class="edit-input" style="height:60px; resize:none;">${escapeHtml(rawTextForEdit)}</textarea>`;
    document.getElementById('btnEdit').style.display = 'none'; document.getElementById('btnSave').style.display = 'inline-block';
}

function saveEditedData() {
    let target = localEvents.find(e => e.id === currentSelectedEventId); if (!target) return;
    let newTitle = document.getElementById('editTitle').value.trim(); let newTime = parseFloat(document.getElementById('editTime').value || 0);
    let newStart = isAllRecordsDetailMode ? target.extendedProps.startDate : getValidatedDate(document.getElementById('editStart').value);
    let newEnd = isAllRecordsDetailMode ? (target.extendedProps.endDate || '') : getValidatedDate(document.getElementById('editEnd').value);

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

    target.extendedProps.title = newTitle; setRecordMinutes(target.extendedProps, Math.round(newTime * 60)); target.extendedProps.startDate = newStart;
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
    syncChangedRecordsSafely([target], { actionLabel: '게임 기록 수정' });
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

function closeGameModal() { setModalVisibility(document.getElementById('gameModal'), false); if (currentSelectedGameTitle) { refreshUI(); } }

function openUsageGuide() {
    const guide = document.getElementById('usageGuideModal');
    setModalVisibility(guide, true);
    document.getElementById('closeUsageGuide').focus();
}

function closeUsageGuide() {
    const guide = document.getElementById('usageGuideModal');
    setModalVisibility(guide, false);
    document.getElementById('usageGuideButton').focus();
}

function renderBetaSettings() {
    const settings = getBetaSettings();
    document.getElementById('calendarBlockStyle').value = settings.calendarBlockStyle;
    document.getElementById('calendarMonthDisplay').value = settings.calendarMonthDisplay;
    document.getElementById('showSteamTotalOnCalendar').value = String(settings.showSteamTotalOnCalendar);
    document.getElementById('themeMode').value = settings.themeMode;
    document.getElementById('platformSettingsList').innerHTML = settings.platforms.map((item, index) => `<div class="platform-setting-row"><span>${escapeHtml(item.name)}</span><input type="color" value="${escapeHtml(item.color)}" data-platform-index="${index}"><button type="button" data-remove-platform="${index}">제거</button></div>`).join('');
    document.getElementById('platformSettingsList').querySelectorAll('[data-remove-platform]').forEach(button => button.addEventListener('click', () => {
        settings.platforms.splice(Number(button.dataset.removePlatform), 1); saveBetaSettings(settings); renderBetaSettings();
    }));
    renderSteamLauncherSettings();
    const history = JSON.parse(localStorage.getItem('game_effect_edit_history') || '[]');
    document.getElementById('editHistoryList').innerHTML = history.length ? history.map((item, index) => {
        const details = (item.details || []).filter(detail => detail !== '변경한 내용 없음');
        const detailHtml = details.length ? details.map(detail => `<small>${escapeHtml(detail)}</small>`).join('') : '<small>이전 버전에서 남은 기록이라 상세 변경값이 없습니다.</small>';
        return `<div class="edit-history-item"><span><strong>${escapeHtml(item.at)} · ${escapeHtml(item.action)}: ${escapeHtml(item.title)}</strong>${detailHtml}</span>${item.snapshot ? `<button type="button" data-undo-history="${index}">되돌리기</button>` : ''}</div>`;
    }).join('') : '아직 편집 기록이 없습니다.';
    document.getElementById('editHistoryList').querySelectorAll('[data-undo-history]').forEach(button => button.addEventListener('click', () => undoBetaHistory(Number(button.dataset.undoHistory))));
}

function renderSteamLauncherSettings() {
    const container = document.getElementById('steamLauncherSettingsList');
    if (!container || typeof getSteamLauncherRegistry !== 'function') return;
    const registry = getSteamLauncherRegistry();
    container.replaceChildren();

    if (registry.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'recent-week-empty';
        empty.textContent = '등록된 통합 런처가 없습니다.';
        container.appendChild(empty);
        return;
    }

    registry.forEach((launcher, launcherIndex) => {
        const item = document.createElement('div');
        item.className = 'steam-launcher-settings-item';
        const head = document.createElement('div');
        head.className = 'steam-launcher-settings-head';
        const title = document.createElement('strong');
        title.textContent = launcher.title;
        const appId = document.createElement('small');
        appId.textContent = `AppID: ${launcher.appId}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '런처 제거';
        remove.addEventListener('click', () => {
            if (!confirm(`'${launcher.title}' 통합 런처와 하위 게임 등록을 제거할까요? 기존 게임 기록은 삭제하지 않습니다.`)) return;
            const updated = getSteamLauncherRegistry();
            updated.splice(launcherIndex, 1);
            saveSteamLauncherRegistry(updated);
            renderBetaSettings();
        });
        head.append(title, appId, remove);

        const childList = document.createElement('div');
        childList.className = 'steam-launcher-child-list';
        if (launcher.children.length === 0) {
            const empty = document.createElement('small');
            empty.textContent = '하위 게임을 하나 이상 등록해야 동기화 때 선택할 수 있습니다.';
            childList.appendChild(empty);
        }
        launcher.children.forEach((child, childIndex) => {
            const row = document.createElement('div');
            row.className = 'steam-launcher-child-row';
            const name = document.createElement('span');
            name.textContent = child.appId ? `${child.title} (상점 AppID: ${child.appId})` : child.title;
            const removeChild = document.createElement('button');
            removeChild.type = 'button';
            removeChild.textContent = '제거';
            removeChild.addEventListener('click', () => {
                const updated = getSteamLauncherRegistry();
                updated[launcherIndex].children.splice(childIndex, 1);
                saveSteamLauncherRegistry(updated);
                renderBetaSettings();
            });
            row.append(name, removeChild);
            childList.appendChild(row);
        });

        const addRow = document.createElement('div');
        addRow.className = 'steam-launcher-child-add';
        const childTitle = document.createElement('input');
        childTitle.type = 'text';
        childTitle.placeholder = '하위 게임 이름';
        const childAppId = document.createElement('input');
        childAppId.type = 'text';
        childAppId.inputMode = 'numeric';
        childAppId.placeholder = '상점 AppID (선택)';
        const addChild = document.createElement('button');
        addChild.type = 'button';
        addChild.textContent = '하위 게임 추가';
        addChild.addEventListener('click', () => {
            const name = childTitle.value.trim();
            const storeAppId = childAppId.value.trim();
            if (!name) return alert('하위 게임 이름을 입력해 주세요.');
            if (storeAppId && !/^\d+$/.test(storeAppId)) return alert('상점 AppID는 숫자만 입력해 주세요.');
            const updated = getSteamLauncherRegistry();
            if (updated[launcherIndex].children.some(child => child.title.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('같은 하위 게임이 이미 등록되어 있습니다.');
            updated[launcherIndex].children.push({ title: name, appId: storeAppId });
            saveSteamLauncherRegistry(updated);
            renderBetaSettings();
        });
        addRow.append(childTitle, childAppId, addChild);
        item.append(head, childList, addRow);
        container.appendChild(item);
    });
}

function addSteamLauncherFromSettings() {
    if (typeof getSteamLauncherRegistry !== 'function') return;
    const titleInput = document.getElementById('newSteamLauncherTitle');
    const appIdInput = document.getElementById('newSteamLauncherAppId');
    const title = titleInput.value.trim();
    const appId = appIdInput.value.trim();
    if (!title || !appId) return alert('런처 이름과 Steam AppID를 모두 입력해 주세요.');
    if (!/^\d+$/.test(appId)) return alert('Steam AppID는 숫자만 입력해 주세요.');
    const registry = getSteamLauncherRegistry();
    if (registry.some(launcher => launcher.appId === appId)) return alert('같은 Steam AppID의 런처가 이미 등록되어 있습니다.');
    registry.push({ title, appId, children: [] });
    saveSteamLauncherRegistry(registry);
    titleInput.value = '';
    appIdInput.value = '';
    renderBetaSettings();
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
function openSettings() { renderBetaSettings(); setModalVisibility(document.getElementById('settingsModal'), true); }
function closeSettings() { setModalVisibility(document.getElementById('settingsModal'), false); }
function saveSettingsFromModal() {
    const settings = getBetaSettings();
    settings.calendarBlockStyle = document.getElementById('calendarBlockStyle').value;
    settings.calendarMonthDisplay = document.getElementById('calendarMonthDisplay').value;
    settings.showSteamTotalOnCalendar = document.getElementById('showSteamTotalOnCalendar').value === 'true';
    settings.themeMode = document.getElementById('themeMode').value;
    document.querySelectorAll('[data-platform-index]').forEach(input => { settings.platforms[Number(input.dataset.platformIndex)].color = input.value; });
    saveBetaSettings(settings);
    localEvents.forEach(event => { event.backgroundColor = determineEventColor(event.extendedProps); });
    saveToLocalStorage(); applyBetaTheme(); renderPlatformOptions('gamePlatform');
    if (calendar) {
        const showFullGrid = settings.calendarMonthDisplay === 'full-grid';
        calendar.setOption('fixedWeekCount', showFullGrid);
        calendar.setOption('showNonCurrentDates', showFullGrid);
        document.getElementById('calendar')?.classList.toggle('calendar-current-month-only', !showFullGrid);
        calendar.updateSize();
    }
    refreshUI();
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
    localStorage.removeItem('steam_launcher_registry');
    localStorage.removeItem('steam_launcher_title_mappings');
    localStorage.removeItem('steam_launcher_sync_totals');
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

    const savedSheetSyncToken = localStorage.getItem('user_local_sheet_sync_token');
    if (savedSheetSyncToken && document.getElementById('sheetSyncTokenInput')) {
        document.getElementById('sheetSyncTokenInput').value = savedSheetSyncToken;
    }

    const savedSteamId = localStorage.getItem('user_steam_id');
    if (savedSteamId && document.getElementById('steamIdInput')) {
        document.getElementById('steamIdInput').value = savedSteamId;
    }

    const calendarSettings = getBetaSettings();
    calendarEl.classList.toggle('calendar-current-month-only', calendarSettings.calendarMonthDisplay !== 'full-grid');
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth', locale: 'ko',
        fixedWeekCount: calendarSettings.calendarMonthDisplay === 'full-grid',
        showNonCurrentDates: calendarSettings.calendarMonthDisplay === 'full-grid',
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
            if (migrateRecordDataModel()) saveToLocalStorage();
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
    document.getElementById('addSteamLauncherButton').addEventListener('click', addSteamLauncherFromSettings);
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
