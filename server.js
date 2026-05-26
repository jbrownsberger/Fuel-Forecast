import express from 'express';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const EIA_KEY    = process.env.EIA_KEY;
const RESEND_KEY = process.env.RESEND_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'alerts@yourdomain.com';
const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;

const sb = createClient(SB_URL, SB_KEY);

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/images', express.static(join(__dirname, 'images')));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

// ── EIA helpers ────────────────────────────────────────────────────────────
async function eiaFetch(route, params) {
  const url = new URL(`https://api.eia.gov/v2/${route}`);
  url.searchParams.set('api_key', EIA_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`EIA ${route} -> ${r.status}`);
  return r.json();
}
async function getWTI()      { const j = await eiaFetch('petroleum/pri/spt/data/', { frequency:'daily','data[0]':'value','facets[series][]':'RWTC','sort[0][column]':'period','sort[0][direction]':'desc',length:10 }); return j.response?.data||[]; }
async function getBrent()    { const j = await eiaFetch('petroleum/pri/spt/data/', { frequency:'daily','data[0]':'value','facets[series][]':'EER_EBRTWHERE_EPD2F_NUS_DPB','sort[0][column]':'period','sort[0][direction]':'desc',length:10 }); return j.response?.data||[]; }
async function getRBOBSpot() { const j = await eiaFetch('petroleum/pri/spt/data/', { frequency:'daily','data[0]':'value','facets[series][]':'EER_EPMRR_PF4_Y35NY_DPG','sort[0][column]':'period','sort[0][direction]':'desc',length:10 }); return j.response?.data||[]; }
async function getRBOBFutures() {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/RB=F?interval=1d&range=10d',{headers:{'User-Agent':'Mozilla/5.0'}});
    const j = await r.json();
    const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close||[];
    const ts     = j?.chart?.result?.[0]?.timestamp||[];
    return ts.map((t,i)=>({period:new Date(t*1000).toISOString().slice(0,10),value:closes[i]})).filter(d=>d.value!=null).reverse();
  } catch { return []; }
}
async function getRetailGas()  { const j = await eiaFetch('petroleum/pri/gnd/data/', { frequency:'weekly','data[0]':'value','facets[duoarea][]':'NUS','facets[product][]':'EPMR','sort[0][column]':'period','sort[0][direction]':'desc',length:4 }); return j.response?.data||[]; }
async function getInventories(){ const j = await eiaFetch('petroleum/stoc/wstk/data/',{ frequency:'weekly','data[0]':'value','facets[product][]':'EPC0','facets[duoarea][]':'NUS','sort[0][column]':'period','sort[0][direction]':'desc',length:3 }); return j.response?.data||[]; }
async function getRefinery()   { const j = await eiaFetch('petroleum/pnp/wiup/data/', { frequency:'weekly','data[0]':'value','facets[series][]':'WPULEUS3','sort[0][column]':'period','sort[0][direction]':'desc',length:3 }); return j.response?.data||[]; }

function calcDailySlope(arr,field='value'){
  const n=arr.length; if(n<2)return 0;
  const vals=arr.map((d,i)=>({x:n-1-i,y:parseFloat(d[field])}));
  const xm=vals.reduce((s,d)=>s+d.x,0)/n, ym=vals.reduce((s,d)=>s+d.y,0)/n;
  const num=vals.reduce((s,d)=>s+(d.x-xm)*(d.y-ym),0);
  const den=vals.reduce((s,d)=>s+(d.x-xm)**2,0);
  return den===0?0:num/den;
}

const INDIANA_OFFSET = -0.05;

function buildShortTerm(retailNow, futSlope, spotSlope, brentWtiSpread){
  const spreadAdj = brentWtiSpread>5?0.002:brentWtiSpread<0?-0.001:0;
  const comp = futSlope*0.60 + spotSlope*0.30 + spreadAdj;
  const lagDays = comp>0?7:14;
  const today = new Date();
  return Array.from({length:21},(_,i)=>{
    const d=new Date(today); d.setDate(d.getDate()+i);
    const lag=Math.min(i/lagDays,1);
    const midN=Math.max(retailNow+comp*0.92*lag*i,2.00);
    const midI=Math.max(midN+INDIANA_OFFSET,2.00);
    const band=parseFloat((0.02+i*0.003).toFixed(3));
    return {date:d.toISOString().slice(0,10),
      national:{mid:Math.round(midN*100)/100,lo:Math.round((midN-band)*100)/100,hi:Math.round((midN+band)*100)/100},
      indiana: {mid:Math.round(midI*100)/100,lo:Math.round((midI-band)*100)/100,hi:Math.round((midI+band)*100)/100}};
  });
}

function buildVerdict(compositeSlope, retailNow, shortTerm){
  const price14d = shortTerm[13]?.national?.mid||retailNow;
  const delta = price14d - retailNow;
  if (delta>0.08||compositeSlope*100>0.3) return {verdict:'Fill up soon',color:'orange',reason:`Prices projected ~${Math.abs(delta*100).toFixed(0)} cents/gal higher in 2 weeks.`,confidence:delta>0.15?75:60};
  if (delta<-0.08||compositeSlope*100<-0.3) return {verdict:'Wait — prices are falling',color:'green',reason:`Prices projected ~${Math.abs(delta*100).toFixed(0)} cents/gal lower in 2 weeks.`,confidence:delta<-0.15?75:60};
  return {verdict:'Neutral — fill when convenient',color:'blue',reason:'No strong directional signal over the next 2 weeks.',confidence:55};
}

const MONTHLY_FORECAST = [
  {label:'Now (May 26)',mid:3.45,lo:3.38,hi:3.55,conf:75},
  {label:'Early June', mid:3.58,lo:3.45,hi:3.68,conf:65},
  {label:'Late June',  mid:3.52,lo:3.40,hi:3.62,conf:60},
  {label:'July',       mid:3.38,lo:3.25,hi:3.50,conf:60},
  {label:'August',     mid:3.28,lo:3.15,hi:3.42,conf:55},
  {label:'September',  mid:3.18,lo:3.05,hi:3.32,conf:55},
  {label:'October',    mid:3.08,lo:2.95,hi:3.22,conf:50},
  {label:'November',   mid:3.00,lo:2.88,hi:3.14,conf:50},
  {label:'December',   mid:2.95,lo:2.82,hi:3.08,conf:50},
];

async function assembleData(){
  const [wtiArr,brentArr,rbobSpotArr,rbobFutArr,retailArr,invArr,refArr] = await Promise.all([
    getWTI(),getBrent(),getRBOBSpot(),getRBOBFutures(),getRetailGas(),getInventories(),getRefinery()
  ]);
  const retailNow  = parseFloat(retailArr[0]?.value||3.45);
  const retailPrev = parseFloat(retailArr[1]?.value||retailNow);
  const wtiNow     = parseFloat(wtiArr[0]?.value||71.4);
  const brentNow   = parseFloat(brentArr[0]?.value||76.0);
  const rbobSpotNow= parseFloat(rbobSpotArr[0]?.value||2.31);
  const brentWtiSpread = brentNow - wtiNow;
  const rbobSpotSlope  = calcDailySlope(rbobSpotArr.slice(0,10));
  const rbobFutSlope   = rbobFutArr.length>=3?calcDailySlope(rbobFutArr.slice(0,8)):rbobSpotSlope;
  const compositeSlope = rbobFutSlope*0.60 + rbobSpotSlope*0.30;
  const shortTerm  = buildShortTerm(retailNow,rbobFutSlope,rbobSpotSlope,brentWtiSpread);
  const verdict    = buildVerdict(compositeSlope,retailNow,shortTerm);
  return {
    updated: new Date().toISOString(),
    kpis:{retailNow,retailPrev,retailChange:retailNow-retailPrev,wtiNow,brentNow,brentWtiSpread,rbobSpotNow,
          rbobFuturesAvailable:rbobFutArr.length>0,compositeSlope,
          inventoryChangeMbbl:invArr.length>=2?(parseFloat(invArr[0].value)-parseFloat(invArr[1].value))/1000:0,
          refineryUtil:parseFloat(refArr[0]?.value||88.4)},
    verdict, shortTerm, monthly:MONTHLY_FORECAST
  };
}

// ── Supabase: persist snapshot ─────────────────────────────────────────────
async function persistSnapshot(data){
  const {kpis,verdict} = data;
  await sb.from('fuel_snapshots').insert({
    retail_now: kpis.retailNow, retail_prev: kpis.retailPrev,
    wti_now: kpis.wtiNow, brent_now: kpis.brentNow, rbob_spot: kpis.rbobSpotNow,
    composite_slope: kpis.compositeSlope, verdict: verdict.verdict,
    confidence: verdict.confidence, payload: data
  });
}

// ── Resend alerts ──────────────────────────────────────────────────────────
async function sendAlerts(data){
  if (!RESEND_KEY) return;
  const {verdict,kpis,shortTerm} = data;
  const price14d = shortTerm[13]?.national?.mid||kpis.retailNow;
  const deltaCents = Math.abs(price14d-kpis.retailNow)*100;
  const {data:subs} = await sb.from('fuel_subscribers').select('id,email,threshold').eq('active',true);
  if (!subs?.length) return;
  const now = new Date();
  for (const sub of subs){
    if (deltaCents < sub.threshold) continue;
    const {data:recent} = await sb.from('fuel_alert_log').select('sent_at')
      .eq('subscriber_id',sub.id).gte('sent_at',new Date(now-86400000).toISOString()).limit(1);
    if (recent?.length) continue;
    const direction = price14d>kpis.retailNow?'rising':'falling';
    await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':`Bearer ${RESEND_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        from:FROM_EMAIL, to:sub.email,
        subject:`Fuel Forecast: ${verdict.verdict}`,
        html:`<h2>Fuel Forecast Alert</h2><p><strong>${verdict.verdict}</strong></p><p>${verdict.reason}</p><p>Prices are ${direction} — a ~${deltaCents.toFixed(0)} cent/gal move expected over 2 weeks.</p><p>Current US average: <strong>$${kpis.retailNow.toFixed(2)}/gal</strong></p><p><small>Reply STOP to unsubscribe.</small></p>`
      })
    }).catch(e=>console.error('Resend error:',e.message));
    await sb.from('fuel_alert_log').insert({subscriber_id:sub.id,verdict:verdict.verdict,delta_cents:deltaCents});
  }
}

// ── In-memory cache (1h TTL) ───────────────────────────────────────────────
let cache=null, cacheTime=0;
const CACHE_TTL=60*60*1000;

async function refresh(){
  try {
    const data = await assembleData();
    cache = data; cacheTime = Date.now();
    await persistSnapshot(data);
    await sendAlerts(data);
    console.log('[refresh]',new Date().toISOString(),data.verdict.verdict);
  } catch(e){ console.error('[refresh error]',e.message); }
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get('/api/data', async (req,res)=>{
  if (!cache||Date.now()-cacheTime>CACHE_TTL) await refresh();
  if (cache) res.json({ok:true,data:cache});
  else res.status(500).json({ok:false,error:'Data unavailable'});
});

app.post('/api/subscribe', async (req,res)=>{
  const {email,threshold=10} = req.body;
  if (!email||!email.includes('@')) return res.status(400).json({ok:false,error:'Invalid email'});
  const {error} = await sb.from('fuel_subscribers').upsert({email:email.toLowerCase(),threshold:parseFloat(threshold),active:true},{onConflict:'email'});
  if (error) return res.status(500).json({ok:false,error:error.message});
  if (RESEND_KEY){
    await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':`Bearer ${RESEND_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:FROM_EMAIL,to:email,subject:'Fuel Forecast — subscribed',html:`<p>You are signed up for Fuel Forecast alerts when prices are projected to move more than ${threshold} cents/gal.</p><p><small>Reply STOP to unsubscribe.</small></p>`})
    }).catch(e=>console.error('Confirm email error:',e.message));
  }
  res.json({ok:true,message:'Subscribed! Confirmation sent to your email.'});
});

app.post('/api/unsubscribe', async (req,res)=>{
  const {email} = req.body;
  await sb.from('fuel_subscribers').update({active:false}).eq('email',email?.toLowerCase());
  res.json({ok:true});
});

// ── Cron endpoint ─────────────────────────────────────────────────────────
app.post('/api/cron', async (req,res)=>{
  const secret = req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret!==process.env.CRON_SECRET)
    return res.status(401).json({ok:false,error:'Unauthorized'});
  await refresh();
  res.json({ok:true,verdict:cache?.verdict?.verdict||'unknown'});
});

// ── Boot refresh + hourly interval ────────────────────────────────────────
refresh();
setInterval(refresh, CACHE_TTL);

app.listen(PORT, ()=>console.log(`Fuel Forecast v3 on :${PORT}`));
