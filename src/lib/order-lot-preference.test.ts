import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadOrderLotPreference, saveOrderLotPreference, TICKET_LOTS, QUICK_ORDER_LOTS } from './order-lot-preference';
import type { ContractInfo } from './types/contract';

const stock = { code: '2330', security_type: 'STK' } as ContractInfo;
beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    });
});
afterEach(() => vi.unstubAllGlobals());

it('stores units per symbol and surface without quantities or futures preferences', () => {
    saveOrderLotPreference('ticket', stock, 'Odd');
    saveOrderLotPreference('grid', stock, 'IntradayOdd');
    expect(loadOrderLotPreference('ticket', stock, TICKET_LOTS, 'Common')).toBe('Odd');
    expect(loadOrderLotPreference('grid', stock, QUICK_ORDER_LOTS, 'Common')).toBe('IntradayOdd');
    expect(loadOrderLotPreference('flash', stock, QUICK_ORDER_LOTS, 'Common')).toBe('Common');
    expect(loadOrderLotPreference('ticket', { ...stock, code: '2317' }, TICKET_LOTS, 'Common')).toBe('Common');
    for (const security_type of ['FUT', 'OPT']) {
        const future = { ...stock, security_type } as ContractInfo;
        saveOrderLotPreference('ticket', future, 'Common');
        expect(loadOrderLotPreference('ticket', future, TICKET_LOTS, 'Common')).toBe('Common');
    }
    expect(loadOrderLotPreference('ticket', stock, TICKET_LOTS, 'Common')).toBe('Odd');
});

it.each(['{', 'null', '[]', '{"ticket":{"2330":"BlockTrade"}}'])('ignores malformed or unsupported storage: %s', raw => {
    globalThis.localStorage.setItem('sj-pro-order-lot-preferences', raw);
    expect(loadOrderLotPreference('ticket', stock, TICKET_LOTS, 'Common')).toBe('Common');
    expect(() => saveOrderLotPreference('grid', stock, 'IntradayOdd')).not.toThrow();
});

it('tolerates denied reads and failed writes', () => {
    vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('quota'); },
    });
    expect(loadOrderLotPreference('flash', stock, QUICK_ORDER_LOTS, 'IntradayOdd')).toBe('IntradayOdd');
    expect(() => saveOrderLotPreference('flash', stock, 'Common')).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: () => '{}', setItem: () => { throw new Error('quota'); } });
    expect(() => saveOrderLotPreference('flash', stock, 'Common')).not.toThrow();
});

it('re-reads before writing and merges only this symbol after another window writes', () => {
    const key = 'sj-pro-order-lot-preferences';
    saveOrderLotPreference('ticket', stock, 'Odd');
    // 本視窗先讀取，另一視窗隨後更新不同商品與面板。
    expect(loadOrderLotPreference('ticket', stock, TICKET_LOTS, 'Common')).toBe('Odd');
    globalThis.localStorage.setItem(key, JSON.stringify({
        ticket: { '2330': 'Odd', '2317': 'IntradayOdd' },
        chart: { '2454': 'Common' },
    }));
    saveOrderLotPreference('ticket', stock, 'Common');
    expect(JSON.parse(globalThis.localStorage.getItem(key)!)).toEqual({
        ticket: { '2330': 'Common', '2317': 'IntradayOdd' },
        chart: { '2454': 'Common' },
    });
});
