import { describe, it, expect } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

// EXP-028 research-only collectors: raw values, never weighted; failures store nothing.
function scopeWith(fetchImpl) {
  return evalInScope(extractFunctions('ensureResearchSnapshotTable', 'parseDeribitDvol', 'parseLlamaUsdtSupply', 'snapshotResearchSources'), { fetch: fetchImpl });
}
const NOW = Date.UTC(2026, 9, 11, 10, 2);
function db() { const rows = []; const calls = []; return { rows, calls, prepare(sql) { let a = []; const q = { bind(...x) { a = x; return q; }, async run() { calls.push(sql); if (/^INSERT/.test(sql)) rows.push(a); return {}; } }; return q; } }; }

describe('parsers', () => {
  const s = scopeWith(async () => ({}));
  it('Deribit DVOL takes the latest close and rejects empty/invalid data', () => {
    expect(s.parseDeribitDvol({ result: { data: [[1, 50, 52, 49, 51], [2, 51, 53, 50, 52.5]] } })).toBe(52.5);
    expect(() => s.parseDeribitDvol({ result: { data: [] } })).toThrow(/no data/);
    expect(() => s.parseDeribitDvol({ result: { data: [[1, 0, 0, 0, null]] } })).toThrow(/invalid/);
  });
  it('DeFiLlama picks USDT (id 1) circulating USD', () => {
    expect(s.parseLlamaUsdtSupply({ peggedAssets: [{ id: '2', symbol: 'USDC', circulating: { peggedUSD: 7 } }, { id: '1', symbol: 'USDT', circulating: { peggedUSD: 1.8e11 } }] })).toBe(1.8e11);
    expect(() => s.parseLlamaUsdtSupply({ peggedAssets: [] })).toThrow(/USDT/);
  });
});

describe('snapshotResearchSources', () => {
  it('stores each source independently at the hour; a failed source stores nothing', async () => {
    const s = scopeWith(async (url) => url.includes('deribit')
      ? { ok: true, json: async () => ({ result: { data: [[1, 1, 1, 1, 48.2]] } }) }
      : { ok: false, status: 503 });
    const d = db();
    const out = await s.snapshotResearchSources({ DB: d }, NOW);
    expect(out).toEqual({ deribit_dvol_btc: 48.2, defillama_usdt_supply: null });
    expect(d.calls[0]).toMatch(/CREATE TABLE IF NOT EXISTS research_source_snapshots/);
    expect(d.rows).toEqual([[Date.UTC(2026, 9, 11, 10), 'deribit_dvol_btc', 48.2]]);
  });
});
