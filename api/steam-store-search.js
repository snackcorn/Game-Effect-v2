// Steam 상점의 한국어 검색 결과를 조회합니다. API 키는 필요하지 않습니다.
module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'GET 요청만 사용할 수 있습니다.' });
    }

    const term = String(req.query.term || '').trim();
    if (!term || term.length > 120) return res.status(400).json({ error: '게임 제목을 확인해 주세요.' });

    try {
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=korean&cc=KR`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        let results = [];
        if (response.ok) {
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            results = items
                .filter(item => /^\d+$/.test(String(item?.id || '')) && ['app', 'game'].includes(String(item?.type || 'app')))
                .slice(0, 20)
                .map(item => ({ appid: String(item.id), name: String(item.name || '').trim() }));
        }

        // Store Search API가 한국어 검색어를 찾지 못하는 경우, 상점 검색 페이지 결과를 보조로 사용합니다.
        if (results.length === 0) {
            const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(term)}&l=korean&cc=KR`;
            const searchResponse = await fetch(searchUrl);
            if (searchResponse.ok) {
                const html = await searchResponse.text();
                const matches = html.matchAll(/data-ds-appid="(\d+)"[\s\S]*?<span class="title">([\s\S]*?)<\/span>/g);
                const seen = new Set();
                for (const match of matches) {
                    const appid = match[1];
                    const name = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
                    if (!seen.has(appid) && name) {
                        seen.add(appid);
                        results.push({ appid, name });
                    }
                    if (results.length >= 20) break;
                }
            }
        }
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
        return res.status(200).json({ items: results });
    } catch (error) {
        console.error('Steam store search request failed:', error);
        return res.status(200).json({ items: [] });
    }
};
