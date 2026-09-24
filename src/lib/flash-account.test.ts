import { describe, expect, it, vi } from 'vitest';
import { accountMatches, flashAccountKey, flashPopoutParams, loadPopoutFlashAccounts, newPopoutWindowId, resolveFlashAccount, savePopoutFlashAccounts, scopedFlashRows } from './flash-account';
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
        expect(resolveFlashAccount(all, 'F', flashAccountKey(b), a)).toEqual({ account: b, following: false, missing: false });
        expect(resolveFlashAccount(all, 'F', undefined, b)).toEqual({ account: b, following: true, missing: false });
        expect(resolveFlashAccount(all, 'S', undefined, s).account).toBe(s);
    });
    it('never swaps a missing/unsigned/other-market saved account for another one', () => {
        for (const key of [flashAccountKey(unsigned), flashAccountKey(s), 'F:B:gone']) {
            expect(resolveFlashAccount(all, 'F', key, a)).toEqual({ account: undefined, following: false, missing: true });
        }
        expect(resolveFlashAccount(all, 'F', undefined, unsigned).account).toBeUndefined();
    });
    const withStorage = (fn: (store: Map<string, string>) => void) => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
        try { fn(store); } finally { vi.unstubAllGlobals(); }
    };
    it('seeds a popout from its panel as-is, including follow-main, ignoring older popouts', () => withStorage(() => {
        const old = flashPopoutParams({ F: 'F:B:A' });
        savePopoutFlashAccounts(old.win, { F: 'F:B:B' });
        const fresh = flashPopoutParams({});
        expect(loadPopoutFlashAccounts(fresh.win)).toEqual({});
        expect(loadPopoutFlashAccounts(flashPopoutParams(undefined).win)).toEqual({});
        expect(loadPopoutFlashAccounts(flashPopoutParams({ F: 'F:B:A' }).win)).toEqual({ F: 'F:B:A' });
    }));
    it('a popout\'s own later choice wins on reload over the seed', () => withStorage(() => {
        const { win } = flashPopoutParams({ F: 'F:B:A' });
        savePopoutFlashAccounts(win, { F: 'F:B:B' });
        // reload = same URL (same window id) → reads the stored entry again
        expect(loadPopoutFlashAccounts(win)).toEqual({ F: 'F:B:B' });
    }));
    it('two popouts of the same contract persist independently', () => withStorage(() => {
        const one = flashPopoutParams({});
        const two = flashPopoutParams({});
        savePopoutFlashAccounts(one.win, { F: 'F:B:A' });
        savePopoutFlashAccounts(two.win, { F: 'F:B:B' });
        expect(loadPopoutFlashAccounts(one.win)).toEqual({ F: 'F:B:A' });
        expect(loadPopoutFlashAccounts(two.win)).toEqual({ F: 'F:B:B' });
    }));
    it('a tile / unknown window id follows main; the URL never carries an account id', () => withStorage(store => {
        expect(loadPopoutFlashAccounts(newPopoutWindowId())).toEqual({});
        expect(loadPopoutFlashAccounts(null)).toEqual({});
        const params = flashPopoutParams({ F: 'F:B:9876543' });
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
});
