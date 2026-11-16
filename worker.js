// ============================================================
// Worker پراکسی بورس ایران (TSETMC) برای «ترمینال نوسان‌گیر بورس»
// استقرار: Cloudflare Workers → Create Worker → این کد را جایگزین کن → Deploy
// مسیرها:  /mw  (دیده‌بان بازار + بهترین قیمت‌ها)   /clients (حقیقی/حقوقی)
//          /hist?code=INS_CODE&n=120  (تاریخچه روزانه)   /diag (عیب‌یابی)
// هشدار: اگر TSETMC آی‌پی خارجی (Cloudflare) را رد کند (۴۰۳)، همین کد را
// روی یک سرور/هاست داخل ایران اجرا کن (کد فقط fetch استاندارد است).
// ============================================================
const BASE = 'https://cdn.tsetmc.com/api';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MW_QS =
  'market=0&industrialGroup=&paperTypes%5B0%5D=1&paperTypes%5B1%5D=2&paperTypes%5B2%5D=3&paperTypes%5B3%5D=4' +
  '&paperTypes%5B4%5D=5&paperTypes%5B5%5D=6&paperTypes%5B6%5D=7&paperTypes%5B7%5D=8&paperTypes%5B8%5D=9' +
  '&showTraded=false&withBestLimits=true&hEven=0&RefID=0';

const json = (o, status = 200, ttl = 5) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + ttl },
  });

async function up(path, ttl = 5) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://main.tsetmc.com/',
    Origin: 'https://main.tsetmc.com',
  };
  let err;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(BASE + path, { headers, cf: { cacheTtl: ttl, cacheEverything: true } });
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 403 ? ' (TSETMC آی‌پی خارجی را رد کرده؛ Worker را روی سرور ایران اجرا کن)' : ''));
      return await r.json();
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.pathname === '/mw') return json(await up('/ClosingPrice/GetMarketWatch?' + (u.searchParams.get('qs') || MW_QS), 4), 200, 4);
      if (u.pathname === '/clients') return json(await up('/ClientType/GetClientTypeAll', 10), 200, 10);
      if (u.pathname === '/hist') {
        const code = (u.searchParams.get('code') || '').replace(/\D/g, '');
        if (!code) return json({ error: 'code لازم است' }, 400);
        const n = Math.min(parseInt(u.searchParams.get('n') || '0', 10) || 0, 400);
        return json(await up('/ClosingPrice/GetClosingPriceDailyList/' + code + '/' + n, 600), 200, 600);
      }
      if (u.pathname === '/diag') {
        const d = await up('/ClosingPrice/GetMarketWatch?' + MW_QS, 4);
        const rows = d.marketwatch || d.marketWatch || (Array.isArray(d) ? d : []);
        const bl = d.bestLimits || [];
        return json({ topKeys: Object.keys(d), rows: rows.length, rowKeys: Object.keys(rows[0] || {}), rowSample: rows[0] || null, bestLimitKeys: Object.keys(bl[0] || {}) }, 200, 0);
      }
      return json({ ok: true, routes: ['/mw', '/clients', '/hist?code=', '/diag'] });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, 0);
    }
  },
};
