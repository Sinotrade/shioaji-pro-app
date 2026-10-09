// src/lib/order-confirm.ts — 手動下單的可視化委託確認（promise 服務）
//
// RiskSettings.confirmManualOrders 開啟時，手動下單路徑先呼叫
// requestOrderConfirm() 取得使用者確認才送單；自動路徑（trigger-engine
// 停損/停利、bracket）永不經過這裡 — 觸發時使用者可能不在場，彈窗
// 等於錯過行情（docs/design/order-confirm-split.md）。
//
// 純 UX 安全帶，不是安全邊界：WebView 內的確認擋不了被汙染的 WebView。

import { fetchInfo } from './shioaji';
import { getAccountState } from './account-store';
import { captureServerMode, currentServerInfoSequence, knownServerInfo, serverInfoFreshSince, SERVER_MODE_CHANGED_MESSAGE, subscribeServerInfo, type ServerModeGuard } from './server-info-store';
import { getApiBase } from './runtime';
import { getPrivacyMode, maskAccountId } from './privacy';
import type { Action } from './types/order';
import type { Account } from './types/portfolio';

export interface OrderConfirmRequest {
    code: string;
    name?: string;
    action: Action;
    // null = 市價
    price: number | null;
    // 複數限價委託可用明確區間覆寫單一價格顯示
    priceLabel?: string;
    // 待確認觸價單的即時行情代碼；確認視窗顯示最新成交價，市價仍非保證成交價。
    livePriceCode?: string;
    quantity: number;
    // 口/張/股（或組合描述，如「1 張＋234 股」）
    unit: string;
    accountLabel?: string;
    // 額外說明（盤中零股、平倉等）
    note?: string;
    // 股票信用條件（融資／融券／現沖）：寫進動作名稱（融券賣出、確認融券賣出）
    credit?: string;
    // true=模擬、false=正式、null=未知（server 未回應）
    simulation: boolean | null;
    // 開啟時重新取得伺服器模式還沒完成：先不能按確認
    awaitingMode?: boolean;
    // 開啟時的 /info 失敗：無法確認模式（請取消後重試）
    modeUnavailable?: boolean;
    // 顯示後伺服器或模式變了：這個確認已失效（按確認也不會送出）
    serverChanged?: boolean;
}

interface PendingConfirm {
    request: OrderConfirmRequest;
    resolve: (approved: boolean) => void;
    reject: (error: Error) => void;
    // the server and mode when the dialog was shown (server-info-store)
    sameServer: ServerModeGuard;
    // shown to the user (after refreshing /info); approval before that is ignored
    started: boolean;
    // API base when the dialog was shown; the mode is only ever adopted on it
    base: string;
    // request sequence when the dialog opened; only later /info responses count
    openSequence: number;
    // a known mode has been shown: its guard is kept for good (no later recapture)
    shownKnown: boolean;
    // the caller's own gate, pinned at approval to what the dialog showed
    callerGate?: ServerModeGuard;
    refreshFailed: boolean;
}

/** 確認視窗開著時伺服器或模式變了（例如模擬 sidecar 重啟成正式）：舊的確認不算數 */
export const ORDER_CONFIRM_SERVER_CHANGED = SERVER_MODE_CHANGED_MESSAGE;

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
    return pending?.started ? pending.request : null;
}

export function resolveOrderConfirm(approved: boolean): void {
    if (!pending) return;
    // 還沒顯示、或仍在取得最新模式的確認不能被按下確認
    if (approved && !pending.shownKnown) return;
    const current = pending;
    pending = null;
    emit();
    if (approved && current.callerGate) current.callerGate.rebaseTo(current.sameServer.snapshot());
    if (approved && !current.sameServer()) {
        current.reject(Object.assign(new Error(ORDER_CONFIRM_SERVER_CHANGED), { mutationNotStarted: true as const }));
        return;
    }
    current.resolve(approved);
}

// 環境 badge：一律取伺服器資訊 store 目前的模式（與送單閘門同一份），
// 不另外長期快取 — sidecar 在同一位址由模擬重啟成正式時不會顯示舊的「模擬」
let simulationOverride: boolean | null | undefined;
let simulationInflight: { base: string; promise: Promise<void> } | null = null;
function currentSimulation(): boolean | null {
    if (simulationOverride !== undefined) return simulationOverride;
    const s = knownServerInfo()?.simulation;
    return typeof s === 'boolean' ? s : null;
}

// 確認視窗一律遮罩帳號（只露末四碼）；隱私模式開啟時與底部 dock 同規則（只露末兩碼）
export function accountConfirmLabel(account: Pick<Account, 'broker_id' | 'account_id'>): string {
    const id = account.account_id;
    const masked = getPrivacyMode()
        ? maskAccountId(id, true)
        : id.length > 4 ? `${'*'.repeat(id.length - 4)}${id.slice(-4)}` : id;
    return `${account.broker_id}-${masked}`;
}

/** 確認視窗開著時才開隱私模式：把已組好的「分公司-***6502」改成 dock 規則（只露末兩碼） */
export function privacyAccountLabel(label: string, priv: boolean): string {
    if (!priv) return label;
    return label.replace(/\*+(\d{2})(\d{2})$/, (m: string, _a: string, tail: string) => '•'.repeat(m.length - 2) + tail);
}

function selectedAccountLabel(unit: string): string | undefined {
    const state = getAccountState();
    const account = unit === '口' ? state.selectedFutures : state.selectedStock;
    return account ? accountConfirmLabel(account) : undefined;
}

/** 重新取得 /info（更新 store）；確認視窗開啟時一律取一次最新的模式 */
export function primeOrderConfirmSimulation(): Promise<void> {
    // 只共用同一個伺服器位址上進行中的請求
    const base = getApiBase();
    if (simulationInflight?.base === base) return simulationInflight.promise;
    const entry = {
        base,
        promise: fetchInfo()
            .then(() => undefined)
            .catch(() => {
                // 未知就未知 — 不阻塞下單確認
            })
            .finally(() => {
                if (simulationInflight === entry) simulationInflight = null;
            }),
    };
    simulationInflight = entry;
    return entry.promise;
}

// 確認視窗只採用「開啟之後才開始」的 /info 請求所得到的模式（舊請求的回應、
// 失敗都不算）；取得前顯示「確認伺服器模式中…」且不能確認
function refreshPendingMode() {
    const current = pending;
    if (!current?.started) return;
    // 已經顯示過模式：閘門固定不再更新；之後失效就只能取消重下
    if (current.shownKnown) {
        if (!current.request.serverChanged && !current.sameServer()) {
            current.request = { ...current.request, serverChanged: true };
            emit();
        }
        return;
    }
    const fresh = getApiBase() === current.base && serverInfoFreshSince(current.openSequence);
    if (fresh) {
        current.sameServer = captureServerMode();
        current.shownKnown = true;
        current.request = { ...current.request, simulation: currentSimulation(), awaitingMode: false, modeUnavailable: false };
    } else {
        if (current.request.awaitingMode && current.request.modeUnavailable === current.refreshFailed) return;
        current.request = { ...current.request, simulation: null, awaitingMode: true, modeUnavailable: current.refreshFailed };
    }
    emit();
}
subscribeServerInfo(refreshPendingMode);

export function requestOrderConfirm(
    request: Omit<OrderConfirmRequest, 'simulation'>,
    opts?: { serverMode?: ServerModeGuard },
): Promise<boolean> {
    // 手動單一次一筆；已有待確認委託時直接拒絕新請求，
    // 不排隊（排隊會讓使用者對著過期價格按確認）
    if (pending) {
        return Promise.reject(
            Object.assign(new Error('已有待確認的委託 — 請先確認或取消上一筆'), { mutationNotStarted: true as const }),
        );
    }
    return new Promise<boolean>((resolve, reject) => {
        // Reserve synchronously before the first await. A cold simulation
        // cache may take hundreds of milliseconds; without this placeholder,
        // two same-tick orders can both pass the guard and one promise is
        // overwritten forever.
        const withAccount = {
            ...request,
            accountLabel: request.accountLabel ?? selectedAccountLabel(request.unit),
        };
        const current: PendingConfirm = {
            request: { ...withAccount, simulation: currentSimulation() },
            resolve,
            reject,
            sameServer: captureServerMode(),
            started: false,
            base: getApiBase(),
            openSequence: currentServerInfoSequence(),
            refreshFailed: false,
            shownKnown: false,
            callerGate: opts?.serverMode,
        };
        pending = current;
        // 開啟時一律另發一次 /info（不沿用可能卡住的預載請求）
        const prime = fetchInfo().then(() => undefined, () => { current.refreshFailed = true; });
        const start = () => {
            if (pending !== current || current.started) return;
            current.started = true;
            current.request = { ...withAccount, simulation: null, awaitingMode: true };
            // 用開啟後的回應決定模式與閘門；換了位址永遠不能確認
            refreshPendingMode();
            if (!current.request.awaitingMode) return;
            emit();
        };
        void prime.then(() => { if (current.started) refreshPendingMode(); else start(); });
        // 環境資訊最多等 800ms — 拿不到就先顯示（未知、不能確認）
        void new Promise<void>((r) => setTimeout(r, 800)).then(start);
    });
}

// 測試用
export function resetOrderConfirmForTest() {
    if (pending) {
        const current = pending;
        pending = null;
        current.resolve(false);
    }
    simulationOverride = undefined;
    simulationInflight = null;
    emit();
}

export function setSimulationCacheForTest(value: boolean | null) {
    simulationOverride = value;
}
