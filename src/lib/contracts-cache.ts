// src/lib/contracts-cache.ts — global contract cache for pinned panels.
// Resolves Contract V2 identities and exposes a useSyncExternalStore hook.

import { useSyncExternalStore } from 'react';
import { resolveContract } from './shioaji';
import { registerCodeAlias } from './stream';
import { prefetchTickBands } from './tick-bands';
import type { ContractInfo, SecurityType } from './types/contract';

// 期權合約一進 cache 就預取級距表 — 面板首次渲染（要等行情快照）前
// bands 已就緒，render 期的 lazy prefetch 只是最後防線
function prefetchBands(c: ContractInfo) {
    if (
        (c.security_type === 'FUT' || c.security_type === 'OPT') &&
        c.tick_rule
    ) {
        prefetchTickBands(c.tick_rule, c.security_type);
    }
}

const cache = new Map<string, ContractInfo>();
// Preserve code-only consumers while typed lookups can retain colliding codes.
const typedCache = new Map<string, ContractInfo>();
const pending = new Map<string, Promise<ContractInfo>>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

function typedKey(code: string, type: SecurityType | undefined) {
    return `${type ?? 'AUTO'}:${code}`;
}

function rememberContract(contract: ContractInfo, requestedCode = contract.code) {
    cache.set(requestedCode, contract);
    cache.set(contract.code, contract);
    typedCache.set(typedKey(requestedCode, contract.security_type), contract);
    typedCache.set(typedKey(contract.code, contract.security_type), contract);
}

async function resolveTypedContract(code: string, type?: SecurityType) {
    const contract = await resolveContract(code, type);
    if (type && contract.security_type !== type) {
        throw new Error(`商品 ${code} 的型別不是 ${type}，未使用此合約`);
    }
    return contract;
}

export function getCachedContract(code: string): ContractInfo | undefined {
    return cache.get(code);
}

export function primeContract(contract: ContractInfo) {
    rememberContract(contract);
    if (contract.target_code) {
        registerCodeAlias(contract.target_code, contract.code);
    }
    prefetchBands(contract);
    emit();
}

export async function refreshCachedContracts(
    securityType?: SecurityType,
): Promise<void> {
    const targets = new Map<string, ContractInfo>();
    for (const contract of typedCache.values()) {
        if (securityType && contract.security_type !== securityType) continue;
        targets.set(
            typedKey(contract.code, contract.security_type),
            contract,
        );
    }
    if (targets.size === 0) return;

    const targetList = [...targets.values()];
    const refreshed = await Promise.allSettled(
        targetList.map((contract) =>
            resolveTypedContract(contract.code, contract.security_type ?? undefined),
        ),
    );
    let changed = false;
    refreshed.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const previous = targetList[index];
        if (!previous) return;
        const next = result.value;
        for (const entries of [cache, typedCache]) {
            for (const [key, cached] of entries) {
                if (
                    cached.code === previous.code &&
                    cached.security_type === previous.security_type
                ) {
                    entries.set(key, next);
                }
            }
        }
        typedCache.set(typedKey(next.code, next.security_type), next);
        // Refreshing a hidden type must not switch code-only panels to it.
        const current = cache.get(next.code);
        if (!current || current.security_type === previous.security_type) {
            cache.set(next.code, next);
        }
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
    const hit = type ? typedCache.get(typedKey(code, type)) : cache.get(code);
    if (hit) {
        if (hit.target_code) {
            registerCodeAlias(hit.target_code, hit.code);
        }
        return hit;
    }
    const pendingKey = typedKey(code, type);
    const inflight = pending.get(pendingKey);
    if (inflight) return inflight;

    const task = (async () => {
        // Contract V2 get() searches all security types when no type is
        // supplied, so auto-detection is one request instead of four 404s.
        const contract = await resolveTypedContract(code, type);
        rememberContract(contract, code);
        if (contract.target_code) {
            registerCodeAlias(contract.target_code, contract.code);
        }
        prefetchBands(contract);
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
