// issue #139 — account capture helpers used by every manual/armed order path
import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
const m = vi.hoisted(() => ({ accounts: [] as Account[], stock: null as Account | null, futures: null as Account | null }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedStock: m.stock, selectedFutures: m.futures }) }));
import { captureSelectedAccount, isSelectedAccountUnchanged, mainFlashSelection, usableCapturedAccount } from './order-account';
const acc = (account_type: 'S' | 'F', account_id: string, signed = true): Account => ({ account_type, broker_id: 'BR', account_id, signed, person_id: '', username: '' });
const A = acc('F', 'A'), B = acc('F', 'B'), S = acc('S', 'S');
beforeEach(() => { m.accounts = [A, B, S]; m.futures = A; m.stock = S; });

it('captures only a signed account of the requested market', () => {
    expect(captureSelectedAccount('F')).toBe(A);
    expect(captureSelectedAccount('S')).toBe(S);
    m.futures = acc('F', 'U', false);
    expect(captureSelectedAccount('F')).toBeUndefined();
    m.futures = S;
    expect(captureSelectedAccount('F')).toBeUndefined();
});
it('detects a selection change or an account that became unavailable', () => {
    expect(isSelectedAccountUnchanged(A)).toBe(true);
    m.futures = B;
    expect(isSelectedAccountUnchanged(A)).toBe(false);
    m.futures = A; m.accounts = [B, S];
    expect(isSelectedAccountUnchanged(A)).toBe(false);
});
it('an armed path keeps its captured account regardless of the selection, until it is unusable', () => {
    m.futures = B;
    expect(usableCapturedAccount(A)).toBe(A);
    m.accounts = [B, S];
    expect(usableCapturedAccount(A)).toBeUndefined();
    m.accounts = [{ ...A, signed: false }, B];
    expect(usableCapturedAccount(A)).toBeUndefined();
    expect(usableCapturedAccount(undefined)).toBeUndefined();
});
it('mainFlashSelection reports this window\'s selection for pinning popouts', () => {
    expect(mainFlashSelection()).toEqual({ S, F: A });
});
