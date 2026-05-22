# The Dial — Manager Dashboard

## Deploy to Netlify

### First time setup (5 minutes)

1. **Get a free football API key**
   - Go to https://www.football-data.org/client/register
   - Sign up free — gives you Premier League, Champions League, Europa League, World Cup
   - Copy your API key from the dashboard

2. **Upload to Netlify**
   - Go to app.netlify.com
   - Drag the entire `the-dial-site` folder onto the deploy area
   - OR connect your GitHub repo for auto-deploys

3. **Add your API key to Netlify**
   - In Netlify: Site settings → Environment variables
   - Add variable: `FOOTBALL_API_KEY` = your key from step 1
   - Click Save

4. **Done** — the dashboard now:
   - Fetches live O2 show data on every page load
   - Pulls live Premier League, Champions League, Europa League, World Cup fixtures
   - Updates automatically — no manual uploads needed

## How it works

- `public/index.html` — the dashboard (all static data as fallback)
- `netlify/functions/data.js` — serverless function that runs on demand
  - Hits The O2 calendar for new shows
  - Hits football-data.org for upcoming fixtures
  - Returns JSON merged into the dashboard

## Updating manually

If you want to add show details (crowd profiles, notes) for a newly announced show,
just message the dashboard builder and they can update the static data in index.html.
New shows appear automatically but with basic info until manually enriched.

## API limits

- football-data.org free tier: 10 requests/minute, plenty for this use case
- The O2 calendar: public, no limits
- Open-Meteo (weather): free, no key needed
