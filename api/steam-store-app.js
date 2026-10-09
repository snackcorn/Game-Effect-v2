// Steam 상점의 지역화된 게임 이름을 가져옵니다. API 키는 필요하지 않습니다.
module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'GET 요청만 사용할 수 있습니다.' });
    }

    const appId = String(req.query.appid || '').trim();
    if (!/^\d+$/.test(appId)) return res.status(400).json({ error: 'Steam AppID를 확인해 주세요.' });

    try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&cc=KR&l=korean`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) return res.status(200).json({ available: false });
        const payload = await response.json();
        const name = String(payload?.[appId]?.data?.name || '').trim();
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        return res.status(200).json({ available: Boolean(name), name });
    } catch (error) {
        console.error('Steam store title request failed:', error);
        return res.status(200).json({ available: false });
    }
};
