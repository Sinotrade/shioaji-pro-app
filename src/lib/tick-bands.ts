// src/lib/tick-bands.ts — FUT/OPT 跳動級距（tick bands）快取
//
// 期權級距不寫死在程式裡（交易所規則會改，skill 紀律）：以 server 的
// tick-bands API 為權威，按 tick_rule 名稱快取一次、全程同步查表。
// 尚未載入時呼叫端 fallback 到 contract.tick（server 給的參考價位級距，
// 在同一級距帶內正確）— localhost 取回是毫秒級，實務上首次渲染前就緒。

import { useSyncExternalStore } from 'react';
import { fetchTickBands } from './shioaji';
import type { TickBand } from './types/contract';

const cache = new Map<string, TickBand[]>();
const inflight = new Set<string>();
// bands 到貨要讓依 tick 計算的 memo（閃電下單 rows）失效 — 盤後沒有
// 行情跳動觸發 re-render 時，載入完成前算出的 fallback 格才會被換掉
let version = 0;
const listeners = new Set<() => void>();

function bump() {
    version++;
    listeners.forEach((l) => l());
}

// 同步查表：rule 已載入時回該價位（權利金）所在 band 的 tick
export function bandTickFor(rule: string, price: number): number | undefined {
    const bands = cache.get(rule);
    if (!bands) return undefined;
    for (const b of bands) {
        if (price >= b.min && (b.max === null || price < b.max)) return b.tick;
    }
    return undefined;
}

// 冪等預取：未快取的 rule 發一次 API，失敗允許之後重試
export function prefetchTickBands(
    rule: string,
    securityType: 'FUT' | 'OPT',
): void {
    if (cache.has(rule) || inflight.has(rule)) return;
    inflight.add(rule);
    try {
        fetchTickBands(rule, securityType)
            .then((res) => {
                cache.set(rule, res.bands);
                bump();
            })
            .catch(() => {
                // 失敗不快取 — 下次呼叫重試；期間吃 contract.tick fallback
            })
            .finally(() => {
                inflight.delete(rule);
            });
    } catch {
        inflight.delete(rule);
    }
}

// 依 tick 計算 memo 的元件把這個 version 放進 deps — bands 到貨即重算
export function useTickBandsVersion(): number {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => version,
    );
}

// 測試用：直接灌表／清空（正式路徑一律走 prefetch）
export function setTickBands(rule: string, bands: TickBand[]) {
    cache.set(rule, bands);
    bump();
}

export function clearTickBands() {
    cache.clear();
    inflight.clear();
    bump();
}
