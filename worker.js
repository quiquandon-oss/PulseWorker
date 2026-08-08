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
async function evaluateTechnicalsFromCloses(env, closes, extended) {
  if (closes.length < 200) throw new Error('Insufficient history (' + closes.length + ' points)');
  const last = closes.length - 1;
  const currentPrice = closes[last];
  const tenkan = ichimokuLine(closes, closes, 9, last);
  const kijun = ichimokuLine(closes, closes, 26, last);
  const ma50 = sma(closes, 50, last);
  const ma100 = sma(closes, 100, last);
  const ma200 = sma(closes, 200, last);
  const rsi14 = rsi(closes, 14, last);

  let snapshot = `Current BTC price: $${currentPrice.toFixed(0)}
Tenkan (9d): $${tenkan?.toFixed(0) ?? 'N/A'} — price ${currentPrice > tenkan ? 'above' : 'below'}
Kijun (26d): $${kijun?.toFixed(0) ?? 'N/A'} — price ${currentPrice > kijun ? 'above' : 'below'}
MA50: $${ma50?.toFixed(0) ?? 'N/A'} — price ${currentPrice > ma50 ? 'above' : 'below'}
MA100: $${ma100?.toFixed(0) ?? 'N/A'} — price ${currentPrice > ma100 ? 'above' : 'below'}
MA200: $${ma200?.toFixed(0) ?? 'N/A'} — price ${currentPrice > ma200 ? 'above' : 'below'}
RSI(14): ${rsi14?.toFixed(1) ?? 'N/A'} (>50 = buyer momentum, <50 = seller momentum)`;

  // Extended indicators — pre-computed client-side by CryptoPulse (not
  // recomputed here, avoiding duplicate logic in two languages). Optional:
  // gracefully omitted from the prompt if not supplied (e.g. an older
  // client, or the GET fallback trigger path).
  if (extended) {
    const fmtPct = (p) => {
      if (!p || p.prob == null) return 'insufficient data';
      const pct = Math.round(p.prob * 100);
      const base = p.baseline != null ? Math.round(p.baseline * 100) : null;
      return `${pct}%${base != null ? ` (baseline ${base}%)` : ''}, n=${p.n}`;
    };
    const lines = [];
    if (extended.macd && extended.macd.histogram != null) {
      lines.push(`MACD: histogram ${extended.macd.histogram > 0 ? 'positive' : 'negative'} (${extended.macd.histogram.toFixed(0)})`);
    }
    if (extended.bollinger && extended.bollinger.upper != null) {
      const pctB = (currentPrice - extended.bollinger.lower) / (extended.bollinger.upper - extended.bollinger.lower);
      lines.push(`Bollinger Bands: price at ${Math.round(pctB * 100)}% of the band (0%=lower, 100%=upper)`);
    }
    if (extended.obv && extended.obv.confirming != null) {
      lines.push(`OBV (60d): ${extended.obv.confirming ? 'confirms' : 'diverges from'} the price trend`);
    }
    if (extended.kumoTwist && extended.kumoTwist.type) {
      lines.push(`Kumo Twist: ${extended.kumoTwist.type} crossover (${extended.kumoTwist.daysAgo}d${extended.kumoTwist.daysAgo < 0 ? ', upcoming' : ' ago'})`);
    }
    if (extended.probRsiExtreme) {
      if (extended.probRsiExtreme.overbought?.n >= 5) lines.push(`History: after RSI>70, price fell back ${fmtPct(extended.probRsiExtreme.overbought)}`);
      if (extended.probRsiExtreme.oversold?.n >= 5) lines.push(`History: after RSI<30, price rose ${fmtPct(extended.probRsiExtreme.oversold)}`);
    }
    if (extended.probSwing) {
      if (extended.probSwing.uptrend?.n >= 5) lines.push(`History: uptrend structure → up in 14d ${fmtPct(extended.probSwing.uptrend)}`);
      if (extended.probSwing.downtrend?.n >= 5) lines.push(`History: downtrend structure → up in 14d ${fmtPct(extended.probSwing.downtrend)}`);
    }
    if (lines.length) snapshot += `\n${lines.join('\n')}`;
  }

  const prompt = `You are a crypto technical analyst in the "Foufi" style (Ichimoku/moving averages/RSI/MACD/Bollinger/OBV analysis).
Here is Bitcoin's current technical state, including real historical probabilities calculated
over the last 365 days (with their baseline reference and sample size n — a small n
is not statistically reliable, mention this if n<10):

${snapshot}

Give a short evaluation (4-5 sentences max) in this style: identify whether price is holding
key levels (Tenkan/Kijun/MA), comment on RSI and MACD, mention the historical probabilities
ONLY if they have a decent sample (n>=10) and a clear gap from their baseline, and conclude with
an overall bias (bullish/bearish/neutral). Never present a low-sample probability as a certainty.
End your response with an exact line in this format:
SCORE: X (where X is an integer from -2 very bearish to +2 very bullish).`;

  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 450,
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

// ---------- Trader Analysis: shared data-block builder + prompt rules ----------
// Extracted so BOTH /trader-analysis (fast Llama, constrained purely to
// given numbers) and /trader-analysis-gemini (Gemini, same numbers PLUS
// permission to supplement with its own broader knowledge) work from
// byte-identical data and byte-identical correction rules — genuinely
// comparable independent reads of the same snapshot, not two differently-
// scoped analyses that happen to look similar.
function buildTraderAnalysisDataBlock(data) {
  const fmt = (v, d = 2) => v == null ? 'N/A' : (typeof v === 'number' ? v.toFixed(d) : String(v));
  const sourcesLines = Object.entries(data.sentiment?.sources || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const corrLines = Object.entries(data.sourceCorrelations?.perSourceCorrelation || data.sourceCorrelations?.perSource || {})
    .map(([k, v]) => `  ${k}: ${fmt(v && typeof v === 'object' ? v.correlation : v)}`).join('\n');
  const t = data.technicals || {};
  const pm = data.probabilityModel || {};
  const btn = data.buyTheNews || {};
  const lc = data.liquidationClusters || null;
  const distPct = (target, live) => (target == null || live == null) ? null : ((target / live - 1) * 100);
  let liqLines = 'Not available this session.';
  if (lc) {
    const distAbove = distPct(lc.nextClusterAbove, lc.livePrice);
    const distBelow = distPct(lc.nextClusterBelow, lc.livePrice);
    const aboveTxt = lc.nextClusterAbove != null
      ? `Next cluster ABOVE: $${fmt(lc.nextClusterAbove, 0)} (${fmt(Math.abs(distAbove), 1)}% higher). Modeled P(reach within ${lc.horizonDays}-day horizon) = ${Math.round((lc.probAbove || 0) * 100)}%. ${lc.calibrationAbove ? `Historically, similar predictions have actually hit ${Math.round(lc.calibrationAbove.empiricalRate * 100)}% of the time (${lc.calibrationAbove.count} comparable past case(s)).` : "Not enough resolved history yet to check this model's accuracy."}`
      : 'No cluster above within range.';
    const belowTxt = lc.nextClusterBelow != null
      ? `Next cluster BELOW: $${fmt(lc.nextClusterBelow, 0)} (${fmt(Math.abs(distBelow), 1)}% lower). Modeled P(reach within ${lc.horizonDays}-day horizon) = ${Math.round((lc.probBelow || 0) * 100)}%. ${lc.calibrationBelow ? `Historically, similar predictions have actually hit ${Math.round(lc.calibrationBelow.empiricalRate * 100)}% of the time (${lc.calibrationBelow.count} comparable past case(s)).` : "Not enough resolved history yet to check this model's accuracy."}`
      : 'No cluster below within range.';
    const crowdTxt = lc.crowded
      ? `${lc.crowdedSide === 'long' ? 'Longs' : 'Shorts'} are crowded today, nearest relevant level about ${fmt(lc.nearestDistPct, 1)}% away.`
      : 'Crowding is balanced today, neither side is more exposed than the other.';
    const monthlyTxt = lc.monthly
      ? `This crowding direction has been dominant in ${lc.monthly.pct}% of the last ${lc.monthly.count} logged reading(s).`
      : 'Not enough logged history yet to say if this crowding direction is new or sustained over time.';
    liqLines = `${aboveTxt}\n${belowTxt}\n${crowdTxt} ${monthlyTxt}`;
  }
  const wa = data.whaleActivity || null;
  let waLines = null;
  if (wa) {
    const c = wa.concentration || {};
    const flagsTxt = (c.flags || []).map(f => f.type === 'concentration'
      ? `${f.count} transfers concentrated at ${f.exchange}`
      : `bidirectional flow at ${f.exchange} (in $${((f.inflowUsd || 0) / 1e6).toFixed(1)}M / out $${((f.outflowUsd || 0) / 1e6).toFixed(1)}M)`
    ).join('; ') || 'none flagged';
    const topTxt = (wa.transfers || []).slice(0, 5).map(tr =>
      `  ${tr.symbol} $${(tr.usd / 1e6).toFixed(1)}M ${tr.direction === 'outflow' ? 'OUT of' : 'INTO'} an exchange (${tr.from} -> ${tr.to})`
    ).join('\n');
    waLines = `Total tracked transfer volume this snapshot: $${((c.totalUsd || 0) / 1e6).toFixed(1)}M${c.highVolume ? ' (above the disclosed high-volume floor)' : ''}.
Pattern flags: ${flagsTxt}.
Largest transfers:
${topTxt || '  (none)'}`;
  }

  const nm = data.nineMagFlags || [];
  const nineMagLines = nm.length ? nm.map(f =>
    `  ${f.sym} (${f.name}) moved ${f.pct >= 0 ? '+' : ''}${fmt(f.pct, 1)}% today.${f.headline ? ` Headline found: "${f.headline}".` : ' No headline found for this move.'}`
  ).join('\n') : null;

  return `PRICE: $${fmt(data.price, 0)}

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

LIQUIDATION CLUSTERS (Hyperliquid-modeled, BTC-focused - only present if the Liquidation tab was visited this session with BTC focused; if absent, do not mention liquidation clusters at all)
${liqLines}

WHALE ACTIVITY (large exchange-flow transfers - only ever present when high current volatility has been detected client-side; if absent, do NOT mention whale activity, volatility being high or low, or speculate about either)
${waLines || 'Not applicable right now - high volatility not currently detected, or whale data not fetched this session.'}

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
${(data.topHeadlines || []).length ? data.topHeadlines.map(h => `  [${h.category}, score ${fmt(h.score, 0)}] "${h.title}"`).join('\n') : '  (none available this cycle)'}

9 MAGNIFICENT COMPANY MOVES (individual stock moves large enough to trigger a targeted news check — only present when at least one of the 9 tracked companies moved beyond +/-3.5% today; absent means none crossed that threshold this cycle)
${nineMagLines || 'Not applicable — no individual company move crossed the threshold today.'}`;
}
// Shared correction rules — identical for both models. Numbered list kept
// as one string so both prompts interpolate the exact same text rather
// than two hand-maintained copies that could silently drift apart.
const TRADER_ANALYSIS_RULES = `- RSI(14) interpretation: only call it "overbought" if it is ABOVE 70, and only "oversold" if BELOW 30. A value between 50-70 is healthy bullish momentum, NOT overbought — do not mislabel it. Between 30-50 is bearish momentum, NOT oversold.
- US Dollar / USD strength direction: a WEAKENING dollar (or falling rate-hike expectations, or rising rate-cut expectations) is the standard BULLISH signal for BTC and risk assets generally — never state or imply the reverse. A STRENGTHENING dollar (or rising rate-hike expectations) is the bearish/headwind direction. Do not confuse "hike expectations falling" with something bearish — falling hike expectations is itself the bullish case, not a reason for concern.
- If a field says "insufficient data", "N/A", or "Not available": state that plainly ONCE, then move on. Do NOT follow it with a fabricated claim about that same topic (e.g. never say "not available, but it's probably above X" — if it's not available, you have nothing to say about X, full stop).
- Never use the internal labels "Mechanism 1" or "Mechanism 2" in your output — translate them into plain questions instead: mechanism 1 (actual vs. typical reaction) becomes something like "has this already been priced in?"; mechanism 2 (multi-lag correlation) becomes something like "is the effect still unfolding?".
- If a conflict exists between timeframes (short/medium/long-term, or between the regime scorecard's columns), name it explicitly and explain briefly why it might be happening (e.g. crypto-native flows vs. broader macro correlation) rather than just listing both sides.
- Before labeling any Timeframe breakdown outlook (short/medium/long-term), check it against the TECHNICALS section you already described in your own output: if price is trading above Tenkan, Kijun, and the 50-day MA (bullish technical structure) but you are labeling that timeframe bearish anyway, say explicitly what is outweighing the bullish technicals (e.g. sentiment sources pulling the other way, a regime scorecard factor, an overbought/exhaustion read) — never state a directional label that contradicts the technical structure you already described without naming the reason for the disagreement.
- The event calendar (FOMC proximity) is a CONFIDENCE modifier only — it tempers how much weight to put on short-term reads, it is never itself bullish or bearish.
- If sector rotation shows BTC underperforming Nasdaq, say plainly that this looks like capital rotating away from crypto specifically, not generic risk-off.
- LIQUIDATION CLUSTERS, if present, belongs INSIDE the Technicals section (never its own heading) as 1-2 extra plain-language sentences: current price, the nearest cluster above and below with their distance in % and modeled probability of being reached within the stated horizon, and today's crowding read. State the historical hit-rate or "not enough data yet" for calibration, and the monthly persistence or "not enough logged history yet", exactly as given - never guess these when the data says they're unavailable. If LIQUIDATION CLUSTERS says "Not available this session", do not mention liquidation clusters at all.
- WHALE ACTIVITY, if present, ALSO belongs INSIDE the Technicals section (never its own heading), as 1 extra plain-language sentence on what the large-transfer pattern suggests (e.g. exchange outflows read as accumulation/reduced sell-side supply, inflows as potential distribution, bidirectional flow at the same exchange as repositioning/uncertainty) - state only what the transfer directions and flags actually show, never invent a motive. WHALE ACTIVITY only ever appears when high volatility has genuinely been detected - if it says "Not applicable right now", do not mention whale activity, large transfers, or volatility being high or low anywhere in your output.
- Key takeaway must explicitly factor in LIQUIDATION CLUSTERS and WHALE ACTIVITY, when present, if either points to a plausible near-term price impact (e.g. a very close and reasonably probable cluster, or whale flow reinforcing or contradicting the rest of the read) - don't force them in if neither adds anything beyond what's already said elsewhere.
- For the Geopolitical & Macro Drivers section: use ONLY the headlines listed in TOP HEADLINES, verbatim topic (you may paraphrase the headline briefly, do not invent an event not present in that list). Pick the 3 to 5 with the largest |score|. For each, give the headline's topic in a few words and one sentence on why it plausibly matters for BTC (e.g. risk-off/risk-on transmission, inflation/rate-cut expectations, dollar strength, haven demand) — do not assert a causal price move you weren't given data for. If TOP HEADLINES is empty or says "(none available this cycle)", say plainly that no headline-level detail was available this cycle and do not invent any events.
- 9 MAGNIFICENT COMPANY MOVES gets its own short paragraph, always present in your output (even when nothing was flagged — see below). For each flagged company: state its % move and, if a headline was found, name the likely topic in plain words. Only explain a connection to crypto sentiment as far as the OTHER data in this prompt actually supports it (e.g. the 9 Magnificent composite score in SENTIMENT sources moved the same direction around the same time, or SECTOR ROTATION shows a related pattern) — if nothing else in the data connects it, say plainly that the move is noted but no clear crypto-market linkage is visible in what you were given. Never invent a causal story. If the section says "Not applicable," write one sentence saying no individual company move crossed the threshold today — do not skip this paragraph entirely.`;
const TRADER_ANALYSIS_OUTPUT_FORMAT = `OUTPUT FORMAT — plain text, no markdown symbols (no #, **, |, >, since this displays as raw text, not rendered markdown), structured with blank lines between sections exactly like this:

[One or two sentence summary: current price, overall lean, and the single biggest reason why.]

Sentiment & drivers: [2-3 sentences on composite score, which raw sources are pulling it up or down, and what that implies.]

Technicals: [2-3 sentences on RSI/MAs/Ichimoku/divergence/structure, using the correct RSI interpretation above. If LIQUIDATION CLUSTERS data is present, add 1-2 more sentences folding in the nearby modeled clusters, their distance/probability, and today's crowding read - in plain everyday language, not jargon. If WHALE ACTIVITY is present, add 1 more sentence on what the large-transfer pattern suggests.]

Geopolitical & Macro Drivers: [3 to 5 bullet-style lines (use a leading dash, not a markdown bullet), each naming one headline topic from TOP HEADLINES and one sentence on its plausible market impact. If none available, say so plainly in one sentence instead of a list.]

9 Magnificent Watch: [1-3 sentences on any flagged company moves and their headline, explaining the likely connection to crypto sentiment based on the data given, or noting there's no clear data-supported link. If no companies were flagged this cycle, write one sentence saying no individual company move crossed the threshold today.]

Timeframe breakdown:
Short-term (7d): [outlook] - [one-line reason, mention the FOMC confidence caveat here if relevant]
Medium-term (30-50d): [outlook] - [one-line reason]
Long-term: [outlook, or "not enough data yet" if genuinely unavailable] - [one-line reason if available]

Key takeaway: [one sentence synthesizing everything above into the single most useful thing to know right now, explicitly weighing liquidation clusters and/or whale activity when present and relevant.]`;

// ---------- Foufi daily digest: YouTube RSS + unofficial transcript fetch ----------
// TEST-PHASE NOTE: unlike the RSS proxies above (official feeds, stable
// format), this reverse-engineers two undocumented YouTube surfaces the same
// way open-source transcript tools do: the channel RSS (documented-ish,
// stable) for "is there a new video", and the timedtext listing/content
// endpoints (NOT documented, can shift) for the actual transcript. First
// attempt scraped the full watch page for an embedded JSON blob and hit a
// 429 from YouTube — same class of shared-IP rate-limiting already diagnosed
// for CoinGecko in this codebase. Switched to the lighter timedtext
// endpoints below (no full page download) as a cheaper first fix to try
// before assuming this needs the client-side-fetch treatment CoinGecko got.
// Every step fails gracefully into a status string rather than throwing.
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const FOUFI_CHANNEL_ID = 'UCfCMwYqt_OEBvOT4cKq42LQ';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchLatestFoufiVideo() {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${FOUFI_CHANNEL_ID}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  if (!res.ok) throw new Error('YouTube RSS ' + res.status);
  const xml = await res.text();
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/);
  if (!entryMatch) throw new Error('No entries in feed');
  const entry = entryMatch[0];
  const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
  const titleRaw = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
  const published = entry.match(/<published>(.*?)<\/published>/)?.[1];
  if (!videoId || !titleRaw) throw new Error('Could not parse feed entry (page format may have changed)');
  return { videoId, title: decodeHtmlEntities(titleRaw.trim()), published, url: `https://www.youtube.com/watch?v=${videoId}` };
}

// Classifies AM vs PM, and weekly/monthly special editions, purely from the
// publish timestamp — deterministic, not asked of Gemini (same principle as
// everywhere else in this app: compute what can be computed, LLM only
// narrates content). Confirmed against a real week of titles (Aug 6, 2026):
// every day has exactly one ~06:00 UTC video (overnight/macro-flavored) and
// one ~17:30-19:30 UTC video (technical/TradFi-flavored) — clean AM/PM
// split on UTC noon. Sunday PM is confirmed as the weekly-close special
// ("Alerte Clôture Hebdo... MM200W", Aug 2). The monthly video is NOT
// Sunday-anchored — it's month-boundary anchored: the July wrap posted Aug 1
// (a Saturday) PM ("BITCOIN FINI JUILLET"), i.e. day 1 of the new month, not
// the last Sunday of July. Flags day<=2 or day>=(daysInMonth-1) PM as a
// monthly_close candidate — untested against an actual case where this
// heuristic's boundary matters (e.g. month-end falling near a Sunday), so
// revisit once the 3-month backfill gives more real examples.
function classifyFoufiVideo(publishedIso) {
  if (!publishedIso) return { videoType: null, specialEdition: null };
  const d = new Date(publishedIso);
  const hourUtc = d.getUTCHours();
  const videoType = hourUtc < 12 ? 'morning' : 'evening';
  const dow = d.getUTCDay(); // 0 = Sunday
  const dom = d.getUTCDate();
  let specialEdition = null;
  if (videoType === 'evening' && dow === 0) specialEdition = 'weekly_close';
  // NARROWED after a real false-positive: originally also flagged
  // dom>=daysInMonth-1 (tail of the outgoing month), on the guess that the
  // monthly video might sometimes land there instead. Live data disproved
  // it immediately — Jul 30 and Jul 31 (ordinary PM videos, no monthly
  // content) both got wrongly tagged, while only Aug 1 (the real "BITCOIN
  // FINI JUILLET" wrap) was genuine. Narrowed to only the confirmed case.
  else if (videoType === 'evening' && dom <= 2) specialEdition = 'monthly_close';
  return { videoType, specialEdition };
}

// Shared by the /foufi-check route and the daily cron in scheduled() below —
// checks for a new video, hands it to Gemini, stores the result. Never
// throws past this function; errors come back as { ok:false, error } so
// callers (an HTTP response vs. a cron's ctx.waitUntil) can each handle them
// appropriately rather than this function assuming which one is calling.
async function checkFoufiDigest(env, { force = false, videoOverride = null, videoObj = null } = {}) {
  if (!env.GEMINI_API_KEY) return { ok: false, error: 'GEMINI_API_KEY not configured on this Worker' };
  try {
    const video = videoObj
      ? videoObj
      : videoOverride
        ? { videoId: videoOverride, title: '(manual video id — RSS lookup skipped)', published: null, url: `https://www.youtube.com/watch?v=${videoOverride}` }
        : await fetchLatestFoufiVideo();

    if (!force) {
      // Only 'ok' (and 'unstructured' — Gemini answered, just not in the
      // expected shape, so retrying won't help) count as "already handled".
      // A prior 'error' (e.g. a transient Gemini 503) must NOT block a
      // retry, or the hourly cron would permanently skip any video that
      // happened to hit a transient failure on its first pass — silently,
      // with no future attempt ever made again.
      const existing = await env.DB.prepare('SELECT video_id, transcript_status FROM foufi_digest WHERE video_id = ?').bind(video.videoId).first();
      if (existing && existing.transcript_status !== 'error') return { ok: true, skipped: true, reason: 'already processed', video };
    }

    const { videoType, specialEdition } = classifyFoufiVideo(video.published);

    let summaryJson = null, geminiError = null, rawText = null;
    try {
      const prompt = `You are extracting a structured summary from this French-language crypto YouTube video by the analyst "Foufi". Base everything ONLY on what he actually says and shows in the video — do not add outside knowledge, do not speculate beyond what's covered. Use "not addressed in this video" for any topic he doesn't cover, and null for any coin he doesn't mention, rather than inventing content.

Respond in English. Plain text only (no markdown symbols). Follow this exact structure and order:

Market summary: [2-3 sentences: what crypto broadly did today, per Foufi]
Macro economy: [central banks, rates, inflation, FX, geopolitics, or "not addressed in this video"]
Micro economy: [individual company earnings/moves he discussed, or "not addressed in this video"]
TradFi correlation: [how he links crypto to stock indices like the S&P 500/Nasdaq specifically, or "not addressed in this video"]
BTC: [score, see scale below, or "not addressed"] — [one-line reason]
ETH: [same]
SOL: [same]
LINK: [same]
HYPE: [same]

Score scale for each coin: -2 very bearish, -1 bearish, 0 neutral, +1 bullish, +2 very bullish — based on his stated view for THAT coin specifically, not the market overall. Most videos only address BTC and sometimes ETH — leaving the others "not addressed" is the normal, expected case, not a failure.

Dominant short-term driver: [macro, tradfi, micro, or none — see definitions below]
Secondary driver: [same options, or none — only if a second distinct factor was also clearly in play]

These two fields are about what will move price in the NEXT FEW HOURS, not medium-term narratives. Concretely:
- macro = central bank decisions/signals, rate expectations, inflation prints, FX moves, geopolitical shocks (e.g. a surprise Fed comment, a Middle East escalation, a surprise CPI print)
- tradfi = a stock index or broad equity move dragging crypto with it (e.g. S&P 500 hitting a record high, a Nasdaq selloff, an equity-market risk-on/risk-off shift)
- micro = a single company's earnings or stock move creating an immediate ripple (e.g. a specific AI-stock earnings shock, a single liquidation cascade)
- none = no single identifiable short-term catalyst, or the video's tone was driven by pure technical levels
Do NOT use "macro" for adoption, partnership, infrastructure, or regulatory-approval news (e.g. a company acquiring a stablecoin business, an ETF approval) — these are real but they are multi-week stories, not next-few-hours price drivers. Leave both fields "none" rather than force-fitting a story that isn't actually a short-term catalyst.

Major pending catalyst: [only if Foufi specifically names a significant STILL-PENDING legislative, regulatory, or similarly structural event that the market is waiting on — e.g. a named bill working through a legislature, a major pending regulatory decision — give its name and his stated status/lean in one line, e.g. "CLARITY Act: Senate vote delayed, bearish near-term". If he doesn't mention anything like this, or only discusses something that already happened (an approval, a decision already made) rather than something still pending, write "none".]

This is deliberately NOT the same as macro/micro/tradfi above — a still-pending structural catalyst (something the whole market is waiting on, that hasn't resolved yet) is a different kind of thing than a same-day price driver, and deserves its own line so it isn't lost inside general macro commentary. Only ever name ONE such catalyst — the single most significant one he discusses, if any.

On its own final line, nothing else on it:
FOUFI_JSON: {"market_summary":"...","macro":{"lean":"bullish|bearish|neutral","text":"..."},"micro":{"lean":"bullish|bearish|neutral","text":"..."},"tradfi":{"lean":"bullish|bearish|neutral","text":"..."},"coins":{"BTC":{"score":-2,"note":"..."},"ETH":{"score":null,"note":"not addressed in this video"},"SOL":{"score":null,"note":"..."},"LINK":{"score":null,"note":"..."},"HYPE":{"score":null,"note":"..."}},"dominant_driver":"macro|tradfi|micro|none","secondary_driver":"macro|tradfi|micro|none","major_catalyst":{"name":"...or null","status":"...or null"}}`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { file_data: { file_uri: video.url } },
              ],
            }],
          }),
        }
      );
      if (!geminiRes.ok) {
        const errBody = await geminiRes.text();
        throw new Error(`Gemini API ${geminiRes.status}: ${errBody.slice(0, 400)}`);
      }
      const geminiJsonRes = await geminiRes.json();
      const text = geminiJsonRes?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty or unexpected Gemini response shape: ' + JSON.stringify(geminiJsonRes).slice(0, 400));
      rawText = text.trim();
      const match = rawText.match(/FOUFI_JSON:\s*(\{[\s\S]*\})\s*$/);
      if (match) {
        try { summaryJson = JSON.parse(match[1]); }
        catch (e) { summaryJson = { raw: rawText, parseError: e.message }; }
      } else {
        summaryJson = { raw: rawText };
      }
    } catch (err) {
      geminiError = err.message;
    }

    // Legacy simple lean, kept for backward compatibility with anything still
    // reading the plain overall_lean column — derived from BTC's score sign
    // since BTC is addressed in essentially every video, unlike the others.
    const btcScore = summaryJson?.coins?.BTC?.score;
    const overallLean = typeof btcScore === 'number' ? (btcScore > 0 ? 'bullish' : btcScore < 0 ? 'bearish' : 'neutral') : null;

    const status = summaryJson && !geminiError && !summaryJson.raw ? 'ok' : (summaryJson?.raw ? 'unstructured' : 'error');
    const now = Date.now();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO foufi_digest (video_id, published_ts, title, url, transcript_status, summary_json, overall_lean, fetched_ts, video_type, special_edition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      video.videoId,
      video.published ? new Date(video.published).getTime() : null,
      video.title,
      video.url,
      status,
      summaryJson ? JSON.stringify(summaryJson) : null,
      overallLean,
      now,
      videoType,
      specialEdition
    ).run();

    return { ok: true, video, videoType, specialEdition, status, geminiError, summary: summaryJson };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    // Three crons share this handler now (see wrangler.toml): "0 6,18 * * *"
    // for the existing technical eval, "*/15 * * * *" for the alert checker,
    // "0 * * * *" (hourly) for the Foufi digest check. Hourly rather than a
    // single fixed daily time because Foufi's actual publish time varies
    // (seen anywhere from morning to evening) — checkFoufiDigest's own dedup
    // (skip if that video_id is already in foufi_digest) makes the other 23
    // hourly runs each day a cheap no-op (one D1 SELECT) rather than 23
    // redundant Gemini video calls, so hourly costs almost nothing extra
    // over guessing a single fixed time and often being late or early.
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(evaluateAlerts(env));
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(checkFoufiDigest(env));
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

    // ---- GET /strc-proxy — Strategy's (MSTR) "Stretch" perpetual preferred
    // (STRC), fetched the same way as 9 Magnificent (Yahoo Finance v8/chart,
    // same unofficial-endpoint caveats apply). Deliberately a SEPARATE route
    // rather than folding into NINE_MAG_SYMBOLS above: that route's
    // semantics (market-cap weighting, SpaceX-style IPO dampening, a 3.5%
    // move threshold tuned for common-stock volatility) don't fit STRC,
    // which is a par-anchored ($100) low-volatility-by-design instrument —
    // even its real stress episodes played out as a gradual drift over
    // weeks, not single-day spikes. Confirmed via research (Strategy's own
    // June 29 2026 policy announcement, SEC 8-Ks, CoinDesk coverage) before
    // building: Strategy's stated target is STRC trading in a $99-$100
    // range; real deviations below that have historically correlated with
    // thin dividend-reserve coverage and, in the worst case, forced BTC
    // sales specifically to fund dividends — this is a health/stress proxy
    // for the whole capital-raising machine, not a simple "higher=bullish"
    // signal. See strcHealthScore on the frontend for the scoring logic
    // this feeds. ----
    if (url.pathname === '/strc-proxy' && request.method === 'GET') {
      try {
        const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/STRC?interval=1d&range=3mo`;
        const res = await fetch(yUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        });
        if (!res.ok) throw new Error('STRC ' + res.status);
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const meta = result?.meta;
        if (!meta || meta.regularMarketPrice == null) throw new Error('STRC no price data');
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const series = timestamps.map((t, i) => ({ ts: t * 1000, close: closes[i] })).filter((p) => p.close != null);
        // Same fix already proven necessary for 9 Magnificent: derive
        // prevClose from the daily series itself, not meta.previousClose/
        // chartPreviousClose, which reflects the close before the requested
        // 3mo RANGE began rather than yesterday's actual close.
        const prevClose = series.length >= 2 ? series[series.length - 2].close : (meta.previousClose ?? meta.chartPreviousClose);
        const pct = prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : null;
        return new Response(JSON.stringify({
          price: meta.regularMarketPrice, prevClose, pct, series, ts: Date.now(),
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- GET /stock-proxy — "9 Magnificent" (Broadcom, Apple, Tesla,
    // Microsoft, Meta, Alphabet, Amazon, Nvidia, SpaceX), fetched server-side
    // via Yahoo Finance's v8/finance/chart endpoint. This is an unofficial,
    // undocumented API — no CORS header for arbitrary browser origins
    // either way, hence the proxy — and it has a documented history of
    // access changes (the older v7/finance/quote endpoint was locked down
    // in late 2024/2025; v8/chart is the current working replacement). No
    // evidence found of the Binance/Bybit-style hard geoblock against cloud
    // IPs specifically, but this is inherently less stable than a real
    // published API and may need re-checking if it stops working. ----
    const NINE_MAG_SYMBOLS = ['NVDA', 'AVGO', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'SPCX'];
    const NINE_MAG_NEWS_THRESHOLD_PCT = 3.5; // 24h move magnitude that triggers a targeted news fetch
    if (url.pathname === '/stock-proxy' && request.method === 'GET') {
      // ?granularity=intraday — 5-minute candles over the current/most
      // recent trading session, for the 24H tab specifically. Separate
      // request shape from the daily/3mo one used for 7D/30D/90D (stocks
      // only trade ~6.5h/day, so "24H" here means "today's session," the
      // conventional meaning on stock dashboards, not a literal rolling
      // 24-hour clock). range=2d as a buffer so there's still a session to
      // show if markets are currently closed (evening/weekend). Only
      // fetched when the client actually requests this tab, not on every
      // regular refresh, given this source's documented fragility.
      const isIntraday = url.searchParams.get('granularity') === 'intraday';
      try {
        const results = await Promise.allSettled(NINE_MAG_SYMBOLS.map(async (sym) => {
          // range=3mo — enough history that range-tab switching (7D/30D/90D)
          // can slice client-side from one fetch, rather than re-calling
          // this unofficial endpoint on every range switch.
          const yUrl = isIntraday
            ? `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=2d`
            : `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`;
          const res = await fetch(yUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
          });
          if (!res.ok) throw new Error(sym + ' ' + res.status);
          const json = await res.json();
          const result = json?.chart?.result?.[0];
          const meta = result?.meta;
          if (!meta || meta.regularMarketPrice == null) throw new Error(sym + ' no price data');
          const timestamps = result.timestamp || [];
          const closes = result.indicators?.quote?.[0]?.close || [];
          const series = timestamps.map((t, i) => ({ ts: t * 1000, close: closes[i] })).filter((p) => p.close != null);
          // FIX: meta.previousClose / chartPreviousClose became unreliable
          // once range was extended to 3mo (confirmed via real screenshot
          // evidence: "24h" cards showing -9% to +26%, which are implausible
          // as one-day moves but match 1-3 month reality almost exactly —
          // chartPreviousClose appears to reflect the close before the
          // requested RANGE began, not yesterday). Derive prevClose directly
          // from the daily series instead — the second-to-last point vs the
          // last — removing dependency on that ambiguous meta field. For
          // intraday requests, keep using meta's previousClose (a genuine
          // prior-session close, appropriate here since the series itself
          // is 5-minute intrasession data, not daily closes).
          const prevClose = isIntraday
            ? (meta.previousClose ?? meta.chartPreviousClose)
            : (series.length >= 2 ? series[series.length - 2].close : (meta.previousClose ?? meta.chartPreviousClose));
          const pct = prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : null;
          // Targeted, threshold-triggered news — only for daily-mode
          // requests (not every 24H-tab click) and only when the move is
          // large enough to plausibly have a real cause worth explaining.
          // Reuses the same generic RSS parser already used for the
          // crypto/macro news-proxy above, against Yahoo's per-ticker feed
          // (same trusted domain already confirmed working for this Worker,
          // not a new unvetted source). Non-fatal if it fails — the price
          // data itself doesn't depend on this succeeding.
          let headlines = null;
          if (!isIntraday && pct != null && Math.abs(pct) >= NINE_MAG_NEWS_THRESHOLD_PCT) {
            try {
              const newsRes = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
              });
              if (newsRes.ok) {
                const xml = await newsRes.text();
                headlines = parseRssTitles(xml, sym).slice(0, 3);
              }
            } catch (e) { /* non-fatal — omit headlines, price data still returned */ }
          }
          return { sym, price: meta.regularMarketPrice, prevClose, marketCap: meta.marketCap ?? null, series, pct, headlines };
        }));
        const quotes = {};
        results.forEach((r, i) => {
          const sym = NINE_MAG_SYMBOLS[i];
          if (r.status === 'fulfilled') quotes[sym] = { price: r.value.price, prevClose: r.value.prevClose, marketCap: r.value.marketCap, series: r.value.series, pct: r.value.pct, headlines: r.value.headlines };
          else quotes[sym] = { error: r.reason?.message || String(r.reason) };
        });
        return new Response(JSON.stringify({ quotes, ts: Date.now() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- POST /whale-analysis — LLM narration of the whale transfers
    // CryptoPulse already fetched and classified (exchange outflow/inflow),
    // plus any concentration/bidirectional/high-volume flags CryptoPulse
    // already detected (deterministic threshold checks, not an LLM judgment).
    // Same rule as /trader-analysis: the Worker only explains numbers/flags
    // it's given, it never computes, invents, or second-guesses one.
    // Written for someone with no trading background — explains outflow/
    // inflow in plain terms the first time, leads with any elevated-activity
    // flag if present, and is explicitly forbidden from calling this "smart
    // money" or predicting price, since this data has no entity-level
    // attribution and isn't backtested. ----
    if (url.pathname === '/whale-analysis' && request.method === 'POST') {
      try {
        const { transfers, concentration } = await request.json();
        if (!Array.isArray(transfers) || !transfers.length) {
          return new Response(JSON.stringify({ error: 'transfers[] requis et non vide' }), { status: 400, headers: corsHeaders });
        }
        const lines = transfers.slice(0, 10).map(t =>
          `${t.symbol} $${(t.usd / 1e6).toFixed(1)}M moved from "${t.from}" to "${t.to}" — classified as ${t.direction === 'outflow' ? 'OUTFLOW (left a named exchange for an unlabeled wallet)' : 'INFLOW (moved from an unlabeled wallet onto a named exchange)'}`
        ).join('\n');
        const flagLines = (concentration?.flags || []).map(f =>
          f.type === 'concentration'
            ? `CONCENTRATION FLAG: ${f.count} separate transfers all involved "${f.exchange}" in this snapshot (already detected by CryptoPulse, a fixed threshold of 3+, not an LLM judgment call)`
            : `BIDIRECTIONAL FLAG: "${f.exchange}" shows BOTH outflow ($${(f.outflowUsd / 1e6).toFixed(1)}M) AND inflow ($${(f.inflowUsd / 1e6).toFixed(1)}M) at the same time in this snapshot`
        ).join('\n');
        const volumeLine = concentration?.highVolume
          ? `HIGH VOLUME FLAG: total moved across all listed transfers is $${(concentration.totalUsd / 1e6).toFixed(0)}M in this single snapshot (already flagged by CryptoPulse against a fixed $500M floor, not a calibrated historical baseline)`
          : '';
        const prompt = `You are explaining a list of recent large cryptocurrency exchange movements to someone with NO trading background, in the simplest possible everyday language.

DATA (each line is one real transfer that already happened; OUTFLOW/INFLOW labels were already determined, do not recompute or second-guess them):
${lines}

PATTERN FLAGS (already detected by CryptoPulse using fixed threshold checks — do NOT invent your own flags, do NOT decide something is elevated on your own judgment, only narrate what's listed here; if this section is empty, say plainly that nothing unusual stood out this time):
${flagLines || volumeLine ? [flagLines, volumeLine].filter(Boolean).join('\n') : '(none this cycle)'}

RULES:
- If any PATTERN FLAG is present, lead your answer with it in plain language — this is the most important thing to communicate. Explain concentration as "an unusually large number of transfers all touching the same exchange, which is more attention-worthy than one transfer alone." Explain bidirectional as "money moving in AND out of the same exchange around the same time, which often means active repositioning or uncertainty rather than a clean one-directional trend."
- Frame any flag as "elevated activity worth being aware of," NEVER as "volatility is about to increase" or any other price prediction — you were not given data that validates a volatility forecast, only a pattern-concentration check.
- The very first time you use the word "outflow" or "inflow" in your answer, briefly explain what it means in plain words (outflow = coins left an exchange for a private wallet, often read as someone moving funds off the exchange rather than preparing to sell; inflow = coins moved onto an exchange, often read as possible preparation to trade or sell, though it could also just mean depositing for other reasons).
- Do NOT call any of this "smart money" — there is no information here about WHO moved these coins, only that a named exchange was on one side.
- Do NOT state or imply that this predicts a future price move, even when a pattern flag is present. This is not backtested or statistically validated.
- End with one plain sentence reminding the reader that a single transfer usually means very little on its own, and this is background context, not a signal to act on.
- Keep the entire answer to 4-6 short sentences, no jargon, no markdown symbols.`;
        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
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

    // ---- POST /liquidation-analysis — LLM narration of CryptoPulse's
    // modeled liquidation levels (leverage-tier calculation on real
    // Hyperliquid mark price + funding), the crowding/elevated flags, and the
    // monthly persistence check — all already computed by CryptoPulse, the
    // Worker only explains them. Gives a DAILY reading (today's snapshot) and
    // a separate MONTHLY reading (has this crowding been persistent or is it
    // new) for the focus asset, since those are genuinely different
    // information, not the same snapshot restated twice. Explicitly
    // forbidden from treating the model as measured real positions or a
    // price prediction — every public liquidation heatmap makes the same
    // entry-price assumption this does, and says so; this must too. ----
    if (url.pathname === '/liquidation-analysis' && request.method === 'POST') {
      try {
        const { assets, focus, chartContext } = await request.json();
        if (!assets || typeof assets !== 'object' || !Object.keys(assets).length) {
          return new Response(JSON.stringify({ error: 'assets{} requis et non vide' }), { status: 400, headers: corsHeaders });
        }
        const lines = Object.entries(assets).map(([sym, d]) => {
          const levelsStr = (d.levels || []).map(l =>
            `${l.leverage}x: long liq $${l.longLiq.toFixed(l.longLiq < 10 ? 4 : 0)}, short liq $${l.shortLiq.toFixed(l.shortLiq < 10 ? 4 : 0)}`
          ).join(' | ');
          const crowdStr = d.flags?.crowded
            ? `${d.flags.crowdedSide === 'long' ? 'LONGS' : 'SHORTS'} crowded (premium ${d.premiumPct >= 0 ? '+' : ''}${d.premiumPct.toFixed(1)}% APR), nearest ${d.flags.crowdedSide} liq level is ${d.flags.nearestDistPct.toFixed(1)}% away${d.flags.elevated ? ' — ELEVATED FLAG (within the 8% proximity threshold)' : ''}`
            : `balanced, no strongly crowded side (premium ${d.premiumPct >= 0 ? '+' : ''}${d.premiumPct.toFixed(1)}% APR)`;
          const monthlyStr = d.monthly
            ? `Monthly persistence: this same side has been dominant in ${d.monthly.pct}% of the last ${d.monthly.count} logged readings`
            : 'Monthly persistence: not enough logged history yet to say whether this is new or sustained';
          return `${sym}: mark price $${d.markPx.toFixed(d.markPx < 10 ? 4 : 0)}. Modeled liquidation levels (assuming a position opened at today's price): ${levelsStr}. Crowding: ${crowdStr}. ${monthlyStr}.`;
        }).join('\n');
        // The actual heatmap the user is looking at (specific asset + range
        // currently selected) — the real "next fresh cluster" prices computed
        // the SAME way the chart itself draws them, so the narration can cite
        // real numbers from the visible graph instead of only the coarser
        // per-tier snapshot above.
        let chartLine = '';
        if (chartContext && chartContext.livePrice) {
          const pctAbove = chartContext.nextClusterAbove != null ? ((chartContext.nextClusterAbove - chartContext.livePrice) / chartContext.livePrice * 100) : null;
          const pctBelow = chartContext.nextClusterBelow != null ? ((chartContext.livePrice - chartContext.nextClusterBelow) / chartContext.livePrice * 100) : null;
          chartLine = `\n\nCURRENT GRAPH (${chartContext.asset}, ${chartContext.range} view — this is literally what the user is looking at right now): live price $${chartContext.livePrice.toFixed(chartContext.livePrice < 10 ? 4 : 0)}. `
            + (pctAbove != null ? `Nearest fresh (un-eaten) significant cluster ABOVE price: $${chartContext.nextClusterAbove.toFixed(chartContext.nextClusterAbove < 10 ? 4 : 0)}, which is ${pctAbove.toFixed(1)}% higher. ` : 'No significant fresh cluster above price in the visible range. ')
            + (pctBelow != null ? `Nearest fresh (un-eaten) significant cluster BELOW price: $${chartContext.nextClusterBelow.toFixed(chartContext.nextClusterBelow < 10 ? 4 : 0)}, which is ${pctBelow.toFixed(1)}% lower.` : 'No significant fresh cluster below price in the visible range.');
          // Probability of reaching each cluster within the current horizon —
          // computed by CryptoPulse using the same volatility model already
          // used for Break-even Probability elsewhere in the app, NOT
          // computed or estimated by you. Calibration (if present) is a real
          // check of past predictions of similar confidence against what
          // actually happened, not a theoretical adjustment.
          if (chartContext.probAbove != null) {
            chartLine += `\n\nMODELED PROBABILITY of reaching the cluster ABOVE within this ${chartContext.range} horizon: ${(chartContext.probAbove * 100).toFixed(0)}% (from CryptoPulse's volatility model, already computed — do not recompute).`;
            chartLine += chartContext.calibrationAbove
              ? ` Historical calibration: among ${chartContext.calibrationAbove.count} past predictions of similar confidence, ${(chartContext.calibrationAbove.empiricalRate * 100).toFixed(0)}% actually hit their target (${chartContext.calibrationAbove.totalResolved} total resolved predictions logged so far).`
              : ' Not enough resolved historical predictions yet to check this model\u2019s real accuracy for similar setups.';
          }
          if (chartContext.probBelow != null) {
            chartLine += `\n\nMODELED PROBABILITY of reaching the cluster BELOW within this ${chartContext.range} horizon: ${(chartContext.probBelow * 100).toFixed(0)}% (from CryptoPulse's volatility model, already computed — do not recompute).`;
            chartLine += chartContext.calibrationBelow
              ? ` Historical calibration: among ${chartContext.calibrationBelow.count} past predictions of similar confidence, ${(chartContext.calibrationBelow.empiricalRate * 100).toFixed(0)}% actually hit their target (${chartContext.calibrationBelow.totalResolved} total resolved predictions logged so far).`
              : ' Not enough resolved historical predictions yet to check this model\u2019s real accuracy for similar setups.';
          }
        }
        const prompt = `You are explaining a modeled crypto liquidation-level snapshot to someone with NO trading background, in the simplest possible everyday language. The focus asset for this explanation is ${focus || 'BTC'}, but you may briefly mention other assets only if they show an ELEVATED FLAG.

DATA (already computed by CryptoPulse — do not recompute, second-guess, or invent any number; all leverage tiers, prices, and flags are given, not your job to determine):
${lines}${chartLine}

RULES:
- The first time you use the term "liquidation level" or "liquidation price", explain in plain words what it means: a modeled price at which a leveraged position would be automatically force-closed by the exchange, assuming someone opened that position today at the current price.
- Explicitly say this is a MODEL based on standard leverage tiers and real mark price / funding data — NOT measured real positions, since no public source gives that (every public liquidation heatmap, including the well-known paid ones, makes this same assumption).
- If CURRENT GRAPH data is present, reference its exact cluster prices and % distances directly — that's literally the chart the user is looking at, so cite it specifically (e.g. "the next real cluster above is about $X, roughly Y% away") rather than only speaking generally.
- If a MODELED PROBABILITY is present, state it plainly as a modeled estimate (e.g. "the model gives roughly a 30% chance of reaching that level"), never as a confident forecast or guarantee. Include the calibration sentence exactly as given — if it says not enough data yet, say that plainly rather than implying the model is unproven or proven either way.
- Give a DAILY reading for the focus asset: today's crowding direction (which side, longs or shorts, is currently more exposed) and how close the nearest relevant level is right now, in 1-2 plain sentences.
- Give a separate MONTHLY reading for the focus asset: whether this same crowding direction has been persistent over the logged history, or whether today's reading is new/different from the recent pattern, in 1 plain sentence. If there's not enough logged history, say so plainly instead of guessing.
- If any asset (including ones other than the focus) shows an ELEVATED FLAG, mention it explicitly: explain that a crowded side with its liquidation level very close to the current price means forced selling or buying could accelerate a move if price reaches that level — but do NOT say this WILL happen or WHEN.
- Do NOT state or imply this predicts a future price move or its timing. This is a model, not a forecast.
- Keep the entire answer to 7-9 short sentences, no jargon, no markdown symbols.`;
        const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 480,
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
          'SELECT ts, score, technical_score as technicalScore, btc_price as btc, gold_regime as goldRegime, sources_json, regime_mag as regimeMag, bottom_score as bottomScore, global_mcap as globalMcap FROM history ORDER BY ts DESC LIMIT 500'
        ).all();
        return new Response(JSON.stringify({ history: results.reverse() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- POST /history — log one snapshot point (sentiment, technical, price, sources) ----
    if (url.pathname === '/history' && request.method === 'POST') {
      try {
        // FIX: regimeMag was already being sent by the client every cycle (see
        // window.__lastRegimeScorecard?.overallMag in the POST body) but this
        // handler never destructured or stored it — no regime_mag column
        // existed either. Every read of row.regimeMag downstream (the
        // self-backtest, the conviction-average-over-window helper) has
        // therefore always seen null/undefined, silently. bottomScore is new:
        // needed so the Market Bottom Signal can appear in the Dashboard's
        // 24h-ago comparison alongside Sentiment/Technical/Combined/Scorecard.
        // globalMcap: the raw total crypto market cap in USD (from CoinGecko's
        // free /global endpoint, which the composite already calls every
        // cycle for its 24h-change score — this is the SAME call, just also
        // keeping the absolute dollar figure it was discarding before).
        // History starts accumulating from whenever this first gets written —
        // CoinGecko's actual historical total-market-cap chart endpoint is
        // Pro-API-only, so there's no way to backfill real data before today.
        const { score, technicalScore, btcPrice, sources, goldRegime, regimeMag, bottomScore, globalMcap } = await request.json();
        if (typeof score !== 'number') {
          return new Response(JSON.stringify({ error: 'score (number) requis' }), { status: 400, headers: corsHeaders });
        }
        const now = Date.now();
        await env.DB.prepare('INSERT INTO history (ts, score, technical_score, btc_price, gold_regime, sources_json, regime_mag, bottom_score, global_mcap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(now, score, typeof technicalScore === 'number' ? technicalScore : null, btcPrice ?? null, goldRegime ?? null, sources ? JSON.stringify(sources) : null, typeof regimeMag === 'number' ? regimeMag : null, typeof bottomScore === 'number' ? bottomScore : null, typeof globalMcap === 'number' ? globalMcap : null).run();
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
        const { closes, extended } = await request.json();
        if (!Array.isArray(closes) || closes.length < 200) {
          return new Response(JSON.stringify({ error: 'closes[] (200+ points) requis' }), { status: 400, headers: corsHeaders });
        }
        await evaluateTechnicalsFromCloses(env, closes, extended);
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
        const dataBlock = buildTraderAnalysisDataBlock(data);
        const prompt = `You are an experienced crypto trader writing a short, clear BTC market read for someone who wants to understand it in one pass, not decode jargon. You must use the exact numbers given - every value below was already calculated; do not compute, estimate, or invent any number not explicitly provided.

CRITICAL RULES:
${TRADER_ANALYSIS_RULES}

${TRADER_ANALYSIS_OUTPUT_FORMAT}

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


    // ---- POST /gemini-outlook — powers the "Narrative" tab (previously
    // called "Outlook"; the old deterministic-only Narrative tab, with its
    // own /narrative-analysis route, was removed). Calls Gemini directly
    // (the user's own free-tier API key, added as a Worker secret) and
    // explicitly INVITES it to draw on its own broader knowledge of current
    // crypto narratives — the whole reason to use Gemini here is that it
    // isn't limited to a 24h price snapshot the way the small fast model
    // is. No Google Search grounding for now (deliberately — grounding's
    // free-tier billing requirement is genuinely ambiguous per research;
    // base Gemini calls are unambiguously free with no billing account
    // needed at all). Portfolio composition (real weights) is the one
    // piece of ground-truth data passed in; the narrative content itself
    // is Gemini's own synthesis, not something CryptoPulse computed and is
    // just asking to be narrated. ----
    // ---- POST /trader-analysis-gemini — Gemini's OWN full, independent
    // analysis from the SAME data block /trader-analysis (fast Llama) uses,
    // not a review of Llama's prose. Replaces the earlier, narrower
    // "cross-check the narrative text" version: a short critique of prose
    // Gemini didn't generate can only catch obvious logic errors (and it
    // did — see the USD-direction and technicals-vs-label fixes this
    // caught, now folded into TRADER_ANALYSIS_RULES for both models). Two
    // full independent reads of the SAME raw numbers, using the SAME
    // rules/format for genuine side-by-side comparability, is a more
    // informative check than one model grading the other's writing.
    //
    // Deliberately NOT Google Search grounding: /gemini-outlook already
    // documented that grounding's free-tier billing requirement is
    // genuinely ambiguous, and base Gemini calls are the unambiguously-
    // free, already-proven path in this codebase — same mechanism, same
    // model, same auth as /gemini-outlook. Gemini IS explicitly invited to
    // supplement with its own broader knowledge (unlike Llama, which is
    // strictly constrained to the given numbers) — same differentiator
    // /gemini-outlook already relies on — but must clearly flag whenever
    // it does, so that's never mistaken for something CryptoPulse itself
    // computed.
    //
    // On-demand only (a button the user presses), not run automatically on
    // every load — this is a larger prompt+completion than the old
    // crosscheck, and shares the same 20/day free-tier quota bucket as
    // Foufi and Outlook, already hit multiple times this project. ----
    if (url.pathname === '/trader-analysis-gemini' && request.method === 'POST') {
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured on this Worker' }), { status: 500, headers: corsHeaders });
      }
      try {
        const data = await request.json();
        const dataBlock = buildTraderAnalysisDataBlock(data);
        const prompt = `You are an experienced crypto trader writing your OWN independent BTC market read from the live snapshot data below — the exact same data another, faster model was also given to write its own separate read. Do not assume you're reviewing or agreeing with that other read; you haven't seen it. Write your own analysis from the numbers.

You must use the exact numbers given for anything below - do not invent or alter a number that was provided. Unlike a purely numeric model, you MAY supplement with your own broader knowledge of current crypto market conditions and context beyond this snapshot (e.g. a recent macro development, a narrative you're aware of) — but whenever you do this, say explicitly that it's from your own broader knowledge, not from the snapshot data, so it's never mistaken for something CryptoPulse itself computed. If you're not confident something in your broader knowledge is current, say so plainly rather than stating it as settled fact.

CRITICAL RULES:
${TRADER_ANALYSIS_RULES}

${TRADER_ANALYSIS_OUTPUT_FORMAT}

DATA:
${dataBlock}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          }
        );
        if (!geminiRes.ok) {
          const errBody = await geminiRes.text();
          throw new Error(`Gemini API ${geminiRes.status}: ${errBody.slice(0, 300)}`);
        }
        const geminiJson = await geminiRes.json();
        const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty or unexpected Gemini response shape: ' + JSON.stringify(geminiJson).slice(0, 300));
        return new Response(JSON.stringify({ analysis: text.trim(), ts: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === '/gemini-outlook' && request.method === 'POST') {
      if (!env.GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured on this Worker' }), { status: 500, headers: corsHeaders });
      }
      try {
        const data = await request.json();
        const portfolio = data.portfolio || [];
        const fmt = (v, d = 1) => (v == null ? 'N/A' : v.toFixed(d));
        const portfolioLines = portfolio.length
          ? portfolio.map((p) => `  ${p.sym}: ${fmt(p.weight)}% of portfolio`).join('\n')
          : '  (no portfolio data provided)';

        const prompt = `You are a crypto portfolio analyst. Using your own knowledge of current and recent crypto market narratives and trends, identify exactly the 2-3 most significant themes currently shaping the crypto market at a MEDIUM-TERM (weeks to a few months) and LONG-TERM (6+ months) horizon.

USER'S PORTFOLIO (answer specifically about these holdings, not the market in general — this is factual, not a hypothetical):
${portfolioLines}

RULES:
- Never state or imply a specific future price target or a guaranteed outcome — this is a positioning read, not a forecast.
- If your knowledge of very recent events might be incomplete or outdated, say so plainly rather than presenting something uncertain as settled fact.
- Be honest when a coin has little real connection to a narrative — say so plainly rather than forcing a link that isn't there.
- Plain text only, no markdown symbols (no #, **, |, >, since this displays as raw text).
- Follow the exact structure below, in the exact order, with a blank line between every labeled section — do not merge sections into one block of prose.

OUTPUT FORMAT — follow this structure exactly, once per narrative (2-3 narratives total):

Narrative 1: [short name for the theme]
[2-3 sentences: what this narrative is, why it's significant right now, which sectors or ecosystems it touches]
Impact on your holdings:
BTC: [one sentence on how this specific narrative affects BTC specifically, medium vs long term if they differ, or state plainly it has little connection]
ETH: [same]
SOL: [same]
LINK: [same]
HYPE: [same]

Narrative 2: [same structure]
[same structure]
Impact on your holdings:
BTC: [same]
ETH: [same]
SOL: [same]
LINK: [same]
HYPE: [same]

Narrative 3 (only if genuinely significant, otherwise omit entirely): [same structure]

Overall positioning: [1-2 sentences synthesizing what this means for the portfolio as a whole across these narratives and timeframes.]

After all of the above, on its own final line with absolutely nothing else on that line, output exactly this (valid JSON, one line, no trailing text after it, one object per narrative in the SAME order as above, using the SAME narrative names):
NARRATIVE_JSON: [{"name":"[exact same name as Narrative 1 above]","medium":{"BTC":"bullish|bearish|neutral","ETH":"...","SOL":"...","LINK":"...","HYPE":"..."},"long":{"BTC":"...","ETH":"...","SOL":"...","LINK":"...","HYPE":"..."}},{"name":"[Narrative 2 name]","medium":{...},"long":{...}}]
Only ever use the words bullish, bearish, or neutral as values. Neutral is a real, expected, and often correct answer for a specific narrative x coin pair — use it honestly whenever a coin has no genuine connection to that particular narrative, rather than forcing a bullish or bearish label onto every coin regardless of relevance.`;

        const geminiRes = await fetch(
          // gemini-2.5-flash was confirmed deprecated for new API keys (the
          // exact 404 the user's key hit). gemini-3.6-flash is the current
          // GA flagship Flash model as of testing — confirmed free on
          // Google AI Studio's tier alongside 3.5 Flash and 3.5 Flash-Lite
          // (only Pro-series models are paid-only, since April 2026).
          // Chose the full Flash model over Flash-Lite since narrative
          // synthesis needs genuine reasoning, not the simple
          // classification/extraction work Flash-Lite is tuned for.
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          }
        );
        if (!geminiRes.ok) {
          const errBody = await geminiRes.text();
          throw new Error(`Gemini API ${geminiRes.status}: ${errBody.slice(0, 300)}`);
        }
        const geminiJson = await geminiRes.json();
        const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty or unexpected Gemini response shape: ' + JSON.stringify(geminiJson).slice(0, 300));
        // Extract the trailing NARRATIVE_JSON line separate from the prose.
        // If it's missing or malformed, still return the narrative - never
        // let a formatting hiccup break the whole response.
        let narrative = text.trim();
        let narrativeScores = null;
        const scorecardMatch = narrative.match(/NARRATIVE_JSON:\s*(\[[\s\S]*\])\s*$/);
        if (scorecardMatch) {
          try {
            narrativeScores = JSON.parse(scorecardMatch[1]);
          } catch (e) { /* malformed - just omit the scorecard, keep the narrative */ }
          narrative = narrative.slice(0, scorecardMatch.index).trim();
        }
        // Deterministic line-break insertion before known structural labels,
        // regardless of whether Gemini included its own newlines. Relying
        // purely on the prompt's formatting instructions has failed twice in
        // real testing (came back as one unbroken block both times) - this
        // guarantees readable structure independent of the model's
        // cooperation, rather than trying a third prompt wording.
        narrative = narrative
          .replace(/\s*(Narrative\s+\d+:)/g, '\n\n$1')
          .replace(/\s*(Impact on your holdings:)/gi, '\n$1')
          .replace(/\s*\b(BTC|ETH|SOL|LINK|HYPE):/g, '\n$1:')
          .replace(/\s*(Overall positioning:)/gi, '\n\n$1')
          .replace(/^\n+/, '')
          .trim();
        return new Response(JSON.stringify({ analysis: narrative, narrativeScores, ts: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // ---- GET /foufi-check?force=1 — TEST ROUTE, not yet wired to any UI.
    // Checks Foufi's YouTube channel for its latest video and hands the URL
    // directly to Gemini (file_data part, YouTube-URL-as-input — a Gemini
    // API preview feature, free) to extract only what he actually said,
    // structured around his own 5-point framework (the same one that shaped
    // this app's Sentiment Engine / Regime Scorecard). Deliberately
    // constrained to the video's own content — no outside-knowledge
    // synthesis, unlike /gemini-outlook — this reports what Foufi said, not
    // what Gemini thinks. No transcript-scraping needed: Google's own
    // servers fetch the video, sidestepping the YouTube bot-detection wall
    // three earlier attempts here hit trying to scrape it from the Worker
    // directly (watch-page scrape → 429; timedtext list → dead endpoint;
    // Innertube player → LOGIN_REQUIRED bot challenge — all three were the
    // Worker's shared/datacenter IP getting flagged, regardless of endpoint).
    // Also runs on a daily cron now (see scheduled() below) — this route stays
    // for manual testing (?force=1, ?video=ID). ----
    // ---- GET /foufi-latest — read-only, for the Trader Analysis tile. Just
    // returns the most recently stored digest row; never triggers a Gemini
    // call itself (that only happens via checkFoufiDigest, from the hourly
    // cron or the manual /foufi-check route). ----
    // ---- GET /foufi-list — diagnostic only, no Gemini cost. Lists recent
    // entries straight from the channel RSS (title/videoId/published) so we
    // can see real posting-time/title patterns without processing every
    // video through Gemini just to look at metadata. ----
    if (url.pathname === '/foufi-list' && request.method === 'GET') {
      try {
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${FOUFI_CHANNEL_ID}`, { headers: { 'User-Agent': BROWSER_UA } });
        if (!res.ok) throw new Error('YouTube RSS ' + res.status);
        const xml = await res.text();
        const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
          const entry = m[0];
          const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
          const titleRaw = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
          const published = entry.match(/<published>(.*?)<\/published>/)?.[1];
          return { videoId, title: titleRaw ? decodeHtmlEntities(titleRaw.trim()) : null, published };
        });
        return new Response(JSON.stringify({ entries }), { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    // Shared formatter for both routes below.
    function formatDigestRow(row) {
      let summary = null;
      try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch (e) { /* leave null */ }
      return {
        videoId: row.video_id,
        title: row.title,
        url: row.url,
        publishedTs: row.published_ts,
        status: row.transcript_status,
        overallLean: row.overall_lean,
        videoType: row.video_type,
        specialEdition: row.special_edition,
        summary,
        fetchedTs: row.fetched_ts,
      };
    }

    // ---- GET /foufi-latest — the 2 most recent digests (in normal operation,
    // today's AM+PM — or yesterday's PM + today's AM if today's PM hasn't
    // posted yet), for the side-by-side Trader Analysis tile. Read-only,
    // never triggers a Gemini call itself. ----
    if (url.pathname === '/foufi-latest' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare('SELECT * FROM foufi_digest ORDER BY published_ts DESC LIMIT 2').all();
        return new Response(JSON.stringify({ latest: results.map(formatDigestRow) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /foufi-recent?days=90 — for the collapsible recap table.
    // Joins each digest against the closest same-day CryptoPulse Sentiment
    // history row (same "closest within tolerance" pattern used everywhere
    // else in this app, e.g. computeRegimeBacktest) so each row can show
    // "what Foufi said" next to "what our own Sentiment Engine said" that
    // day — the comparison the person asked for, without registering Foufi
    // as a scored Sentiment source (deliberately not done yet). ----
    if (url.pathname === '/foufi-recent' && request.method === 'GET') {
      try {
        const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get('days') || '90', 10) || 90));
        const cutoff = Date.now() - days * 86400000;
        const { results: digestRows } = await env.DB.prepare(
          'SELECT * FROM foufi_digest WHERE published_ts >= ? ORDER BY published_ts DESC'
        ).bind(cutoff).all();
        const { results: historyRows } = await env.DB.prepare(
          'SELECT ts, score FROM history WHERE ts >= ? AND score IS NOT NULL ORDER BY ts ASC'
        ).bind(cutoff).all();
        const tolerance = 4 * 3600000; // within 4h counts as "same reading"
        function nearestSentiment(ts) {
          let best = null, bestDiff = Infinity;
          for (const h of historyRows) {
            const diff = Math.abs(h.ts - ts);
            if (diff < bestDiff) { bestDiff = diff; best = h; }
          }
          return (best && bestDiff <= tolerance) ? best.score : null;
        }
        const rows = digestRows.map(row => {
          const d = formatDigestRow(row);
          d.sentimentScoreThatDay = row.published_ts ? nearestSentiment(row.published_ts) : null;
          return d;
        });
        return new Response(JSON.stringify({ days, count: rows.length, rows }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ---- GET /foufi-backfill-rss?limit=3 — processes videos already
    // exposed by the channel RSS (~15 most recent, ~1 week) that aren't yet
    // in foufi_digest. Oldest-unprocessed-first, so an interrupted batch
    // still leaves a contiguous block of history rather than gaps. Small
    // default batch size — each video is a real Gemini video-understanding
    // call (real wall-clock time, not just a fetch), so this stays
    // deliberately conservative rather than risking a request timeout by
    // trying to clear the whole backlog in one call. Call repeatedly
    // (response tells you how many are left) until caught up. This is NOT
    // the 3-month backfill — RSS structurally can't see further back than
    // this; that one needs the YouTube Data API key, separately. ----
    if (url.pathname === '/foufi-backfill-rss' && request.method === 'GET') {
      try {
        const limit = Math.min(10, Math.max(1, parseInt(url.searchParams.get('limit') || '3', 10) || 3));
        const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${FOUFI_CHANNEL_ID}`, { headers: { 'User-Agent': BROWSER_UA } });
        if (!res.ok) throw new Error('YouTube RSS ' + res.status);
        const xml = await res.text();
        const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
          const entry = m[0];
          const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
          const titleRaw = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
          const published = entry.match(/<published>(.*?)<\/published>/)?.[1];
          return videoId ? { videoId, title: titleRaw ? decodeHtmlEntities(titleRaw.trim()) : videoId, published, url: `https://www.youtube.com/watch?v=${videoId}` } : null;
        }).filter(Boolean);

        const results = [];
        let remaining = 0;
        for (const entry of entries.slice().reverse()) { // oldest first
          const existing = await env.DB.prepare('SELECT transcript_status FROM foufi_digest WHERE video_id = ?').bind(entry.videoId).first();
          if (existing && existing.transcript_status !== 'error') continue; // already handled
          if (results.length >= limit) { remaining++; continue; }
          const r = await checkFoufiDigest(env, { force: true, videoObj: entry });
          results.push({ videoId: entry.videoId, title: entry.title, status: r.status || 'error', error: r.geminiError || r.error || null });
        }
        return new Response(JSON.stringify({ ok: true, processedThisCall: results.length, remaining, totalEntriesInFeed: entries.length, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: corsHeaders });
      }
    }

    if (url.pathname === '/foufi-check' && request.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      const videoOverride = url.searchParams.get('video');
      const result = await checkFoufiDigest(env, { force, videoOverride });
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // ---- Anything else: not a route this Worker serves ----
    return new Response(JSON.stringify({ error: 'Not found. This Worker serves CryptoPulse only.' }), { status: 404, headers: corsHeaders });
  },
};
