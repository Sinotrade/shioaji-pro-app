// issue #139 — popouts follow the main window's account selection
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./shioaji', () => ({ fetchAccounts: m.fetch }));
const acc = (account_type: 'S' | 'F', account_id: string, signed = true): Account => ({ account_type, broker_id: 'BR', account_id, signed, person_id: '', username: '' });
const accounts = [acc('F', 'A'), acc('F', 'B'), acc('F', 'U', false), acc('S', 'S1'), acc('S', 'S2')];
const KEY = 'sj-pro-accounts-selected';
let onStorage!: (e: { key: string | null; newValue: string | null }) => void;
const store = new Map<string, string>();

async function loadStore() {
    vi.resetModules();
    vi.stubGlobal('window', { addEventListener: (type: string, fn: typeof onStorage) => { if (type === 'storage') onStorage = fn; } });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const mod = await import('./account-store');
    await mod.refreshAccounts();
    return mod;
}
beforeEach(() => { store.clear(); m.fetch.mockReset().mockResolvedValue(accounts); });
afterEach(() => vi.unstubAllGlobals());

it('adopts another window\'s selection from the storage event', async () => {
    const { getAccountState } = await loadStore();
    expect(getAccountState().selectedFutures?.account_id).toBe('A');
    onStorage({ key: KEY, newValue: JSON.stringify({ stock: 'BR-S2', futures: 'BR-B' }) });
    expect(getAccountState().selectedFutures?.account_id).toBe('B');
    expect(getAccountState().selectedStock?.account_id).toBe('S2');
});

it('ignores unsigned / unknown / malformed values and other keys', async () => {
    const { getAccountState } = await loadStore();
    const before = getAccountState();
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-U' }) });
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-nope' }) });
    onStorage({ key: KEY, newValue: 'not json' });
    onStorage({ key: KEY, newValue: null });
    onStorage({ key: 'other', newValue: JSON.stringify({ futures: 'BR-B' }) });
    expect(getAccountState()).toBe(before);
});

it('ignores an echo of its own write', async () => {
    const { getAccountState, selectAccount } = await loadStore();
    selectAccount(accounts[1]!);
    const written = store.get(KEY)!;
    const after = getAccountState();
    onStorage({ key: KEY, newValue: written });
    expect(getAccountState()).toBe(after);
});
