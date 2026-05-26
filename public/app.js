const API = '/api/data';
const SC = { RISING: '#ef9a5a', PEAK: '#ef5a5a', FALLING: '#66bb6a', FLAT: '#b0bec5' };
const ICONS = { RISING: '📈', PEAK: '🔺', FALLING: '📉', FLAT: '➡️' };

function confClass(c) { return c >= 70 ? 'conf-high' : c >= 55 ? 'conf-med' : 'conf-low'; }
function fmtDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

function buildShortChart(shortTerm) {
  const ctx = document.getElementById('short-chart').getContext('2d');
  new Chart(ctx, {
    data: {
      labels: shortTerm.map(d => fmtDate(d.date)),
      datasets: [
        { type: 'line', label: 'Estimate', data: shortTerm.map(d => d.mid), borderColor: '#4fc3f7', backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: '#4fc3f7', tension: 0.35, order: 1 },
        { type: 'line', label: 'High', data: shortTerm.map(d => d.hi), borderColor: 'transparent', backgroundColor: 'rgba(79,195,247,0.10)', borderWidth: 0, pointRadius: 0, tension: 0.35, fill: '+1', order: 2 },
        { type: 'line', label: 'Low',  data: shortTerm.map(d => d.lo), borderColor: 'transparent', backgroundColor: 'rgba(79,195,247,0.10)', borderWidth: 0, pointRadius: 0, tension: 0.35, fill: false, order: 3 },
      ]
    },
    options: {
      responsive: true, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e2230', titleColor: '#e8eaf0', bodyColor: '#9aa0b8', padding: 10, callbacks: { label: c => { if (c.datasetIndex === 0) return ` Est: $${c.parsed.y.toFixed(2)}/gal`; if (c.datasetIndex === 1) return ` High: $${c.parsed.y.toFixed(2)}`; if (c.datasetIndex === 2) return ` Low: $${c.parsed.y.toFixed(2)}`; } } } },
      scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7f94', font: { size: 10 }, maxTicksLimit: 7 } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7f94', font: { size: 10 }, callback: v => '$' + v.toFixed(2) } } }
    }
  });
}

function buildMonthlyChart(monthly) {
  const ctx = document.getElementById('monthly-chart').getContext('2d');
  new Chart(ctx, {
    data: {
      labels: monthly.map(d => d.label),
      datasets: [
        { type: 'line', label: 'Central', data: monthly.map(d => d.mid), borderColor: '#4fc3f7', backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 4, pointBackgroundColor: '#4fc3f7', tension: 0.35, order: 1 },
        { type: 'line', label: 'High',    data: monthly.map(d => d.hi),  borderColor: 'transparent', backgroundColor: 'rgba(79,195,247,0.08)', borderWidth: 0, pointRadius: 0, tension: 0.35, fill: '+1', order: 2 },
        { type: 'line', label: 'Low',     data: monthly.map(d => d.lo),  borderColor: 'transparent', backgroundColor: 'rgba(79,195,247,0.08)', borderWidth: 0, pointRadius: 0, tension: 0.35, fill: false, order: 3 },
      ]
    },
    options: {
      responsive: true, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e2230', titleColor: '#e8eaf0', bodyColor: '#9aa0b8', padding: 10, callbacks: { label: c => { if (c.datasetIndex === 0) return ` Central: $${c.parsed.y.toFixed(2)}/gal`; if (c.datasetIndex === 1) return ` High: $${c.parsed.y.toFixed(2)}`; if (c.datasetIndex === 2) return ` Low: $${c.parsed.y.toFixed(2)}`; } } } },
      scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7f94', font: { size: 10 }, maxRotation: 30 } }, y: { min: 2.70, max: 3.80, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#7a7f94', font: { size: 10 }, callback: v => '$' + v.toFixed(2) } } }
    }
  });
}

function buildMonthlyStrip(monthly) {
  const strip = document.getElementById('monthly-strip');
  monthly.forEach((d, i) => {
    const sig = i === 0 ? 'RISING' : d.mid < monthly[i-1].mid ? 'FALLING' : d.mid > monthly[i-1].mid ? 'RISING' : 'FLAT';
    const el = document.createElement('div');
    el.className = 'day-card' + (i === 0 ? ' active' : '');
    el.innerHTML = `<div class="day-month">${d.label}</div><div class="day-icon">${ICONS[sig]||'➡️'}</div><div class="day-price" style="color:${SC[sig]}">$${d.mid.toFixed(2)}</div><div class="day-range">$${d.lo.toFixed(2)} – $${d.hi.toFixed(2)}</div><div class="day-conf ${confClass(d.conf)}">${d.conf}% conf</div>`;
    strip.appendChild(el);
  });
}

function render(data) {
  const { kpis, verdict, shortTerm, monthly, updated } = data;
  const tmpl = document.getElementById('app-template').content.cloneNode(true);
  const content = document.getElementById('app-content');
  content.innerHTML = '';
  content.appendChild(tmpl);
  const updStr = new Date(updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  document.getElementById('src-badge').textContent = `📊 Live EIA data · updated ${updStr}`;
  const vc = document.getElementById('verdict-card');
  vc.classList.add(verdict.color);
  document.getElementById('verdict-icon').textContent = verdict.icon;
  document.getElementById('verdict-text').textContent = verdict.verdict;
  document.getElementById('verdict-sub').textContent = verdict.reason;
  document.getElementById('verdict-conf').textContent = `${verdict.confidence}% confidence`;
  const retail = kpis.retailNow;
  const delta = kpis.retailChange;
  document.getElementById('today-price').textContent = `$${retail.toFixed(2)}`;
  document.getElementById('today-range').textContent = `Range: $${(retail-0.07).toFixed(2)} – $${(retail+0.10).toFixed(2)}`;
  const tc = delta > 0 ? '#ef9a5a' : delta < 0 ? '#66bb6a' : '#b0bec5';
  const ta = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const tl = delta > 0 ? 'Rising' : delta < 0 ? 'Falling' : 'Flat';
  document.getElementById('today-trend').innerHTML = `<span style="font-size:1.3rem;color:${tc}">${ta}</span><div style="color:${tc}"><div>${tl}</div><div style="font-size:.7rem;font-weight:400;color:#7a7f94">wk/wk: ${delta>=0?'+':''}${(delta*100).toFixed(1)}¢</div></div>`;
  buildShortChart(shortTerm);
  buildMonthlyStrip(monthly);
  buildMonthlyChart(monthly);
}

function renderError(msg) {
  document.getElementById('app-content').innerHTML = `<div class="status">⚠️ Could not load live data: ${msg}<br><br>Check that EIA_KEY and FRED_KEY are set in your .env file.</div>`;
  document.getElementById('src-badge').textContent = '⚠️ Data unavailable';
}

async function init() {
  try {
    const res = await fetch(API);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Server error');
    render(json.data);
  } catch (err) { renderError(err.message); }
}

init();
