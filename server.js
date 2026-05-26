import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const EIA_KEY      = process.env.EIA_KEY;
const FRED_KEY     = process.env.FRED_KEY;
const RESEND_KEY   = process.env.RESEND_KEY;
const FROM_EMAIL   = process.env.FROM_EMAIL || 'alerts@yourdomain.com';

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;
const subscribers = new Map();

async function eiaFetch(route, params) {
  const url = new URL(`https://api.eia.gov/v2/${route}`);
  url.searchParams.set('api_key', EIA_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`EIA ${route} → ${r.status}`);
  return r.json();
}

async function getWTI(days = 14) {
  const j = await eiaFetch('petroleum/pri/spt/data/', { frequency: 'daily', 'data[0]': 'value', 'facets[series][]': 'RWTC', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: days });
  return j.response?.data || [];
}

async function getBrent(days = 14) {
  const j = await eiaFetch('petroleum/pri/spt/data/', { frequency: 'daily', 'data[0]': 'value', 'facets[series][]': 'EER_EBRTWHERE_EPD2F_NUS_DPB', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: days });
  return j.response?.data || [];
}

async function getRBOBSpot(days = 14) {
  const j = await eiaFetch('petroleum/pri/spt/data/', { frequency: 'daily', 'data[0]': 'value', 'facets[series][]': 'EER_EPMRR_PF4_Y35NY_DPG', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: days });
  return j.response?.data || [];
}

async function getRBOBFutures() {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/RB=F?interval=1d&range=10d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const timestamps = j?.chart?.result?.[0]?.timestamp || [];
    return timestamps.map((ts, i) => ({ period: new Date(ts * 1000).toISOString().slice(0, 10), value: closes[i] })).filter(d => d.value != null).reverse();
  } catch { return []; }
}

async function getRetailGas(weeks = 4) {
  const j = await eiaFetch('petroleum/pri/gnd/data/', { frequency: 'weekly', 'data[0]': 'value', 'facets[duoarea][]': 'NUS', 'facets[product][]': 'EPMR', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: weeks });
  return j.response?.data || [];
}

async function getInventories(weeks = 3) {
  const j = await eiaFetch('petroleum/stoc/wstk/data/', { frequency: 'weekly', 'data[0]': 'value', 'facets[product][]': 'EPC0', 'facets[duoarea][]': 'NUS', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: weeks });
  return j.response?.data || [];
}

async function getRefinery(weeks = 3) {
  const j = await eiaFetch('petroleum/pnp/wiup/data/', { frequency: 'weekly', 'data[0]': 'value', 'facets[series][]': 'WPULEUS3', 'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: weeks });
  return j.response?.data || [];
}

function calcDailySlope(arr, field = 'value') {
  const n = arr.length;
  if (n < 2) return 0;
  const vals = arr.map((d, i) => ({ x: n - 1 - i, y: parseFloat(d[field]) }));
  const xm = vals.reduce((s, d) => s + d.x, 0) / n;
  const ym = vals.reduce((s, d) => s + d.y, 0) / n;
  const num = vals.reduce((s, d) => s + (d.x - xm) * (d.y - ym), 0);
  const den = vals.reduce((s, d) => s + (d.x - xm) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function calcTrend(arr, field = 'value') {
  if (!arr || arr.length < 2) return 0;
  return ((parseFloat(arr[0][field]) - parseFloat(arr[arr.length - 1][field])) / parseFloat(arr[arr.length - 1][field])) * 100;
}

const INDIANA_OFFSET = -0.05;

function buildShortTermForecast(retailNow, rbobFuturesSlope, rbobSpotSlope, wtiTrend, brentWtiSpread) {
  const spreadAdjust = brentWtiSpread > 5 ? 0.002 : brentWtiSpread < 0 ? -0.001 : 0;
  const compositeSlope = rbobFuturesSlope * 0.60 + rbobSpotSlope * 0.30 + spreadAdjust;
  const lagDays = compositeSlope > 0 ? 7 : 14;
  const days = [];
  const today = new Date();
  for (let i = 0; i < 21; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const lagFactor = Math.min(i / lagDays, 1);
    const dailyMove = compositeSlope * 0.92 * lagFactor;
    const midNational = Math.max(retailNow + dailyMove * i, 2.00);
    const midIndiana  = Math.max(midNational + INDIANA_OFFSET, 2.00);
    const band = parseFloat((0.02 + i * 0.003).toFixed(3));
    days.push({
      date: d.toISOString().slice(0, 10),
      national: { mid: Math.round(midNational * 100) / 100, lo: Math.round((midNational - band) * 100) / 100, hi: Math.round((midNational + band) * 100) / 100 },
      indiana:  { mid: Math.round(midIndiana  * 100) / 100, lo: Math.round((midIndiana  - band) * 100) / 100, hi: Math.round((midIndiana  + band) * 100) / 100 },
    });
  }
  return days;
}

function buildVerdict(compositeSlope, retailNow, shortTerm) {
  const price14d = shortTerm[13]?.national?.mid || retailNow;
  const delta = price14d - retailNow;
  if (delta > 0.08 || compositeSlope * 100 > 0.3) return { verdict: 'Fill up soon', icon: '⚠️', color: 'orange', reason: `Prices look ~${Math.abs(delta * 100).toFixed(0)}¢/gal higher in ~2 weeks. Fill up before the increase.`, confidence: delta > 0.15 ? 75 : 60 };
  if (delta < -0.08 || compositeSlope * 100 < -0.3) return { verdict: 'Wait — prices are falling', icon: '✅', color: 'green', reason: `Prices look ~${Math.abs(delta * 100).toFixed(0)}¢/gal lower in ~2 weeks. Running low is fine.`, confidence: delta < -0.15 ? 75 : 60 };
  return { verdict: 'Neutral — fill when convenient', icon: '➡️', color: 'blue', reason: 'No strong directional signal over the next 2 weeks.', confidence: 55 };
}

const MONTHLY_FORECAST = [
  { label: 'Now (May 26)', mid: 3.45, lo: 3.38, hi: 3.55, conf: 75 },
  { label: 'Early June',   mid: 3.58, lo: 3.45, hi: 3.68, conf: 65 },
  { label: 'Late June',    mid: 3.52, lo: 3.40, hi: 3.62, conf: 60 },
  { label: 'July',         mid: 3.38, lo: 3.25, hi: 3.50, conf: 60 },
  { label: 'August',       mid: 3.28, lo: 3.15, hi: 3.42, conf: 55 },
  { label: 'September',    mid: 3.18, lo: 3.05, hi: 3.32, conf: 55 },
  { label: 'October',      mid: 3.08, lo: 2.95, hi: 3.22, conf: 50 },
  { label: 'November',     mid: 3.00, lo: 2.88, hi: 3.14, conf: 50 },
  { label: 'December',     mid: 2.95, lo: 2.82, hi: 3.08, conf: 50 },
];

async function assembleData() {
  const [wtiArr, brentArr, rbobSpotArr, rbobFutArr, retailArr, invArr, refArr] = await Promise.all([
    getWTI(10), getBrent(10), getRBOBSpot(10), getRBOBFutures(), getRetailGas(4), getInventories(3), getRefinery(3),
  ]);
  const retailNow  = parseFloat(retailArr[0]?.value || 3.45);
  const retailPrev = parseFloat(retailArr[1]?.value || retailNow);
  const wtiNow     = parseFloat(wtiArr[0]?.value   || 71.4);
  const brentNow   = parseFloat(brentArr[0]?.value  || 76.0);
  const rbobSpotNow= parseFloat(rbobSpotArr[0]?.value || 2.31);
  const brentWtiSpread  = brentNow - wtiNow;
  const rbobSpotSlope   = calcDailySlope(rbobSpotArr.slice(0, 10));
  const rbobFutSlope    = rbobFutArr.length >= 3 ? calcDailySlope(rbobFutArr.slice(0, 8)) : rbobSpotSlope;
  const wtiTrend5       = calcTrend(wtiArr.slice(0, 5));
  const compositeSlope  = rbobFutSlope * 0.60 + rbobSpotSlope * 0.30;
  const shortTerm = buildShortTermForecast(retailNow, rbobFutSlope, rbobSpotSlope, wtiTrend5, brentWtiSpread);
  const verdict   = buildVerdict(compositeSlope, retailNow, shortTerm);
  return {
    updated: new Date().toISOString(),
    kpis: { retailNow, retailPrev, retailChange: retailNow - retailPrev, wtiNow, brentNow, brentWtiSpread, rbobSpotNow, rbobFuturesAvailable: rbobFutArr.length > 0, compositeSlope, inventoryChangeMbbl: invArr.length >= 2 ? (parseFloat(invArr[0].value) - parseFloat(invArr[1].value)) / 1000 : 0, refineryUtil: parseFloat(refArr[0]?.value || 88.4) },
    verdict, shortTerm, monthly: MONTHLY_FORECAST, steoUpdated: '2026-05-12', indianaOffset: INDIANA_OFFSET,
  };
}

app.get('/api/data', async (req, res) => {
  try {
    const now = Date.now();
    if (!cache || now - cacheTime > CACHE_TTL_MS) { cache = await assembleData(); cacheTime = now; }
    res.json({ ok: true, data: cache });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/subscribe', async (req, res) => {
  const { email, threshold = 10 } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false, error: 'Invalid email' });
  subscribers.set(email.toLowerCase(), { threshold: parseFloat(threshold), confirmed: false });
  if (RESEND_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: email, subject: '⛽ Fuel Forecast — you\'re subscribed', html: `<p>You\'re signed up for Fuel Forecast alerts when gas prices are predicted to move more than ${threshold}¢/gal over the next 2 weeks.</p><p><small>Reply STOP to unsubscribe.</small></p>` })
      });
    } catch (e) { console.error('Email error:', e.message); }
  }
  res.json({ ok: true, message: 'Subscribed! Check your email for confirmation.' });
});

app.post('/api/unsubscribe', (req, res) => {
  subscribers.delete(req.body?.email?.toLowerCase());
  res.json({ ok: true });
});

async function checkAndSendAlerts() {
  if (!cache || !RESEND_KEY || subscribers.size === 0) return;
  const { verdict, kpis, shortTerm } = cache;
  const price14d = shortTerm[13]?.national?.mid || kpis.retailNow;
  const delta = Math.abs(price14d - kpis.retailNow) * 100;
  for (const [email, sub] of subscribers) {
    if (delta >= sub.threshold) {
      const direction = price14d > kpis.retailNow ? '📈 rising' : '📉 falling';
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to: email, subject: `⛽ Gas price alert: ${verdict.verdict}`, html: `<h2>⛽ Fuel Forecast Alert</h2><p><strong>${verdict.verdict}</strong></p><p>${verdict.reason}</p><p>Prices are ${direction} — a ~${delta.toFixed(0)}¢/gal move is expected over the next 2 weeks.</p><p>Current US avg: <strong>$${kpis.retailNow.toFixed(2)}/gal</strong></p>` })
      }).catch(e => console.error('Alert error:', e.message));
    }
  }
}

setInterval(async () => {
  try { cache = await assembleData(); cacheTime = Date.now(); await checkAndSendAlerts(); }
  catch (e) { console.error('Refresh error:', e.message); }
}, CACHE_TTL_MS);

app.listen(PORT, () => console.log(`Fuel Forecast v2 running on :${PORT}`));
