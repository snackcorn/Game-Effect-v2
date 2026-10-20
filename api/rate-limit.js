// Vercel 서버리스 인스턴스별로 동작하는 가벼운 1차 요청 제한입니다.
// 분산 저장소가 아니므로 전역 차단을 보장하지는 않지만, 단일 인스턴스의 API 키 남용을 줄입니다.
const buckets = new Map();

function getClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || String(req.headers['x-real-ip'] || 'unknown').trim() || 'unknown';
}

function applyRateLimit(req, res, { key, limit, windowMs = 60_000 }) {
    const now = Date.now();
    const bucketKey = `${key}:${getClientIp(req)}`;
    const current = buckets.get(bucketKey);
    const bucket = !current || now >= current.resetAt
        ? { count: 0, resetAt: now + windowMs }
        : current;

    bucket.count += 1;
    buckets.set(bucketKey, bucket);
    if (bucket.count <= limit) return false;

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    return true;
}

module.exports = { applyRateLimit };
