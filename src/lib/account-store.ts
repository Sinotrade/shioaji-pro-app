// src/lib/account-store.ts — trading accounts: load once, let the user pick
// which stock / futures account to trade with; selection feeds every order
// and portfolio request.

import { useSyncExternalStore } from 'react';
import { fetchAccounts } from './shioaji';
import type { Account } from './types/portfolio';

const STORAGE_KEY = 'sj-pro-accounts-selected';

interface AccountState {
    accounts: Account[];
    selectedStock: Account | null;
    selectedFutures: Account | null;
    loaded: boolean;
}

let state: AccountState = {
    accounts: [],
    selectedStock: null,
    selectedFutures: null,
    loaded: false,
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

let started = false;
export function ensureAccounts() {
    if (started) return;
    started = true;
    fetchAccounts()
        .then((all) => {
            const signed = all.filter((a) => a.signed);
            const saved = loadSelection();
            const stocks = signed.filter((a) => a.account_type === 'S');
            const futures = signed.filter((a) => a.account_type === 'F');
            state = {
                accounts: signed,
                selectedStock:
                    stocks.find((a) => keyOf(a) === saved.stock) ??
                    stocks[0] ??
                    null,
                selectedFutures:
                    futures.find((a) => keyOf(a) === saved.futures) ??
                    futures[0] ??
                    null,
                loaded: true,
            };
            emit();
        })
        .catch(() => {
            state = { ...state, loaded: true };
            emit();
        });
}

export function selectAccount(account: Account) {
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
// "let the server pick its default"
export function accountFor(type: 'S' | 'F'): Account | undefined {
    return (
        (type === 'S' ? state.selectedStock : state.selectedFutures) ??
        undefined
    );
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
