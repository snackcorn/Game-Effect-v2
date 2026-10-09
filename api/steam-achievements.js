const STEAM_ID64_PATTERN = /^\d{17}$/;
const STEAM_APP_ID_PATTERN = /^\d+$/;

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'GET 요청만 사용할 수 있습니다.' });
    }

    const steamId = String(req.query.steamid || '').trim();
    const appId = String(req.query.appid || '').trim();
    if (!STEAM_ID64_PATTERN.test(steamId) || !STEAM_APP_ID_PATTERN.test(appId)) {
        return res.status(400).json({ error: '유효한 SteamID64와 AppID가 필요합니다.' });
    }

    const apiKey = process.env.STEAM_WEB_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Vercel에 STEAM_WEB_API_KEY 환경 변수가 설정되지 않았습니다.' });
    }

    const steamUrl = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/');
    steamUrl.searchParams.set('key', apiKey);
    steamUrl.searchParams.set('steamid', steamId);
    steamUrl.searchParams.set('appid', appId);
    steamUrl.searchParams.set('format', 'json');

    try {
        const response = await fetch(steamUrl);
        if (!response.ok) return res.status(200).json({ available: false });

        const payload = await response.json();
        const achievements = payload.playerstats?.achievements;
        if (!Array.isArray(achievements)) return res.status(200).json({ available: false });

        return res.status(200).json({
            available: true,
            achievedCount: achievements.filter(item => Number(item.achieved) === 1).length,
            totalCount: achievements.length
        });
    } catch (error) {
        console.error('Steam achievement request failed:', error);
        return res.status(200).json({ available: false });
    }
};
