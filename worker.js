// worker.js — Cloudflare Worker backend for CryptoPulse, exclusively.
// Rebuilt clean: every route below is one CryptoPulse's index.html actually
// calls (verified by grepping PULSE_WORKER_URL usage in the live app). Nothing
// else is kept — no unused ETF-flow proxy, no unused headline classifier,
// no leftover routes from other apps that used to share this Worker.
//
// Bindings required (see wrangler.toml): env.AI (Workers AI), env.DB (D1,
// database "sentiment-history").

// ---------- Technical analysis helpers (Ichimoku / moving averages / RSI) ----------
function sma(values, period, endIndex) {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i];
  return sum / period;
}

function ichimokuLine(highs, lows, period, endIndex) {
  if (endIndex - period + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    if (highs[i] > hi) hi = highs[i];
    if (lows[i] < lo) lo = lows[i];
  }
  return (hi + lo) / 2;
}

function rsi(closes, period, endIndex) {
  if (endIndex - period < 0) return null;
  let gains = 0, losses = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Pure evaluation — takes a closes[] array as input rather than fetching it
// itself. This is what lets CryptoPulse supply its own already-fetched price
// data (proven reliable from a real browser) instead of depending on
// Cloudflare Workers reaching CoinGecko, which is rate-limited (429) on a
// shared-IP basis for Workers traffic — not fixable with headers/params.
async function evaluateTechnicalsFromCloses(env, closes) {
  if (closes.length < 200) throw new Error('Historique insuffisant (' + closes.length + ' points)');
  const last = closes.length - 1;
  const currentPrice = closes[last];
  const tenkan = ichimokuLine(closes, closes, 9, last);
  const kijun = ichimokuLine(closes, closes, 26, last);
  const ma50 = sma(closes, 50, last);
  const ma100 = sma(closes, 100, last);
  const ma200 = sma(closes, 200, last);
  const rsi14 = rsi(closes, 14, last);

  const snapshot = `Prix BTC actuel : $${currentPrice.toFixed(0)}
Tenkan (9j) : $${tenkan?.toFixed(0) ?? 'N/A'} — prix ${currentPrice > tenkan ? 'au-dessus' : 'en dessous'}
Kijun (26j) : $${kijun?.toFixed(0) ?? 'N/A'} — prix ${currentPrice > kijun ? 'au-dessus' : 'en dessous'}
MM50 : $${ma50?.toFixed(0) ?? 'N/A'} — prix ${currentPrice > ma50 ? 'au-dessus' : 'en dessous'}
MM100 : $${ma100?.toFixed(0) ?? 'N/A'} — prix ${currentPrice > ma100 ? 'au-dessus' : 'en dessous'}
MM200 : $${ma200?.toFixed(0) ?? 'N/A'} — prix ${currentPrice > ma200 ? 'au-dessus' : 'en dessous'}
RSI(14) : ${rsi14?.toFixed(1) ?? 'N/A'} (>50 = momentum acheteur, <50 = vendeur)`;

  const prompt = `Tu es un analyste technique crypto façon "Foufi" (analyse Ichimoku/moyennes mobiles/RSI).
Voici l'état technique actuel du Bitcoin :

${snapshot}

Donne une évaluation courte (3-4 phrases max) dans ce style : identifie si le prix tient
les niveaux clés (Tenkan/Kijun/MM), commente le RSI par rapport au seuil 50, et conclus sur
un biais général (haussier/baissier/neutre). Termine ta réponse par une ligne exacte au format :
SCORE: X (où X est un entier de -2 très baissier à +2 très haussier).`;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
  });
  const text = typeof result.response === 'string' ? result.response : JSON.stringify(result.response || '');
  const scoreMatch = text.match(/SCORE:\s*(-?\d+)/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

  await env.DB.prepare('INSERT INTO technical_eval (ts, evaluation, score) VALUES (?, ?, ?)')
    .bind(Date.now(), text, score).run();
  await env.DB.prepare(
    'DELETE FROM technical_eval WHERE id NOT IN (SELECT id FROM technical_eval ORDER BY ts DESC LIMIT 100)'
  ).run();
}

// Cron wrapper (2x/day, see wrangler.toml) — best-effort automatic path, still
// tries fetching CoinGecko itself (may occasionally hit the shared-IP rate
// limit). The reliable path is CryptoPulse calling POST /run-technical-eval
// with its own closes[] data — this cron is just a background safety net.
async function runTechnicalEvaluation(env) {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=250', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) throw new Error('CoinGecko market_chart ' + res.status);
    const json = await res.json();
    const closes = (json.prices || []).map(p => p[1]);
    await evaluateTechnicalsFromCloses(env, closes);
  } catch (err) {
    try {
      await env.DB.prepare('INSERT INTO technical_eval (ts, evaluation, score) VALUES (?, ?, ?)')
        .bind(Date.now(), 'ERREUR cron : ' + err.message, null).run();
    } catch (e2) { /* rien de plus à faire */ }
  }
}

// ---------- News RSS proxy (avoids CORS from the browser) ----------
function stripHtml(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function parseRssTitles(xml, sourceName) {
  const items = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of itemMatches) {
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const descMatch = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    if (titleMatch) {
      items.push({
        title: titleMatch[1].trim(),
        description: descMatch ? stripHtml(descMatch[1]).slice(0, 400) : '',
        source: sourceName,
      });
    }
    if (items.length >= 15) break;
  }
  return items;
}

// ---------- Telegram ----------
async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn('Telegram secrets not configured — alert not sent:', text);
    return { ok: false, detail: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret not set on the Worker' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const body = await res.text();
    return { ok: res.ok, detail: res.ok ? 'sent' : `Telegram API ${res.status}: ${body}` };
  } catch (err) {
    console.warn('Telegram send failed:', err.message);
    return { ok: false, detail: 'Network error calling Telegram: ' + err.message };
  }
}

// ---------- Weekly cheap-window analysis (ported from CryptoPulse's client-side
// analyzeWeeklyHeatmap, unchanged logic — needs to run here too since the alert
// cron has no browser to ask) ----------
function analyzeWeeklyHeatmap(prices) {
  const weekKey = ts => { const d = new Date(ts); const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return mon.toDateString(); };
  const weekSum = {};
  prices.forEach(([ts, p]) => { const k = weekKey(ts); (weekSum[k] ??= { s: 0, n: 0 }); weekSum[k].s += p; weekSum[k].n++; });
  const weekAvg = {}; Object.keys(weekSum).forEach(k => weekAvg[k] = weekSum[k].s / weekSum[k].n);
  const cellAgg = {}; const weekMin = {};
  prices.forEach(([ts, p]) => {
    const d = new Date(ts), k = weekKey(ts), rel = p / weekAvg[k] - 1;
    const ck = d.getDay() + '-' + Math.floor(d.getHours() / 3); (cellAgg[ck] ??= { s: 0, n: 0 }); cellAgg[ck].s += rel; cellAgg[ck].n++;
    if (!weekMin[k] || p < weekMin[k].p) weekMin[k] = { p, day: d.getDay() };
  });
  let best = null;
  for (let day = 0; day < 7; day++) {
    for (let block = 0; block < 8; block++) {
      const a = cellAgg[day + '-' + block]; const pct = a && a.n ? (a.s / a.n) * 100 : null;
      if (a && a.n >= 8 && (!best || pct < best.pct)) best = { day, block, pct };
    }
  }
  return best;
}

const CG = 'https://api.coingecko.com/api/v3';
const CG_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', LINK: 'chainlink', HYPE: 'hyperliquid' };
async function fetchCoinGeckoPrice(sym) {
  const id = CG_IDS[sym]; if (!id) return null;
  const res = await fetch(`${CG}/simple/price?ids=${id}&vs_currencies=usd`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error('CoinGecko simple/price ' + res.status);
  const json = await res.json();
  return json[id]?.usd ?? null;
}
async function fetchCoinGecko7dAvgAndWindow(sym) {
  const id = CG_IDS[sym]; if (!id) return null;
  const res = await fetch(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=90`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error('CoinGecko market_chart ' + res.status);
  const json = await res.json();
  const prices = json.prices || [];
  const cutoff = Date.now() - 7 * 86400000;
  const last7d = prices.filter(([ts]) => ts >= cutoff).map(([, p]) => p);
  const avg7d = last7d.length ? last7d.reduce((a, b) => a + b, 0) / last7d.length : null;
  const best = analyzeWeeklyHeatmap(prices);
  return { avg7d, best };
}

// ---------- Main alert evaluator — runs every 15 minutes ----------
async function evaluateAlerts(env) {
  const now = Date.now();
  const { results: configs } = await env.DB.prepare('SELECT * FROM alert_configs WHERE enabled = 1').all();
  if (!configs.length) return;

  // Latest sentiment/technical/gold/funding reading — as fresh as the last time
  // CryptoPulse was opened, not real-time (this was a deliberate, explicit
  // trade-off, not an oversight — see conversation history).
  const { results: latestRows } = await env.DB.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT 1').all();
  const latest = latestRows[0] || null;
  let sources = {};
  try { sources = latest?.sources_json ? JSON.parse(latest.sources_json) : {}; } catch (e) {}

  const priceCache = {}, radarCache = {};
  async function getPrice(sym) { if (!(sym in priceCache)) priceCache[sym] = await fetchCoinGeckoPrice(sym).catch(() => null); return priceCache[sym]; }
  async function getRadar(sym) { if (!(sym in radarCache)) radarCache[sym] = await fetchCoinGecko7dAvgAndWindow(sym).catch(() => null); return radarCache[sym]; }

  // Returns { hit: bool, detail: string } for a single leaf condition (also used
  // to evaluate each side of a combo). Never throws — a data-fetch failure for
  // one leaf just makes that leaf (and any combo using it) not fire this cycle.
  async function evalCondition(type, p) {
    try {
      if (type === 'price') {
        const price = await getPrice(p.coin); if (price == null) return { hit: false };
        const hit = p.direction === 'above' ? price >= p.value : price <= p.value;
        return { hit, detail: `${p.coin} price $${price.toFixed(2)} (target ${p.direction} $${p.value})` };
      }
      if (type === 'radar_discount') {
        const r = await getRadar(p.coin); if (!r || r.avg7d == null) return { hit: false };
        const price = await getPrice(p.coin); if (price == null) return { hit: false };
        const discount = (price - r.avg7d) / r.avg7d * 100;
        const hit = discount <= -Math.abs(p.discountPct);
        return { hit, detail: `${p.coin} is ${discount.toFixed(2)}% vs 7d avg (price $${price.toFixed(2)})` };
      }
      if (type === 'radar_window') {
        const r = await getRadar(p.coin); if (!r || !r.best) return { hit: false };
        const d = new Date();
        const hit = d.getUTCDay() === r.best.day && Math.floor(d.getUTCHours() / 3) === r.best.block;
        return { hit, detail: `${p.coin} historically-cheapest weekly window is open now` };
      }
      if (type === 'score_threshold') {
        const val = p.metric === 'technical' ? latest?.technical_score : p.metric === 'combined'
          ? (latest?.score != null && latest?.technical_score != null ? (latest.score + latest.technical_score) / 2 : null)
          : latest?.score;
        if (val == null) return { hit: false };
        const hit = p.direction === 'above' ? val >= p.value : val <= p.value;
        return { hit, detail: `${p.metric} score is ${val.toFixed(0)} (target ${p.direction} ${p.value})` };
      }
      if (type === 'gold_regime') {
        const hit = latest?.gold_regime === 'competing-haven';
        return { hit, detail: 'Gold regime flipped to competing-haven (gold rising at BTC\u2019s expense)' };
      }
      if (type === 'funding_spike') {
        const val = sources[p.source]; if (val == null) return { hit: false };
        const hit = p.direction === 'above' ? val >= p.value : val <= p.value;
        return { hit, detail: `${p.source} score is ${val} (target ${p.direction} ${p.value})` };
      }
    } catch (err) { return { hit: false }; }
    return { hit: false };
  }

  for (const cfg of configs) {
    let params; try { params = JSON.parse(cfg.params_json); } catch (e) { continue; }
    // ---- Fire-twice-then-disable: an alert fires once, then at most one
    // follow-up exactly FOLLOWUP_MS later if the condition is STILL true,
    // then auto-disables. Replaces the old indefinite cooldown-repeat model,
    // which would re-fire forever (every cooldown_minutes) for as long as a
    // condition stayed true — e.g. a price alert re-firing hourly for days
    // while price just sat above the target. cooldown_minutes is no longer
    // used for repeat gating; kept in the schema only for backward
    // compatibility with existing rows. ----
    const FOLLOWUP_MS = 4 * 60 * 60 * 1000;
    const fireCount = cfg.fire_count || 0;
    if (fireCount >= 2) continue; // already fired twice — stays disabled until manually re-enabled
    if (fireCount === 1 && cfg.last_fired_ts && now - cfg.last_fired_ts < FOLLOWUP_MS) continue; // waiting out the 4h gap before the follow-up

    let hit = false, detail = '';
    if (cfg.type === 'combo') {
      const [a, b] = params.conditions || [];
      if (!a || !b) continue;
      const ra = await evalCondition(a.type, a.params);
      const rb = await evalCondition(b.type, b.params);
      hit = ra.hit && rb.hit;
      detail = [ra.detail, rb.detail].filter(Boolean).join(' AND ');
    } else {
      const r = await evalCondition(cfg.type, params);
      hit = r.hit; detail = r.detail;
    }

    if (hit) {
      const newCount = fireCount + 1;
      const label = newCount === 1 ? '' : ' (follow-up — this alert is now disabled)';
      const message = `\u26a1 <b>CryptoPulse Alert</b>${label}\n${detail}`;
      const sent = await sendTelegram(env, message);
      const stillEnabled = newCount < 2 ? 1 : 0;
      await env.DB.prepare('UPDATE alert_configs SET last_fired_ts = ?, fire_count = ?, enabled = ? WHERE id = ?').bind(now, newCount, stillEnabled, cfg.id).run();
      await env.DB.prepare('INSERT INTO alert_log (ts, config_id, type, message) VALUES (?, ?, ?, ?)')
        .bind(now, cfg.id, cfg.type, detail + label + (sent.ok ? '' : ' [Telegram: ' + sent.detail + ']')).run();
    }
  }
}

// ---------- FRED (Federal Reserve St. Louis) series config, used by /macro-proxy ----------
// Documented here so the meaning of each `series` param CryptoPulse sends is traceable.
const FRED_SERIES_LABELS = {
  DCOILWTICO: 'WTI Oil',
  DGS10: '10Y Treasury Yield',
  DTWEXBGS: 'US Dollar Index (broad)',
  NASDAQCOM: 'Nasdaq Composite',
  SP500: 'S&P 500',
};

export default {
  async scheduled(event, env, ctx) {
    // Two crons share this handler now (see wrangler.toml): "0 6,18 * * *" for
    // the existing technical eval, "*/15 * * * *" for the new alert checker.
    // event.cron tells us which one fired.
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(evaluateAlerts(env));
    } else {
      ctx.waitUntil(runTechnicalEvaluation(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ---- GET /news-proxy?source=crypto|macro|geopolitics|regulatory ----
    if (url.pathname === '/news-proxy' && request.method === 'GET') {
      const source = url.searchParams.get('source');
      try {
        if (source === 'crypto') {
          const res = await fetch('https://cointelegraph.com/rss');
          if (!res.ok) throw new Error('CoinTelegraph ' + res.status);
          const xml = await res.text();
          return new Response(JSON.stringify({ items: parseRssTitles(xml, 'CoinTelegraph') }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (source === 'macro') {
          const res = await fetch('https://www.investing.com/rss/news_14.rss');
          if (!res.ok) throw new Error('Investing.com ' + res.status);
          const xml = await res.text();
          return new Response(JSON.stringify({ items: parseRssTitles(xml, 'Investing.com Economy') }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (source === 'geopolitics') {
          const res = await fetch('https://feeds.bbci.co.uk/news/world/rss.xml');
          if (!res.ok) throw new Error('BBC World ' + res.status);
          const xml = await res.text();
          return new Response(JSON.stringify({ items: parseRssTitles(xml, 'BBC World News') }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (source === 'regulatory') {
          // Both feeds, per explicit choice — crypto-specific regulatory/legislative
          // coverage (Clarity Act, SEC actions, etc.) that the generic macro/
          // geopolitics feeds above aren't focused on catching. Merged and
          // interleaved by index so one feed being briefly down doesn't wipe out
          // the whole source (best-effort per-feed, not all-or-nothing).
          const feeds = [
            { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
            { url: 'https://www.theblock.co/rss.xml', name: 'The Block' },
          ];
          const results = await Promise.allSettled(feeds.map(async f => {
            const res = await fetch(f.url);
            if (!res.ok) throw new Error(f.name + ' ' + res.status);
            return parseRssTitles(await res.text(), f.name);
          }));
          const perFeed = results.map(r => r.status === 'fulfilled' ? r.value : []);
          const merged = [];
          const maxLen = Math.max(...perFeed.map(a => a.length), 0);
          for (let i = 0; i < maxLen; i++) perFeed.forEach(a => { if (a[i]) merged.push(a[i]); });
          if (!merged.length) throw new Error('Both regulatory feeds failed: ' + results.map(r => r.reason?.message).filter(Boolean).join('; '));
          return new Response(JSON.stringify({ items: merged.slice(0, 15) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: 'source doit être crypto, macro, geopolitics ou regulatory' }), { status: 400, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- GET /whale-proxy — Whale Alert mirrors its own feed (same data that
    // costs $29.95-$699/mo via their official API) to a public Telegram
    // channel for free: t.me/s/whale_alert_io. That /s/ path is Telegram's
    // documented public-preview feature (built for embedding), not a scraping
    // workaround — different situation from scraping X, which has no
    // equivalent free/intentional public surface.
    // Parses the alert PATTERN directly out of the page's visible text
    // ("821 $BTC (52,363,952 USD) transferred from #Kraken to unknown
    // wallet") rather than depending on Telegram's exact div/class names —
    // the pattern is confirmed stable (verified against the live page before
    // writing this), the class names are not, and depending on the latter
    // would be the most fragile possible choice for a page with no documented
    // schema. Mint/burn events ("250,000,000 $USDC ... minted at USDC
    // Treasury") and analysis/story posts are deliberately NOT captured —
    // only wallet-to-wallet transfers are a directional flow signal.
    // No per-item timestamp extraction — the preview page only ever returns
    // roughly the last ~20 messages, which is used as-is as "recent" rather
    // than filtered to a precise window; simpler and far more robust than
    // pairing timestamps to messages via fragile positional matching. ----
    if (url.pathname === '/whale-proxy' && request.method === 'GET') {
      try {
        // A default Workers fetch() sends no User-Agent, which can make
        // Telegram (and many sites) serve a stripped-down/empty response
        // instead of the real page — this mimics a normal browser request.
        const res = await fetch('https://t.me/s/whale_alert_io', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (!res.ok) throw new Error('Telegram t.me ' + res.status);
        const html = await res.text();
        const plain = html
          .replace(/<script[\s\S]*?<\/script>/g, ' ')
          .replace(/<style[\s\S]*?<\/style>/g, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          // Generic numeric HTML entity decode (&#36; or &#036; or any other
          // zero-padding — parseInt tolerates leading zeros) instead of
          // hardcoding specific entities one at a time and finding a new bug
          // for each padding variant, which is exactly what happened here.
          .replace(/&#0*(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          .replace(/[ \t]+/g, ' ');
        const re = /([\d,]+(?:\.\d+)?)\s+\$([A-Z0-9]{2,10})\s+\(([\d,]+)\s*USD\)\s+transferred from ([^\n]+?) to ([^\n]+?)(?=\n|$)/g;
        const items = [];
        let m;
        while ((m = re.exec(plain)) !== null && items.length < 50) {
          items.push({
            qty: parseFloat(m[1].replace(/,/g, '')),
            symbol: m[2],
            usd: parseFloat(m[3].replace(/,/g, '')),
            from: m[4].trim().replace(/\s*Details.*$/, ''),
            to: m[5].trim().replace(/\s*Details.*$/, ''),
          });
        }
        // If nothing matched, include a real text sample rather than guess at
        // another regex fix blindly — this shows EXACTLY what the text looks
        // like around a real transfer mention (spacing, hidden characters,
        // unexpected formatting) so the next fix is evidence-based. Char
        // codes (numbers) are included too, immune to any HTML
        // re-interpretation that could silently mislead a text sample alone
        // (exactly what happened with the first attempt at this).
        let debug;
        if (items.length === 0) {
          const idx = plain.indexOf('transferred');
          const sampleAroundTransferred = idx >= 0 ? plain.slice(Math.max(0, idx - 150), idx + 150) : null;
          const tickerMatch = plain.match(/\d\s*.{0,4}(USDT|USDC|BTC|ETH|SOL|LINK)\b/);
          const charsBeforeTicker = tickerMatch
            ? tickerMatch[0].split('').map(c => ({ char: c, code: c.charCodeAt(0) }))
            : null;
          debug = {
            htmlLength: html.length,
            containsTransferredWord: plain.includes('transferred'),
            containsDollarSign: plain.includes('$'),
            sampleAroundTransferred,
            charsBeforeTicker,
          };
        }
        return new Response(JSON.stringify({ items, ...(debug ? { debug } : {}) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- POST /whale-analysis — LLM narration of the whale transfers
    // CryptoPulse already fetched and classified (exchange outflow/inflow).
    // Same rule as /trader-analysis: the Worker only explains numbers it's
    // given, it never computes or invents one. Written for someone with no
    // trading background — explains outflow/inflow in plain terms the first
    // time, flags repeated exchange patterns if present, and is explicitly
    // forbidden from calling this "smart money" or predicting price, since
    // this data has no entity-level attribution and isn't backtested. ----
    if (url.pathname === '/whale-analysis' && request.method === 'POST') {
      try {
        const { transfers } = await request.json();
        if (!Array.isArray(transfers) || !transfers.length) {
          return new Response(JSON.stringify({ error: 'transfers[] requis et non vide' }), { status: 400, headers: corsHeaders });
        }
        const lines = transfers.slice(0, 10).map(t =>
          `${t.symbol} $${(t.usd / 1e6).toFixed(1)}M moved from "${t.from}" to "${t.to}" — classified as ${t.direction === 'outflow' ? 'OUTFLOW (left a named exchange for an unlabeled wallet)' : 'INFLOW (moved from an unlabeled wallet onto a named exchange)'}`
        ).join('\n');
        const prompt = `You are explaining a list of recent large cryptocurrency exchange movements to someone with NO trading background, in the simplest possible everyday language.

DATA (each line is one real transfer that already happened; OUTFLOW/INFLOW labels were already determined, do not recompute or second-guess them):
${lines}

RULES:
- The very first time you use the word "outflow" or "inflow" in your answer, briefly explain what it means in plain words (outflow = coins left an exchange for a private wallet, often read as someone moving funds off the exchange rather than preparing to sell; inflow = coins moved onto an exchange, often read as possible preparation to trade or sell, though it could also just mean depositing for other reasons).
- If two or more transfers involve the SAME exchange name, point that out explicitly as a repeated pattern, since a repeated pattern is more meaningful than one isolated transfer.
- Do NOT call any of this "smart money" — there is no information here about WHO moved these coins, only that a named exchange was on one side.
- Do NOT state or imply that this predicts a future price move. This is not backtested or statistically validated.
- End with one plain sentence reminding the reader that a single transfer usually means very little on its own, and this is background context, not a signal to act on.
- Keep the entire answer to 3-5 short sentences, no jargon, no markdown symbols.`;
        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 350,
        });
        const text = typeof result.response === 'string' ? result.response : JSON.stringify(result.response || '');
        if (!text) throw new Error('Empty model response');
        return new Response(JSON.stringify({ analysis: text.trim(), ts: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /history — sentiment + technical score history for the combined chart ----
    if (url.pathname === '/history' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT ts, score, technical_score as technicalScore, btc_price as btc, gold_regime as goldRegime, sources_json FROM history ORDER BY ts DESC LIMIT 500'
        ).all();
        return new Response(JSON.stringify({ history: results.reverse() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /history — log one snapshot point (sentiment, technical, price, sources) ----
    if (url.pathname === '/history' && request.method === 'POST') {
      try {
        const { score, technicalScore, btcPrice, sources, goldRegime } = await request.json();
        if (typeof score !== 'number') {
          return new Response(JSON.stringify({ error: 'score (number) requis' }), { status: 400, headers: corsHeaders });
        }
        const now = Date.now();
        await env.DB.prepare('INSERT INTO history (ts, score, technical_score, btc_price, gold_regime, sources_json) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(now, score, typeof technicalScore === 'number' ? technicalScore : null, btcPrice ?? null, goldRegime ?? null, sources ? JSON.stringify(sources) : null).run();
        await env.DB.prepare(
          'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC LIMIT 500)'
        ).run();
        return new Response(JSON.stringify({ ok: true, ts: now }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /backfill-sources — patch specific source values onto EXISTING
    // history rows, matched by exact ts. Used for retroactively filling in a
    // newly-added source (e.g. gold) or a source that changed data provider
    // partway through (e.g. usd moving from FRED to Hyperliquid) — computed
    // client-side from real historical price data, never invented. Only the
    // named keys are touched; everything else in that row's sources_json (and
    // the row's own score/technical_score/btc_price) is left exactly as-is. ----
    if (url.pathname === '/backfill-sources' && request.method === 'POST') {
      try {
        const { updates } = await request.json();
        if (!Array.isArray(updates)) {
          return new Response(JSON.stringify({ error: 'updates[] requis' }), { status: 400, headers: corsHeaders });
        }
        let rowsPatched = 0;
        for (const u of updates) {
          if (!u || typeof u.ts !== 'number' || !u.patch || typeof u.patch !== 'object') continue;
          for (const [key, val] of Object.entries(u.patch)) {
            if (typeof val !== 'number') continue;
            await env.DB.prepare(
              "UPDATE history SET sources_json = json_set(COALESCE(sources_json,'{}'), '$.' || ?, ?) WHERE ts = ?"
            ).bind(key, val, u.ts).run();
          }
          rowsPatched++;
        }
        return new Response(JSON.stringify({ ok: true, rowsPatched }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ═══ Alerts system ═══ — config CRUD, log read, and a manual test-send.
    // The actual checking happens in evaluateAlerts() on the 15-min cron above;
    // these routes just let CryptoPulse manage what to check.

    // ---- GET /alert-configs — list all (enabled + disabled) ----
    if (url.pathname === '/alert-configs' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare('SELECT * FROM alert_configs ORDER BY created_ts DESC').all();
        return new Response(JSON.stringify({ configs: results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /alert-configs — create a new alert ----
    if (url.pathname === '/alert-configs' && request.method === 'POST') {
      try {
        const { type, params, cooldownMinutes } = await request.json();
        const validTypes = ['price', 'radar_discount', 'radar_window', 'score_threshold', 'gold_regime', 'funding_spike', 'combo'];
        if (!validTypes.includes(type)) {
          return new Response(JSON.stringify({ error: 'type invalide' }), { status: 400, headers: corsHeaders });
        }
        const now = Date.now();
        const res = await env.DB.prepare(
          'INSERT INTO alert_configs (type, enabled, params_json, cooldown_minutes, created_ts) VALUES (?, 1, ?, ?, ?)'
        ).bind(type, JSON.stringify(params || {}), cooldownMinutes || 60, now).run();
        return new Response(JSON.stringify({ ok: true, id: res.meta.last_row_id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /alert-configs/toggle {id, enabled} ----
    if (url.pathname === '/alert-configs/toggle' && request.method === 'POST') {
      try {
        const { id, enabled } = await request.json();
        // Re-enabling resets fire_count so the alert gets a fresh
        // fire-once-then-followup-then-disable cycle, rather than
        // immediately re-disabling itself next cron tick because it had
        // already used both of its fires from before.
        if (enabled) {
          await env.DB.prepare('UPDATE alert_configs SET enabled = 1, fire_count = 0, last_fired_ts = NULL WHERE id = ?').bind(id).run();
        } else {
          await env.DB.prepare('UPDATE alert_configs SET enabled = 0 WHERE id = ?').bind(id).run();
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /alert-configs/delete {id} ----
    if (url.pathname === '/alert-configs/delete' && request.method === 'POST') {
      try {
        const { id } = await request.json();
        await env.DB.prepare('DELETE FROM alert_configs WHERE id = ?').bind(id).run();
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /alert-log?limit=50 — recently fired alerts ----
    if (url.pathname === '/alert-log' && request.method === 'GET') {
      try {
        const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10));
        const { results } = await env.DB.prepare('SELECT * FROM alert_log ORDER BY ts DESC LIMIT ?').bind(limit).all();
        return new Response(JSON.stringify({ log: results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /test-telegram — manual send, to verify secrets are configured right ----
    if (url.pathname === '/test-telegram' && request.method === 'POST') {
      const sent = await sendTelegram(env, '\u2705 CryptoPulse alerts are wired up correctly. This is a test message.');
      return new Response(JSON.stringify(sent), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- GET /analysis?lagHours=24 — Pearson correlation, sentiment -> future BTC move ----
    if (url.pathname === '/analysis' && request.method === 'GET') {
      try {
        function pearson(xs, ys) {
          const n = xs.length;
          if (n < 2) return null;
          const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
          let num = 0, dx2 = 0, dy2 = 0;
          for (let i = 0; i < n; i++) {
            const dx = xs[i] - mx, dy = ys[i] - my;
            num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
          }
          const denom = Math.sqrt(dx2 * dy2);
          return denom === 0 ? null : num / denom;
        }
        function buildPairs(scoreExtractor) {
          const xs = [], ys = [];
          for (let i = 0; i < results.length; i++) {
            const p = results[i];
            if (p.btc == null) continue;
            const targetTs = p.ts + lagMs;
            let best = null, bestDiff = Infinity;
            for (let j = i + 1; j < results.length; j++) {
              if (results[j].btc == null) continue;
              const diff = Math.abs(results[j].ts - targetTs);
              if (diff < bestDiff) { bestDiff = diff; best = results[j]; }
            }
            if (!best || bestDiff > lagMs * 0.2) continue;
            const futureReturn = (best.btc - p.btc) / p.btc * 100;
            const score = scoreExtractor(p);
            if (score == null) continue;
            xs.push(score); ys.push(futureReturn);
          }
          return { xs, ys };
        }

        const lagHours = parseFloat(url.searchParams.get('lagHours') || '24');
        const lagMs = lagHours * 60 * 60 * 1000;
        const { results } = await env.DB.prepare(
          'SELECT ts, score, technical_score as technicalScore, btc_price as btc, sources_json FROM history ORDER BY ts ASC'
        ).all();

        if (results.length < 20) {
          return new Response(JSON.stringify({
            insufficientData: true,
            pointsAvailable: results.length,
            message: `Seulement ${results.length} points disponibles — au moins 20 recommandés, idéalement plusieurs jours, pour un résultat fiable.`,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const composite = buildPairs(p => p.score);
        const compositeCorr = pearson(composite.xs, composite.ys);
        // Technical score correlation — only present for points recorded since
        // technical_score started being sent (older rows have it as null, and
        // buildPairs already skips any point where the extractor returns null).
        const technical = buildPairs(p => p.technicalScore);
        const technicalCorr = pearson(technical.xs, technical.ys);
        const sourceIds = new Set();
        results.forEach(p => {
          if (p.sources_json) {
            try { Object.keys(JSON.parse(p.sources_json)).forEach(id => sourceIds.add(id)); } catch (e) {}
          }
        });
        const perSource = {};
        sourceIds.forEach(id => {
          const pairs = buildPairs(p => {
            if (!p.sources_json) return null;
            try { return JSON.parse(p.sources_json)[id] ?? null; } catch (e) { return null; }
          });
          perSource[id] = { correlation: pearson(pairs.xs, pairs.ys), samples: pairs.xs.length };
        });

        return new Response(JSON.stringify({
          lagHours,
          pointsTotal: results.length,
          compositeSamples: composite.xs.length,
          compositeCorrelation: compositeCorr,
          technicalSamples: technical.xs.length,
          technicalCorrelation: technicalCorr,
          perSourceCorrelation: perSource,
          interpretation: 'Corrélation proche de +1 = la source précède bien une hausse future du prix. Proche de -1 = précède une baisse (contrarian). Proche de 0 = pas de lien détecté. Avec peu de jours de données, ces chiffres restent peu fiables statistiquement — à revérifier après accumulation.',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /macro-proxy?series=DGS10&key=XXX&limit=5 — FRED proxy (avoids CORS) ----
    if (url.pathname === '/macro-proxy' && request.method === 'GET') {
      const series = url.searchParams.get('series');
      const key = url.searchParams.get('key');
      // Optional, defaults to 5 (unchanged behavior for existing callers) — a
      // caller wanting a real multi-week trend (e.g. sector-rotation) instead
      // of just the latest-vs-previous pair can request more, capped at 90 to
      // keep this a small proxy call, not a bulk data dump.
      const limit = Math.min(90, Math.max(2, parseInt(url.searchParams.get('limit') || '5', 10) || 5));
      if (!series || !key) {
        return new Response(JSON.stringify({ error: 'series et key requis' }), { status: 400, headers: corsHeaders });
      }
      try {
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`;
        // cf.cacheTtl:0 + cacheEverything:false: force Cloudflare's edge to
        // never cache this specific outbound request to FRED. Without this,
        // oil (DCOILWTICO) and usd (DTWEXBGS) were observed returning the
        // exact same value on every single reading for days — confirmed via
        // real-world price data showing genuine daily moves of -0.9% to -1.8%
        // that never showed up in our numbers. Root cause: an edge cache hit
        // on this exact outbound URL (series_id+api_key never change between
        // polls), serving stale bytes instead of a fresh FRED response.
        const res = await fetch(fredUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
        if (!res.ok) throw new Error('FRED ' + res.status);
        const json = await res.json();
        const obs = (json.observations || []).filter(o => o.value !== '.'); // FRED utilise "." pour les valeurs manquantes
        return new Response(JSON.stringify({ observations: obs, series: FRED_SERIES_LABELS[series] || series }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- GET /run-technical-eval — on-demand trigger, Worker fetches CoinGecko itself.
    //      Kept as a fallback/manual-test path; can hit the shared-IP rate limit — prefer POST. ----
    if (url.pathname === '/run-technical-eval' && request.method === 'GET') {
      await runTechnicalEvaluation(env);
      try {
        const { results } = await env.DB.prepare('SELECT ts, evaluation, score FROM technical_eval ORDER BY ts DESC LIMIT 1').all();
        return new Response(JSON.stringify({ latest: results[0] || null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /run-technical-eval — reliable path: CryptoPulse supplies its own closes[] ----
    if (url.pathname === '/run-technical-eval' && request.method === 'POST') {
      try {
        const { closes } = await request.json();
        if (!Array.isArray(closes) || closes.length < 200) {
          return new Response(JSON.stringify({ error: 'closes[] (200+ points) requis' }), { status: 400, headers: corsHeaders });
        }
        await evaluateTechnicalsFromCloses(env, closes);
        const { results } = await env.DB.prepare('SELECT ts, evaluation, score FROM technical_eval ORDER BY ts DESC LIMIT 1').all();
        return new Response(JSON.stringify({ latest: results[0] || null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /technical-eval — read the latest stored evaluation (no recompute) ----
    if (url.pathname === '/technical-eval' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare('SELECT ts, evaluation, score FROM technical_eval ORDER BY ts DESC LIMIT 1').all();
        return new Response(JSON.stringify({ latest: results[0] || null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /trader-analysis — LLM synthesis across everything CryptoPulse already
    //      computed itself (composite, per-source correlations, technicals, probability
    //      model, buy-the-news mechanisms). This route never computes its own numbers —
    //      it only narrates the ones it's given. ----
    if (url.pathname === '/trader-analysis' && request.method === 'POST') {
      try {
        const data = await request.json();
        const fmt = (v, d = 2) => v == null ? 'N/A' : (typeof v === 'number' ? v.toFixed(d) : String(v));
        const sourcesLines = Object.entries(data.sentiment?.sources || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
        const corrLines = Object.entries(data.sourceCorrelations?.perSourceCorrelation || data.sourceCorrelations?.perSource || {})
          .map(([k, v]) => `  ${k}: ${fmt(v && typeof v === 'object' ? v.correlation : v)}`).join('\n');
        const t = data.technicals || {};
        const pm = data.probabilityModel || {};
        const btn = data.buyTheNews || {};

        const dataBlock = `PRICE: $${fmt(data.price, 0)}

SENTIMENT - composite: ${fmt(data.sentiment?.composite, 0)}/100
Raw sources:
${sourcesLines || '  (none)'}

SOURCE-VS-BTC CORRELATION (composite: ${fmt(data.sourceCorrelations?.compositeCorrelation)})
${corrLines || '  (none)'}

TECHNICALS
Tenkan: $${fmt(t.tenkan, 0)} - Kijun: $${fmt(t.kijun, 0)} - MA50: $${fmt(t.ma50, 0)} - MA100: $${fmt(t.ma100, 0)} - MA200: $${fmt(t.ma200, 0)}
RSI(14): ${fmt(t.rsi14, 1)}
Ichimoku Cloud: ${t.cloud?.position || 'N/A'} (Senkou A $${fmt(t.cloud?.senkouA, 0)} / B $${fmt(t.cloud?.senkouB, 0)})
Volume: ${t.volume?.trend || 'N/A'}
MA Crossover: ${t.maCrossover?.type ? `${t.maCrossover.type} cross, ${t.maCrossover.daysAgo} day(s) ago` : 'none in window'}
Swing structure: ${t.swingStructure || 'N/A'}
RSI/Price divergence: ${t.divergence?.type || 'none'}

PROBABILITY MODEL (frequency-based, NOT a guess)
${pm.insufficient ? `Insufficient data (${pm.n || 0} matches) - do not state a probability, say so plainly.` : `${Math.round((pm.probUp || 0) * 100)}% of ${pm.n} historically comparable day(s) (bucket ${pm.bucket}-${(pm.bucket || 0) + 20}) saw BTC higher 7 days later.`}

BUY THE NEWS VS PRICED IN
Mechanism 1 (actual vs typical reaction): sentiment shift ${fmt(btn.reaction?.sentimentShift, 1)}, actual move ${fmt(btn.reaction?.actualPriceChange)}%, typical move for similar shifts ${fmt(btn.reaction?.typicalChange)}%. Read: ${btn.reaction?.read || 'insufficient data'}
Mechanism 2 (multi-lag correlation pattern): ${(btn.lagPattern?.corrs || []).map(c => `${c.lag}h=${fmt(c.corr)}`).join(', ') || 'insufficient data'}. Read: ${btn.lagPattern?.read || 'insufficient data'}

REGIME SCORECARD (from the Cycles tab — only present if that tab was visited this session; if absent, do not speculate about it)
${data.regimeScorecard ? `Overall: ${data.regimeScorecard.bullCount}/${data.regimeScorecard.total} bullish, ${data.regimeScorecard.bearCount}/${data.regimeScorecard.total} bearish - ${data.regimeScorecard.overallLabel}
Short-term (days): ${(data.regimeScorecard.shortTerm || []).map(f => `${f.label}=${f.display} (${f.tag})`).join(', ')}
Medium-term (weeks): ${(data.regimeScorecard.midTerm || []).map(f => `${f.label}=${f.display} (${f.tag})`).join(', ')}
Long-term (months+): ${(data.regimeScorecard.longTerm || []).map(f => `${f.label}=${f.display} (${f.tag})`).join(', ')}
EVENT CALENDAR (CONFIDENCE MODIFIER ONLY — this does not vote bullish or bearish, it only affects how much weight to put on the short-term reads above): ${data.regimeScorecard.eventCalendar?.daysUntilFOMC != null ? `FOMC decision in ${data.regimeScorecard.eventCalendar.daysUntilFOMC} day(s).${data.regimeScorecard.eventCalendar.confidenceReduced ? ' This is close enough that short-term reads may just be pre-FOMC positioning, not organic trend — say so explicitly, do not treat this as bullish or bearish.' : ''}` : 'No FOMC date data available.'}` : 'Not available this session.'}

ON-CHAIN VS PRICE (CoinMetrics active addresses, 30d trend, vs BTC price trend over the same window)
${data.onChainDivergence ? `${data.onChainDivergence.label} (on-chain slope ${fmt(data.onChainDivergence.onchainSlope, 4)}, price slope ${fmt(data.onChainDivergence.priceSlope, 4)})` : 'Not available this session.'}

SECTOR ROTATION (BTC's own 30d trend vs Nasdaq's 30d trend, normalized so scale doesn't matter — distinguishes "crypto-specific weakness" from "broad risk-off that's hitting everything")
${data.sectorRotation ? `${data.sectorRotation.label} (BTC trend ${fmt(data.sectorRotation.btcSlope * 100, 3)}%/day, Nasdaq trend ${fmt(data.sectorRotation.nasdaqSlope * 100, 3)}%/day)` : 'Not available this session.'}

TECHNICAL TIMEFRAME ALIGNMENT (50-WEEK EMA — a roughly one-year structural level, distinct from the 50/100/200-DAY technicals above which answer a near-term question)
${data.technicalAlignment ? `${data.technicalAlignment.label} (price $${fmt(data.technicalAlignment.price, 0)} vs 50wk EMA $${fmt(data.technicalAlignment.ema50, 0)})` : 'Not available this session.'}

TOP HEADLINES (individual news items behind the sentiment sources above, ranked by how strongly each one scored — NOT the same as the aggregate source numbers; these are the specific real headlines driving them)
${(data.topHeadlines || []).length ? data.topHeadlines.map(h => `  [${h.category}, score ${fmt(h.score, 0)}] "${h.title}"`).join('\n') : '  (none available this cycle)'}`;

        const prompt = `You are an experienced crypto trader writing a short, clear BTC market read for someone who wants to understand it in one pass, not decode jargon. You must use the exact numbers given - every value below was already calculated; do not compute, estimate, or invent any number not explicitly provided.

CRITICAL RULES:
- RSI(14) interpretation: only call it "overbought" if it is ABOVE 70, and only "oversold" if BELOW 30. A value between 50-70 is healthy bullish momentum, NOT overbought — do not mislabel it. Between 30-50 is bearish momentum, NOT oversold.
- If a field says "insufficient data", "N/A", or "Not available": state that plainly ONCE, then move on. Do NOT follow it with a fabricated claim about that same topic (e.g. never say "not available, but it's probably above X" — if it's not available, you have nothing to say about X, full stop).
- Never use the internal labels "Mechanism 1" or "Mechanism 2" in your output — translate them into plain questions instead: mechanism 1 (actual vs. typical reaction) becomes something like "has this already been priced in?"; mechanism 2 (multi-lag correlation) becomes something like "is the effect still unfolding?".
- If a conflict exists between timeframes (short/medium/long-term, or between the regime scorecard's columns), name it explicitly and explain briefly why it might be happening (e.g. crypto-native flows vs. broader macro correlation) rather than just listing both sides.
- The event calendar (FOMC proximity) is a CONFIDENCE modifier only — it tempers how much weight to put on short-term reads, it is never itself bullish or bearish.
- If sector rotation shows BTC underperforming Nasdaq, say plainly that this looks like capital rotating away from crypto specifically, not generic risk-off.
- For the Geopolitical & Macro Drivers section: use ONLY the headlines listed in TOP HEADLINES, verbatim topic (you may paraphrase the headline briefly, do not invent an event not present in that list). Pick the 3 to 5 with the largest |score|. For each, give the headline's topic in a few words and one sentence on why it plausibly matters for BTC (e.g. risk-off/risk-on transmission, inflation/rate-cut expectations, dollar strength, haven demand) — do not assert a causal price move you weren't given data for. If TOP HEADLINES is empty or says "(none available this cycle)", say plainly that no headline-level detail was available this cycle and do not invent any events.

OUTPUT FORMAT — plain text, no markdown symbols (no #, **, |, >, since this displays as raw text, not rendered markdown), structured with blank lines between sections exactly like this:

[One or two sentence summary: current price, overall lean, and the single biggest reason why.]

Sentiment & drivers: [2-3 sentences on composite score, which raw sources are pulling it up or down, and what that implies.]

Technicals: [2-3 sentences on RSI/MAs/Ichimoku/divergence/structure, using the correct RSI interpretation above.]

Geopolitical & Macro Drivers: [3 to 5 bullet-style lines (use a leading dash, not a markdown bullet), each naming one headline topic from TOP HEADLINES and one sentence on its plausible market impact. If none available, say so plainly in one sentence instead of a list.]

Timeframe breakdown:
Short-term (7d): [outlook] - [one-line reason, mention the FOMC confidence caveat here if relevant]
Medium-term (30-50d): [outlook] - [one-line reason]
Long-term: [outlook, or "not enough data yet" if genuinely unavailable] - [one-line reason if available]

Key takeaway: [one sentence synthesizing everything above into the single most useful thing to know right now.]

DATA:
${dataBlock}`;

        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 650,
        });
        const text = typeof result.response === 'string' ? result.response : JSON.stringify(result.response || '');
        if (!text) throw new Error('Réponse vide du modèle');
        return new Response(JSON.stringify({ analysis: text.trim(), ts: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- Anything else: not a route this Worker serves ----
    return new Response(JSON.stringify({ error: 'Not found. This Worker serves CryptoPulse only.' }), { status: 404, headers: corsHeaders });
  },
};
