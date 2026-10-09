// ==========================================
// 🎮 STEAM MODULE: 스팀 인증 및 플레이타임 동기화
// ==========================================

const MIN_STEAM_SYNC_PLAYTIME_MINUTES = 18;
let pendingSteamTitleChanges = [];
const steamStoreTitleCache = new Map();
const steamStoreSearchCache = new Map();

function shouldSyncSteamGame(game) {
    return Number(game?.playtime_forever) >= MIN_STEAM_SYNC_PLAYTIME_MINUTES;
}

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getSteamLastPlayedDate(lastPlayedTimestamp, fallbackDate) {
    const timestamp = Number(lastPlayedTimestamp);
    return Number.isFinite(timestamp) && timestamp > 0
        ? formatLocalDate(new Date(timestamp * 1000))
        : fallbackDate;
}

function getSteamLastPlayedDateOrEmpty(lastPlayedTimestamp) {
    const timestamp = Number(lastPlayedTimestamp);
    return Number.isFinite(timestamp) && timestamp > 0
        ? formatLocalDate(new Date(timestamp * 1000))
        : '';
}

// 1. SteamID64만 브라우저에 보관합니다. API 키는 Vercel 환경 변수에만 저장됩니다.
function saveSteamCredentials() {
    const idVal = document.getElementById('steamIdInput').value.trim();

    if (!/^\d{17}$/.test(idVal)) {
        alert("17자리 숫자로 된 SteamID64를 입력해 주세요.");
        return;
    }

    localStorage.setItem('user_steam_id', idVal);
    // 이전 버전에서 저장한 키는 더 이상 사용하지 않습니다.
    localStorage.removeItem('user_steam_api_key');
    alert("SteamID64가 이 브라우저에 저장되었습니다.");
}

function getSteamCredentials() {
    return {
        steamId: localStorage.getItem('user_steam_id') || ''
    };
}

function toggleSteamHelp() {
    const help = document.getElementById('steamHelp');
    const button = document.getElementById('steamHelpButton');
    const isVisible = help.classList.toggle('is-visible');
    button.setAttribute('aria-expanded', String(isVisible));
    button.innerText = isVisible ? '📕 Steam 도움말 닫기' : '❔ Steam 연결 도움말';
}

function extractSteamAppId(value) {
    const text = String(value || '').trim();
    const storeUrlMatch = text.match(/store\.steampowered\.com\/app\/(\d+)/i);
    if (storeUrlMatch) return storeUrlMatch[1];
    return /^\d+$/.test(text) ? text : '';
}

function linkCurrentGameToSteam() {
    const selected = localEvents.find(event => event.id === currentSelectedEventId);
    if (!selected) return;

    const previousId = selected.extendedProps.steamAppId || '';
    const entered = prompt(
        'Steam 상점 주소 또는 AppID 숫자를 붙여 넣어 주세요.\n예: https://store.steampowered.com/app/1086940/',
        previousId
    );
    if (entered === null) return;

    const steamAppId = extractSteamAppId(entered);
    if (!steamAppId) {
        alert('Steam 상점 주소 또는 숫자로 된 AppID를 확인해 주세요.');
        return;
    }

    const titleKey = selected.title.toLocaleLowerCase();
    const sameTitleRecords = localEvents.filter(event => event.title && event.title.toLocaleLowerCase() === titleKey);
    sameTitleRecords.forEach(event => { event.extendedProps.steamAppId = steamAppId; });
    saveSteamTitleLink(selected.title, steamAppId);
    saveToLocalStorage();
    document.getElementById('modalSteamLinkZone').innerText = `연결됨 (AppID: ${steamAppId})`;
    alert(`'${selected.title}' 기록 ${sameTitleRecords.length}개를 Steam 게임과 연결했습니다. 이제 제목이 달라도 같은 게임으로 동기화합니다.`);
}

function normalizeSteamTitle(title) {
    return String(title || '')
        .toLocaleLowerCase()
        .normalize('NFKD')
        .replace(/[™®©]/g, '')
        .replace(/[\[\]{}()'"`~!@#$%^&*_+=|\\:;,.?\-/]/g, ' ')
        .replace(/\b(the|game|edition|deluxe|complete|ultimate)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleSimilarity(leftTitle, rightTitle) {
    const left = normalizeSteamTitle(leftTitle);
    const right = normalizeSteamTitle(rightTitle);
    if (!left || !right) return 0;
    if (left === right) return 1;

    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    if (shorter >= 5 && (left.includes(right) || right.includes(left))) return shorter / longer;

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row++) {
        let diagonal = previous[0];
        previous[0] = row;
        for (let column = 1; column <= right.length; column++) {
            const before = previous[column];
            previous[column] = Math.min(
                previous[column] + 1,
                previous[column - 1] + 1,
                diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
            );
            diagonal = before;
        }
    }
    return 1 - previous[right.length] / longer;
}

function loadSteamOwnedGames() {
    const creds = getSteamCredentials();
    if (!/^\d{17}$/.test(creds.steamId)) return Promise.reject(new Error('SteamID64를 먼저 저장해 주세요.'));

    return fetch(`/api/steam-owned-games?steamid=${encodeURIComponent(creds.steamId)}`)
        .then(async response => {
            const parsed = await response.json().catch(() => ({}));
            if (!response.ok || parsed.error) throw new Error(parsed.error || 'Steam 게임 목록을 불러오지 못했습니다.');
            return parsed.games || [];
        });
}

function getSteamStoreKoreanTitle(steamAppId) {
    const appId = String(steamAppId || '').trim();
    if (!/^\d+$/.test(appId)) return Promise.resolve('');
    if (!steamStoreTitleCache.has(appId)) {
        const request = fetch(`/api/steam-store-app?appid=${encodeURIComponent(appId)}`)
            .then(async response => {
                const data = await response.json().catch(() => ({}));
                return response.ok && data.available ? String(data.name || '').trim() : '';
            })
            .catch(() => '');
        steamStoreTitleCache.set(appId, request);
    }
    return steamStoreTitleCache.get(appId);
}

function searchSteamStoreKoreanTitles(title) {
    const key = String(title || '').trim().toLocaleLowerCase();
    if (!key) return Promise.resolve([]);
    if (!steamStoreSearchCache.has(key)) {
        const request = fetch(`/api/steam-store-search?term=${encodeURIComponent(title)}`)
            .then(async response => {
                const data = await response.json().catch(() => ({}));
                return response.ok && Array.isArray(data.items) ? data.items : [];
            })
            .catch(() => []);
        steamStoreSearchCache.set(key, request);
    }
    return steamStoreSearchCache.get(key);
}

async function findOwnedGameByKoreanStoreTitle(title, gamesByAppId) {
    const storeItems = await searchSteamStoreKoreanTitles(title);
    // 검색어는 시트에 적힌 한국어 상점명입니다. API의 영어 라이브러리 이름과
    // 유사도를 비교하면 항상 낮아질 수 있으므로, 먼저 상점 검색 결과와 내 소유
    // AppID를 대조합니다. 내 라이브러리에 있는 결과가 하나면 안전하게 연결합니다.
    const candidates = [...new Map(storeItems
        .filter(item => gamesByAppId.has(String(item.appid)))
        .map(item => [String(item.appid), item])).values()];
    if (candidates.length === 1) return gamesByAppId.get(String(candidates[0].appid));

    // 동명·에디션 등 결과가 여러 개인 경우에는 상점 한국어 제목이 정확히 같은
    // 항목 하나만 자동 연결합니다. 그 외에는 애매한 상태로 남겨 둡니다.
    const exactCandidates = candidates.filter(item => normalizeSteamTitle(item.name) === normalizeSteamTitle(title));
    return exactCandidates.length === 1 ? gamesByAppId.get(String(exactCandidates[0].appid)) : null;
}

async function bulkLinkSteamGames(options = {}) {
    const silent = Boolean(options.silent);
    const skipConfirmation = Boolean(options.skipConfirmation);
    const button = document.getElementById('bulkSteamLinkButton');
    const steamRecords = localEvents.filter(event => String(event.extendedProps.platform || '').toLocaleLowerCase() === 'steam');
    const unlinkedTitles = [...new Set(steamRecords
        .filter(event => !event.extendedProps.steamAppId)
        .map(event => event.title)
        .filter(Boolean))];

    if (unlinkedTitles.length === 0) {
        if (!silent) alert('연결할 Steam 기록이 없습니다. 이미 모두 연결되어 있거나 플랫폼이 Steam이 아닙니다.');
        return { linkedTitles: 0, linkedRecords: 0, remaining: 0 };
    }
    if (!skipConfirmation && !confirm(`연결되지 않은 Steam 게임 ${unlinkedTitles.length}개를 내 Steam 라이브러리와 비교합니다.\n이름이 정확히 같거나 매우 비슷한 게임만 자동 연결합니다. 계속할까요?`)) return null;

    button.disabled = true;
    button.innerText = '⏳ Steam 게임 비교 중...';
    try {
        const ownedGames = options.ownedGames || await loadSteamOwnedGames();
        const gamesByAppId = new Map(ownedGames.map(game => [String(game.appid || ''), game]));
        let linkedTitles = 0;
        let linkedRecords = 0;
        let koreanStoreLinkedTitles = 0;

        for (const title of unlinkedTitles) {
            let best = null;
            let bestScore = -1;
            let nextBestScore = -1;
            ownedGames.forEach(game => {
                const score = titleSimilarity(title, game.name);
                if (score > bestScore) {
                    nextBestScore = bestScore;
                    bestScore = score;
                    best = { game, score };
                } else if (score > nextBestScore) {
                    nextBestScore = score;
                }
            });
            const clearlyBest = best && (best.score === 1 || (best.score >= 0.92 && best.score - nextBestScore >= 0.12));
            if (!clearlyBest) {
                best = await findOwnedGameByKoreanStoreTitle(title, gamesByAppId);
                if (!best) continue;
                koreanStoreLinkedTitles++;
            }

            const steamAppId = String((best.game || best).appid || '');
            if (!steamAppId) continue;
            localEvents.forEach(event => {
                if (event.title === title && !event.extendedProps.steamAppId) {
                    event.extendedProps.steamAppId = steamAppId;
                    linkedRecords++;
                }
            });
            saveSteamTitleLink(title, steamAppId);
            linkedTitles++;
        }

        saveToLocalStorage();
        refreshUI();
        const remaining = unlinkedTitles.length - linkedTitles;
        const koreanStoreMessage = koreanStoreLinkedTitles > 0 ? `\n(한국어 Steam 상점 이름으로 연결: ${koreanStoreLinkedTitles}개)` : '';
        if (!silent) alert(`자동 연결 완료\n\n연결한 게임: ${linkedTitles}개 (${linkedRecords}개 기록)${koreanStoreMessage}\n확인 필요: ${remaining}개\n\n확인 필요 게임은 상세 화면의 'Steam 게임 연결'에서 상점 주소를 붙여 넣어 연결할 수 있습니다.`);
        return { linkedTitles, linkedRecords, koreanStoreLinkedTitles, remaining };
    } catch (error) {
        if (silent) throw error;
        alert(`자동 연결 실패: ${error.message}`);
        return null;
    } finally {
        button.disabled = false;
        button.innerText = '🔗 Steam 기록 한꺼번에 연결';
    }
}

// 통합 최초 불러오기에서는 화면·로컬 저장소에 넣기 전에 Steam 상점 제목으로 통일합니다.
// 확정할 수 없는 제목은 건드리지 않아 잘못된 게임으로 합쳐지지 않습니다.
async function normalizeIncomingSteamSheetRecords(records, ownedGames) {
    const gamesByAppId = new Map(ownedGames.map(game => [String(game.appid || ''), game]));
    const groups = new Map();
    records.forEach(record => {
        const game = record.extendedProps || {};
        if (String(game.platform || '').toLocaleLowerCase() !== 'steam') return;
        const key = String(record.title || game.title || '').trim();
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    });

    let linkedTitles = 0;
    let renamedTitles = 0;
    const unresolvedTitles = [];
    for (const [title, group] of groups) {
        const existingAppId = String(group[0].extendedProps.steamAppId || '').trim();
        let matchedGame = existingAppId ? gamesByAppId.get(existingAppId) : null;

        if (!matchedGame) {
            let best = null;
            let bestScore = -1;
            let nextBestScore = -1;
            ownedGames.forEach(game => {
                const score = titleSimilarity(title, game.name);
                if (score > bestScore) {
                    nextBestScore = bestScore;
                    bestScore = score;
                    best = game;
                } else if (score > nextBestScore) {
                    nextBestScore = score;
                }
            });
            if (best && (bestScore === 1 || (bestScore >= 0.92 && bestScore - nextBestScore >= 0.12))) {
                matchedGame = best;
            } else {
                matchedGame = await findOwnedGameByKoreanStoreTitle(title, gamesByAppId);
            }
        }

        if (!matchedGame) {
            unresolvedTitles.push(title);
            continue;
        }

        const appId = String(matchedGame.appid || '');
        const officialTitle = await getSteamStoreKoreanTitle(appId) || String(matchedGame.name || title);
        const changedTitle = officialTitle !== title;
        group.forEach(record => {
            record.title = officialTitle;
            record.extendedProps.title = officialTitle;
            record.extendedProps.steamAppId = appId;
        });
        saveSteamTitleLink(title, appId);
        saveSteamTitleLink(officialTitle, appId);
        linkedTitles++;
        if (changedTitle) renamedTitles++;
    }
    return { records, linkedTitles, renamedTitles, unresolvedTitles };
}

// 처음 연결할 때 시트 기록을 먼저 기준 데이터로 가져온 뒤 Steam 정보를 안전하게 반영합니다.
async function initialCombinedSync() {
    const button = document.getElementById('initialCombinedSyncButton');
    const sheetUrl = document.getElementById('spreadsheetUrlInput')?.value.trim();
    const webAppUrl = localStorage.getItem('user_local_web_app_url');
    const steamId = getSteamCredentials().steamId;

    if (!sheetUrl || !extractSpreadsheetId(sheetUrl)) {
        alert('먼저 구글 스프레드시트 주소를 “기록 가져오기”에 입력해 주세요.');
        return;
    }
    if (!webAppUrl) {
        alert('먼저 “기록 저장하기”에 Apps Script의 /exec 주소를 저장해 주세요.');
        return;
    }
    if (!/^\d{17}$/.test(steamId)) {
        alert('먼저 SteamID64를 입력하고 저장해 주세요.');
        return;
    }
    if (!confirm('스프레드시트와 Steam 라이브러리를 함께 불러온 뒤, Steam 상점 이름으로 제목을 정리하고 플레이 정보를 비교합니다.\n\nAppID를 확정하지 못한 기존 Steam 기록은 이번 동기화에서 제외합니다. 연결된 게임은 계속 안전하게 반영합니다. 계속할까요?')) return;

    button.disabled = true;
    button.innerText = '⏳ 시트와 Steam 불러오는 중...';
    try {
        localStorage.setItem('saved_game_sheet_url', sheetUrl);
        const [sheetRecords, ownedGames] = await Promise.all([
            fetchAllYearTabsForInitialSync(webAppUrl),
            loadSteamOwnedGames()
        ]);
        if (!sheetRecords) {
            alert('시트 기록을 읽지 못해 통합 동기화를 중단했습니다.');
            return;
        }

        button.innerText = '⏳ Steam 상점 제목 통일 중...';
        const incomingResult = await normalizeIncomingSteamSheetRecords(sheetRecords, ownedGames);
        const appliedSheetRecords = applyIncomingSheetRecords(incomingResult.records, '구글 시트');
        if (!appliedSheetRecords) {
            alert('시트 기록을 로컬에 적용하지 않아 통합 동기화를 중단했습니다.');
            return;
        }

        button.innerText = '⏳ Steam 기록 연결 중...';
        const linkResult = await bulkLinkSteamGames({ silent: true, skipConfirmation: true, ownedGames });
        button.innerText = '⏳ Steam 상점 이름으로 제목 정리 중...';
        const titleResult = await normalizeExistingSteamTitles({ silent: true, autoApply: true, skipSheetSync: true, ownedGames });
        const stillUnlinkedTitles = [...new Set(localEvents
            .filter(event => String(event.extendedProps.platform || '').toLocaleLowerCase() === 'steam' && !event.extendedProps.steamAppId)
            .map(event => event.title)
            .filter(Boolean))];
        if (stillUnlinkedTitles.length > 0) {
            // AppID가 없는 기존 제목은 Steam의 어느 게임인지 확정할 수 없습니다. 이 경우에는
            // 새 Steam 레코드를 만들지 않고, 이미 AppID가 연결된 게임만 안전하게 업데이트합니다.
            button.innerText = '⏳ 연결된 Steam 기록 반영 중...';
            const syncResult = await syncRecentSteamPlaytime({
                silent: true,
                ownedGames,
                onlyExistingLinkedRecords: true,
                useLastPlayedDateForSheetRemainder: true
            });
            openInitialSyncNextSteps({
                unresolvedTitles: stillUnlinkedTitles,
                linkResult,
                titleResult,
                syncResult
            });
            return;
        }

        button.innerText = '⏳ Steam 최신 정보 반영 중...';
        const syncResult = await syncRecentSteamPlaytime({ silent: true, ownedGames, useLastPlayedDateForSheetRemainder: true });
        alert(`통합 초기 동기화 완료\n\n시트 기록을 Steam 상점 제목으로 먼저 통일한 뒤 불러왔습니다.\n입력 전 AppID 연결: ${incomingResult.linkedTitles}개\n입력 전 제목 통일: ${incomingResult.renamedTitles}개\n추가 Steam 연결: ${linkResult?.linkedTitles || 0}개\n추가 제목 정리: ${titleResult?.changedGames || 0}개\n새 플레이 기록: ${syncResult?.updatedCount || 0}개\n마지막 실행일에 추가한 남은 시간: ${syncResult?.lastPlayedRemainderCount || 0}개`);
    } catch (error) {
        alert(`통합 초기 동기화 실패: ${error.message}`);
    } finally {
        button.disabled = false;
        button.innerText = '⚡ 처음 데이터 통합 동기화';
    }
}

function openInitialSyncNextSteps({ unresolvedTitles, linkResult, titleResult, syncResult }) {
    const modal = document.getElementById('initialSyncNextStepsModal');
    const summary = document.getElementById('initialSyncNextStepsSummary');
    const examples = unresolvedTitles.slice(0, 6).join(', ');
    const more = unresolvedTitles.length > 6 ? ` 외 ${unresolvedTitles.length - 6}개` : '';
    summary.textContent = `시트 기록을 불러오고, AppID가 연결된 Steam 게임은 계속 반영했습니다. AppID를 확정하지 못한 ${unresolvedTitles.length}개 게임은 중복을 막기 위해 이번 Steam 반영에서 제외했습니다.${examples ? `\n\n확인 필요: ${examples}${more}` : ''}\n\n자동 연결: ${linkResult?.linkedTitles || 0}개 · 제목 정리: ${titleResult?.changedGames || 0}개 · 연결된 게임의 새 기록: ${syncResult?.updatedCount || 0}개`;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
}

function closeInitialSyncNextSteps() {
    const modal = document.getElementById('initialSyncNextStepsModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
}

async function retryInitialSyncSteamLinking() {
    closeInitialSyncNextSteps();
    await bulkLinkSteamGames();
    await normalizeExistingSteamTitles();
}

function openInitialSyncTitleConverter() {
    closeInitialSyncNextSteps();
    normalizeExistingSteamTitles();
}

async function repairSteamSyncDates() {
    const candidates = localEvents.filter(event => {
        const game = event.extendedProps || {};
        // 마지막 실행일 조회에는 AppID만 필요합니다. 과거 시트 기록처럼
        // Steam 누적시간이 비어 있는 항목도 AppID가 확인되면 안전하게 재정렬합니다.
        return String(game.platform || '').toLocaleLowerCase() === 'steam'
            && /^\d+$/.test(String(game.steamAppId || ''));
    });
    const dates = [...new Set(candidates.map(event => event.extendedProps.startDate).filter(Boolean))].sort();
    if (dates.length === 0) {
        alert('Steam 날짜를 재정렬할 기록이 없습니다. Steam AppID가 연결된 기록만 처리할 수 있습니다.');
        return;
    }
    const selectedDate = prompt(`오늘로 몰린 Steam 기록의 날짜를 입력해 주세요.\n가능한 날짜: ${dates.join(', ')}`, dates[dates.length - 1]);
    if (selectedDate === null) return;
    const targetDate = selectedDate.trim();
    const targets = candidates.filter(event => event.extendedProps.startDate === targetDate);
    if (targets.length === 0) {
        alert('해당 날짜의 Steam AppID 연결 기록을 찾지 못했습니다.');
        return;
    }
    if (!confirm(`${targetDate}에 몰린 Steam 기록 ${targets.length}개의 날짜를 Steam 마지막 실행일 기준으로 재정렬할까요?\n\n마지막 실행일을 제공하지 않는 게임은 현재 날짜를 유지합니다.`)) return;

    try {
        const ownedGames = await loadSteamOwnedGames();
        const lastPlayedByAppId = new Map(ownedGames.map(game => [String(game.appid || ''), getSteamLastPlayedDateOrEmpty(game.rtime_last_played)]));
        let movedCount = 0;
        let unavailableCount = 0;
        recordEditHistory('Steam 날짜 재정렬', `${targetDate} · ${targets.length}개 기록`, localEvents);

        targets.forEach(event => {
            const lastPlayedDate = lastPlayedByAppId.get(String(event.extendedProps.steamAppId || '')) || '';
            if (!lastPlayedDate) {
                unavailableCount++;
                return;
            }
            if (lastPlayedDate === event.extendedProps.startDate
                && (event.extendedProps.rawEndDate || event.extendedProps.endDate || '') === lastPlayedDate) return;
            event.extendedProps.startDate = lastPlayedDate;
            event.extendedProps.rawEndDate = lastPlayedDate;
            event.extendedProps.endDate = '';
            movedCount++;
        });

        if (movedCount > 0) {
            saveToLocalStorage();
            refreshUI();
            syncAllRecordsSafely();
        }
        alert(`날짜 재정렬 완료\n\nSteam 마지막 실행일로 이동: ${movedCount}개\n마지막 실행일 정보가 없어 유지: ${unavailableCount}개`);
    } catch (error) {
        alert(`Steam 날짜 재정렬 실패: ${error.message}`);
    }
}

function rollbackSteamFirstSyncRecords() {
    const firstSyncRecords = localEvents.filter(event => String(event.extendedProps.memo || '') === '스팀 최초 동기화 세션 (마지막 실행일 기준)');
    // 이전 버전은 최초 동기화 메모가 시트에 남지 않은 경우가 있어,
    // Steam 누적시간이 있는 날짜별 Steam 기록을 복구 후보로 함께 제공합니다.
    const hasFirstSyncMarker = firstSyncRecords.length > 0;
    const rollbackCandidates = hasFirstSyncMarker
        ? firstSyncRecords
        : localEvents.filter(event => {
            const game = event.extendedProps || {};
            return String(game.platform || '').toLocaleLowerCase() === 'steam'
                && game.steamTotal !== null && game.steamTotal !== '' && Number.isFinite(Number(game.steamTotal));
        });
    const dates = [...new Set(rollbackCandidates.map(event => event.extendedProps.startDate).filter(Boolean))].sort();
    if (dates.length === 0) {
        alert('되돌릴 Steam 최초 동기화 기록이 없습니다.');
        return;
    }
    const selectedDate = prompt(`되돌릴 Steam 최초 동기화 날짜를 입력해 주세요.\n가능한 날짜: ${dates.join(', ')}`, dates[dates.length - 1]);
    if (selectedDate === null) return;
    const targetDate = selectedDate.trim();
    const targets = rollbackCandidates.filter(event => event.extendedProps.startDate === targetDate);
    if (targets.length === 0) {
        alert('해당 날짜의 Steam 최초 동기화 기록을 찾지 못했습니다.');
        return;
    }
    const fallbackWarning = hasFirstSyncMarker
        ? ''
        : '\n\n이 기록들은 이전 버전에서 최초 동기화 메모가 저장되지 않은 Steam 누적시간 기록입니다. 같은 날짜에 직접 추가한 Steam 기록도 포함될 수 있으니 개수를 확인해 주세요.';
    if (!confirm(`${targetDate}의 Steam 동기화 후보 기록 ${targets.length}개를 삭제할까요?${fallbackWarning}\n\n시트 저장 주소가 설정돼 있으면 삭제 결과도 시트에 반영됩니다.`)) return;

    recordEditHistory('Steam 최초 동기화 되돌리기', `${targetDate} · ${targets.length}개 기록`, localEvents);
    const targetIds = new Set(targets.map(event => event.id));
    localEvents = localEvents.filter(event => !targetIds.has(event.id));
    uniqueTitles = [];
    saveToLocalStorage();
    refreshUI();
    syncAllRecordsSafely();
    alert(`${targetDate}의 Steam 동기화 기록 ${targets.length}개를 되돌렸습니다.`);
}

// 기존 Steam 기록의 표시 제목을 Steam 상점의 한국어 이름으로 맞춥니다.
// AppID가 이미 연결된 경우를 우선하고, 없는 경우에는 자동 연결과 같은 보수적인 이름 비교만 사용합니다.
async function normalizeExistingSteamTitles(options = {}) {
    const silent = Boolean(options.silent);
    const button = document.getElementById('normalizeSteamTitlesButton');
    const steamRecords = localEvents.filter(event => String(event.extendedProps.platform || '').toLocaleLowerCase() === 'steam');
    if (steamRecords.length === 0) {
        if (!silent) alert('정리할 Steam 플랫폼 기록이 없습니다.');
        return { changedGames: 0, changedRecords: 0 };
    }

    button.disabled = true;
    button.innerText = '⏳ Steam 이름 확인 중...';
    try {
        const ownedGames = options.ownedGames || await loadSteamOwnedGames();
        const gamesByAppId = new Map(ownedGames.map(game => [String(game.appid), game]));
        const groups = new Map();

        steamRecords.forEach(event => {
            const appId = String(event.extendedProps.steamAppId || '').trim();
            const key = appId ? `appid:${appId}` : `title:${event.title}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(event);
        });

        const matches = [];
        for (const records of groups.values()) {
            const currentTitle = String(records[0].title || '').trim();
            const currentAppId = String(records[0].extendedProps.steamAppId || '').trim();
            let matchedGame = currentAppId ? gamesByAppId.get(currentAppId) : null;

            if (!matchedGame && !currentAppId) {
                let best = null;
                let bestScore = -1;
                let nextBestScore = -1;
                ownedGames.forEach(game => {
                    const score = titleSimilarity(currentTitle, game.name);
                    if (score > bestScore) {
                        nextBestScore = bestScore;
                        bestScore = score;
                        best = game;
                    } else if (score > nextBestScore) {
                        nextBestScore = score;
                    }
                });
                if (best && (bestScore === 1 || (bestScore >= 0.92 && bestScore - nextBestScore >= 0.12))) matchedGame = best;
                if (!matchedGame) matchedGame = await findOwnedGameByKoreanStoreTitle(currentTitle, gamesByAppId);
            }

            const apiTitle = String(matchedGame?.name || '').trim();
            const appId = String(matchedGame?.appid || currentAppId || '').trim();
            if (!apiTitle || !appId) continue;
            matches.push({ records, currentTitle, apiTitle, appId });
        }

        const changes = (await Promise.all(matches.map(async match => {
            const koreanStoreTitle = await getSteamStoreKoreanTitle(match.appId);
            const officialTitle = koreanStoreTitle || match.apiTitle;
            const titleChanged = match.currentTitle !== officialTitle;
            const appIdLinked = match.records.some(event => String(event.extendedProps.steamAppId || '') !== match.appId);
            return titleChanged || appIdLinked ? { ...match, officialTitle, titleChanged, appIdLinked } : null;
        }))).filter(Boolean);

        if (changes.length === 0) {
            if (!silent) alert('자동으로 확정할 수 있는 제목 변경이 없습니다.\n상점 검색 결과가 여러 개이거나 검색되지 않은 게임은 이번 작업에서 그대로 둡니다. 다른 기록은 변경되지 않습니다.');
            return { changedGames: 0, changedRecords: 0 };
        }

        if (options.autoApply) return commitSteamTitleChanges(changes, { skipSheetSync: Boolean(options.skipSheetSync) });
        openSteamTitleConverter(changes);
        return { changedGames: 0, changedRecords: 0, awaitingSelection: changes.length };
    } catch (error) {
        if (silent) throw error;
        alert(`Steam 제목 정리 실패: ${error.message}`);
        return null;
    } finally {
        button.disabled = false;
        button.innerText = '✏️ Steam 상점 이름으로 제목 정리';
    }
}

function openSteamTitleConverter(changes) {
    pendingSteamTitleChanges = changes;
    const list = document.getElementById('steamTitleConverterList');
    list.replaceChildren();
    changes.forEach((change, index) => {
        const label = document.createElement('label');
        label.className = 'steam-title-converter-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.changeIndex = String(index);
        const text = document.createElement('div');
        const from = document.createElement('span');
        from.className = 'steam-title-converter-from';
        from.textContent = change.currentTitle;
        const arrow = document.createElement('span');
        arrow.className = 'steam-title-converter-arrow';
        arrow.textContent = ' → ';
        const to = document.createElement('span');
        to.className = 'steam-title-converter-to';
        to.textContent = change.officialTitle;
        const meta = document.createElement('small');
        meta.className = 'steam-title-converter-meta';
        meta.textContent = `${change.records.length}개 기록 · AppID ${change.appId}`;
        text.append(from, arrow, to, meta);
        label.append(checkbox, text);
        list.appendChild(label);
    });
    const modal = document.getElementById('steamTitleConverterModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
}

function closeSteamTitleConverter() {
    const modal = document.getElementById('steamTitleConverterModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    pendingSteamTitleChanges = [];
}

function commitSteamTitleChanges(selected, options = {}) {
    const recordCount = selected.reduce((sum, change) => sum + change.records.length, 0);
    recordEditHistory('Steam 제목 정리', `${selected.length}개 게임`, localEvents);
    selected.forEach(change => {
        change.records.forEach(event => {
            event.title = change.officialTitle;
            event.extendedProps.title = change.officialTitle;
            event.extendedProps.steamAppId = change.appId;
        });
        saveSteamTitleLink(change.currentTitle, change.appId);
        saveSteamTitleLink(change.officialTitle, change.appId);
    });
    saveToLocalStorage();
    refreshUI();
    if (!options.skipSheetSync) syncAllRecordsSafely();
    return { changedGames: selected.length, changedRecords: recordCount };
}

function applySteamTitleConversions() {
    const selected = [...document.querySelectorAll('#steamTitleConverterList input:checked')]
        .map(input => pendingSteamTitleChanges[Number(input.dataset.changeIndex)])
        .filter(Boolean);
    if (selected.length === 0) {
        alert('적용할 게임을 하나 이상 선택해 주세요.');
        return;
    }

    const result = commitSteamTitleChanges(selected);
    closeSteamTitleConverter();
    alert(`정리 완료: ${result.changedGames}개 게임 (${result.changedRecords}개 기록)의 Steam 이름을 맞췄습니다.`);
}

// 2. 계산기 입력 시 스팀 총 플레이타임 자동 조회
async function autoFillPrevTime(gameNameInput) {
    let trimmed = gameNameInput.trim().toLowerCase();
    if (!trimmed) { 
        document.getElementById('calcPrevTime').value = ''; 
        return; 
    }
    
    // 기존 누적 시간 계산
    let sameGames = localEvents.filter(e => e.title && e.title.toLowerCase() === trimmed);
    let currentTotal = sameGames.reduce((acc, curr) => acc + curr.extendedProps.time, 0);
    document.getElementById('calcPrevTime').value = currentTotal > 0 ? currentTotal.toFixed(1) : '0';

    // Vercel API를 통해 최신 Steam 플레이 시간을 가져옵니다.
    const steamCreds = getSteamCredentials();
    if (steamCreds.steamId) {
        try {
            const ownedGames = await loadSteamOwnedGames();
            const foundGame = ownedGames.find(g => g.name.toLowerCase() === trimmed);
            if (foundGame) {
                const steamHours = (foundGame.playtime_forever / 60).toFixed(1);
                document.getElementById('calcCurrTime').value = steamHours;
                calculateTimeDifference();
            }
        } catch (e) {
            console.warn("스팀 플레이타임 자동 조회 생략:", e);
        }
    }
}

function calculateTimeDifference() {
    let prev = parseFloat(document.getElementById('calcPrevTime').value || 0);
    let curr = parseFloat(document.getElementById('calcCurrTime').value || 0);
    if (curr <= prev) {
        document.getElementById('calcResultBox').innerHTML = `<span style="color:#ef4444; font-weight:bold;">⚠️ 알림: 현재 총 시간(${curr}h)이 이전 누적 시간(${prev}h)보다 커야 새 플레이 시간이 계산됩니다.</span>`;
        return;
    }
    let diff = (curr - prev).toFixed(1);
    document.getElementById('gameTime').value = diff; 
    document.getElementById('calcResultBox').innerHTML = `📈 계산 완료: 이전 기록 대비 <span style="color:#10b981; font-weight:bold; font-size:1.1em;">+${diff}</span> 시간 증가 자동 반영 완료!`;
}


// 3. 원클릭 스팀 최근 플레이 동기화 (Vercel API 연동)
async function syncRecentSteamPlaytime(options = {}) {
    const silent = Boolean(options.silent);
    const creds = getSteamCredentials();
    if (!creds.steamId) {
        const error = new Error('먼저 SteamID64를 입력하고 저장해 주세요!');
        if (silent) throw error;
        alert(error.message);
        return null;
    }

    const syncBtns = document.querySelectorAll('button[onclick*="syncRecentSteamPlaytime"]');
    syncBtns.forEach(b => { b.disabled = true; b.innerText = "⏳ 스팀 통신 중..."; });

    try {
        const games = options.ownedGames || await loadSteamOwnedGames();
        if (games.length === 0) {
            const error = new Error('스팀 라이브러리 데이터를 가져오지 못했습니다. 프로필 공개 설정과 SteamID64를 확인해 주세요.');
            if (silent) throw error;
            alert(error.message);
            return null;
        }

        let updatedCount = 0;
        let skippedShortPlaytimeCount = 0;
        let skippedUnknownLastPlayedCount = 0;
        let skippedUnlinkedRecordCount = 0;
        let lastPlayedRemainderCount = 0;
        const todayStr = formatLocalDate(new Date());

        for (const game of games) {
            if (!shouldSyncSteamGame(game)) {
                skippedShortPlaytimeCount++;
                continue;
            }

            const name = game.name;
            const steamAppId = String(game.appid || '');
            const currentTotalSteamHours = parseFloat((game.playtime_forever / 60).toFixed(1));

            // Steam 동기화는 제목이 아니라 Steam AppID가 같은 기록만 합산합니다.
            const appIdRecords = steamAppId
                ? localEvents.filter(e => String(e.extendedProps.steamAppId || '') === steamAppId)
                : [];
            const existingRecords = appIdRecords;
            const isFirstSync = existingRecords.length === 0;
            // 통합 최초 동기화 중 AppID를 확인하지 못한 기존 시트 기록이 있을 때는
            // 새 기록을 만들지 않습니다. 제목만 비슷한 게임에 잘못 합쳐지는 일을 막습니다.
            if (options.onlyExistingLinkedRecords && isFirstSync) {
                skippedUnlinkedRecordCount++;
                continue;
            }
            const steamLastPlayedDate = getSteamLastPlayedDateOrEmpty(game.rtime_last_played);
            // 신규 게임은 Steam이 실제 마지막 실행일을 제공하는 경우에만 첫 기록을 만듭니다.
            // 날짜가 없으면 오늘로 임의 배치하지 않아 달력에 대량 기록이 생기는 것을 막습니다.
            if (isFirstSync && !steamLastPlayedDate) {
                skippedUnknownLastPlayedCount++;
                continue;
            }
            const recordsWithSteamTotal = existingRecords
                .filter(record => record.extendedProps.steamTotal !== null && record.extendedProps.steamTotal !== '' && Number.isFinite(Number(record.extendedProps.steamTotal)))
                .sort((first, second) => {
                    const firstDate = first.extendedProps.startDate || '';
                    const secondDate = second.extendedProps.startDate || '';
                    return firstDate.localeCompare(secondDate) || first.id.localeCompare(second.id);
                });
            const lastRecordedSteamTotal = recordsWithSteamTotal.length
                ? Number(recordsWithSteamTotal[recordsWithSteamTotal.length - 1].extendedProps.steamTotal)
                : null;
            const recordedTotalHours = lastRecordedSteamTotal ?? existingRecords.reduce((sum, e) => sum + e.extendedProps.time, 0);
            const diffHours = parseFloat((currentTotalSteamHours - recordedTotalHours).toFixed(1));

            if (diffHours > 0) {
                // 통합 최초 불러오기에서는 시트에 이미 적힌 시간을 먼저 유지하고,
                // Steam 누적시간과의 차이만 마지막 실행일에 별도 기록합니다.
                const displayName = existingRecords[0]?.title || name;
                const hasSheetEndDate = existingRecords.some(record => Boolean(record.extendedProps.endDate));
                const useLastPlayedForRemainder = Boolean(
                    options.useLastPlayedDateForSheetRemainder
                    && !isFirstSync
                    && hasSheetEndDate
                    && steamLastPlayedDate
                );
                const syncDate = (isFirstSync || useLastPlayedForRemainder)
                    ? getSteamLastPlayedDate(game.rtime_last_played, todayStr)
                    : todayStr;
                const syncMemo = isFirstSync
                    ? '스팀 최초 동기화 세션 (마지막 실행일 기준)'
                    : useLastPlayedForRemainder
                        ? '시트 기록 이후 Steam 잔여 시간 (마지막 실행일 기준)'
                    : '스팀 동기화 세션';
                const newGame = createGameObj(displayName, syncDate, syncDate, 'steam', diffHours, 'x', syncMemo, '', false, steamAppId, currentTotalSteamHours);
                localEvents.push(newGame);
                updatedCount++;
                if (useLastPlayedForRemainder) lastPlayedRemainderCount++;
            }
        }

        if (updatedCount > 0) {
            refreshUI();
            saveToLocalStorage();
            syncAllRecordsSafely();
            const skippedMessages = [];
            if (skippedShortPlaytimeCount > 0) skippedMessages.push(`총 플레이 0.3시간 미만 게임 ${skippedShortPlaytimeCount}개 제외`);
            if (skippedUnknownLastPlayedCount > 0) skippedMessages.push(`마지막 실행일 정보가 없는 신규 게임 ${skippedUnknownLastPlayedCount}개 제외`);
            const skippedMessage = skippedMessages.length ? `\n(${skippedMessages.join(' / ')})` : '';
            const syncMessage = `🎉 총 ${updatedCount}개 스팀 게임의 플레이 기록이 동기화되었습니다!`;
            if (!silent) alert(`${syncMessage}${skippedMessage}`);
        } else {
            const skippedMessages = [];
            if (skippedShortPlaytimeCount > 0) skippedMessages.push(`총 플레이 0.3시간 미만 게임 ${skippedShortPlaytimeCount}개 제외`);
            if (skippedUnknownLastPlayedCount > 0) skippedMessages.push(`마지막 실행일 정보가 없는 신규 게임 ${skippedUnknownLastPlayedCount}개 제외`);
            const skippedMessage = skippedMessages.length ? `\n(${skippedMessages.join(' / ')})` : '';
            if (!silent) alert(`이미 모든 스팀 게임의 최신 플레이타임이 반영되어 있습니다! (새로 늘어난 시간 없음)${skippedMessage}`);
        }
        return { updatedCount, skippedShortPlaytimeCount, skippedUnlinkedRecordCount, lastPlayedRemainderCount };
    } catch (error) {
        if (silent) throw error;
        alert(`스팀 연동 실패: ${error.message}`);
        return null;
    } finally {
        syncBtns.forEach(b => { b.disabled = false; b.innerText = "🔄 최근 플레이 동기화"; });
    }
}
