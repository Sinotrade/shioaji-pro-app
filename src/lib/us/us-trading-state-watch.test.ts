import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: [] as unknown[],
    accountListeners: new Set<() => void>(),
    ensureStream: vi.fn(),
}));
vi.mock('../account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }),
    subscribeAccounts: (fn: () => void) => { m.accountListeners.add(fn); return () => { m.accountListeners.delete(fn); }; },
}));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../stream', () => ({
    ensureStream: m.ensureStream, getStreamStatus: () => 'down',
    onOrderEvent: () => () => undefined, subscribeStatusStore: () => () => undefined,
}));
vi.mock('./us-api', () => ({ fetchUsTrades: vi.fn(), fetchUsTradeCacheHealth: vi.fn(), fetchUsPositions: vi.fn() }));
vi.mock('../api', () => ({ apiGet: vi.fn() }));

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const S = { ...H, account_type: 'S' };

beforeEach(() => {
    vi.resetModules();
    m.accounts = [];
    m.accountListeners.clear();
    m.ensureStream.mockReset();
});

describe('watchUsTradingState (app-level lifecycle)', () => {
    it('starts as soon as an H account exists, without any US panel', async () => {
        m.accounts = [S, H];
        const us = await import('./us-trading-state');
        us.watchUsTradingState();
        expect(m.ensureStream).toHaveBeenCalledTimes(1);
    });

    it('waits for a late account list, then starts once', async () => {
        m.accounts = [S];
        const us = await import('./us-trading-state');
        const stop = us.watchUsTradingState();
        expect(m.ensureStream).not.toHaveBeenCalled();
        m.accounts = [S, H];
        [...m.accountListeners].forEach(l => l());
        [...m.accountListeners].forEach(l => l());
        expect(m.ensureStream).toHaveBeenCalledTimes(1);
        stop();
    });

    it('never starts without an H account', async () => {
        m.accounts = [S];
        const us = await import('./us-trading-state');
        const stop = us.watchUsTradingState();
        [...m.accountListeners].forEach(l => l());
        expect(m.ensureStream).not.toHaveBeenCalled();
        stop();
        expect(m.accountListeners.size).toBe(0);
    });
});
