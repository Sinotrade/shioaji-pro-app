import { describe, expect, it, vi } from 'vitest';
import { accountMatches, flashAccountKey, flashPopoutParams, loadPopoutFlashAccounts, newPopoutWindowId, pinnedFlashAccounts, resolveFlashAccount, savePopoutFlashAccounts, scopedFlashRows, touchPopoutFlashAccounts } from './flash-account';
import type { Account } from './types/portfolio';
const a: Account = { account_type: 'F', broker_id: 'B', account_id: 'A', signed: true, person_id: '', username: '' };
const b = { ...a, account_id: 'B' };
describe('flash account ownership', () => {
    it('isolates same-product accounts and rejects missing or conflicting ownership', () => {
        const mine = { code: 'TMF', account: a };
        const other = { code: 'TMF', account: b };
        const conflict = { code: 'TMF', account: a, order: { account: b } };
        expect(scopedFlashRows([mine, other, conflict, { code: 'TMF', account: undefined }], a)).toEqual([mine]);
        expect(scopedFlashRows([mine], undefined)).toEqual([]);
        expect(scopedFlashRows([{ order: { account: a } }], a)).toHaveLength(1);
    });
    it('compares market and broker as well as account id', () => {
        expect(accountMatches(a, { ...a, broker_id: 'OTHER' })).toBe(false);
        expect(accountMatches(a, { ...a, account_type: 'S' })).toBe(false);
        expect(accountMatches(a, null)).toBe(false);
    });
});

describe('per-panel flash account (#139)', () => {
    const s: Account = { ...a, account_type: 'S', account_id: 'S1' };
    const unsigned = { ...a, account_id: 'U', signed: false };
    const all = [a, b, s, unsigned];
    it('uses the saved key, else follows the app-wide selection', () => {
        expect(resolveFlashAccount(all, 'F', flashAccountKey(b), a)).toEqual({ account: b, following: false, missing: false, unset: false });
        expect(resolveFlashAccount(all, 'F', undefined, b)).toEqual({ account: b, following: true, missing: false, unset: false });
        expect(resolveFlashAccount(all, 'S', undefined, s).account).toBe(s);
    });
    it('never swaps a missing/unsigned/other-market saved account for another one', () => {
        for (const key of [flashAccountKey(unsigned), flashAccountKey(s), 'F:B:gone']) {
            expect(resolveFlashAccount(all, 'F', key, a)).toEqual({ account: undefined, following: false, missing: true, unset: false });
        }
        expect(resolveFlashAccount(all, 'F', undefined, unsigned).account).toBeUndefined();
    });
    it('popouts (followMain=false) never follow: no key means no account until the user picks', () => {
        expect(resolveFlashAccount(all, 'F', undefined, a, false)).toEqual({ account: undefined, following: false, missing: false, unset: true });
        expect(resolveFlashAccount(all, 'F', flashAccountKey(b), a, false).account).toBe(b);
    });
    const withStorage = (fn: (store: Map<string, string>) => void) => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
        try { fn(store); } finally { vi.unstubAllGlobals(); }
    };
    const main = { S: s, F: a };
    it('pins the panel\'s own choice, or the main selection at open time for a following market', () => {
        expect(pinnedFlashAccounts({ F: flashAccountKey(b) }, main)).toEqual({ F: flashAccountKey(b), S: flashAccountKey(s) });
        expect(pinnedFlashAccounts({}, main)).toEqual({ F: flashAccountKey(a), S: flashAccountKey(s) });
        expect(pinnedFlashAccounts(undefined, { F: unsigned, S: { ...s, account_type: 'F' } })).toEqual({});
        expect(pinnedFlashAccounts(undefined, {})).toEqual({});
    });
    it('a new popout starts with its pinned accounts, ignoring older popouts of the same contract', () => withStorage(() => {
        const old = flashPopoutParams({ F: flashAccountKey(a) }, main);
        savePopoutFlashAccounts(old.win, { F: flashAccountKey(b) });
        // panel follows main (A) → the new popout is pinned to A, not the old popout's B
        expect(loadPopoutFlashAccounts(flashPopoutParams({}, main).win)).toEqual({ F: flashAccountKey(a), S: flashAccountKey(s) });
        // a later main change does not move an already-open popout
        const pinned = flashPopoutParams({}, main);
        expect(loadPopoutFlashAccounts(pinned.win).F).toBe(flashAccountKey(a));
        flashPopoutParams({}, { F: b });
        expect(loadPopoutFlashAccounts(pinned.win).F).toBe(flashAccountKey(a));
    }));
    it('a popout\'s own later choice wins on reload over the pin', () => withStorage(() => {
        const { win } = flashPopoutParams({}, main);
        savePopoutFlashAccounts(win, { F: flashAccountKey(b) });
        // reload = same URL (same window id) → reads the stored entry again
        expect(loadPopoutFlashAccounts(win)).toEqual({ F: flashAccountKey(b) });
    }));
    it('two popouts of the same contract persist independently', () => withStorage(() => {
        const one = flashPopoutParams({}, main);
        const two = flashPopoutParams({}, main);
        savePopoutFlashAccounts(two.win, { F: flashAccountKey(b) });
        expect(loadPopoutFlashAccounts(one.win).F).toBe(flashAccountKey(a));
        expect(loadPopoutFlashAccounts(two.win).F).toBe(flashAccountKey(b));
    }));
    it('an unknown window id has no account; the URL never carries an account id', () => withStorage(store => {
        expect(loadPopoutFlashAccounts(newPopoutWindowId())).toEqual({});
        expect(loadPopoutFlashAccounts(null)).toEqual({});
        const params = flashPopoutParams({ F: 'F:B:9876543' }, main);
        expect(Object.keys(params)).toEqual(['win']);
        expect(new URLSearchParams({ popout: 'flash', code: 'TMF', ...params }).toString()).not.toContain('9876543');
        expect([...store.values()].join()).toContain('9876543');
    }));
    it('ignores malformed storage', () => withStorage(store => {
        store.set('sj-pro-flash-popout-windows', '{"w":{"keys":{"X":"1"}},"v":"bad"}');
        expect(loadPopoutFlashAccounts('w')).toEqual({});
        store.set('sj-pro-flash-popout-windows', 'nope');
        expect(loadPopoutFlashAccounts('w')).toEqual({});
    }));
    it('evicts the least recently seen popout, not a long-open one that is still loaded/touched', () => withStorage(() => {
        let now = 1_000;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
        try {
            savePopoutFlashAccounts('pinned', { F: 'F:B:A' });
            savePopoutFlashAccounts('closed', { F: 'F:B:B' });
            for (let n = 0; n < 60; n++) {
                savePopoutFlashAccounts(`w${n}`, {});
                if (n % 20 === 0) touchPopoutFlashAccounts('pinned');
                if (n === 45) loadPopoutFlashAccounts('pinned');
            }
            expect(loadPopoutFlashAccounts('pinned')).toEqual({ F: 'F:B:A' });
            expect(loadPopoutFlashAccounts('closed')).toEqual({});
            expect(loadPopoutFlashAccounts('w0')).toEqual({});
            expect(loadPopoutFlashAccounts('w59')).toEqual({});
        } finally { spy.mockRestore(); }
    }));
});
