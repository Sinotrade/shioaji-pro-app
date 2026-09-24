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

it('ignores unsigned / malformed values and other keys', async () => {
    const { getAccountState } = await loadStore();
    const before = getAccountState();
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-U' }) });
    onStorage({ key: KEY, newValue: 'not json' });
    onStorage({ key: KEY, newValue: null });
    onStorage({ key: 'other', newValue: JSON.stringify({ futures: 'BR-B' }) });
    expect(getAccountState()).toBe(before);
});

it('A→B→A: a local write followed by a remote change back is adopted', async () => {
    const { getAccountState, selectAccount } = await loadStore();
    // this window: A → B (writes B); other window then writes A
    selectAccount(accounts[1]!);
    expect(store.get(KEY)).toContain('BR-B');
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-A' }) });
    expect(getAccountState().selectedFutures?.account_id).toBe('A');
});

it('A→B→A: remote B then remote A, and a local pick after a remote change', async () => {
    const { getAccountState, selectAccount } = await loadStore();
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-B' }) });
    expect(getAccountState().selectedFutures?.account_id).toBe('B');
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-A' }) });
    expect(getAccountState().selectedFutures?.account_id).toBe('A');
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-B' }) });
    selectAccount(accounts[0]!);
    expect(getAccountState().selectedFutures?.account_id).toBe('A');
    onStorage({ key: KEY, newValue: JSON.stringify({ futures: 'BR-B' }) });
    expect(getAccountState().selectedFutures?.account_id).toBe('B');
});

it('re-fetches accounts once for a key this window has not seen, then adopts it', async () => {
    const { getAccountState } = await loadStore();
    const fresh = acc('F', 'C');
    m.fetch.mockResolvedValue([...accounts, fresh]);
    const raw = JSON.stringify({ futures: 'BR-C' });
    // the other window wrote it to storage before the event fires
    store.set(KEY, raw);
    onStorage({ key: KEY, newValue: raw });
    await vi.waitFor(() => expect(getAccountState().selectedFutures?.account_id).toBe('C'));
    expect(m.fetch).toHaveBeenCalledTimes(2);
});

it('a key still unknown after the re-fetch leaves the selection alone (no fetch loop)', async () => {
    const { getAccountState } = await loadStore();
    const raw = JSON.stringify({ futures: 'BR-ghost' });
    onStorage({ key: KEY, newValue: raw });
    await vi.waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(2));
    await new Promise(r => setTimeout(r, 0));
    expect(m.fetch).toHaveBeenCalledTimes(2);
    expect(getAccountState().selectedFutures?.account_id).toBe('A');
});
