// src/lib/order-confirm.ts — 手動下單的可視化委託確認（promise 服務）
//
// RiskSettings.confirmManualOrders 開啟時，手動下單路徑先呼叫
// requestOrderConfirm() 取得使用者確認才送單；自動路徑（trigger-engine
// 停損/停利、bracket）永不經過這裡 — 觸發時使用者可能不在場，彈窗
// 等於錯過行情（docs/design/order-confirm-split.md）。
//
// 純 UX 安全帶，不是安全邊界：WebView 內的確認擋不了被汙染的 WebView。

import { fetchInfo } from './shioaji';
import type { Action } from './types/order';

export interface OrderConfirmRequest {
    code: string;
    name?: string;
    action: Action;
    // null = 市價
    price: number | null;
    quantity: number;
    // 口/張/股（或組合描述，如「1 張＋234 股」）
    unit: string;
    // 額外說明（盤中零股、平倉等）
    note?: string;
    // true=模擬、false=正式、null=未知（server 未回應）
    simulation: boolean | null;
}

interface PendingConfirm {
    request: OrderConfirmRequest;
    resolve: (approved: boolean) => void;
}

let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

export function subscribeOrderConfirm(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getPendingOrderConfirm(): OrderConfirmRequest | null {
    return pending?.request ?? null;
}

export function resolveOrderConfirm(approved: boolean): void {
    if (!pending) return;
    const current = pending;
    pending = null;
    emit();
    current.resolve(approved);
}

// 環境 badge 用 — lazy 快取一次，local server 毫秒級回應
let simulationCache: boolean | null = null;
let simulationInflight: Promise<void> | null = null;

function primeSimulation(): Promise<void> {
    if (simulationCache !== null) return Promise.resolve();
    simulationInflight ??= fetchInfo()
        .then((info) => {
            simulationCache = info.simulation;
        })
        .catch(() => {
            // 未知就未知 — 不阻塞下單確認
        })
        .finally(() => {
            simulationInflight = null;
        });
    return simulationInflight;
}

export function requestOrderConfirm(
    request: Omit<OrderConfirmRequest, 'simulation'>,
): Promise<boolean> {
    // 手動單一次一筆；已有待確認委託時直接拒絕新請求，
    // 不排隊（排隊會讓使用者對著過期價格按確認）
    if (pending) {
        return Promise.reject(
            new Error('已有待確認的委託 — 請先確認或取消上一筆'),
        );
    }
    return new Promise<boolean>((resolve) => {
        // Reserve synchronously before the first await. A cold simulation
        // cache may take hundreds of milliseconds; without this placeholder,
        // two same-tick orders can both pass the guard and one promise is
        // overwritten forever.
        const current: PendingConfirm = {
            request: { ...request, simulation: simulationCache },
            resolve,
        };
        pending = current;
        const start = () => {
            if (pending !== current) return;
            current.request = { ...request, simulation: simulationCache };
            emit();
        };
        // 環境資訊最多等 800ms — 拿不到就以未知呈現
        void Promise.race([
            primeSimulation(),
            new Promise<void>((r) => setTimeout(r, 800)),
        ]).then(start);
    });
}

// 測試用
export function resetOrderConfirmForTest() {
    if (pending) {
        const current = pending;
        pending = null;
        current.resolve(false);
    }
    simulationCache = null;
    simulationInflight = null;
    emit();
}

export function setSimulationCacheForTest(value: boolean | null) {
    simulationCache = value;
}
