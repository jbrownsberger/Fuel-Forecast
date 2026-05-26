import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const EIA_KEY = process.env.EIA_KEY;
const FRED_KEY = process.env.FRED_KEY;

// --- In-memory cache ---
let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

app.use(express.static(join(__dirname, 'public')));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

// ── EIA helpers ──────────────────────────────────────────────────────────────

async function eiaFetch(route, params) {
  const url = new URL(`https://api.eia.gov/v2/${route}`);
  url.searchParams.set('api_key', EIA_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`EIA ${route} → ${r.status}`);
  return r.json();
}

async function getWTI(days = 14) {
  const j = await eiaFetch('petroleum/pri/spt/data/', {
    frequency: 'daily',
    'data[0]': 'value',
    'facets[series][]': 'RWTC',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: days,
  });
  return j.response?.data || [];
}

async function getRBOB(days = 14) {
  const j = await eiaFetch('petroleum/pri/spt/data/', {
    frequency: 'daily',
    'data[0]': 'value',
    'facets[series][]': 'EER_EPMRR_PF4_Y35NY_DPG',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: days,
  });
  return j.response?.data || [];
}

async function getRetailGas(weeks = 4) {
  const j = await eiaFetch('petroleum/pri/gnd/data/', {
    frequency: 'weekly',
    'data[0]': 'value',
    'facets[duoarea][]': 'NUS',
    'facets[product][]': 'EPMR',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: weeks,
  });
  return j.response?.data || [];
}

async function getInventories(weeks = 3) {
  const j = await eiaFetch('petroleum/stoc/wstk/data/', {
    frequency: 'weekly',
    'data[0]': 'value',
    'facets[product][]': 'EPC0',
    'facets[duoarea][]': 'NUS',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: weeks,
  });
  return j.response?.data || [];
}

async function getRefinery(weeks = 3) {
  const j = await eiaFetch('petroleum/pnp/wiup/data/', {
    frequency: 'weekly',
    'data[0]': 'value',
    'facets[series][]': 'WPULEUS3',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: weeks,
  });
  return j.response?.data || [];
}

// ── FRED helper ──────────────────────────────────────────────────────────────

async function getFREDGas(limit = 12) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=GASREGCOVW&api_key=${FRED_KEY}&sort_order=desc&limit=${limit}&file_type=json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FRED → ${r.status}`);
  const j = await r.json();
  return j.observations || [];
}

// ── Forecast logic ────────────────────────────────────────────────────────────

function calcTrend(arr, field = 'value') {
  if (!arr || arr.length < 2) return 0;
  const newest = parseFloat(arr[0][field]);
  const oldest = parseFloat(arr[arr.length - 1][field]);
  return ((newest - oldest) / oldest) * 100;
}

function calcDailySlope(arr, field = 'value') {
  const n = arr.length;
  if (n < 2) return 0;
  const vals = arr.map((d, i) => ({ x: n - 1 - i, y: parseFloat(d[field]) }));
  const xMean = vals.reduce((s, d) => s + d.x, 0) / n;
  const yMean = vals.reduce((s, d) => s + d.y, 0) / n;
  const num = vals.reduce((s, d) => s + (d.x - xMean) * (d.y - yMean), 0);
  const den = vals.reduce((s, d) => s + (d.x - xMean) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function buildShortTermForecast(retailNow, rbobSlope, wtiTrend5day) {
  const days = [];
  const today = new Date();
  for (let i = 0; i < 21; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const lagFactor = Math.min(i / 9, 1);
    const dailyMove = rbobSlope * 0.92 * lagFactor;
    const mid = Math.round((retailNow + dailyMove * i) * 100) / 100;
    const band = parseFloat((0.02 + i * 0.003).toFixed(3));
    days.push({
      date: d.toISOString().slice(0, 10),
      mid: Math.max(mid, 2.00),
      lo: Math.max(mid - band, 2.00),
      hi: mid + band,
    });
  }
  return days;
}

function buildVerdict(rbobSlope, wtiTrend5day, retailNow, shortTerm) {
  const price14d = shortTerm[13]?.mid || retailNow;
  const delta = price14d - retailNow;
  const rbobDaily = rbobSlope * 100;
  let verdict, icon, color, reason, confidence;
  if (delta > 0.08 || rbobDaily > 0.3) {
    verdict = 'Fill up soon';
    icon = '⚠️'; color = 'orange';
    reason = `Prices look ~${Math.abs(delta * 100).toFixed(0)}¢/gal higher in ~2 weeks. Fill up before the increase arrives.`;
    confidence = delta > 0.15 ? 75 : 60;
  } else if (delta < -0.08 || rbobDaily < -0.3) {
    verdict = 'Wait — prices are falling';
    icon = '✅'; color = 'green';
    reason = `Prices look ~${Math.abs(delta * 100).toFixed(0)}¢/gal lower in ~2 weeks. Running low is fine.`;
    confidence = delta < -0.15 ? 75 : 60;
  } else {
    verdict = 'Neutral — fill when convenient';
    icon = '➡️'; color = 'blue';
    reason = 'No strong directional signal in the next 2 weeks. Fill up when convenient.';
    confidence = 55;
  }
  return { verdict, icon, color, reason, confidence };
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
  const [wtiArr, rbobArr, retailArr, invArr, refArr] = await Promise.all([
    getWTI(10), getRBOB(10), getRetailGas(4), getInventories(3), getRefinery(3),
  ]);
  const retailNow  = parseFloat(retailArr[0]?.value || 3.45);
  const retailPrev = parseFloat(retailArr[1]?.value || retailNow);
  const wtiNow     = parseFloat(wtiArr[0]?.value || 71.4);
  const rbobNow    = parseFloat(rbobArr[0]?.value || 2.31);
  const wtiTrend5  = calcTrend(wtiArr.slice(0, 5));
  const rbobSlope  = calcDailySlope(rbobArr.slice(0, 10));
  const invChange  = invArr.length >= 2 ? parseFloat(invArr[0].value) - parseFloat(invArr[1].value) : 0;
  const refUtil    = parseFloat(refArr[0]?.value || 88.4);
  const shortTerm  = buildShortTermForecast(retailNow, rbobSlope, wtiTrend5);
  const verdict    = buildVerdict(rbobSlope, wtiTrend5, retailNow, shortTerm);
  return {
    updated: new Date().toISOString(),
    kpis: { retailNow, retailPrev, retailChange: retailNow - retailPrev, wtiNow, wtiTrend5day: wtiTrend5, rbobNow, rbobSlopeDailyDollars: rbobSlope, inventoryChangeMbbl: invChange / 1000, refineryUtil: refUtil },
    verdict, shortTerm, monthly: MONTHLY_FORECAST, steoUpdated: '2026-05-12',
  };
}

app.get('/api/data', async (req, res) => {
  try {
    const now = Date.now();
    if (!cache || now - cacheTime > CACHE_TTL_MS) { cache = await assembleData(); cacheTime = now; }
    res.json({ ok: true, data: cache });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Fuel Forecast running on :${PORT}`));
