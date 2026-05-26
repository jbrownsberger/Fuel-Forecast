const API='/api/data';
const SC={RISING:'#e07050',FALLING:'#5aaa7a',FLAT:'#8a90a8'};
const SIG={RISING:'Rising',FALLING:'Falling',FLAT:'Flat'};
let showIndiana=true;
let shortChartInstance=null;

function confClass(c){return c>=70?'conf-high':c>=55?'conf-med':'conf-low';}
function fmtDate(iso){return new Date(iso+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function fmtDay(iso){const d=new Date(iso+'T12:00:00');const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return `${days[d.getDay()]} ${fmtDate(iso)}`;}

function buildShortChart(shortTerm,indiana){
  const series=shortTerm.map(d=>indiana?d.indiana:d.national);
  if(shortChartInstance)shortChartInstance.destroy();
  const ctx=document.getElementById('short-chart').getContext('2d');
  shortChartInstance=new Chart(ctx,{data:{labels:shortTerm.map(d=>fmtDate(d.date)),datasets:[
    {type:'line',label:'Estimate',data:series.map(d=>d.mid),borderColor:'#c8a96e',backgroundColor:'transparent',borderWidth:2.5,pointRadius:3,pointBackgroundColor:'#c8a96e',tension:0.35,order:1},
    {type:'line',label:'High',data:series.map(d=>d.hi),borderColor:'transparent',backgroundColor:'rgba(200,169,110,0.10)',borderWidth:0,pointRadius:0,tension:0.35,fill:'+1',order:2},
    {type:'line',label:'Low',data:series.map(d=>d.lo),borderColor:'transparent',backgroundColor:'rgba(200,169,110,0.10)',borderWidth:0,pointRadius:0,tension:0.35,fill:false,order:3},
  ]},options:{responsive:true,interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:false},tooltip:{backgroundColor:'#161922',titleColor:'#e8eaf0',bodyColor:'#8a90a8',padding:10,
      callbacks:{label:c=>{if(c.datasetIndex===0)return ` Est: $${c.parsed.y.toFixed(2)}/gal`;if(c.datasetIndex===1)return ` High: $${c.parsed.y.toFixed(2)}`;if(c.datasetIndex===2)return ` Low: $${c.parsed.y.toFixed(2)}`;} }}},
    scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8a90a8',font:{size:10},maxTicksLimit:7}},
             y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8a90a8',font:{size:10},callback:v=>'$'+v.toFixed(2)}}}
  }});
}

function buildDayStrip(shortTerm,indiana){
  const strip=document.getElementById('day-strip');strip.innerHTML='';
  shortTerm.forEach((d,i)=>{
    const s=indiana?d.indiana:d.national;
    const prev=i>0?(indiana?shortTerm[i-1].indiana.mid:shortTerm[i-1].national.mid):s.mid;
    const delta=s.mid-prev;
    const sig=Math.abs(delta)<0.01?'FLAT':delta>0?'RISING':'FALLING';
    const arrow=sig==='RISING'?'+ ':sig==='FALLING'?'- ':'';
    const lbl=i===0?'Today':i===1?'Tomorrow':fmtDay(d.date);
    const el=document.createElement('div');
    el.className='day-tile'+(i===0?' today-tile':'');
    el.innerHTML=`<div class="dt-label">${lbl}</div><div class="dt-sig" style="color:${SC[sig]}">${SIG[sig]}</div><div class="dt-price" style="color:${SC[sig]}">$${s.mid.toFixed(2)}</div><div class="dt-arrow" style="color:${SC[sig]}">${arrow}${Math.abs(delta*100).toFixed(0)}c</div><div class="dt-range">$${s.lo.toFixed(2)}-$${s.hi.toFixed(2)}</div>`;
    strip.appendChild(el);
  });
}

function buildMonthlyChart(monthly){
  const ctx=document.getElementById('monthly-chart').getContext('2d');
  new Chart(ctx,{data:{labels:monthly.map(d=>d.label),datasets:[
    {type:'line',label:'Central',data:monthly.map(d=>d.mid),borderColor:'#c8a96e',backgroundColor:'transparent',borderWidth:2.5,pointRadius:4,pointBackgroundColor:'#c8a96e',tension:0.35,order:1},
    {type:'line',label:'High',data:monthly.map(d=>d.hi),borderColor:'transparent',backgroundColor:'rgba(200,169,110,0.08)',borderWidth:0,pointRadius:0,tension:0.35,fill:'+1',order:2},
    {type:'line',label:'Low',data:monthly.map(d=>d.lo),borderColor:'transparent',backgroundColor:'rgba(200,169,110,0.08)',borderWidth:0,pointRadius:0,tension:0.35,fill:false,order:3},
  ]},options:{responsive:true,interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:false},tooltip:{backgroundColor:'#161922',titleColor:'#e8eaf0',bodyColor:'#8a90a8',padding:10,
      callbacks:{label:c=>{if(c.datasetIndex===0)return ` Central: $${c.parsed.y.toFixed(2)}/gal`;if(c.datasetIndex===1)return ` High: $${c.parsed.y.toFixed(2)}`;if(c.datasetIndex===2)return ` Low: $${c.parsed.y.toFixed(2)}`;} }}},
    scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8a90a8',font:{size:10},maxRotation:30}},
             y:{min:2.70,max:3.80,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8a90a8',font:{size:10},callback:v=>'$'+v.toFixed(2)}}}
  }});
}

function buildMonthlyStrip(monthly){
  const strip=document.getElementById('monthly-strip');strip.innerHTML='';
  monthly.forEach((d,i)=>{
    const sig=i===0?'RISING':d.mid<monthly[i-1].mid?'FALLING':d.mid>monthly[i-1].mid?'RISING':'FLAT';
    const el=document.createElement('div');
    el.className='day-card'+(i===0?' active':'');
    el.innerHTML=`<div class="day-month">${d.label}</div><div class="day-sig" style="color:${SC[sig]}">${SIG[sig]}</div><div class="day-price" style="color:${SC[sig]}">$${d.mid.toFixed(2)}</div><div class="day-range">$${d.lo.toFixed(2)} - $${d.hi.toFixed(2)}</div><div class="day-conf ${confClass(d.conf)}">${d.conf}% conf</div>`;
    strip.appendChild(el);
  });
}

function setupSubscribeForm(){
  const form=document.getElementById('subscribe-form');
  const msg=document.getElementById('subscribe-msg');
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const email=document.getElementById('sub-email').value.trim();
    const threshold=document.getElementById('sub-threshold').value;
    msg.textContent='Subscribing...';
    try{
      const r=await fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,threshold})});
      const j=await r.json();
      msg.textContent=j.ok?'Subscribed. Check your email.':'Error: '+j.error;
      if(j.ok)form.reset();
    }catch{msg.textContent='Could not subscribe. Try again.';}
  });
}

function setupToggle(shortTerm){
  document.getElementById('region-toggle').addEventListener('change',e=>{
    showIndiana=e.target.checked;
    document.getElementById('region-label').textContent=showIndiana?'Indiana':'US National';
    buildDayStrip(shortTerm,showIndiana);
    buildShortChart(shortTerm,showIndiana);
  });
}

function render(data){
  const{kpis,verdict,shortTerm,monthly,updated}=data;
  const tmpl=document.getElementById('app-template').content.cloneNode(true);
  document.getElementById('app-content').innerHTML='';
  document.getElementById('app-content').appendChild(tmpl);

  const updStr=new Date(updated).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  document.getElementById('src-badge').textContent=`Live EIA${kpis.rbobFuturesAvailable?' + NYMEX':''} — updated ${updStr}`;

  const vc=document.getElementById('verdict-card');vc.classList.add(verdict.color);
  document.getElementById('verdict-text').textContent=verdict.verdict;
  document.getElementById('verdict-sub').textContent=verdict.reason;
  document.getElementById('verdict-conf').textContent=`${verdict.confidence}% confidence`;

  const retail=kpis.retailNow,delta=kpis.retailChange;
  document.getElementById('today-price').textContent=`$${retail.toFixed(2)}`;
  document.getElementById('today-range').textContent=`Range: $${(retail-0.07).toFixed(2)} - $${(retail+0.10).toFixed(2)}`;
  const tc=delta>0?'var(--up)':delta<0?'var(--down)':'var(--flat)';
  const tl=delta>0?'Rising':delta<0?'Falling':'Flat';
  document.getElementById('today-trend').innerHTML=`<span style="color:${tc};font-size:1.1rem;font-weight:700">${tl}</span><br><span style="font-size:.75rem;color:var(--muted)">${delta>=0?'+':''}${(delta*100).toFixed(1)}c week over week</span>`;

  const kpiEl=document.getElementById('kpi-list');
  kpiEl.innerHTML=[
    `Brent-WTI: <span class="kpi-val">${kpis.brentWtiSpread>0?'+':''}${kpis.brentWtiSpread.toFixed(1)}</span>`,
    `Inventory: <span class="kpi-val">${kpis.inventoryChangeMbbl>0?'+':''}${kpis.inventoryChangeMbbl.toFixed(1)} Mbbl</span>`,
    `Refinery: <span class="kpi-val">${kpis.refineryUtil.toFixed(1)}%</span>`
  ].join('<br>');

  buildDayStrip(shortTerm,showIndiana);
  buildShortChart(shortTerm,showIndiana);
  buildMonthlyStrip(monthly);
  buildMonthlyChart(monthly);
  setupToggle(shortTerm);
  setupSubscribeForm();
}

function renderError(msg){
  document.getElementById('app-content').innerHTML=`<div class="status">Could not load live data: ${msg}. Check that EIA_KEY and SUPABASE environment variables are set.</div>`;
  document.getElementById('src-badge').textContent='Data unavailable';
}

async function init(){
  try{
    const res=await fetch(API);
    const json=await res.json();
    if(!json.ok)throw new Error(json.error||'Server error');
    render(json.data);
  }catch(err){renderError(err.message);}
}

init();
