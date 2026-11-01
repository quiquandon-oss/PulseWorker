// Server-side V1 sentiment collection (scomp-v1): mocked network, in-memory SQLite (migration 0002 in isolation),
// and contract tests against the browser scorers in CryptoPulse/index.html when that checkout is present.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractFunctions } from './helpers/extract.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const MIG = readFileSync(new URL('../db/migrations/0002_server_composite.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../db/rollback/0002_server_composite.sql', import.meta.url), 'utf8');
const between = (a, b) => SRC.slice(SRC.indexOf(a), SRC.indexOf(b, SRC.indexOf(a)));
const constLine = (name) => { const i = SRC.indexOf(`const ${name} =`); return SRC.slice(i, SRC.indexOf(';\n', i) + 1); };
const objConst = (name) => { const i = SRC.indexOf(`const ${name} = {`); return SRC.slice(i, SRC.indexOf('\n};', i) + 3); };

function load(stubs = {}) {
  const body = [
    constLine('V1_COMPOSITE_FORMULA'), objConst('SENTIMENT_DEFAULT_WEIGHTS'), constLine('SENTIMENT_DEFAULT_WEIGHTS_VERSION'),
    extractFunctions('parseRssTitles', 'stripHtml', 'recomputeComposite'),
    between('// ═══ Server-side V1 sentiment collection', 'export default {'),
    'return { collectServerSources, buildServerComposite, runServerComposite, getServerCompositeStatus, scompScoreHeadline, scompScoreHeadlineBatch, scompScorers, scompFetch, SCOMP_SENT_LEXICON, SCOMP_SOURCE_REGISTRY, SENTIMENT_DEFAULT_WEIGHTS };',
  ].join('\n\n');
  const names = Object.keys(stubs);
  return new Function(...names, body)(...names.map((n) => stubs[n]));
}

const NOW = Date.UTC(2026, 10, 1, 12, 5);
const H = 3600000;
const HL = [{ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'HYPE' }, { name: 'SOL' }, { name: 'LINK' }] },
  [{ funding: '0.0000300', markPx: '101', prevDayPx: '100' }, { funding: '0.0000100' }, { funding: '0.0000500' }, { funding: '-0.0000100' }, { funding: '0.0000125' }]];
const XYZ = [{ universe: [{ name: 'xyz:BRENTOIL' }, { name: 'xyz:EUR' }, { name: 'xyz:GOLD' }] },
  [{ markPx: '82', prevDayPx: '80' }, { markPx: '1.09', prevDayPx: '1.1' }, { markPx: '2050', prevDayPx: '2000' }]];
const rss = (titles) => `<rss><channel>${titles.map((t) => `<item><title><![CDATA[${t}]]></title><description>d</description></item>`).join('')}</channel></rss>`;
const NEWS = {
  'cointelegraph.com': ['Bitcoin rally extends as ETF inflows surge', 'Exchange hacked, funds drained'],
  'investing.com': ['Fed signals rate cut as inflation eases', 'Recession fears grow'],
  'bbci.co.uk': ['Ceasefire agreed after weeks of conflict', 'Trade war escalation feared'],
  'coindesk.com': ['SEC approves new crypto rules'], 'theblock.co': ['Regulator launches crackdown on fraud'],
};
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });
function net(over = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(url);
    if (over[url]) return over[url](url, init);
    if (url.includes('hyperliquid')) return json(JSON.parse(init.body).dex === 'xyz' ? XYZ : HL);
    if (url.includes('alternative.me')) return json({ data: [{ value: '63', timestamp: String(Math.floor((NOW - 3 * H) / 1000)) }] });
    if (url.includes('coingecko')) return json({ data: { market_cap_change_percentage_24h_usd: -2.4, updated_at: Math.floor((NOW - 600000) / 1000) } });
    if (url.includes('mempool')) return json({ difficultyChange: 3.1 });
    if (url.includes('stlouisfed')) return json({ observations: [{ date: '2026-10-30', value: '4.10' }, { date: '2026-10-29', value: '4.20' }] });
    if (url.includes('sosovalue')) return json({ data: { list: [{ title: 'Bitcoin ETF inflows record high' }] } });
    const host = Object.keys(NEWS).find((h) => url.includes(h));
    if (host) return json(rss(NEWS[host]));
    return json({}, 404);
  };
  f.calls = calls;
  return f;
}
function fakeEnv(db, extra = {}) {
  const run = (sql, a) => { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } }; };
  const stmt = (sql, a = []) => ({ bind: (...b) => stmt(sql, b), run: async () => run(sql, a), all: async () => ({ results: db.prepare(sql).all(...a) }), first: async () => db.prepare(sql).get(...a) ?? null });
  return { DB: { prepare: (s) => stmt(s), batch: async (ss) => { db.exec('BEGIN'); try { const o = []; for (const s of ss) o.push(await s.run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } }, ...extra };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE foufi_digest (published_ts INTEGER, transcript_status TEXT, summary_json TEXT)');
  db.prepare('INSERT INTO foufi_digest VALUES (?, ?, ?)').run(NOW - 5 * H, 'ok', JSON.stringify({ coins: { BTC: { score: 1 } } }));
  db.exec(MIG);
  return db;
}
const stubs = {
  getHlOiReading: async () => ({ status: 'OK', score: 57, latest_ts: NOW - 20 * 60000 }),
  getRiskRegimeReading: async () => ({ status: 'INSUFFICIENT_DATA', reason: 'cross-asset history too short' }),
};
const noSleep = async () => {};

describe('scomp-v1 collection', () => {
  it('collects every reachable public source with its observation time; secret-gated and unported sources are recorded as unavailable', async () => {
    const S = load(stubs);
    const db = freshDb();
    const c = await S.collectServerSources(fakeEnv(db), { now: NOW, fetchImpl: net(), sleep: noSleep });
    const by = Object.fromEntries(c.observations.map((o) => [o.source_id, o]));
    expect(c.slotTs).toBe(Date.UTC(2026, 10, 1, 12));
    for (const id of ['fng', 'funding', 'longshort', 'hypefunding', 'oil', 'usd', 'gold', 'global', 'onchain', 'cryptonews', 'macrogeo', 'geopolitics', 'regulatory', 'hloi', 'foufi']) {
      expect(by[id].status, id).toBe('ok');
      expect(by[id].score).toBeGreaterThanOrEqual(0);
    }
    expect(by.fng).toMatchObject({ score: 63, observed_at: NOW - 3 * H });           // publisher time, not fetch time
    expect(by.foufi).toMatchObject({ score: 75, observed_at: NOW - 5 * H });
    expect(by.riskregime).toMatchObject({ status: 'error', score: null });
    expect(by.riskregime.error).toMatch(/INSUFFICIENT_DATA/);
    for (const id of ['yield10y', 'nasdaq', 'sp500', 'sosovalue']) expect(by[id]).toMatchObject({ status: 'unavailable', score: null });
    for (const id of ['etfflows', 'ninemag', 'strc']) expect(by[id].error).toMatch(/not collected server-side/);
    expect(c.observations).toHaveLength(Object.keys(S.SCOMP_SOURCE_REGISTRY).length);
  });

  it('uses FRED and SoSoValue only when their secrets are configured, with FRED observation dates', async () => {
    const S = load(stubs);
    const c = await S.collectServerSources(fakeEnv(freshDb(), { FRED_API_KEY: 'k', SOSO_API_KEY: 'k' }), { now: NOW, fetchImpl: net(), sleep: noSleep });
    const by = Object.fromEntries(c.observations.map((o) => [o.source_id, o]));
    expect(by.yield10y).toMatchObject({ status: 'ok', observed_at: Date.UTC(2026, 9, 30) });
    expect(by.sosovalue.status).toBe('ok');
  });

  it('times out, retries once, and records the failure instead of a neutral score', async () => {
    const S = load(stubs);
    const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const f = net({ 'https://mempool.space/api/v1/difficulty-adjustment': hang });
    const r = await S.scompFetch('https://mempool.space/api/v1/difficulty-adjustment', {}, { timeoutMs: 20, fetchImpl: f, sleep: noSleep }).catch((e) => e);
    expect(r.message).toBe('timeout after 20 ms');
    expect(r.attempts).toBe(2);
  });

  it('retries a 429 once and succeeds; a 404 is not retried', async () => {
    const S = load(stubs);
    let n = 0;
    const f = net({ 'https://api.alternative.me/fng/?limit=1': () => (++n === 1 ? json({}, 429) : json({ data: [{ value: '40', timestamp: String(Math.floor(NOW / 1000)) }] })) });
    const ok = await S.scompFetch('https://api.alternative.me/fng/?limit=1', {}, { fetchImpl: f, sleep: noSleep });
    expect(ok.attempts).toBe(2);
    const g = net({ 'https://x/y': () => json({}, 404) });
    const e = await S.scompFetch('https://x/y', {}, { fetchImpl: g, sleep: noSleep }).catch((x) => x);
    expect([e.message, e.attempts]).toEqual(['HTTP 404', 1]);
  });

  it('marks a stale publisher timestamp as stale, never as a valid reading', async () => {
    const S = load(stubs);
    const f = net({ 'https://api.alternative.me/fng/?limit=1': () => json({ data: [{ value: '80', timestamp: String(Math.floor((NOW - 50 * H) / 1000)) }] }) });
    const c = await S.collectServerSources(fakeEnv(freshDb()), { now: NOW, fetchImpl: f, sleep: noSleep });
    expect(c.observations.find((o) => o.source_id === 'fng')).toMatchObject({ status: 'stale', score: null, observed_at: NOW - 50 * H });
  });

  it('a source failing outright is recorded as error with its reason', async () => {
    const S = load(stubs);
    const f = net({ 'https://mempool.space/api/v1/difficulty-adjustment': () => json({ foo: 1 }) });
    const c = await S.collectServerSources(fakeEnv(freshDb()), { now: NOW, fetchImpl: f, sleep: noSleep });
    expect(c.observations.find((o) => o.source_id === 'onchain')).toMatchObject({ status: 'error', score: null, error: 'mempool.space: no difficultyChange' });
  });
});

describe('scomp-v1 composite and persistence', () => {
  it('renormalises over answering sources, lists every missing one, and flags readings below the 50% floor', async () => {
    const S = load(stubs);
    const c = await S.collectServerSources(fakeEnv(freshDb()), { now: NOW, fetchImpl: net(), sleep: noSleep });
    const comp = S.buildServerComposite(c, S.SENTIMENT_DEFAULT_WEIGHTS, NOW);
    const ok = c.observations.filter((o) => o.status === 'ok');
    const w = S.SENTIMENT_DEFAULT_WEIGHTS;
    const exact = ok.reduce((a, o) => a + o.score * w[o.source_id][0] * w[o.source_id][1], 0) / ok.reduce((a, o) => a + w[o.source_id][0] * w[o.source_id][1], 0);
    expect(comp.composite_exact).toBeCloseTo(exact, 9);
    expect(comp.provenance.missing.map((m) => m.id).sort()).toEqual(['etfflows', 'nasdaq', 'ninemag', 'riskregime', 'sosovalue', 'sp500', 'strc', 'yield10y']);
    expect(comp.completeness).toBeCloseTo(ok.reduce((a, o) => a + w[o.source_id][0], 0) / Object.values(w).reduce((a, x) => a + x[0], 0), 9);
    expect(comp.below_floor).toBe(0);
    const few = { slotTs: c.slotTs, observations: c.observations.map((o) => (['fng', 'onchain'].includes(o.source_id) ? o : { ...o, status: 'error', score: null })) };
    expect(S.buildServerComposite(few, w, NOW).below_floor).toBe(1);
  });

  it('writes one row per source and one reading per hour slot; a re-run of the slot writes nothing', async () => {
    const S = load(stubs);
    const db = freshDb();
    const env = fakeEnv(db);
    const a = await S.runServerComposite(env, { now: NOW, fetchImpl: net(), sleep: noSleep });
    const b = await S.runServerComposite(env, { now: NOW + 10 * 60000, fetchImpl: net(), sleep: noSleep });
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(db.prepare('SELECT COUNT(*) n FROM server_composite_readings').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM server_source_observations').get().n).toBe(Object.keys(S.SCOMP_SOURCE_REGISTRY).length);
    expect(db.prepare("SELECT COUNT(*) n FROM server_source_observations WHERE status != 'ok' AND score IS NOT NULL").get().n).toBe(0);
    const st = await S.getServerCompositeStatus(env, NOW + 2 * H, 24);
    expect(st.ok).toBe(true);
    expect(st.readings.n).toBe(1);
    expect(st.sources.find((s) => s.id === 'fng').n_ok).toBe(1);
  });

  it('status reports missing tables instead of failing', async () => {
    const S = load(stubs);
    const db = new DatabaseSync(':memory:');
    const st = await S.getServerCompositeStatus(fakeEnv(db), NOW, 24);
    expect(st).toMatchObject({ ok: false, enabled: false });
    expect(st.error).toMatch(/apply db\/migrations\/0002/);
  });
});

describe('migration 0002 in isolation', () => {
  it('is append-only, rejects a score on a failed source, and rolls back cleanly', () => {
    const db = freshDb();
    db.exec(MIG);   // idempotent
    db.prepare("INSERT INTO server_source_observations (slot_ts, source_id, status, score, fetched_at, collector_version) VALUES (1, 'fng', 'ok', 50, 1, 'v')").run();
    expect(() => db.exec("UPDATE server_source_observations SET score = 1")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM server_source_observations')).toThrow(/append-only/);
    expect(() => db.prepare("INSERT INTO server_source_observations (slot_ts, source_id, status, score, fetched_at, collector_version) VALUES (1, 'oil', 'error', 50, 1, 'v')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO server_source_observations (slot_ts, source_id, status, score, fetched_at, collector_version) VALUES (1, 'oil', 'ok', NULL, 1, 'v')").run()).toThrow(/CHECK/);
    db.exec(RB); db.exec(RB);
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'server_%'").get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM foufi_digest').get().n).toBe(1);
  });
});

describe('the collector is inert unless configured', () => {
  it('the hourly cron runs it only when SERVER_COMPOSITE is "1", and nothing writes to history', () => {
    expect(SRC).toContain("if (env.SERVER_COMPOSITE === '1') ctx.waitUntil(runServerComposite(env)");
    const block = between('// ═══ Server-side V1 sentiment collection', 'export default {');
    expect(block).not.toMatch(/INSERT[^`]*INTO history\b/);
  });
});

describe('parity with the browser scorers (CryptoPulse/index.html, when the checkout is present)', () => {
  let html; try { html = readFileSync(new URL('../../CryptoPulse/index.html', import.meta.url), 'utf8'); } catch { html = null; }
  const grab = (name) => { const i = html.indexOf(`function ${name}(`); let d = 0, j = html.indexOf('{', i);
    for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return html.slice(i - (html.slice(i - 6, i) === 'async ' ? 6 : 0), j + 1); };
  const lex = () => { const i = html.indexOf('const SENT_LEXICON='); return new Function(html.slice(i, html.indexOf('};', i) + 2) + '; return SENT_LEXICON;')(); };

  it('the lexicon is identical', () => {
    if (!html) return;
    expect(load(stubs).SCOMP_SENT_LEXICON).toEqual(lex());
  });

  it('headline scoring matches the browser on a fuzzed corpus (including hyphens, phrases and look-alike words)', () => {
    if (!html) return;
    const i = html.indexOf('const SENT_LEXICON=');
    const B = new Function(`${html.slice(i, html.indexOf('};', i) + 2)}\n${grab('to0_100')}\n${grab('satur')}\n${grab('scoreHeadline')}\n${grab('scoreHeadlineBatch')}\nreturn { scoreHeadline, scoreHeadlineBatch };`)();
    const S = load(stubs);
    const words = [...Object.keys(lex()), 'warsh', 'warfare', 'de', 'escalation', 'rate', 'cutting', "war's", 'sell', 'off', 'high-yield', 'U.S.', 'café', '2026', 'bitcoin', 'rate-cut', 'trade-war', 'peace', 'treaty', 'cut,', '(ban)'];
    let seed = 11;
    const rnd = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
    for (let k = 0; k < 600; k++) {
      const t = Array.from({ length: 2 + rnd(9) }, () => words[rnd(words.length)]).join(rnd(5) ? ' ' : '-');
      const title = rnd(2) ? t.toUpperCase() : t;
      expect(S.scompScoreHeadline(title), title).toEqual(B.scoreHeadline(title));
    }
    const batch = ['Bitcoin rally extends as ETF inflows surge', 'Exchange hacked, funds drained', 'Neutral headline'];
    expect(S.scompScoreHeadlineBatch(batch)).toBe(B.scoreHeadlineBatch(batch.map((title) => ({ title }))).score);
  });

  it('market scorers give the browser src* results on the same inputs', async () => {
    if (!html) return;
    const consts = 'const HL_ASSETS=["BTC","ETH","HYPE","SOL","LINK"];const HL_FUNDING_FLOOR_HOURLY=0.0000125;';
    const assets = {}; HL[0].universe.forEach((u, i) => { assets[u.name] = HL[1][i]; });
    const xyz = {}; XYZ[0].universe.forEach((u, i) => { xyz[u.name] = XYZ[1][i]; });
    const B = new Function('fetchHyperliquidAssets', 'fetchHyperliquidXyzAssets', 'fetch', 'window', 'renderGlobalMcapTile', 'cgFetch', 'CG',
      `${consts}\n${grab('to0_100')}\n${grab('satur')}\n${['srcFundingRate', 'srcLongShort', 'srcHypeFundingForComposite', 'srcOilFromHyperliquid', 'srcUsdFromHyperliquid', 'srcGoldFromHyperliquid', 'srcOnChain', 'srcGlobalMcap'].map(grab).join('\n')}
       return { srcFundingRate, srcLongShort, srcHypeFundingForComposite, srcOilFromHyperliquid, srcUsdFromHyperliquid, srcGoldFromHyperliquid, srcOnChain, srcGlobalMcap };`)(
      async () => assets, async () => xyz, async () => json({ difficultyChange: 3.1 }), {}, undefined,
      async () => json({ data: { market_cap_change_percentage_24h_usd: -2.4, total_market_cap: { usd: 1 } } }), 'cg');
    const S = load(stubs).scompScorers;
    expect(S.funding(assets)).toBe((await B.srcFundingRate()).score);
    expect(S.longshort(assets)).toBe((await B.srcLongShort()).score);
    expect(S.hypefunding(assets)).toBe((await B.srcHypeFundingForComposite()).score);
    expect(S.oil(xyz)).toBe((await B.srcOilFromHyperliquid()).score);
    expect(S.usd(xyz)).toBe((await B.srcUsdFromHyperliquid()).score);
    for (const ctx of [{}, { btcChg: -1, equitiesScore: 30 }, { btcChg: -1, equitiesScore: 70 }]) expect(S.gold(xyz, ctx)).toBe((await B.srcGoldFromHyperliquid(ctx)).score);
    expect(S.onchain({ difficultyChange: 3.1 })).toBe((await B.srcOnChain()).score);
    expect(S.global({ data: { market_cap_change_percentage_24h_usd: -2.4 } })).toBe((await B.srcGlobalMcap()).score);
  });
});
