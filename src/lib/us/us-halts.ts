// src/lib/us/us-halts.ts — 美股停牌（halt book）
//
// SDK 1.8.0：POST /api/v1/stream/subscribe/halt_stk_us 開始收停牌事件（1.8.0b1–b3 叫
// subscribe/us_halt；新路徑 404／405 就退回舊路徑，見 us-stream-names.ts）；
// GET /api/v1/stream/us_halts 回目前停牌中的項目（全市場、交易所、個股）。
// halt book 只知道訂閱之後收到的事件。這裡用輪詢 us_halts（不多開一條
// SSE 連線），所以狀態最多慢 US_HALT_POLL_MS。

import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from '../api';
import { registerCapabilitySubscription } from '../stream';
import { postUsStreamAction } from './us-stream-names';

export const US_HALT_POLL_MS = 15_000;
export const US_HALTS_PATH = '/api/v1/stream/us_halts';
/** 重連重播的 registry key 與路徑（stream.ts 重播時依 sidecar 換成實際名稱） */
export const US_HALT_CAPABILITY = 'halt_stk_us';

export interface UsHaltEntry {
    scope: 'Symbol' | 'Exchange' | 'Market' | 'Unknown';
    exchange: string;
    code: string;
    /** 1 正常、2 停牌、3 暫停交易、0 未知 */
    tradable_status: number;
    halt_reason: number;
}

interface UsHaltsResponse {
    subscribed: boolean;
    last_seq: number;
    halts: UsHaltEntry[];
}

let halts: UsHaltEntry[] = [];
let refs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let subscribing: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function setHalts(next: UsHaltEntry[]) {
    halts = next;
    version++;
    listeners.forEach(l => l());
}

async function poll() {
    try {
        const res = await apiGet<UsHaltsResponse>(US_HALTS_PATH);
        if (refs > 0) setHalts(Array.isArray(res?.halts) ? res.halts : []);
    } catch {
        // 舊 sidecar 沒有這個 endpoint：維持「不知道」，不顯示停牌
    }
}

function subscribe(): Promise<void> {
    if (!subscribing) {
        subscribing = postUsStreamAction<{ success: boolean }>('subscribe', 'halt', {})
            .then(() => { registerCapabilitySubscription(US_HALT_CAPABILITY, US_HALT_CAPABILITY, {}); })
            .catch(() => { subscribing = null; });
    }
    return subscribing;
}

/** 有美股面板時才訂閱停牌與輪詢 */
export function retainUsHalts(): () => void {
    refs++;
    if (refs === 1) {
        void subscribe().then(poll);
        timer = setInterval(() => { void poll(); }, US_HALT_POLL_MS);
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        refs--;
        if (refs <= 0 && timer) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/** 這檔目前的停牌項目（全市場 → 交易所 → 個股）；沒有回 null */
export function usHaltFor(c: { exchange: string | null; code: string }, list: readonly UsHaltEntry[] = halts): UsHaltEntry | null {
    const ex = (c.exchange ?? '').toUpperCase();
    const code = c.code.toUpperCase();
    return list.find(h => h.scope === 'Market')
        ?? list.find(h => h.scope === 'Exchange' && h.exchange.toUpperCase() === ex)
        ?? list.find(h => h.scope === 'Symbol' && h.code.toUpperCase() === code && (!h.exchange || h.exchange.toUpperCase() === ex))
        ?? null;
}

export function usHaltLabel(h: UsHaltEntry): string {
    const what = h.tradable_status === 3 ? '暫停交易' : '停牌';
    return h.scope === 'Market' ? `美股全市場${what}` : h.scope === 'Exchange' ? `${h.exchange} ${what}` : what;
}

/** React：美股合約的停牌狀態（非美股回 null） */
export function useUsHalt(c: { region?: string; exchange: string | null; code: string } | null | undefined): UsHaltEntry | null {
    const us = c?.region === 'US';
    useEffect(() => (us ? retainUsHalts() : undefined), [us]);
    useSyncExternalStore(
        (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        () => version,
    );
    return us && c ? usHaltFor(c) : null;
}

export function setUsHaltsForTest(next: UsHaltEntry[]) {
    setHalts(next);
}

export function resetUsHaltsForTest() {
    halts = [];
    refs = 0;
    if (timer) clearInterval(timer);
    timer = null;
    subscribing = null;
}
