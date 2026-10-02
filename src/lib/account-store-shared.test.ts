// src/lib/account-store-shared.test.ts — boot's store load and the
// trade-report subscription share one /auth/accounts request (#142)

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAccounts } = vi.hoisted(() => ({ fetchAccounts: vi.fn() }));
vi.mock('./shioaji', () => ({ fetchAccounts }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

const account = { account_type: 'S', broker_id: 'b', account_id: 'a', person_id: 'p', signed: true, username: 'u' };

let mod: typeof import('./account-store');
let info: typeof import('./server-info-store');
beforeEach(async () => {
    vi.resetModules();
    store.clear();
    fetchAccounts.mockReset();
    mod = await import('./account-store');
    info = await import('./server-info-store');
});

describe('unsigned simulation accounts (#228)', () => {
    const unsigned = { ...account, signed: false };
    const mode = (simulation: boolean) => info.observeServerInfo(info.beginServerInfoRequest(), { simulation } as import('./shioaji').ServerInfo);

    it('restores the simulation choice after temporarily falling back to a signed account', async () => {
        mode(true);
        const signed = { ...account, account_id: 'signed' };
        fetchAccounts.mockResolvedValue([signed, unsigned]);
        await mod.loadAccountsShared();
        mod.selectAccount(unsigned);
        mode(false);
        expect(mod.accountFor('S')).toBe(signed);
        await mod.loadAccountsShared();
        mode(true);
        expect(mod.accountFor('S')).toBe(unsigned);
    });

    it('selects unsigned stock and futures accounts in simulation without changing signed', async () => {
        mode(true);
        const futures = { ...unsigned, account_type: 'F', account_id: 'f' };
        fetchAccounts.mockResolvedValue([unsigned, futures]);
        await mod.loadAccountsShared();
        expect(mod.accountFor('S')).toBe(unsigned);
        expect(mod.accountFor('F')).toBe(futures);
        mod.selectAccount(unsigned);
        expect(mod.getAccountState().selectedStock).toBe(unsigned);
        expect(unsigned.signed).toBe(false);
    });

    it.each([false, undefined])('blocks unsigned accounts when simulation=%s', async simulation => {
        if (simulation !== undefined) mode(simulation);
        fetchAccounts.mockResolvedValue([unsigned]);
        await mod.loadAccountsShared();
        mod.selectAccount(unsigned);
        expect(mod.getAccountState().selectedStock).toBeNull();
        expect(mod.accountFor('S')).toBeUndefined();
    });

    it('recalculates selection when unknown mode becomes simulation, then blocks production and unknown again', async () => {
        const second = { ...unsigned, account_id: 'second' };
        store.set('sj-pro-accounts-selected', JSON.stringify({ stock: 'b-second' }));
        fetchAccounts.mockResolvedValue([unsigned, second]);
        await mod.loadAccountsShared();
        expect(mod.accountFor('S')).toBeUndefined();
        const listener = vi.fn();
        const stop = mod.subscribeAccounts(listener);
        try {
            mode(true);
            expect(mod.accountFor('S')).toBe(second);
            expect(listener).toHaveBeenCalledOnce();
            expect(fetchAccounts).toHaveBeenCalledOnce();
            mode(false);
            expect(mod.getAccountState().selectedStock).toBeNull();
            mode(true);
            expect(mod.accountFor('S')).toBe(second);
            info.forgetServerInfo('');
            expect(mod.getAccountState().selectedStock).toBeNull();
            expect(second.signed).toBe(false);
        } finally { stop(); }
    });
});

describe('shared account read', () => {
    it('store load + subscription at the same time → one request', async () => {
        let release!: (v: unknown) => void;
        fetchAccounts.mockReturnValue(new Promise((r) => { release = r; }));
        mod.ensureAccounts();
        const sub = mod.loadAccountsShared();
        release([account]);
        expect(await sub).toEqual([account]);
        expect(fetchAccounts).toHaveBeenCalledTimes(1);
        expect(mod.getAccountState()).toMatchObject({ loaded: true, selectedStock: account });
    });

    it('the subscription sees failures (the store load swallows them)', async () => {
        fetchAccounts.mockRejectedValue(new Error('503'));
        await expect(mod.loadAccountsShared()).rejects.toThrow('503');
        await mod.refreshAccounts();
        expect(mod.getAccountState()).toMatchObject({ loaded: true, loadError: true, accounts: [] });
    });

    it('a re-read keeps this window\'s selection, not what another window saved', async () => {
        const a2 = { ...account, account_id: 'a2' };
        fetchAccounts.mockResolvedValue([account, a2]);
        await mod.loadAccountsShared();
        mod.selectAccount(account); // this window trades on 'a'
        // another window picks a2 and saves it
        store.set('sj-pro-accounts-selected', JSON.stringify({ stock: 'b-a2' }));
        await mod.loadAccountsShared(); // e.g. trade-report re-subscription
        expect(mod.getAccountState().selectedStock).toEqual(account);
        await mod.refreshAccounts();
        expect(mod.getAccountState().selectedStock).toEqual(account);
    });

    it('falls back when the selected account is gone or no longer signed', async () => {
        const a2 = { ...account, account_id: 'a2' };
        fetchAccounts.mockResolvedValue([account, a2]);
        await mod.loadAccountsShared();
        mod.selectAccount(a2);
        fetchAccounts.mockResolvedValue([account, { ...a2, signed: false }]);
        await mod.loadAccountsShared();
        expect(mod.getAccountState().selectedStock).toEqual(account);
    });

    it('a type with no signed account at first load still gets the saved pick later', async () => {
        const a2 = { ...account, account_id: 'a2' };
        store.set('sj-pro-accounts-selected', JSON.stringify({ stock: 'b-a2' }));
        fetchAccounts.mockResolvedValue([{ ...account, signed: false }, { ...a2, signed: false }]);
        await mod.loadAccountsShared();
        expect(mod.getAccountState().selectedStock).toBeNull();
        fetchAccounts.mockResolvedValue([account, a2]); // both signed now
        await mod.loadAccountsShared();
        expect(mod.getAccountState().selectedStock).toEqual(a2); // not the first
    });

    it('the first load still honours the saved selection', async () => {
        const a2 = { ...account, account_id: 'a2' };
        store.set('sj-pro-accounts-selected', JSON.stringify({ stock: 'b-a2' }));
        fetchAccounts.mockResolvedValue([account, a2]);
        await mod.loadAccountsShared();
        expect(mod.getAccountState().selectedStock).toEqual(a2);
    });

    it('a later read is a fresh request', async () => {
        fetchAccounts.mockResolvedValue([account]);
        await mod.loadAccountsShared();
        await mod.loadAccountsShared();
        expect(fetchAccounts).toHaveBeenCalledTimes(2);
    });
});
