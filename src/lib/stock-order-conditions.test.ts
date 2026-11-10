import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteStockOrderConditions, resetStockOrderConditionsForTest, stockDayStart, stockOrderConditions } from './stock-order-conditions';
import type { Account } from './types/portfolio';

const KEY = 'sj-pro-stock-order-conds';
const acct: Account = { account_type: 'S', broker_id: 'BR', account_id: 'A1', signed: true, person_id: '', username: '' };
const tpe = (d: number, h: number, mi = 0) => Date.UTC(2026, 10, d, h - 8, mi); // 2026-11-d hh:mm Taipei
let store: Record<string, string>;
beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    resetStockOrderConditionsForTest();
});
afterEach(() => { vi.unstubAllGlobals(); resetStockOrderConditionsForTest(); });

it('stock day starts at Taipei midnight, so 15:00 is still today', () => {
    expect(stockDayStart(tpe(10, 15, 30))).toBe(tpe(10, 0) / 1000);
    expect(stockDayStart(tpe(10, 0, 0))).toBe(tpe(10, 0) / 1000);
    expect(stockDayStart(tpe(10, 23, 59))).toBe(tpe(10, 0) / 1000);
});

// review P1: Trade.order.id is the sidecar's; seqno/ordno are the broker's
it('keys by account + broker seqno and survives a reload (another window / restarted sidecar with new ids)', () => {
    const now = tpe(10, 10);
    noteStockOrderConditions(acct, { seqno: 'S1', ordno: 'X001' }, { daytrade_short: true }, now);
    noteStockOrderConditions(acct, { seqno: 'S2' }, { order_cond: 'MarginTrading' }, now);
    resetStockOrderConditionsForTest(); // forget memory, read storage
    expect(stockOrderConditions(acct, { seqno: 'S1', ordno: 'X001' }, now)).toEqual({ cond: 'Cash', daytradeShort: true });
    expect(stockOrderConditions(acct, { seqno: 'S1' }, now)).toEqual({ cond: 'Cash', daytradeShort: true }); // row without ordno yet
    expect(stockOrderConditions(acct, { seqno: 'S2', ordno: 'X002' }, now)).toEqual({ cond: 'MarginTrading', daytradeShort: false });
    expect(stockOrderConditions({ ...acct, account_id: 'A2' }, { seqno: 'S1' }, now)).toBeUndefined();
    expect(stockOrderConditions(acct, { seqno: 'other' }, now)).toBeUndefined();
    expect(stockOrderConditions(acct, {}, now)).toBeUndefined();
});

it('a different ordno on the same seqno is another order: unknown', () => {
    const now = tpe(10, 10);
    noteStockOrderConditions(acct, { seqno: 'S1', ordno: 'X001' }, { daytrade_short: true }, now);
    expect(stockOrderConditions(acct, { seqno: 'S1', ordno: 'Y999' }, now)).toBeUndefined();
});

it('does not record an order without a broker seqno', () => {
    noteStockOrderConditions(acct, { seqno: '' }, { daytrade_short: true }, tpe(10, 10));
    expect(store[KEY]).toBeUndefined();
});

// review P2: two windows must not overwrite each other's records
it('merges with what another window wrote instead of overwriting it', () => {
    const now = tpe(10, 10);
    noteStockOrderConditions(acct, { seqno: 'main' }, { daytrade_short: true }, now); // this window caches
    // the popout writes its own record straight to storage
    const other = JSON.parse(store[KEY]!);
    store[KEY] = JSON.stringify({ ...other, 'BR:A1:popout': { cond: 'Cash', daytradeShort: true, at: now / 1000 } });
    noteStockOrderConditions(acct, { seqno: 'main2' }, { daytrade_short: false }, now); // no storage event delivered yet
    expect(Object.keys(JSON.parse(store[KEY]!)).sort()).toEqual(['BR:A1:main', 'BR:A1:main2', 'BR:A1:popout']);
    expect(stockOrderConditions(acct, { seqno: 'popout' }, now)).toEqual({ cond: 'Cash', daytradeShort: true });
});

it('a storage event from another window refreshes the cache', () => {
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal('window', { addEventListener: (_: string, l: (e: { key: string | null }) => void) => listeners.push(l) });
    return import('./stock-order-conditions?storage-event' as string).then((mod: typeof import('./stock-order-conditions')) => {
        const now = tpe(10, 10);
        expect(mod.stockOrderConditions(acct, { seqno: 'p' }, now)).toBeUndefined(); // cached empty
        store[KEY] = JSON.stringify({ 'BR:A1:p': { cond: 'Cash', daytradeShort: true, at: now / 1000 } });
        expect(mod.stockOrderConditions(acct, { seqno: 'p' }, now)).toBeUndefined(); // still cached
        listeners.forEach(l => l({ key: KEY }));
        expect(mod.stockOrderConditions(acct, { seqno: 'p' }, now)).toEqual({ cond: 'Cash', daytradeShort: true });
    });
});

// review P3: a window left open overnight
it('prunes yesterday on read and on write, not only on load', () => {
    noteStockOrderConditions(acct, { seqno: 'y' }, { daytrade_short: true }, tpe(10, 13));
    expect(stockOrderConditions(acct, { seqno: 'y' }, tpe(10, 23, 59))).toEqual({ cond: 'Cash', daytradeShort: true });
    expect(stockOrderConditions(acct, { seqno: 'y' }, tpe(11, 0, 1))).toBeUndefined(); // same window, next day
    noteStockOrderConditions(acct, { seqno: 't' }, { daytrade_short: false }, tpe(11, 9));
    expect(Object.keys(JSON.parse(store[KEY]!))).toEqual(['BR:A1:t']);
});

it('ignores corrupt storage', () => {
    store[KEY] = '{not json';
    expect(stockOrderConditions(acct, { seqno: 'x' }, tpe(10, 10))).toBeUndefined();
    store[KEY] = JSON.stringify({ 'BR:A1:bad': { cond: 1 } });
    resetStockOrderConditionsForTest();
    expect(stockOrderConditions(acct, { seqno: 'bad' }, tpe(10, 10))).toBeUndefined();
    noteStockOrderConditions(acct, { seqno: 'ok' }, {}, tpe(10, 10));
    expect(Object.keys(JSON.parse(store[KEY]!))).toEqual(['BR:A1:ok']);
});
