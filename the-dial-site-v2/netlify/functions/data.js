// netlify/functions/data.js
// Fetches live O2 shows + sports fixtures on demand
// Environment variables needed:
//   FOOTBALL_API_KEY  — from football-data.org (free)
//   SCRAPERAPI_KEY    — from scraperapi.com (free trial)

const https = require('https');
const http  = require('http');

// ── GENERIC FETCH ─────────────────────────────────────────────────
function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── DATE HELPERS ──────────────────────────────────────────────────
function fmt(d) { return d.toISOString().slice(0, 10); }

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isBST(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const lastSunMar = new Date(y, 2, 31 - (new Date(y, 2, 31).getDay()));
  const lastSunOct = new Date(y, 9, 31 - (new Date(y, 9, 31).getDay()));
  return d >= lastSunMar && d < lastSunOct;
}

function utcToUK(utcStr) {
  const d   = new Date(utcStr);
  const off = isBST(utcStr) ? 1 : 0;
  d.setHours(d.getHours() + off);
  return d.toISOString().slice(0, 16);   // "YYYY-MM-DDTHH:MM"
}

const DAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHSFULL = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

function niceDate(dateStr, timeStr, broadcaster) {
  const d   = new Date(dateStr + 'T12:00:00');
  const day = DAYS[d.getDay()];
  const dt  = d.getDate();
  const mo  = MONTHS[d.getMonth()];
  return `${day} ${dt} ${mo} · ${timeStr} BST · ${broadcaster}`;
}

// ── O2 SHOW SCRAPER via ScraperAPI ───────────────────────────────
async function fetchO2Shows() {
  const scraperKey = process.env.SCRAPERAPI_KEY;
  if (!scraperKey) {
    console.log('No SCRAPERAPI_KEY — skipping O2 scrape');
    return [];
  }

  // Use ScraperAPI to fetch The O2's public PDF calendar text
  const target = encodeURIComponent('https://www.theo2.co.uk/events-tickets/pdf');
  const url    = `https://api.scraperapi.com?api_key=${scraperKey}&url=${target}&render=false`;

  let body;
  try {
    const res = await fetch(url);
    if (res.status !== 200) throw new Error(`ScraperAPI returned ${res.status}`);
    body = res.body;
  } catch (e) {
    console.error('O2 scrape failed:', e.message);
    return [];
  }

  const shows  = [];
  const today  = fmt(new Date());
  const cutoff = fmt(addDays(new Date(), 180));

  // Month name → number
  const M = { january:1,february:2,march:3,april:4,may:5,june:6,
              july:7,august:8,september:9,october:10,november:11,december:12 };

  // The O2 PDF text contains lines like:
  //   "29\nApril 2026\nOlivia Dean\n6:30pm"
  // We split by newline and look for the pattern
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let i = 0;
  while (i < lines.length) {
    // Look for a standalone number (day)
    const dayMatch = lines[i].match(/^(\d{1,2})$/);
    if (dayMatch && i + 1 < lines.length) {
      // Next line should be "Month Year" or "Month"
      const monthLine = lines[i + 1];
      const monthMatch = monthLine.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s*(?:2026)?$/i);
      if (monthMatch) {
        const day   = parseInt(dayMatch[1]);
        const month = M[monthMatch[1].toLowerCase()];
        const year  = 2026;
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

        if (dateStr >= today && dateStr <= cutoff) {
          // Scan next lines for artist name and time
          let name = null;
          let start = '18:30';
          let venue = 'arena';

          for (let j = i + 2; j < Math.min(i + 8, lines.length); j++) {
            const l = lines[j];
            // Stop if we hit another day number
            if (l.match(/^\d{1,2}$/) && j > i + 2) break;

            // Time pattern
            const tMatch = l.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
            if (tMatch) {
              let h = parseInt(tMatch[1]);
              if (tMatch[3].toLowerCase() === 'pm' && h !== 12) h += 12;
              if (tMatch[3].toLowerCase() === 'am' && h === 12) h = 0;
              start = `${String(h).padStart(2,'0')}:${tMatch[2]}`;
              continue;
            }
            // Venue hint
            if (l.toLowerCase().includes('indigo')) { venue = 'indigo'; continue; }
            // Artist name — first non-trivial line
            if (!name && l.length > 2 && l.length < 80 &&
                !l.match(/^(buy|more info|event starts|add to|doors|powered)/i)) {
              name = l;
            }
          }

          if (name) {
            shows.push({ date: dateStr, name, venue, start });
          }
        }
        i += 2;
        continue;
      }
    }
    i++;
  }

  console.log(`O2 scrape: found ${shows.length} shows`);
  return shows;
}

// ── SPORTS FETCHER via football-data.org ─────────────────────────
async function fetchSports() {
  const apiKey = process.env.FOOTBALL_API_KEY;
  if (!apiKey) {
    console.log('No FOOTBALL_API_KEY — skipping sports fetch');
    return [];
  }

  const today     = fmt(new Date());
  const endDate   = fmt(addDays(new Date(), 60));
  const headers   = { 'X-Auth-Token': apiKey };
  const sports    = [];

  // UK-relevant competitions on football-data.org free tier
  const comps = [
    { code: 'PL',  label: 'Premier League',   icon: '⚽', type: 'pl',  broadcaster: 'Sky Sports'   },
    { code: 'CL',  label: 'Champions League', icon: '🏆', type: 'ucl', broadcaster: 'TNT Sports'   },
    { code: 'EL',  label: 'Europa League',    icon: '🟠', type: 'el',  broadcaster: 'TNT Sports'   },
    { code: 'EC',  label: 'EURO 2028 Qual.',  icon: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'euro', broadcaster: 'ITV/BBC' },
    { code: 'WC',  label: 'World Cup 2026',   icon: '🌍', type: 'wc',  broadcaster: 'ITV/BBC'       },
  ];

  const UK_TEAMS = new Set([
    'Arsenal FC','Chelsea FC','Liverpool FC','Manchester City FC',
    'Manchester United FC','Tottenham Hotspur FC','Newcastle United FC',
    'Aston Villa FC','West Ham United FC','England',
    'Arsenal','Chelsea','Liverpool','Manchester City',
    'Manchester United','Tottenham','Newcastle','Aston Villa','West Ham',
  ]);

  for (const comp of comps) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${comp.code}/matches` +
                  `?dateFrom=${today}&dateTo=${endDate}&status=SCHEDULED,TIMED`;
      const res = await fetch(url, headers);

      if (res.status === 429) { console.log(`Rate limited on ${comp.code}`); continue; }
      if (res.status !== 200) { console.log(`${comp.code} returned ${res.status}`); continue; }

      const data    = JSON.parse(res.body);
      const matches = data.matches || [];

      for (const m of matches) {
        const uk      = utcToUK(m.utcDate);
        const dateStr = uk.slice(0, 10);
        const timeStr = uk.slice(11, 16);
        const hour    = parseInt(timeStr.split(':')[0]);

        // Only evening UK-time games (after 17:00, or late night/overnight for WC)
        const isWCLate = comp.type === 'wc' && (hour >= 22 || hour <= 2);
        if (hour < 17 && !isWCLate) continue;

        const home = m.homeTeam?.name || 'TBC';
        const away = m.awayTeam?.name || 'TBC';

        const hasUK      = UK_TEAMS.has(home) || UK_TEAMS.has(away);
        const hasEngland = home.includes('England') || away.includes('England');
        const isFinal    = (m.stage || '').toUpperCase().includes('FINAL');
        const isSemiFinal = (m.stage || '').toUpperCase().includes('SEMI');

        // Busyness model (seated sports bar — manager's calibration)
        let boost = 4, solo = 22, impact = 'LOW', ic = 'moderate';

        if (hasEngland) {
          boost = 18; solo = 62; impact = 'MODERATE-HIGH'; ic = 'high';
        } else if (hasUK && comp.type === 'pl') {
          boost = 8; solo = 40; impact = 'MODERATE'; ic = 'moderate';
        } else if (hasUK && isFinal) {
          boost = 14; solo = 52; impact = 'MODERATE-HIGH'; ic = 'high';
        } else if (hasUK) {
          boost = 10; solo = 44; impact = 'MODERATE'; ic = 'moderate';
        } else if (isFinal) {
          boost = 10; solo = 40; impact = 'MODERATE'; ic = 'moderate';
        } else if (isSemiFinal && hasUK) {
          boost = 12; solo = 46; impact = 'MODERATE'; ic = 'moderate';
        }

        sports.push({
          type        : comp.type,
          date        : dateStr,
          name        : `${comp.icon} ${comp.label}: ${home} vs ${away}`,
          ko          : niceDate(dateStr, timeStr, comp.broadcaster),
          boost,
          solo,
          impact,
          impact_class: ic,
        });
      }

      // Small delay between requests to respect rate limit
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      console.error(`${comp.code} error:`, e.message);
    }
  }

  console.log(`Sports fetch: found ${sports.length} fixtures`);
  return sports;
}

// ── HANDLER ───────────────────────────────────────────────────────
exports.handler = async () => {
  try {
    const [shows, sports] = await Promise.all([
      fetchO2Shows(),
      fetchSports(),
    ]);

    return {
      statusCode: 200,
      headers: {
        'Content-Type'                : 'application/json',
        'Access-Control-Allow-Origin' : '*',
        'Cache-Control'               : 'max-age=1800', // cache 30 mins
      },
      body: JSON.stringify({
        shows,
        sports,
        lastUpdated: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('Handler error:', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, shows: [], sports: [] }),
    };
  }
};
