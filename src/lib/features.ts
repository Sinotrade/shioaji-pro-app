// src/lib/features.ts — feature flags + tiered entitlements (public
// framework). Closed-source features live in the private modules repo and
// surface through the '@modules' manifest; this file decides WHO can use
// WHAT: every gated feature declares a required tier, the current user's
// tier comes from the closed resolver (open builds default to 'free'),
// and <FeatureGate>/useFeature() gate the UI.
//
// 規則：公開 repo 上的程式碼都是可開源的；要閉源的功能放私有 modules/，
// 要分級的功能在這裡掛 flag。

import { useSyncExternalStore } from 'react';
import { closedModules } from '@modules';
import { fetchAccounts } from './shioaji';

export type Tier = 'free' | 'vip';

// the closed manifest shape (implemented in the private repo; stubbed in
// src/modules-stub for open-source builds)
export interface ClosedModules {
    resolveTier?: (personId: string | null) => Promise<Tier>;
    // per-feature gate from the entitlement service (e.g. a feature-flag
    // provider). Tri-state: true/false = service decision; undefined =
    // service has no opinion → fall back to the tier rule below.
    checkFeature?: (key: string) => boolean | undefined;
    agent?: {
        Panel: React.ComponentType<{
            initialPrompt?: string;
            visibleTabs?: string[];
        }>;
        ensureScheduler: () => void;
        // sets the provider only if the user has never explicitly chosen one
        ensureDefaultProvider: (
            provider: 'anthropic' | 'openai' | 'codex',
        ) => void;
    };
    backtest?: {
        Panel: React.ComponentType<{
            contract: import('./types/contract').ContractInfo | null;
            onPick: (code: string) => void;
        }>;
    };
}

export interface FeatureDef {
    key: string;
    name: string;
    tier: Tier; // minimum tier required
    closed?: boolean; // implementation lives in the private modules repo
    desc: string;
}

export const FEATURES: FeatureDef[] = [
    {
        key: 'agent',
        name: 'AI Agent',
        tier: 'vip',
        closed: true,
        desc: '多供應商 agentic 對話、技能市集、排程任務、操作觀察學習',
    },
    {
        key: 'backtest',
        name: '策略回測',
        tier: 'vip',
        closed: true,
        desc: '自寫策略（JS + ta 函式庫）、含成本回測引擎、多商品整合績效',
    },
    // 之後要分級的功能（開源或閉源皆可）在這裡加一筆，UI 用
    // <FeatureGate feature='key'> 包起來即可
];

// ---- current tier store ----

// start from the last known tier so returning users don't see a lock flash
// while the entitlement service resolves
const TIER_CACHE_KEY = 'sj-tier-cache';
let tier: Tier = (() => {
    try {
        const v = localStorage.getItem(TIER_CACHE_KEY);
        return v === 'vip' || v === 'free' ? v : 'free';
    } catch {
        return 'free';
    }
})();
let resolved = false;
const listeners = new Set<() => void>();

async function resolve() {
    if (resolved) return;
    resolved = true;
    let personId: string | null = null;
    try {
        personId = (await fetchAccounts())[0]?.person_id ?? null;
    } catch {
        // server not up yet — resolver may not need it
    }
    try {
        const next = await closedModules.resolveTier?.(personId);
        if (next) {
            tier = next;
            try {
                localStorage.setItem(TIER_CACHE_KEY, next);
            } catch {
                // session only
            }
        }
    } catch {
        // keep default
    }
    listeners.forEach((l) => l());
}

export function getTier(): Tier {
    void resolve();
    return tier;
}

export function useTier(): Tier {
    return useSyncExternalStore((l) => {
        listeners.add(l);
        void resolve();
        return () => {
            listeners.delete(l);
        };
    }, getTier);
}

export type FeatureState =
    | { enabled: true }
    | { enabled: false; reason: 'vip-required' | 'desktop-only' };

export function featureState(key: string, currentTier: Tier): FeatureState {
    const def = FEATURES.find((f) => f.key === key);
    if (!def) return { enabled: true }; // unknown key — never block
    if (def.closed && !(key in closedModules)) {
        return { enabled: false, reason: 'desktop-only' };
    }
    // the entitlement service (closed) gets first say per feature
    try {
        const gate = closedModules.checkFeature?.(key);
        if (gate === true) return { enabled: true };
        if (gate === false) return { enabled: false, reason: 'vip-required' };
    } catch {
        // service unavailable — fall back to tier rule
    }
    if (def.tier === 'vip' && currentTier !== 'vip') {
        return { enabled: false, reason: 'vip-required' };
    }
    return { enabled: true };
}

export function useFeature(key: string): FeatureState {
    const currentTier = useTier();
    return featureState(key, currentTier);
}

// closed module accessors (undefined in open-source builds)
export const agentModule = closedModules.agent;
export const backtestModule = closedModules.backtest;
