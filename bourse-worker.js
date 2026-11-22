// ============================================================
// GOLIBIT · Worker پراکسی بورس ایران (TSETMC) — نسخه ۳ (موتور ضدقطعی)
// استقرار: Cloudflare Workers → Edit code → جایگزینی کامل → Deploy
// مسیرها: /mw  /clients  /hist?code=&n=  /bestlimits?code=  /overview  /diag  /ping?id=
// نکته مهم: اگر TSETMC آی‌پی خارجی Cloudflare را با 403/خالی مسدود کرد،
// می‌توانید متغیر محیطی IR_RELAY را روی یک پراکسی داخل ایران ست کنید یا همین
// کد را مستقیم روی سرور/هاست Node.js داخل ایران اجرا نمایید.
// ============================================================
const JSON_HOSTS = [
  'https://cdn.tsetmc.com/api',
  'https://cdn2.tsetmc.com/api',
  'https://cdn4.tsetmc.com/api',
];
const LEGACY_HOSTS = [
  'https://old.tsetmc.com',
  'http://old.tsetmc.com',
  'https://www.tsetmc.com',
];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MW_QS_BL =
  'market=0&industrialGroup=&paperTypes%5B0%5D=1&paperTypes%5B1%5D=2&paperTypes%5B2%5D=3&paperTypes%5B3%5D=4' +
  '&paperTypes%5B4%5D=5&paperTypes%5B5%5D=6&paperTypes%5B6%5D=7&paperTypes%5B7%5D=8&paperTypes%5B8%5D=9' +
  '&showTraded=false&withBestLimits=true&hEven=0&RefID=0';
const MW_QS_NOBL = MW_QS_BL.replace('withBestLimits=true', 'withBestLimits=false');

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://main.tsetmc.com/',
  Origin: 'https://main.tsetmc.com',
};

const ONL = new Map();
let LAST_MW = null;
let LAST_CL = null;
const HIST_CACHE = new Map();

const json = (o, status = 200, ttl = 5) =>
  new Response(JSON.stringify(o), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + ttl,
    },
  });

const rowsOf = (d) => (d && (d.marketwatch || d.marketWatch)) || (Array.isArray(d) ? d : []);
const clOf = (d) => (d && (d.clientTypeAllDto || d.clientType || d.clientTypeAll)) || (Array.isArray(d) ? d : []);
const isBlocked = (txt) =>
  !txt ||
  /مسدود|دسترسی شما|General Error|<!doctype|<html/i.test(txt.slice(0, 400));

async function fetchText(url, ttl, timeoutMs = 9500) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: HDR,
      signal: ctl.signal,
      cf: { cacheTtl: ttl, cacheEverything: ttl > 0 },
    });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, txt };
  } finally {
    clearTimeout(tm);
  }
}

async function upJson(path, ttl, log, check) {
  let last = new Error('بدون پاسخ از سرور بورس');
  for (const base of JSON_HOSTS) {
    const host = new URL(base).host;
    try {
      const { ok, status, txt } = await fetchText(base + path, ttl);
      if (log) log.push({ host, path: path.split('?')[0], status, len: txt.length });
      if (!ok) {
        throw new Error(
          'HTTP ' + status + (status === 403 ? ' (آی‌پی خارجی توسط TSETMC مسدود شده؛ روی سرور ایران اجرا کن)' : '')
        );
      }
      if (isBlocked(txt)) throw new Error('پاسخ مسدودسازی یا غیر JSON از TSETMC');
      const d = JSON.parse(txt);
      if (check && !check(d)) throw new Error('پاسخ خالی یا فاقد ردیف');
      return { d, host };
    } catch (e) {
      last = e;
      if (log) log.push({ host, error: String((e && e.message) || e) });
    }
  }
  throw last;
}

/* ---------- پارس نسخهٔ کلاسیک MarketWatchInit (پوشش کامل + ۵ سطر سفارش) ---------- */
function parseLegacyMW(txt) {
  const parts = String(txt || '').split('@');
  if (parts.length < 3) return null;
  const marketwatch = [];
  const rawRows = parts[2].split(';');
  for (let i = 0; i < rawRows.length; i++) {
    const f = rawRows[i].split(',');
    if (f.length < 20) continue;
    const insCode = f[0].trim();
    if (!/^\d{6,}$/.test(insCode)) continue;
    marketwatch.push({
      insCode,
      isin: f[1] || '',
      lVal18AFC: (f[2] || '').trim(),
      lVal30: (f[3] || '').trim(),
      hEven: +f[4] || 0,
      priceFirst: +f[5] || 0,
      pClosing: +f[6] || 0,
      pDrCotVal: +f[7] || 0,
      zTotTran: +f[8] || 0,
      qTotTran5J: +f[9] || 0,
      qTotCap: +f[10] || 0,
      priceMin: +f[11] || 0,
      priceMax: +f[12] || 0,
      priceYesterday: +f[13] || 0,
      eps: +f[14] || 0,
      bVol: +f[15] || 0,
      cSecVal: (f[18] || '').trim(),
      psGelStaMax: +f[19] || 0,
      psGelStaMin: +f[20] || 0,
      zTitad: +f[21] || 0,
      flow: +f[22] || 0,
    });
  }
  const bestLimits = [];
  if (parts[3]) {
    const blRows = parts[3].split(';');
    for (let i = 0; i < blRows.length; i++) {
      const f = blRows[i].split(',');
      if (f.length < 8) continue;
      bestLimits.push({
        insCode: f[0].trim(),
        number: +f[1] || 0,
        zOrdMeOf: +f[2] || 0,
        zOrdMeDem: +f[3] || 0,
        pMeDem: +f[4] || 0,
        pMeOf: +f[5] || 0,
        qTitMeDem: +f[6] || 0,
        qTitMeOf: +f[7] || 0,
      });
    }
  }
  return marketwatch.length ? { marketwatch, bestLimits, source: 'legacy-init' } : null;
}

function parseLegacyCL(txt) {
  const rows = String(txt || '').split(';');
  const clientTypeAllDto = [];
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].split(',');
    if (f.length < 9) continue;
    const insCode = f[0].trim();
    if (!/^\d{6,}$/.test(insCode)) continue;
    clientTypeAllDto.push({
      insCode,
      buy_CountI: +f[1] || 0,
      buy_CountN: +f[2] || 0,
      buy_I_Volume: +f[3] || 0,
      buy_N_Volume: +f[4] || 0,
      sell_CountI: +f[5] || 0,
      sell_CountN: +f[6] || 0,
      sell_I_Volume: +f[7] || 0,
      sell_N_Volume: +f[8] || 0,
    });
  }
  return clientTypeAllDto.length ? { clientTypeAllDto, source: 'legacy-cl' } : null;
}

function parseLegacyHist(txt) {
  const rows = String(txt || '').split(';');
  const closingPriceDaily = [];
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i].split(',');
    if (f.length < 6) continue;
    const dEven = +f[0] || 0;
    if (dEven < 20000101) continue;
    closingPriceDaily.push({
      dEven,
      priceMax: +f[1] || 0,
      priceMin: +f[2] || 0,
      priceFirst: +f[3] || 0,
      pClosing: +f[4] || 0,
      qTotTran5J: +f[5] || 0,
      pDrCotVal: +f[6] || +f[4] || 0,
    });
  }
  return closingPriceDaily.length ? { closingPriceDaily, source: 'legacy-hist' } : null;
}

async function upLegacy(path, parser, ttl, log) {
  let last = new Error('پاسخی از سرور کلاسیک TSETMC دریافت نشد');
  for (const base of LEGACY_HOSTS) {
    const host = new URL(base).host;
    try {
      const { ok, status, txt } = await fetchText(base + path, ttl, 11000);
      if (log) log.push({ host: host + ' (legacy)', status, len: txt.length });
      if (!ok) throw new Error('HTTP ' + status);
      if (isBlocked(txt)) throw new Error('مسدود یا HTML');
      const parsed = parser(txt);
      if (!parsed) throw new Error('ساختار خالی یا غیرقابل پارس');
      return { d: parsed, host };
    } catch (e) {
      last = e;
      if (log) log.push({ host: host + ' (legacy)', error: String((e && e.message) || e) });
    }
  }
  throw last;
}

async function getMarketWatch(qs, log) {
  // ۱) ابتدا مسیر JSON رسمی با بهترین‌حدها
  try {
    return await upJson('/ClosingPrice/GetMarketWatch?' + (qs || MW_QS_BL), 4, log, (x) => rowsOf(x).length > 50);
  } catch (e1) {
    // ۲) مسیر کلاسیک MarketWatchInit (سریع، کامل و شامل ۵ سطر کامل سفارش و حجم مبنا)
    try {
      return await upLegacy('/tsev2/data/MarketWatchInit.aspx?h=0&r=0', parseLegacyMW, 4, log);
    } catch (e2) {
      // ۳) آخرین تلاش: JSON بدون bestLimits
      return await upJson('/ClosingPrice/GetMarketWatch?' + MW_QS_NOBL, 4, log, (x) => rowsOf(x).length > 50);
    }
  }
}

async function getClients(log) {
  try {
    return await upJson('/ClientType/GetClientTypeAll', 10, log, (x) => clOf(x).length > 20);
  } catch (e) {
    return await upLegacy('/tsev2/data/ClientTypeAll.aspx', parseLegacyCL, 10, log);
  }
}

async function getHistory(code, n, log) {
  const key = code + ':' + n;
  const cached = HIST_CACHE.get(key);
  if (cached && Date.now() - cached.t < 15 * 60000) return { d: cached.d, host: 'cache' };
  let res;
  try {
    res = await upJson('/ClosingPrice/GetClosingPriceDailyList/' + code + '/' + n, 600, log, (x) => {
      const a = x && (x.closingPriceDaily || x.closingPriceDailyList);
      return Array.isArray(a) && a.length > 0;
    });
  } catch (e) {
    res = await upLegacy('/tsev2/chart/data/Financial.aspx?i=' + code + '&t=ph&a=1', parseLegacyHist, 600, log);
  }
  if (HIST_CACHE.size > 320) {
    const firstKey = HIST_CACHE.keys().next().value;
    HIST_CACHE.delete(firstKey);
  }
  HIST_CACHE.set(key, { t: Date.now(), d: res.d });
  return res;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.pathname;

    // اگر رله داخل ایران تنظیم شده باشد، درخواست مستقیم عبور داده می‌شود
    const relay = (env && env.IR_RELAY) ? String(env.IR_RELAY).replace(/\/+$/, '') : '';
    if (relay && p !== '/ping') {
      try {
        const rr = await fetch(relay + p + u.search, { headers: { Accept: 'application/json' } });
        return new Response(rr.body, {
          status: rr.status,
          headers: { ...CORS, 'Content-Type': rr.headers.get('content-type') || 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return json({ error: 'خطا در اتصال به رله ایران: ' + String(e.message || e) }, 502, 0);
      }
    }

    try {
      if (p === '/ping') {
        const id = String(u.searchParams.get('id') || '').slice(0, 40);
        const now = Date.now();
        if (id) ONL.set(id, now);
        for (const [k, t] of ONL) if (now - t > 150000) ONL.delete(k);
        return json({ n: ONL.size }, 200, 0);
      }

      if (p === '/mw') {
        try {
          const { d } = await getMarketWatch(u.searchParams.get('qs'), null);
          LAST_MW = { t: Date.now(), d };
          return json(d, 200, 4);
        } catch (e) {
          if (LAST_MW && Date.now() - LAST_MW.t < 15 * 60000) return json(LAST_MW.d, 200, 2);
          throw e;
        }
      }

      if (p === '/clients') {
        try {
          const { d } = await getClients(null);
          LAST_CL = { t: Date.now(), d };
          return json(d, 200, 10);
        } catch (e) {
          if (LAST_CL && Date.now() - LAST_CL.t < 15 * 60000) return json(LAST_CL.d, 200, 5);
          throw e;
        }
      }

      if (p === '/hist') {
        const code = (u.searchParams.get('code') || '').replace(/\D/g, '');
        if (!code) return json({ error: 'code لازم است' }, 400);
        const n = Math.min(parseInt(u.searchParams.get('n') || '160', 10) || 160, 400);
        const { d } = await getHistory(code, n, null);
        return json(d, 200, 600);
      }

      if (p === '/bestlimits') {
        const code = (u.searchParams.get('code') || '').replace(/\D/g, '');
        if (!code) return json({ error: 'code لازم است' }, 400);
        const { d } = await upJson('/BestLimits/' + code, 3, null, null);
        return json(d, 200, 3);
      }

      if (p === '/overview') {
        const { d } = await upJson('/MarketData/GetMarketOverview/1', 15, null, null);
        return json(d, 200, 15);
      }

      if (p === '/diag') {
        const log = [];
        let mwRes = null, clCount = 0;
        try {
          mwRes = await getMarketWatch(null, log);
        } catch (e) {
          return json({ ok: false, attempts: log, error: String((e && e.message) || e) }, 200, 0);
        }
        try {
          const cl = await getClients(null);
          clCount = clOf(cl.d).length;
        } catch (e) {}
        const d = mwRes.d;
        const rows = rowsOf(d);
        const bl = d.bestLimits || [];
        return json(
          {
            ok: rows.length > 0,
            host: mwRes.host,
            source: d.source || 'json-api',
            attempts: log,
            topKeys: Object.keys(d || {}),
            rows: rows.length,
            clients: clCount,
            bestLimits: bl.length,
            rowKeys: Object.keys(rows[0] || {}),
          },
          200,
          0
        );
      }

      return json({
        ok: true,
        version: 3,
        routes: ['/mw', '/clients', '/hist?code=', '/bestlimits?code=', '/overview', '/diag', '/ping?id='],
      });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, 0);
    }
  },
};