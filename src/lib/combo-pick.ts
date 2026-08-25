// src/lib/combo-pick.ts — 組合商品列表點擊 → 組合單面板帶入兩腳
// （issue #32：自選清單支援組合商品前的替代動線）。比照 option-pick，
// BroadcastChannel 跨視窗（popout 列表也能填主視窗的組合單）。

import { useSyncExternalStore } from 'react';
import { comboContractInfo, comboMonthsLabel } from './combo';
import { primeContract } from './contracts-cache';
import type { ManagedComboContract } from './shioaji';

export interface ComboPick {
    combo: ManagedComboContract;
    seq: number;
}

let current: ComboPick | null = null;
const listeners = new Set<() => void>();

const channel =
    typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('sj-combo-pick')
        : null;

function apply(combo: ManagedComboContract) {
    // 讓本視窗的全域選取/釘選能解析組合 code（跨窗 pick 時對面視窗
    // 的 cache 也要有）；來源面板若有更好的名稱會再覆蓋
    primeContract(
        comboContractInfo(combo, comboMonthsLabel(combo.code) ?? combo.code),
    );
    current = { combo, seq: (current?.seq ?? 0) + 1 };
    listeners.forEach((l) => l());
}

channel?.addEventListener('message', (e) => {
    const c = e.data as ManagedComboContract | null;
    if (
        c &&
        Array.isArray(c.legs) &&
        c.legs.length === 2 &&
        c.legs.every((l) => l && typeof l.code === 'string' && l.code)
    ) {
        apply(c);
    }
});

export function pickCombo(combo: ManagedComboContract) {
    apply(combo);
    channel?.postMessage(combo);
}

export function useComboPick(): ComboPick | null {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => current,
    );
}
