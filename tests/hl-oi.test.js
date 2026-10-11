import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions, evalInScope } from './helpers/extract.js';

const HL_CONSTS = readFileSync(new URL('../worker.js', import.meta.url), 'utf8').match(/^const HL_OI_[A-Z_]+ = .*;$/gm).join('\n');

// V1 composite source "hloi": hourly Hyperliquid BTC OI snapshots scored over 24h.
const scope = evalInScope(
  extractFunctions('ensureHlOiTable', 'parseHlBtcCtx', 'snapshotHyperliquidOi', 'scoreHlOi', 'getHlOiReading') + '\n' +
  HL_CONSTS,
  { fetch: async () => ({ ok: true, json: async () => PAYLOAD }) }
);
const PAYLOAD = [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ openInterest: '1', markPx: '1' }, { openInterest: '30000.5', markPx: '84000' }]];
const H = 3600000, NOW = Date.UTC(2026, 9, 11, 10, 5);

function db(rows = []) {
  const calls = [];
  return { calls, rows, prepare(sql) { let args = []; const q = {
    bind(...a) { args = a; return q; },
    async run() { calls.push(sql);
      if (/^INSERT OR IGNORE/.test(sql) && !rows.some(r => r.ts === args[0])) rows.push({ ts: args[0], open_interest: args[2], mark_px: args[3] });
      if (/^DELETE/.test(sql)) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < args[0]) rows.splice(i, 1);
      return {}; },
    async first() {
      const sorted = [...rows].sort((a, b) => b.ts - a.ts);
      if (/ORDER BY ts DESC LIMIT 1/.test(sql)) return sorted[0] || null;
      const [lo, hi, target] = args;
      return rows.filter(r => r.ts >= lo && r.ts <= hi).sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target))[0] || null;
    } }; return q; } };
}

describe('scoreHlOi (hloi-v1)', () => {
  it('direction from price, conviction from OI', () => {
    const up = scope.scoreHlOi({ open_interest: 110, mark_px: 102 }, { open_interest: 100, mark_px: 100 });
    expect(up.price_change_pct).toBeCloseTo(2, 9);
    expect(up.oi_change_pct).toBeCloseTo(10, 9);
    expect(up.conviction).toBeCloseTo(1.5, 9);
    expect(up.score).toBeCloseTo(65, 9);
    const coverRally = scope.scoreHlOi({ open_interest: 90, mark_px: 102 }, { open_interest: 100, mark_px: 100 });
    expect(coverRally.score).toBeCloseTo(50 + 10 * 0.5, 9);
    const newShorts = scope.scoreHlOi({ open_interest: 105, mark_px: 97 }, { open_interest: 100, mark_px: 100 });
    expect(newShorts.score).toBeCloseTo(50 - 15 * 1.5, 9);
  });
  it('is clamped to 0..100', () => {
    expect(scope.scoreHlOi({ open_interest: 200, mark_px: 130 }, { open_interest: 100, mark_px: 100 }).score).toBe(100);
    expect(scope.scoreHlOi({ open_interest: 200, mark_px: 70 }, { open_interest: 100, mark_px: 100 }).score).toBe(0);
  });
});

describe('parseHlBtcCtx', () => {
  it('finds BTC by name, rejects missing/invalid values', () => {
    expect(scope.parseHlBtcCtx(PAYLOAD)).toEqual({ open_interest: 30000.5, mark_px: 84000 });
    expect(() => scope.parseHlBtcCtx([{ universe: [{ name: 'ETH' }] }, [{}]])).toThrow(/BTC not in/);
    expect(() => scope.parseHlBtcCtx([{ universe: [{ name: 'BTC' }] }, [{ openInterest: '0', markPx: '84000' }]])).toThrow(/invalid/);
    expect(() => scope.parseHlBtcCtx({})).toThrow(/shape/);
  });
});

describe('snapshot + reading', () => {
  it('snapshot creates the table if needed, stores one row per minute, prunes beyond retention', async () => {
    const d = db([{ ts: NOW - 50 * 24 * H, open_interest: 1, mark_px: 1 }]);
    await scope.snapshotHyperliquidOi({ DB: d }, NOW);
    await scope.snapshotHyperliquidOi({ DB: d }, NOW + 20000);
    expect(d.calls[0]).toMatch(/CREATE TABLE IF NOT EXISTS hl_oi_snapshots/);
    expect(d.rows).toEqual([{ ts: Math.floor(NOW / 60000) * 60000, open_interest: 30000.5, mark_px: 84000 }]);
  });
  it('NO_DATA, STALE and INSUFFICIENT_HISTORY are reported, never a neutral score', async () => {
    expect(await scope.getHlOiReading({ DB: db() }, NOW)).toMatchObject({ status: 'NO_DATA' });
    const stale = await scope.getHlOiReading({ DB: db([{ ts: NOW - 3 * H, open_interest: 1, mark_px: 1 }]) }, NOW);
    expect(stale).toMatchObject({ status: 'STALE' });
    expect(stale.score).toBeUndefined();
    const young = await scope.getHlOiReading({ DB: db([{ ts: NOW - 5 * 60000, open_interest: 1, mark_px: 1 }, { ts: NOW - 20 * H, open_interest: 1, mark_px: 1 }]) }, NOW);
    expect(young).toMatchObject({ status: 'INSUFFICIENT_HISTORY' });
  });
  it('OK uses the snapshot nearest 24h before the latest, within 90 min', async () => {
    const latestTs = NOW - 5 * 60000;
    const rows = [
      { ts: latestTs, open_interest: 110, mark_px: 102 },
      { ts: latestTs - 24 * H + 20 * 60000, open_interest: 100, mark_px: 100 },
      { ts: latestTs - 23 * H, open_interest: 50, mark_px: 50 },
    ];
    const r = await scope.getHlOiReading({ DB: db(rows) }, NOW);
    expect(r).toMatchObject({ status: 'OK', version: 'hloi-v1', latest_ts: latestTs, prior_ts: latestTs - 24 * H + 20 * 60000 });
    expect(r.score).toBeCloseTo(65, 9);
  });
});
