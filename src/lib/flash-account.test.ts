import { describe, expect, it, vi } from 'vitest';
import { accountMatches, flashAccountKey, loadPopoutFlashAccounts, parseFlashAccountKeys, resolveFlashAccount, savePopoutFlashAccounts, scopedFlashRows } from './flash-account';
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
    it('parses only well-formed popout keys', () => {
        expect(parseFlashAccountKeys('{"F":"F:B:A"}')).toEqual({ F: 'F:B:A' });
        expect(parseFlashAccountKeys('{"X":"1"}')).toBeUndefined();
        expect(parseFlashAccountKeys('nope')).toBeUndefined();
        expect(parseFlashAccountKeys(null)).toBeUndefined();
    });
    it('keeps popout choices per contract code, with the panel seed winning', () => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
        try {
            savePopoutFlashAccounts('TMF', { F: 'F:B:A' });
            savePopoutFlashAccounts('2330', { S: 'S:B:S1' });
            expect(loadPopoutFlashAccounts('TMF')).toEqual({ F: 'F:B:A' });
            expect(loadPopoutFlashAccounts('TMF', { F: 'F:B:B' })).toEqual({ F: 'F:B:B' });
            expect(loadPopoutFlashAccounts('MXF')).toEqual({});
            expect(loadPopoutFlashAccounts(null)).toEqual({});
        } finally { vi.unstubAllGlobals(); }
    });
});
