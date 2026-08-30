// src/lib/trigger-engine.ts — client-side stop-loss / take-profit triggers.
// Watches the SSE tick stream; when a trigger's condition crosses, it fires
// a market order and removes itself. Triggers persist in localStorage but
// only run while the app is open (client-side engine).

import { useSyncExternalStore } from 'react';
import { ensureContract } from './contracts-cache';
import { onAnyTick } from './stream';
import { notify, placeQuickOrder } from './trade';
import type { Action } from './types/order';

export interface TriggerOrder {
    id: string;
    code: string; // display code (matches quote-store code)
    condition: 'below' | 'above'; // fire when last <= / >= price
    price: number;
    action: Action;
    quantity: number;
    kind: 'stop' | 'take' | 'alert';
    group?: string; // OCO group — when one fires, siblings are cancelled
}

const STORAGE_KEY = 'sj-pro-triggers';

function load(): TriggerOrder[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr as TriggerOrder[];
        }
    } catch {
        // corrupted — start clean
    }
    return [];
}

let triggers: TriggerOrder[] = load();
const listeners = new Set<() => void>();
const firing = new Set<string>();

function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(triggers));
    listeners.forEach((l) => l());
}

export function addTrigger(t: Omit<TriggerOrder, 'id'>): TriggerOrder {
    const trigger: TriggerOrder = {
        ...t,
        id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
    triggers = [...triggers, trigger];
    persist();
    const kindLabel =
        trigger.kind === 'stop'
            ? '⛔ 停損單已掛'
            : trigger.kind === 'take'
              ? '🎯 停利單已掛'
              : '🔔 警示已設';
    notify({
        kind: 'info',
        title: kindLabel,
        body:
            trigger.kind === 'alert'
                ? `${trigger.code} 觸價 ${trigger.condition === 'below' ? '≤' : '≥'} ${trigger.price} 時通知`
                : `${trigger.code} 觸價 ${trigger.condition === 'below' ? '≤' : '≥'} ${trigger.price} → 市價${trigger.action === 'Buy' ? '買' : '賣'} ${trigger.quantity}${trigger.group ? '（OCO）' : ''}`,
    });
    return trigger;
}

export function removeTrigger(id: string) {
    triggers = triggers.filter((t) => t.id !== id);
    persist();
}

export function getTriggers(): TriggerOrder[] {
    return triggers;
}

export function useTriggers(): TriggerOrder[] {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => triggers,
    );
}

async function fire(t: TriggerOrder, lastPrice: number) {
    if (firing.has(t.id)) return;
    firing.add(t.id);
    removeTrigger(t.id);
    // OCO: cancel sibling triggers in the same group
    if (t.group) {
        const siblings = triggers.filter((x) => x.group === t.group);
        for (const sib of siblings) removeTrigger(sib.id);
        if (siblings.length > 0) {
            notify({
                kind: 'info',
                title: 'OCO 互斥撤銷',
                body: `${t.code} 另一邊觸價單已自動移除`,
            });
        }
    }
    if (t.kind === 'alert') {
        notify({
            kind: 'info',
            title: '🔔 到價警示',
            body: `${t.code} 現價 ${lastPrice} 已${t.condition === 'below' ? '跌破' : '突破'} ${t.price}`,
        });
        firing.delete(t.id);
        return;
    }
    try {
        const contract = await ensureContract(t.code);
        const trade = await placeQuickOrder(contract, t.action, null, t.quantity, {
            bypassRisk: true, // protective exit — never blocked by kill switch
            source: 'auto', // 觸價自動單 — 使用者可能不在場，不彈確認
        });
        notify({
            kind: 'ok',
            title: t.kind === 'stop' ? '⛔ 停損觸發' : '🎯 停利觸發',
            body: `${t.code} @${lastPrice} → 市價${t.action === 'Buy' ? '買' : '賣'} ${t.quantity} (${trade.status.status})`,
        });
    } catch (e) {
        notify({
            kind: 'err',
            title: '觸價單送單失敗',
            body: `${t.code} ${e instanceof Error ? e.message : String(e)}`,
        });
    } finally {
        firing.delete(t.id);
    }
}

let engineStarted = false;
export function startTriggerEngine() {
    if (engineStarted) return;
    engineStarted = true;
    onAnyTick((tick) => {
        if (triggers.length === 0) return;
        const price = Number(tick.close);
        if (!Number.isFinite(price)) return;
        for (const t of triggers) {
            if (t.code !== tick.code) continue;
            if (
                (t.condition === 'below' && price <= t.price) ||
                (t.condition === 'above' && price >= t.price)
            ) {
                void fire(t, price);
            }
        }
    });
}
