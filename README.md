# ⛽ Fuel Forecast

A gas-price weather app that answers one question: **fill up now, or wait?**

Shows:
- A fill-now / wait verdict with confidence
- Short-term daily estimate for the next **2–3 weeks** (driven by live RBOB & WTI futures)
- A monthly outlook through December (driven by the EIA Short-Term Energy Outlook)
- A trajectory chart with uncertainty band

## Architecture

```
Browser (public/)  ←→  Node/Express server (server.js)  ←→  EIA API + FRED API
```

The backend fetches live data once per hour, caches it in memory, and exposes a single `/api/data` endpoint. The frontend is a self-contained static page that calls that endpoint.

## Setup

### 1. Get API keys (free)

| Service | URL | What it provides |
|---|---|---|
| EIA Open Data | https://www.eia.gov/opendata/ | WTI spot, retail gas, inventories, refinery utilization |
| FRED (St. Louis Fed) | https://fred.stlouisfed.org/docs/api/api_key.html | Retail gas weekly history (series `GASREGCOVW`) |

Both are free, instant registration, no credit card.

### 2. Install & run locally

```bash
npm install
cp .env.example .env
# Fill in your keys in .env
node server.js
# Open http://localhost:3000
```

### 3. Deploy to Render (free tier)

1. Push this repo to GitHub (done).
2. Go to https://render.com → New → Web Service → connect this repo.
3. Set environment variables: `EIA_KEY`, `FRED_KEY`.
4. Build command: `npm install`
5. Start command: `node server.js`

## Data sources & methodology

### Short-term (next 2–3 weeks)
- **RBOB Gasoline Futures** — wholesale gasoline price leads pump prices by **7–10 days**. Daily moves >3¢ generate a fill-now or wait signal.
- **WTI Crude Spot** — a 5-day trend in crude predicts retail direction **10–14 days** out.
- Short-term daily estimates interpolate between today's known retail price and the implied future price from RBOB.

### Medium-term (monthly)
- **EIA STEO** monthly retail gasoline forecast — updated the second week of every month.
- Confidence bands widen with time horizon.

### Verdict logic
- If RBOB 5-day trend > +2¢/day AND WTI 5-day trend > +1%: **Fill up now**
- If RBOB 5-day trend < -2¢/day AND WTI 5-day trend < -1%: **Wait**
- Otherwise: **Neutral**
