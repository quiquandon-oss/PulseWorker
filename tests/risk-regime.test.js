import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// V1 composite source "riskregime" (rrs-v1). All candles here are synthetic TEST data.
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const CONSTS = SRC.match(/^const RRS_[A-Z_]+ = [\s\S]*?;$/gm).join('\n');
const FNS = ['rrsParseCandles', 'rrsPercentileRank', 'rrsUnderlyingOpen', 'rrsInstrumentFeatures', 'scoreRiskRegime',
  'rrsFetchCandles', 'ensureRiskRegimeTable', 'computeRiskRegimeReading', 'getRiskRegimeReading'];
const H = 3600000;
// Wednesday 2026-10-07 15:00 UTC: underlying markets open.
const T0 = Date.UTC(2026, 9, 7, 15);
const SYMBOLS = ['xyz:SP500', 'xyz:XYZ100', 'xyz:GOLD', 'xyz:SILVER', 'xyz:COPPER', 'xyz:BRENTOIL', 'xyz:EUR', 'para:10Y'];

// 200 hourly candles closing before `end`; a deterministic small wiggle, then the
// last 6 candles move by `lastMovePct` in total (0 = no shock).
function candles({ end = T0, lastMovePct = 0, hours = 200, volume = 10 } = {}) {
  const out = []; let px = 100;
  for (let k = hours; k >= 1; k--) {
    const t = end - k * H;
    const wiggle = ((k * 7919) % 13 - 6) / 100; // within +-0.06 % per hour
    const step = k <= 6 ? lastMovePct / 6 : wiggle;
    const o = px; px = px * (1 + step / 100);
    out.push({ t, T: t + H - 1, o: String(o), h: String(Math.max(o, px)), l: String(Math.min(o, px)), c: String(px), v: String(volume), n: 5 });
  }
  return out;
}
// Big enough to clear the 5th/95th percentile of the wiggle baseline.
const DOWN = -3, UP = 3;

function scope(market = {}, { fail = new Set() } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    const coin = JSON.parse(init.body).req.coin; calls.push(coin);
    if (fail.has(coin)) return { ok: false, status: 503 };
    const m = market[coin];
    return { ok: true, json: async () => (typeof m === 'function' ? m() : m || candles()) };
  };
  return { s: evalInScope(CONSTS + '\n' + extractFunctions(...FNS), { fetch }), calls };
}
function featsFor(moves, end = T0) {
  const { s } = scope();
  const f = {};
  for (const sym of SYMBOLS) f[sym] = s.rrsInstrumentFeatures(s.rrsParseCandles(candles({ end, lastMovePct: moves[sym] || 0 })), end);
  return { s, f };
}
function db() {
  const rows = new Map(); const sqls = [];
  return { rows, sqls, prepare(sql) { let a = []; const q = {
    bind(...x) { a = x; return q; },
    async run() { sqls.push(sql);
      if (/^INSERT OR IGNORE INTO risk_regime_readings/.test(sql) && !rows.has(a[0])) rows.set(a[0], { ts: a[0], version: a[1], status: a[2], score: a[3], regime: a[4], reading_json: a[5], generated_ts: a[6] });
      if (/^DELETE FROM risk_regime_readings/.test(sql)) for (const k of [...rows.keys()]) if (k < a[0]) rows.delete(k);
      return {}; },
    async first() { const r = [...rows.values()].sort((x, y) => y.ts - x.ts); return r[0] || null; },
    async all() { return { results: [...rows.values()].filter(r => r.ts >= a[0]).sort((x, y) => x.ts - y.ts).map(({ ts, status, score, regime }) => ({ ts, status, score, regime })) }; },
  }; return q; } };
}

describe('scoreRiskRegime (rrs-v1): regimes', () => {
  it('calm market -> OK, neutral 50 as a real reading', () => {
    const { s, f } = featsFor({});
    const r = s.scoreRiskRegime(f, T0);
    expect(r).toMatchObject({ status: 'OK', score: 50, regime: 'CALM', version: 'rrs-v1', source: 'riskregime' });
    expect(r.counts.breadth_measurable).toBe(7);
  });
  it('classic risk-off shock across groups -> bearish', () => {
    const { s, f } = featsFor({ 'xyz:SP500': DOWN, 'xyz:XYZ100': DOWN, 'xyz:GOLD': UP, 'xyz:COPPER': DOWN, 'para:10Y': DOWN });
    const r = s.scoreRiskRegime(f, T0);
    expect(r.regime).toBe('RISK_OFF_SHOCK');
    expect(r.score).toBeCloseTo(50 - 40 * 5 / 6, 1);
    expect(r.counts.risk_off_groups.sort()).toEqual(['commodity', 'equity', 'rates']);
    expect(r.explanation).toMatch(/Risk-off cross-asset shock/);
  });
  it('broad risk-on shock -> bullish, but only with breadth and confirmation', () => {
    const { s, f } = featsFor({ 'xyz:SP500': UP, 'xyz:COPPER': UP, 'xyz:EUR': UP, 'para:10Y': UP });
    const r = s.scoreRiskRegime(f, T0);
    expect(r.regime).toBe('RISK_ON_SHOCK');
    expect(r.score).toBeCloseTo(50 + 40 * 4 / 6, 1);
  });
  it('rising risk appetite in one instrument, or falling equities alone, is not a shock', () => {
    const { s, f } = featsFor({ 'xyz:SP500': UP, 'xyz:XYZ100': UP });
    expect(s.scoreRiskRegime(f, T0)).toMatchObject({ score: 50, regime: 'ISOLATED' });
    // Three abnormal, all one group on the directional side -> unconfirmed.
    const g = featsFor({ 'xyz:SP500': DOWN, 'xyz:XYZ100': DOWN, 'xyz:SILVER': DOWN, 'xyz:BRENTOIL': DOWN });
    expect(g.s.scoreRiskRegime(g.f, T0)).toMatchObject({ score: 50, regime: 'UNCONFIRMED' });
  });
  it('contradictory indicators cancel -> MIXED at 50', () => {
    const { s, f } = featsFor({ 'xyz:SP500': DOWN, 'xyz:GOLD': UP, 'xyz:COPPER': UP, 'xyz:EUR': UP });
    const r = s.scoreRiskRegime(f, T0);
    expect(r).toMatchObject({ regime: 'MIXED', score: 50 });
    expect(r.counts.risk_off_votes).toBe(2);
    expect(r.counts.risk_on_votes).toBe(2);
  });
});

describe('missing, stale, malformed, delayed and closed-market inputs', () => {
  it('weekend: MARKETS_CLOSED, no score', () => {
    const sat = Date.UTC(2026, 9, 10, 12);
    const { s, f } = featsFor({}, sat);
    const r = s.scoreRiskRegime(f, sat);
    expect(r.status).toBe('MARKETS_CLOSED');
    expect(r.score).toBeUndefined();
    expect(s.rrsUnderlyingOpen(Date.UTC(2026, 9, 9, 20, 59))).toBe(true);   // Fri 20:59
    expect(s.rrsUnderlyingOpen(Date.UTC(2026, 9, 11, 22, 0))).toBe(true);   // Sun 22:00
  });
  it('a stale or missing instrument is rejected; too few measurable -> INSUFFICIENT_DATA, no score', () => {
    const { s } = scope();
    const delayed = s.rrsInstrumentFeatures(s.rrsParseCandles(candles({ end: T0 - 3 * H })), T0);
    expect(delayed.status).toBe('STALE');
    const f = {};
    for (const sym of SYMBOLS) f[sym] = s.rrsInstrumentFeatures(s.rrsParseCandles(candles({ end: T0 - 3 * H })), T0);
    f['xyz:SP500'] = s.rrsInstrumentFeatures(s.rrsParseCandles(candles()), T0);
    const r = s.scoreRiskRegime(f, T0);
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.score).toBeUndefined();
    expect(r.rejected.length).toBe(7);
    // One missing instrument still leaves 6 measurable breadth instruments.
    const g = featsFor({}); delete g.f['xyz:GOLD'];
    const ok = g.s.scoreRiskRegime(g.f, T0);
    expect(ok.status).toBe('OK');
    expect(ok.rejected).toEqual(['Gold: NO_DATA']);
  });
  it('flat zero-volume candles are INACTIVE; short history is INSUFFICIENT_HISTORY', () => {
    const { s } = scope();
    const flat = candles({ volume: 0 }).map(c => ({ ...c, o: '100', h: '100', l: '100', c: '100' }));
    expect(s.rrsInstrumentFeatures(s.rrsParseCandles(flat), T0).status).toBe('INACTIVE');
    expect(s.rrsInstrumentFeatures(s.rrsParseCandles(candles({ hours: 60 })), T0).status).toBe('INSUFFICIENT_HISTORY');
  });
  it('malformed payloads throw (never a reading)', () => {
    const { s } = scope();
    expect(() => s.rrsParseCandles({ error: 'x' })).toThrow(/expected a list/);
    expect(() => s.rrsParseCandles([{ t: 1, T: 2, o: 'x', h: '1', l: '1', c: '1', v: '1' }])).toThrow(/malformed/);
    expect(() => s.rrsParseCandles([{ t: 1, T: 2, o: '1', h: '1', l: '1', c: '0', v: '1' }])).toThrow(/malformed/);
  });
  it('provider failure for an instrument is recorded as ERROR and excluded', async () => {
    const { s } = scope({}, { fail: new Set(['xyz:GOLD', 'xyz:SILVER', 'xyz:COPPER']) });
    const r = await s.computeRiskRegimeReading({ DB: db() }, T0 + 5 * 60000);
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.inputs.find(i => i.symbol === 'xyz:GOLD')).toMatchObject({ status: 'ERROR' });
  });
});

describe('no look-ahead', () => {
  it('ignores the in-progress candle and anything after the scoring hour', () => {
    const { s } = scope();
    const base = candles();
    // A huge move in a candle that closes AFTER the scoring timestamp must not count.
    const future = [...base, { t: T0, T: T0 + H - 1, o: '100', h: '200', l: '100', c: '200', v: '10' }];
    const a = s.rrsInstrumentFeatures(s.rrsParseCandles(base), T0);
    const b = s.rrsInstrumentFeatures(s.rrsParseCandles(future), T0);
    expect(b).toEqual(a);
  });
  it('the fetch window ends at the scoring hour', async () => {
    const seen = [];
    const s = evalInScope(CONSTS + '\n' + extractFunctions(...FNS), { fetch: async (_u, init) => { seen.push(JSON.parse(init.body).req); return { ok: true, json: async () => candles() }; } });
    await s.computeRiskRegimeReading({ DB: db() }, T0 + 25 * 60000);
    expect(seen.every(r => r.endTime === T0 && r.interval === '1h')).toBe(true);
  });
});

describe('storage, idempotency, staleness and history', () => {
  it('one row per hour however often it runs', async () => {
    const d = db();
    const { s } = scope();
    await s.computeRiskRegimeReading({ DB: d }, T0 + 60000);
    await s.computeRiskRegimeReading({ DB: d }, T0 + 30 * 60000);
    await s.getRiskRegimeReading({ DB: d }, T0 + 40 * 60000);
    expect(d.rows.size).toBe(1);
    const row = d.rows.get(T0);
    expect(row).toMatchObject({ version: 'rrs-v1', status: 'OK', score: 50, regime: 'CALM' });
    const audit = JSON.parse(row.reading_json);
    expect(audit.inputs).toHaveLength(8);
    expect(audit.inputs[0]).toHaveProperty('last_close_ts');
    expect(audit.generated_ts).toBe(T0 + 60000);
  });
  it('GET scores the current hour once, then serves the stored reading', async () => {
    const d = db();
    const { s, calls } = scope();
    const a = await s.getRiskRegimeReading({ DB: d }, T0 + 5 * 60000);
    const n = calls.length;
    const b = await s.getRiskRegimeReading({ DB: d }, T0 + 50 * 60000);
    expect(calls.length).toBe(n);
    expect(a.status).toBe('OK');
    expect(b.scoring_ts).toBe(T0);
  });
  it('collection failing for over 2h -> STALE with no score', async () => {
    const d = db();
    await scope().s.computeRiskRegimeReading({ DB: d }, T0);
    const { s } = scope({}, { fail: new Set(SYMBOLS) });
    const r = await s.getRiskRegimeReading({ DB: d }, T0 + 3 * H);
    // The failed hour is stored as INSUFFICIENT_DATA (honest record, no score).
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.score).toBeUndefined();
    const dead = { DB: { prepare(sql) { const q = { bind() { return q; }, async run() { if (/^INSERT/.test(sql)) throw new Error('D1 down'); return {}; },
      async first() { return { ts: T0, reading_json: d.rows.get(T0).reading_json }; } }; return q; } } };
    const st = await scope().s.getRiskRegimeReading(dead, T0 + 3 * H);
    expect(st.status).toBe('STALE');
    expect(st.score).toBeUndefined();
    expect(st.reason).toMatch(/refresh failed: D1 down/);
  });
  it('history lists stored hours', async () => {
    const d = db();
    const { s } = scope();
    for (let k = 0; k < 3; k++) await s.computeRiskRegimeReading({ DB: d }, T0 + k * H);
    const r = await s.getRiskRegimeReading({ DB: d }, T0 + 2 * H + 60000, 24);
    expect(r.history.map(h => h.ts)).toEqual([T0, T0 + H, T0 + 2 * H]);
  });
});

describe('composite defaults mirror', () => {
  it('riskregime is in the shadow-adaptation defaults at 4 x 0.3 and the version is bumped', () => {
    expect(SRC).toMatch(/riskregime: \[4, 0\.3\]/);
    expect(SRC).toMatch(/SENTIMENT_DEFAULT_WEIGHTS_VERSION = '2026-10-12-riskregime'/);
  });
});
