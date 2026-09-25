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
};

const account = { account_type: 'S', broker_id: 'b', account_id: 'a', person_id: 'p', signed: true, username: 'u' };

let mod: typeof import('./account-store');
beforeEach(async () => {
    vi.resetModules();
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
        expect(mod.getAccountState()).toMatchObject({ loaded: true, accounts: [] });
    });

    it('a later read is a fresh request', async () => {
        fetchAccounts.mockResolvedValue([account]);
        await mod.loadAccountsShared();
        await mod.loadAccountsShared();
        expect(fetchAccounts).toHaveBeenCalledTimes(2);
    });
});
