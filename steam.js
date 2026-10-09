// ==========================================
// 🎮 STEAM MODULE: 스팀 인증 및 플레이타임 동기화
// ==========================================

const MIN_STEAM_SYNC_PLAYTIME_MINUTES = 18;

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

async function bulkLinkSteamGames() {
    const button = document.getElementById('bulkSteamLinkButton');
    const steamRecords = localEvents.filter(event => String(event.extendedProps.platform || '').toLocaleLowerCase() === 'steam');
    const unlinkedTitles = [...new Set(steamRecords
        .filter(event => !event.extendedProps.steamAppId)
        .map(event => event.title)
        .filter(Boolean))];

    if (unlinkedTitles.length === 0) {
        alert('연결할 Steam 기록이 없습니다. 이미 모두 연결되어 있거나 플랫폼이 Steam이 아닙니다.');
        return;
    }
    if (!confirm(`연결되지 않은 Steam 게임 ${unlinkedTitles.length}개를 내 Steam 라이브러리와 비교합니다.\n이름이 정확히 같거나 매우 비슷한 게임만 자동 연결합니다. 계속할까요?`)) return;

    button.disabled = true;
    button.innerText = '⏳ Steam 게임 비교 중...';
    try {
        const ownedGames = await loadSteamOwnedGames();
        let linkedTitles = 0;
        let linkedRecords = 0;

        unlinkedTitles.forEach(title => {
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
            if (!clearlyBest) return;

            const steamAppId = String(best.game.appid || '');
            if (!steamAppId) return;
            localEvents.forEach(event => {
                if (event.title === title && !event.extendedProps.steamAppId) {
                    event.extendedProps.steamAppId = steamAppId;
                    linkedRecords++;
                }
            });
            saveSteamTitleLink(title, steamAppId);
            linkedTitles++;
        });

        saveToLocalStorage();
        refreshUI();
        const remaining = unlinkedTitles.length - linkedTitles;
        alert(`자동 연결 완료\n\n연결한 게임: ${linkedTitles}개 (${linkedRecords}개 기록)\n확인 필요: ${remaining}개\n\n확인 필요 게임은 상세 화면의 'Steam 게임 연결'에서 상점 주소를 붙여 넣어 연결할 수 있습니다.`);
    } catch (error) {
        alert(`자동 연결 실패: ${error.message}`);
    } finally {
        button.disabled = false;
        button.innerText = '🔗 Steam 기록 한꺼번에 연결';
    }
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
async function syncRecentSteamPlaytime() {
    const creds = getSteamCredentials();
    if (!creds.steamId) {
        alert("먼저 SteamID64를 입력하고 저장해 주세요!");
        return;
    }

    const syncBtns = document.querySelectorAll('button[onclick*="syncRecentSteamPlaytime"]');
    syncBtns.forEach(b => { b.disabled = true; b.innerText = "⏳ 스팀 통신 중..."; });

    try {
        const games = await loadSteamOwnedGames();
        if (games.length === 0) {
            alert("스팀 라이브러리 데이터를 가져오지 못했습니다. 프로필 공개 설정과 SteamID64를 확인해 주세요.");
            return;
        }

        let updatedCount = 0;
        let skippedShortPlaytimeCount = 0;
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
                // 첫 동기화는 Steam의 마지막 실행일을, 이후 동기화는 동기화한 날을 기록합니다.
                const displayName = existingRecords[0]?.title || name;
                const syncDate = isFirstSync
                    ? getSteamLastPlayedDate(game.rtime_last_played, todayStr)
                    : todayStr;
                const syncMemo = isFirstSync
                    ? '스팀 최초 동기화 세션 (마지막 실행일 기준)'
                    : '스팀 동기화 세션';
                const newGame = createGameObj(displayName, syncDate, syncDate, 'steam', diffHours, 'x', syncMemo, '', false, steamAppId, currentTotalSteamHours);
                localEvents.push(newGame);
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            refreshUI();
            saveToLocalStorage();
            syncAllRecordsToGoogleSheet();
            const skippedMessage = skippedShortPlaytimeCount > 0 ? `\n(총 플레이 0.3시간 미만 게임 ${skippedShortPlaytimeCount}개 제외)` : '';
            alert(`🎉 총 ${updatedCount}개 스팀 게임의 플레이 기록이 동기화되었습니다!${skippedMessage}`);
        } else {
            const skippedMessage = skippedShortPlaytimeCount > 0 ? `\n(총 플레이 0.3시간 미만 게임 ${skippedShortPlaytimeCount}개 제외)` : '';
            alert(`이미 모든 스팀 게임의 최신 플레이타임이 반영되어 있습니다! (새로 늘어난 시간 없음)${skippedMessage}`);
        }
    } catch (error) {
        alert(`스팀 연동 실패: ${error.message}`);
    } finally {
        syncBtns.forEach(b => { b.disabled = false; b.innerText = "🔄 최근 플레이 동기화"; });
    }
}
