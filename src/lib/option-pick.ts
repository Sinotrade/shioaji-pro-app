// src/lib/option-pick.ts — broadcast an option/future code picked from the
// 選擇權 T 字 so the 組合單 panel can drop it into a leg (issue #1). Separate
// from the global symbol-select so only a combo panel in 連動 mode consumes it.

import { useSyncExternalStore } from 'react';

let current: { code: string; seq: number } | null = null;
const listeners = new Set<() => void>();

export function pickOptionLeg(code: string) {
    current = { code, seq: (current?.seq ?? 0) + 1 };
    listeners.forEach((l) => l());
}

export function useOptionLegPick(): { code: string; seq: number } | null {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => current,
    );
}
