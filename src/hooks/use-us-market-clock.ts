// src/hooks/use-us-market-clock.ts — 美東時段（盤前／一般盤／盤後／收盤）
//
// 全 App 共用一個計時器：只在時段界線（04:00、09:30、16:00、20:00 ET）與美東
// 午夜換值，自選清單每一列、報價板讀同一份，沒有即時成交的商品也會在界線
// 換到正確的狀態（盤後轉灰、04:00 清掉）。

import { useSyncExternalStore } from 'react';
import { msToNextUsBoundary, usMarketPhase, type UsClockPhase } from '../lib/us/us-session-view';

type Clock = { phase: UsClockPhase; date: string };

let current: Clock = usMarketPhase(Date.now());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function tick() {
    timer = null;
    const next = usMarketPhase(Date.now());
    if (next.phase !== current.phase || next.date !== current.date) {
        current = next;
        listeners.forEach(l => l());
    }
    schedule();
}

function schedule() {
    if (timer !== null || listeners.size === 0) return;
    timer = setTimeout(tick, msToNextUsBoundary(Date.now()));
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    // 重新訂閱時（例如電腦睡醒後重新掛載）先對一次現在的時段
    const now = usMarketPhase(Date.now());
    if (now.phase !== current.phase || now.date !== current.date) current = now;
    schedule();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) { clearTimeout(timer); timer = null; }
    };
}

const read = () => current;

/** 現在的美東時段與日期；界線一過就換 */
export function useUsMarketClock(): Clock {
    return useSyncExternalStore(subscribe, read, read);
}

/** 測試用：重設成指定時間的時段 */
export function resetUsMarketClockForTest(nowMs = Date.now()) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    current = usMarketPhase(nowMs);
}
