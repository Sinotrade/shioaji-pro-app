// src/lib/account-store.ts — trading accounts: load (and re-load) the full
// account list, let the user pick which stock / futures account to trade
// with; selection feeds every order and portfolio request.
//
// `accounts` holds EVERY account including unsigned ones (issue #16 — an
// unsigned account silently disappearing looked like "帳號抓取異常"); UI
// surfaces them greyed-out. Anything order-related (selection, accountFor)
// only ever uses signed accounts.

import { useSyncExternalStore } from 'react';
import { fetchAccounts } from './shioaji';
import type { Account } from './types/portfolio';

const STORAGE_KEY = 'sj-pro-accounts-selected';

interface AccountState {
    accounts: Account[];
    selectedStock: Account | null;
    selectedFutures: Account | null;
    loaded: boolean;
    loadError: boolean;
}

let state: AccountState = {
    accounts: [],
    selectedStock: null,
    selectedFutures: null,
    loaded: false,
    loadError: false,
};
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

function keyOf(a: Account) {
    return `${a.broker_id}-${a.account_id}`;
}

function loadSelection(): { stock?: string; futures?: string } {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
        return {};
    }
}

function persistSelection() {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            stock: state.selectedStock ? keyOf(state.selectedStock) : undefined,
            futures: state.selectedFutures
                ? keyOf(state.selectedFutures)
                : undefined,
        }),
    );
}

let inflight: Promise<void> | null = null;
// one /auth/accounts request at a time, shared by the store load and the
// trade-report subscription (boot used to issue both back to back)
let fetching: Promise<Account[]> | null = null;
function fetchShared(): Promise<Account[]> {
    if (!fetching) {
        fetching = fetchAccounts().finally(() => {
            fetching = null;
        });
    }
    return fetching;
}

// This window's in-memory choice wins while that account is still listed
// and signed; the saved selection only fills a type with no usable pick:
// letting storage win on every re-read (each trade-report re-subscription)
// would silently switch the order account to whatever ANOTHER window saved.
function apply(all: Account[]) {
    // only signed accounts are candidates for the order account
    const signed = all.filter((a) => a.signed);
    const stocks = signed.filter((a) => a.account_type === 'S');
    const futures = signed.filter((a) => a.account_type === 'F');
    // per type: keep the current pick while it is still listed and signed;
    // with no usable pick (first load, or none of that type was signed
    // before) the saved choice applies, then the first signed account
    const current = (picked: Account | null, pool: Account[]) =>
        picked ? pool.find((a) => keyOf(a) === keyOf(picked)) : undefined;
    const saved = loadSelection();
    state = {
        accounts: all,
        selectedStock:
            current(state.selectedStock, stocks) ??
            stocks.find((a) => keyOf(a) === saved.stock) ??
            stocks[0] ??
            null,
        selectedFutures:
            current(state.selectedFutures, futures) ??
            futures.find((a) => keyOf(a) === saved.futures) ??
            futures[0] ??
            null,
        loaded: true,
        loadError: false,
    };
}

async function load(): Promise<void> {
    try {
        apply(await fetchShared());
    } catch {
        state = { ...state, loaded: true, loadError: true };
    }
    emit();
}

/** Accounts for the trade-report subscription: joins an in-flight read
 * instead of issuing a second one, updates the store, and — unlike the
 * store load — rethrows, so the caller can mark itself not subscribed. */
export async function loadAccountsShared(): Promise<Account[]> {
    const all = await fetchShared();
    apply(all);
    emit();
    return all;
}

function startLoad(): Promise<void> {
    if (!inflight) {
        inflight = load().finally(() => {
            inflight = null;
        });
    }
    return inflight;
}

// idempotent bootstrap — but a failed/empty first fetch must NOT lock the
// store empty forever (issue #16: the app booted while the server was still
// warming up and never saw the accounts). While the list is empty, every
// call may retry; once accounts are in, this is a no-op.
export function ensureAccounts() {
    if (state.accounts.length > 0 || inflight) return;
    void startLoad();
}

// force a re-fetch and re-emit — the 設定 dialog's 重新整理帳號 button, and
// anything that knows the server-side account list changed
export function refreshAccounts(): Promise<void> {
    return startLoad();
}

export function selectAccount(account: Account) {
    // unsigned accounts can never be the order account
    if (!account.signed) return;
    if (account.account_type === 'S') {
        state = { ...state, selectedStock: account };
    } else if (account.account_type === 'F') {
        state = { ...state, selectedFutures: account };
    }
    persistSelection();
    emit();
}

export function getAccountState(): AccountState {
    return state;
}

// the account to use for a contract/account type — undefined means
// "let the server pick its default". Only ever returns a SIGNED account
// (order safety: unsigned accounts cannot place orders).
export function accountFor(type: 'S' | 'F'): Account | undefined {
    const acc = type === 'S' ? state.selectedStock : state.selectedFutures;
    return acc?.signed ? acc : undefined;
}

export function subscribeAccounts(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useAccounts(): AccountState {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => state,
    );
}
