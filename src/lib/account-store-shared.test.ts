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
beforeEach(async () => {
    vi.resetModules();
    store.clear();
    fetchAccounts.mockReset();
    mod = await import('./account-store');
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
