import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteStockOrderConditions, resetStockOrderConditionsForTest, stockOrderConditions } from './stock-order-conditions';
import type { Account } from './types/portfolio';

const acct: Account = { account_type: 'S', broker_id: 'BR', account_id: 'A1', signed: true, person_id: '', username: '' };
let store: Record<string, string>;
beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    resetStockOrderConditionsForTest();
});
afterEach(() => { vi.unstubAllGlobals(); resetStockOrderConditionsForTest(); });

it('records the request conditions per account and order id, and survives a reload (another window)', () => {
    noteStockOrderConditions(acct, 'o1', { daytrade_short: true });
    noteStockOrderConditions(acct, 'o2', { order_cond: 'MarginTrading' });
    resetStockOrderConditionsForTest(); // forget memory, read storage
    expect(stockOrderConditions(acct, 'o1')).toEqual({ cond: 'Cash', daytradeShort: true });
    expect(stockOrderConditions(acct, 'o2')).toEqual({ cond: 'MarginTrading', daytradeShort: false });
    expect(stockOrderConditions({ ...acct, account_id: 'A2' }, 'o1')).toBeUndefined();
    expect(stockOrderConditions(acct, 'other')).toBeUndefined();
});

it('drops entries from an earlier trading day and ignores corrupt storage', () => {
    store['sj-pro-stock-order-conds'] = JSON.stringify({ 'BR:A1:old': { cond: 'Cash', daytradeShort: true, at: 1 }, 'BR:A1:bad': { cond: 1 } });
    expect(stockOrderConditions(acct, 'old')).toBeUndefined();
    expect(stockOrderConditions(acct, 'bad')).toBeUndefined();
    store['sj-pro-stock-order-conds'] = '{not json';
    resetStockOrderConditionsForTest();
    expect(stockOrderConditions(acct, 'old')).toBeUndefined();
});
