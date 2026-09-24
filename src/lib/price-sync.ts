// src/lib/price-sync.ts — broadcast a "picked price" (chart hover/click,
// depth-ladder click) to order tickets of the same symbol. External store
// so high-frequency hover updates only re-render subscribed tickets.

import { useSyncExternalStore } from 'react';
import { getChartHoverPricePick } from './chart-price-prefs';

export interface PickedPrice {
    code: string;
    price: number;
    seq: number;
}

let current: PickedPrice | null = null;
const listeners = new Set<() => void>();

function publish(code: string, price: number) {
    current = { code, price, seq: (current?.seq ?? 0) + 1 };
    listeners.forEach((l) => l());
}

/**
 * 明確點擊帶價（圖表點擊、五檔點價）。每次點擊都發布 — 即使與上次同價，
 * 使用者在點擊之間手動改過價格時，再點同一價位也必須帶回。
 */
export function setPickedPrice(code: string, price: number) {
    publish(code, price);
}

/**
 * 游標移動帶價（圖表十字線）。受「游標移動帶價」設定控制（#58，預設關閉）；
 * 關閉時完全不改動下單面板。同價位的連續 hover 去重。
 * 回傳是否真的發布。
 */
export function setHoverPickedPrice(code: string, price: number): boolean {
    if (!getChartHoverPricePick()) return false;
    if (current && current.code === code && current.price === price) {
        return false; // dedupe hover spam at the same tick level
    }
    publish(code, price);
    return true;
}

export function getPickedPrice(): PickedPrice | null {
    return current;
}

export function usePickedPrice(code: string | null): PickedPrice | null {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => (current && code === current.code ? current : null),
    );
}
