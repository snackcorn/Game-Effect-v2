const STEAM_ID64_PATTERN = /^\d{17}$/;

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'GET 요청만 사용할 수 있습니다.' });
    }

    const steamId = String(req.query.steamid || '').trim();
    if (!STEAM_ID64_PATTERN.test(steamId)) {
        return res.status(400).json({ error: '유효한 17자리 SteamID64가 필요합니다.' });
    }

    const apiKey = process.env.STEAM_WEB_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Vercel에 STEAM_WEB_API_KEY 환경 변수가 설정되지 않았습니다.' });
    }

    const steamUrl = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/');
    steamUrl.searchParams.set('key', apiKey);
    steamUrl.searchParams.set('steamid', steamId);
    steamUrl.searchParams.set('include_appinfo', '1');
    steamUrl.searchParams.set('include_played_free_games', '1');
    steamUrl.searchParams.set('format', 'json');

    try {
        const response = await fetch(steamUrl);
        if (!response.ok) {
            return res.status(502).json({ error: 'Steam에서 게임 목록을 가져오지 못했습니다.' });
        }

        const payload = await response.json();
        return res.status(200).json({ games: payload.response?.games || [] });
    } catch (error) {
        console.error('Steam API request failed:', error);
        return res.status(502).json({ error: 'Steam 서버와 통신할 수 없습니다.' });
    }
};
