import { describe, it, expect, beforeAll } from 'vitest';
import { extractFunctions, evalInScope } from './helpers/extract.js';

describe('isValidTxsPayload() — /txs-backup input validation', () => {
  let scope;

  beforeAll(() => {
    const src = extractFunctions('isValidTxsPayload');
    scope = evalInScope(src);
  });

  it('accepts a well-formed transaction array', () => {
    const txs = [{ asset: 'BTC', date: '2026-04-11', type: 'buy', qty: 0.1 }];
    expect(scope.isValidTxsPayload(txs)).toEqual({ valid: true });
  });

  it('accepts an empty array (legitimately means zero holdings, not an error)', () => {
    expect(scope.isValidTxsPayload([])).toEqual({ valid: true });
  });

  it('rejects a non-array payload', () => {
    expect(scope.isValidTxsPayload({ asset: 'BTC' }).valid).toBe(false);
  });

  it('rejects a payload over 5000 items', () => {
    const huge = Array.from({ length: 5001 }, () => ({ asset: 'BTC', date: '2026-04-11', type: 'buy', qty: 1 }));
    expect(scope.isValidTxsPayload(huge).valid).toBe(false);
  });

  it('rejects the whole batch if even one transaction is missing a required field', () => {
    const txs = [
      { asset: 'BTC', date: '2026-04-11', type: 'buy', qty: 0.1 },
      { asset: 'LINK', date: '2026-04-12', type: 'buy' }, // missing qty
    ];
    expect(scope.isValidTxsPayload(txs).valid).toBe(false);
  });

  it('rejects qty <= 0', () => {
    expect(scope.isValidTxsPayload([{ asset: 'BTC', date: '2026-04-11', type: 'buy', qty: 0 }]).valid).toBe(false);
    expect(scope.isValidTxsPayload([{ asset: 'BTC', date: '2026-04-11', type: 'buy', qty: -1 }]).valid).toBe(false);
  });

  it('rejects an unrecognized type value', () => {
    expect(scope.isValidTxsPayload([{ asset: 'BTC', date: '2026-04-11', type: 'transfer', qty: 1 }]).valid).toBe(false);
  });

  it('rejects non-string asset/date fields', () => {
    expect(scope.isValidTxsPayload([{ asset: 123, date: '2026-04-11', type: 'buy', qty: 1 }]).valid).toBe(false);
    expect(scope.isValidTxsPayload([{ asset: 'BTC', date: 20260411, type: 'buy', qty: 1 }]).valid).toBe(false);
  });
});
