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
    ctx.waitUntil(runTechnicalEvaluation(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ---- GET /news-proxy?source=crypto|macro|geopolitics ----
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
        return new Response(JSON.stringify({ error: 'source doit être crypto, macro ou geopolitics' }), { status: 400, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- GET /history — sentiment + technical score history for the combined chart ----
    if (url.pathname === '/history' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT ts, score, technical_score as technicalScore, btc_price as btc, sources_json FROM history ORDER BY ts DESC LIMIT 500'
        ).all();
        return new Response(JSON.stringify({ history: results.reverse() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /history — log one snapshot point (sentiment, technical, price, sources) ----
    if (url.pathname === '/history' && request.method === 'POST') {
      try {
        const { score, technicalScore, btcPrice, sources } = await request.json();
        if (typeof score !== 'number') {
          return new Response(JSON.stringify({ error: 'score (number) requis' }), { status: 400, headers: corsHeaders });
        }
        const now = Date.now();
        await env.DB.prepare('INSERT INTO history (ts, score, technical_score, btc_price, sources_json) VALUES (?, ?, ?, ?, ?)')
          .bind(now, score, typeof technicalScore === 'number' ? technicalScore : null, btcPrice ?? null, sources ? JSON.stringify(sources) : null).run();
        await env.DB.prepare(
          'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC LIMIT 500)'
        ).run();
        return new Response(JSON.stringify({ ok: true, ts: now }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
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
          'SELECT ts, score, btc_price as btc, sources_json FROM history ORDER BY ts ASC'
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
          perSourceCorrelation: perSource,
          interpretation: 'Corrélation proche de +1 = la source précède bien une hausse future du prix. Proche de -1 = précède une baisse (contrarian). Proche de 0 = pas de lien détecté. Avec peu de jours de données, ces chiffres restent peu fiables statistiquement — à revérifier après accumulation.',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /macro-proxy?series=DGS10&key=XXX — FRED proxy (avoids CORS) ----
    if (url.pathname === '/macro-proxy' && request.method === 'GET') {
      const series = url.searchParams.get('series');
      const key = url.searchParams.get('key');
      if (!series || !key) {
        return new Response(JSON.stringify({ error: 'series et key requis' }), { status: 400, headers: corsHeaders });
      }
      try {
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=5`;
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
          .map(([k, v]) => `  ${k}: ${fmt(typeof v === 'object' ? v.correlation : v)}`).join('\n');
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
Mechanism 2 (multi-lag correlation pattern): ${(btn.lagPattern?.corrs || []).map(c => `${c.lag}h=${fmt(c.corr)}`).join(', ') || 'insufficient data'}. Read: ${btn.lagPattern?.read || 'insufficient data'}`;

        const prompt = `You are an experienced crypto trader synthesizing the data below into a short, plain-spoken read for BTC. You must use the exact numbers given - every value below was already calculated; do not compute, estimate, or invent any number not explicitly provided. If a field says "insufficient data" or "N/A", say so plainly rather than guessing or filling in a plausible-sounding figure. Reference specific numbers from the data (e.g. name the actual RSI value, the actual probability, which specific source correlations stand out) rather than vague generalities. 3-4 sentences, trader language, no hedging filler, no financial advice disclaimers (the app shows those separately).

DATA:
${dataBlock}`;

        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
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
