// ============================================================
// GOLIBIT · Worker پراکسی بورس ایران (TSETMC) — نسخه ۲
// استقرار: Cloudflare Workers → Edit code → این فایل را جایگزین کن → Deploy
// مسیرها: /mw  /clients  /hist?code=&n=  /diag  /raw?path=  /ping?id=
// اگر TSETMC آی‌پی خارجی را رد کند (۴۰۳/خالی)، /diag دقیقاً نشان می‌دهد؛ در آن صورت
// همین کد را روی سرور داخل ایران اجرا کن (فقط fetch استاندارد است).
// ============================================================
const HOSTS = ['https://cdn.tsetmc.com/api', 'https://cdn2.tsetmc.com/api', 'https://cdn4.tsetmc.com/api'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MW_QS =
  'market=0&industrialGroup=&paperTypes%5B0%5D=1&paperTypes%5B1%5D=2&paperTypes%5B2%5D=3&paperTypes%5B3%5D=4' +
  '&paperTypes%5B4%5D=5&paperTypes%5B5%5D=6&paperTypes%5B6%5D=7&paperTypes%5B7%5D=8&paperTypes%5B8%5D=9' +
  '&showTraded=false&withBestLimits=true&hEven=0&RefID=0';
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  Referer: 'https://main.tsetmc.com/',
  Origin: 'https://main.tsetmc.com',
};
const ONL = new Map(); // شمارندهٔ آنلاین (تقریبی، در حافظهٔ Worker)
let LAST_MW = null; // آخرین دیده‌بان سالم
const json = (o, status = 200, ttl = 5) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + ttl },
  });
const rowsOf = (d) => (d && (d.marketwatch || d.marketWatch)) || (Array.isArray(d) ? d : []);

async function up(path, ttl, log, check) {
  let last = new Error('بدون پاسخ');
  for (const base of HOSTS) {
    const host = new URL(base).host, ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(base + path, { headers: HDR, signal: ctl.signal, cf: { cacheTtl: ttl, cacheEverything: true } });
      const txt = await r.text();
      if (log) log.push({ host, status: r.status, len: txt.length, head: txt.slice(0, 100) });
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 403 ? ' (آی‌پی خارجی رد شده؛ Worker را روی سرور ایران اجرا کن)' : ''));
      let d;
      try { d = JSON.parse(txt); } catch (e) { throw new Error('پاسخ JSON نیست (احتمالاً صفحهٔ مسدودسازی)'); }
      if (check && !check(d)) throw new Error('پاسخ خالی یا با ساختار ناشناخته');
      return { d, host };
    } catch (e) {
      last = e;
      if (log) log.push({ host, error: String((e && e.message) || e) });
    } finally {
      clearTimeout(tm);
    }
  }
  throw last;
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url), p = u.pathname;
    try {
      if (p === '/ping') {
        const id = String(u.searchParams.get('id') || '').slice(0, 40), now = Date.now();
        if (id) ONL.set(id, now);
        for (const [k, t] of ONL) if (now - t > 150000) ONL.delete(k);
        return json({ n: ONL.size }, 200, 0);
      }
      if (p === '/mw') {
        try {
          const { d } = await up('/ClosingPrice/GetMarketWatch?' + (u.searchParams.get('qs') || MW_QS), 4, null, (x) => rowsOf(x).length > 0);
          LAST_MW = { t: Date.now(), d };
          return json(d, 200, 4);
        } catch (e) {
          if (LAST_MW && Date.now() - LAST_MW.t < 10 * 60000) return json(LAST_MW.d, 200, 2); // دادهٔ تازهٔ اخیر
          throw e;
        }
      }
      if (p === '/clients') return json((await up('/ClientType/GetClientTypeAll', 10, null, null)).d, 200, 10);
      if (p === '/hist') {
        const code = (u.searchParams.get('code') || '').replace(/\D/g, '');
        if (!code) return json({ error: 'code لازم است' }, 400);
        const n = Math.min(parseInt(u.searchParams.get('n') || '0', 10) || 0, 400);
        return json((await up('/ClosingPrice/GetClosingPriceDailyList/' + code + '/' + n, 600, null, null)).d, 200, 600);
      }
      if (p === '/diag') {
        const log = [];
        try {
          const { d, host } = await up('/ClosingPrice/GetMarketWatch?' + MW_QS, 0, log, null);
          const rows = rowsOf(d), bl = d.bestLimits || [];
          return json({ ok: rows.length > 0, host, attempts: log, topKeys: Object.keys(d || {}), rows: rows.length, rowKeys: Object.keys(rows[0] || {}), rowSample: rows[0] || null, bestLimits: bl.length, bestLimitKeys: Object.keys(bl[0] || {}) }, 200, 0);
        } catch (e) {
          return json({ ok: false, attempts: log, error: String((e && e.message) || e) }, 200, 0);
        }
      }
      if (p === '/raw') {
        const path = u.searchParams.get('path') || '';
        if (!/^\/(ClosingPrice|ClientType)\//.test(path)) return json({ error: 'مسیر مجاز نیست' }, 400);
        const r = await fetch(HOSTS[0] + path, { headers: HDR });
        const t = await r.text();
        return json({ status: r.status, type: r.headers.get('content-type'), len: t.length, head: t.slice(0, 600) }, 200, 0);
      }
      return json({ ok: true, routes: ['/mw', '/clients', '/hist?code=', '/diag', '/raw?path=', '/ping?id='] });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, 0);
    }
  },
};
