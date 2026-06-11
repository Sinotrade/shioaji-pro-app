// src/lib/contracts-cache.ts — global contract cache for pinned panels.
// Resolves a code to ContractInfo (STK first, FUT fallback), subscribes
// its quote streams once, and exposes a useSyncExternalStore hook.

import { useSyncExternalStore } from 'react';
import { fetchContract, subscribeQuote } from './shioaji';
import { registerCodeAlias } from './stream';
import type { ContractInfo, SecurityType } from './types/contract';

const cache = new Map<string, ContractInfo>();
const pending = new Map<string, Promise<ContractInfo>>();
const subscribed = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

export function getCachedContract(code: string): ContractInfo | undefined {
    return cache.get(code);
}

export function primeContract(contract: ContractInfo) {
    if (!cache.has(contract.code)) {
        cache.set(contract.code, contract);
        emit();
    }
    subscribed.add(contract.code); // watchlist already subscribed it
}

export async function ensureContract(
    code: string,
    type?: SecurityType,
): Promise<ContractInfo> {
    const hit = cache.get(code);
    if (hit) return hit;
    const inflight = pending.get(code);
    if (inflight) return inflight;

    const task = (async () => {
        let contract: ContractInfo;
        if (type) {
            contract = await fetchContract(code, type);
        } else {
            // auto-detect: stock → futures → index
            try {
                contract = await fetchContract(code, 'STK');
            } catch {
                try {
                    contract = await fetchContract(code, 'FUT');
                } catch {
                    contract = await fetchContract(code, 'IND');
                }
            }
        }
        cache.set(code, contract);
        if (contract.target_code) {
            registerCodeAlias(contract.target_code, contract.code);
        }
        if (!subscribed.has(contract.code)) {
            subscribed.add(contract.code);
            await Promise.allSettled([
                subscribeQuote(contract, 'Tick'),
                subscribeQuote(contract, 'BidAsk'),
            ]);
        }
        emit();
        return contract;
    })();
    pending.set(code, task);
    try {
        return await task;
    } finally {
        pending.delete(code);
    }
}

export function useContract(code: string | null): ContractInfo | undefined {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => (code ? cache.get(code) : undefined),
    );
}
