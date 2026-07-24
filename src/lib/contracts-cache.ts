// src/lib/contracts-cache.ts — global contract cache for pinned panels.
// Resolves a code to ContractInfo (STK first, FUT fallback), subscribes
// its quote streams once, and exposes a useSyncExternalStore hook.

import { useSyncExternalStore } from 'react';
import { resolveContract, subscribeContractQuotes } from './shioaji';
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
    cache.set(contract.code, contract);
    if (contract.target_code) {
        registerCodeAlias(contract.target_code, contract.code);
    }
    emit();
}

export async function refreshCachedContracts(
    securityType?: SecurityType,
): Promise<void> {
    const targets = new Map<string, ContractInfo>();
    for (const contract of cache.values()) {
        if (securityType && contract.security_type !== securityType) continue;
        targets.set(
            `${contract.security_type ?? 'AUTO'}:${contract.code}`,
            contract,
        );
    }
    if (targets.size === 0) return;

    const targetList = [...targets.values()];
    const refreshed = await Promise.allSettled(
        targetList.map((contract) =>
            resolveContract(contract.code, contract.security_type ?? undefined),
        ),
    );
    let changed = false;
    refreshed.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const previous = targetList[index];
        if (!previous) return;
        const next = result.value;
        for (const [key, cached] of cache) {
            if (
                cached.code === previous.code &&
                cached.security_type === previous.security_type
            ) {
                cache.set(key, next);
            }
        }
        cache.set(next.code, next);
        if (next.target_code) {
            registerCodeAlias(next.target_code, next.code);
        }
        changed = true;
    });
    if (changed) emit();
}

export async function ensureContract(
    code: string,
    type?: SecurityType,
): Promise<ContractInfo> {
    const hit = cache.get(code);
    if (hit) {
        if (hit.target_code) {
            registerCodeAlias(hit.target_code, hit.code);
        }
        if (!subscribed.has(hit.code)) {
            const results = await subscribeContractQuotes(hit);
            if (results.some((result) => result.status === 'fulfilled')) {
                subscribed.add(hit.code);
            }
        }
        return hit;
    }
    const pendingKey = `${type ?? 'AUTO'}:${code}`;
    const inflight = pending.get(pendingKey);
    if (inflight) return inflight;

    const task = (async () => {
        // Contract V2 get() searches all security types when no type is
        // supplied, so auto-detection is one request instead of four 404s.
        const contract = await resolveContract(code, type);
        cache.set(code, contract);
        cache.set(contract.code, contract);
        if (contract.target_code) {
            registerCodeAlias(contract.target_code, contract.code);
        }
        if (!subscribed.has(contract.code)) {
            const results = await subscribeContractQuotes(contract);
            if (results.some((result) => result.status === 'fulfilled')) {
                subscribed.add(contract.code);
            }
        }
        emit();
        return contract;
    })();
    pending.set(pendingKey, task);
    try {
        return await task;
    } finally {
        pending.delete(pendingKey);
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
