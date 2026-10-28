// src/lib/broadcast/broadcast-hub.ts — 語音播報的中樞。
//
// 負責三件事：
//   1. 記錄「哪個面板要播報哪些商品」（每個語音播報面板各自一份）
//   2. 為這些商品訂閱行情（沿用 quote-ownership 的 retain/release 計數）
//   3. 把 tick 送進判定層 → 佇列 → 語音引擎
//
// 為什麼做成 module singleton：語音出口只有一個，多個面板共用同一個
// 佇列才能做全域去重（同一商品同句話只念一次）。

import { useSyncExternalStore } from 'react';
import { getCachedContract, ensureContract } from '../contracts-cache';
import { retainQuote } from '../quote-ownership';
import { getQuote, subscribeQuoteStore } from '../stream';
import { getTtsEngine } from '../tts';
import type { TtsEngine } from '../tts';
import type { ContractInfo } from '../types/contract';
import type { QuoteTypeName } from '../types/market';
import { BroadcastQueue, STALE_AFTER_MS } from './broadcast-queue';
import {
    createSymbolState,
    evaluateBroadcast,
    type SymbolBroadcastState,
} from './broadcast-rule';
import { toSpeakName } from './broadcast-name';
import { getBroadcastSettings, rateToSpeed } from './broadcast-settings';

export interface BroadcastLogEntry {
    code: string;
    name: string;
    text: string;
    at: number;
}

const LOG_LIMIT = 50;

const panels = new Map<string, string[]>();
const states = new Map<string, SymbolBroadcastState>();
// 每筆訂閱記住它的合約代碼：移除時要連帶清掉同一個 key 的播報狀態
const subscriptions = new Map<string, { release: () => void; contractCode: string }>();
// 這個陣列的參考值必須在沒有新播報時保持穩定 —— useSyncExternalStore
// 每次 render 都會比對 getSnapshot 的結果，參考值一直變會造成無限重繪。
let log: BroadcastLogEntry[] = [];
const listeners = new Set<() => void>();

let queue: BroadcastQueue | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function getQueue(): BroadcastQueue {
    if (!queue) {
        queue = new BroadcastQueue(
            createSettingsAwareEngine(),
            Date.now,
            STALE_AFTER_MS,
            // 紀錄在「真的念完」時才寫 —— 面板的「最近播報」才不會列出
            // 其實被冷卻／去重擋掉、根本沒出聲的句子。
            (text, symbolCode) => {
                pushLog({
                    code: symbolCode,
                    name: symbolCode
                        ? getCachedContract(symbolCode)?.name || symbolCode
                        : '測試',
                    text,
                    at: Date.now(),
                });
            },
        );
    }
    return queue;
}

/**
 * 把「目前的全域設定」（語速、語音）注入每次發聲 ——
 * 使用者在設定面板調整語速後，下一句就用新語速，不用重開面板。
 */
function createSettingsAwareEngine(): TtsEngine {
    const engine = getTtsEngine();
    return {
        id: engine.id,
        get available() {
            return engine.available;
        },
        get reason() {
            return engine.reason;
        },
        get speaking() {
            return engine.speaking;
        },
        listVoices: () => engine.listVoices(),
        cancelAll: () => engine.cancelAll(),
        speak: (text, options) => {
            const settings = getBroadcastSettings();
            return engine.speak(text, {
                rate: options?.rate ?? rateToSpeed(settings.rate),
                volume: options?.volume ?? 1,
                voiceUri: options?.voiceUri || settings.voiceUri || undefined,
            });
        },
    };
}

function emit() {
    listeners.forEach((l) => l());
}

function pushLog(entry: BroadcastLogEntry) {
    log = [entry, ...log].slice(0, LOG_LIMIT);
    emit();
}

// ---- 面板註冊 ----

/** 註冊／更新一個語音播報面板要播報的商品清單 */
export function registerBroadcastPanel(panelId: string, codes: string[]) {
    const next = [...new Set(codes.filter(Boolean))];
    const current = panels.get(panelId);
    if (current && current.length === next.length && current.every((c, i) => c === next[i])) {
        return;
    }
    panels.set(panelId, next);
    sync();
}

/** 面板關閉／卸載時取消註冊 */
export function unregisterBroadcastPanel(panelId: string) {
    if (!panels.has(panelId)) return;
    panels.delete(panelId);
    sync();
}

/** 某個面板目前的播報目標（給 UI 顯示） */
export function getBroadcastPanelCodes(panelId: string): string[] {
    return [...(panels.get(panelId) ?? [])];
}

/** 所有面板的播報目標聯集 */
export function getBroadcastTargets(): string[] {
    const set = new Set<string>();
    panels.forEach((codes) => codes.forEach((c) => set.add(c)));
    return [...set];
}

// ---- 訂閱管理 ----

function desiredCodes(): Set<string> {
    const set = new Set<string>();
    panels.forEach((codes) => codes.forEach((c) => set.add(c)));
    return set;
}

function sync() {
    const desired = desiredCodes();

    for (const [code, entry] of subscriptions) {
        if (desired.has(code)) continue;
        entry.release();
        subscriptions.delete(code);
        // 這檔商品的播報狀態也一併清掉，下次加入時重新從第一筆開始
        states.delete(code);
        states.delete(entry.contractCode);
    }

    for (const code of desired) {
        if (subscriptions.has(code)) continue;
        void attach(code);
    }
}

async function attach(code: string) {
    let contract: ContractInfo;
    try {
        contract = await ensureContract(code);
    } catch {
        // 解析不到合約（代號打錯 / 尚未開盤）→ 稍後再試
        scheduleRetry();
        return;
    }
    if (!desiredCodes().has(code)) return;

    const type: QuoteTypeName = contract.security_type === 'IND' ? 'Quote' : 'Tick';
    const release = retainQuote(contract, type);
    const unsubscribe = subscribeQuoteStore(contract.code, () => {
        onTick(contract);
    });
    // 以「面板填的代號」當 key：合約代碼可能跟輸入不同（target_code 别名）
    subscriptions.set(code, { release, contractCode: contract.code });
}

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        sync();
    }, 5000);
}

// ---- tick 路由 ----

function onTick(contract: ContractInfo) {
    const settings = getBroadcastSettings();
    if (!settings.enabled) return;

    const quote = getQuote(contract.code);
    const tick = quote?.tick;
    const index = quote?.index;

    const price = Number(tick?.close ?? index?.close ?? 0);
    if (!Number.isFinite(price) || price <= 0) return;
    if (tick?.simtrade) return;

    const high = Number(tick?.high ?? index?.high ?? price);
    const low = Number(tick?.low ?? index?.low ?? price);

    const code = contract.code;
    const state = states.get(code) ?? createSymbolState();
    const decision = evaluateBroadcast(
        state,
        {
            price,
            high: Number.isFinite(high) ? high : price,
            low: Number.isFinite(low) ? low : price,
            chgType: tick?.chg_type,
        },
        { limitUp: contract.limit_up, limitDown: contract.limit_down },
        toSpeakName(contract.name || contract.code),
        {
            cooldownMs: settings.cooldownSec * 1000,
            now: Date.now(),
        },
    );
    states.set(code, decision.state);
    if (!decision.speak) return;

    getQueue().enqueue(decision.text, { symbolCode: code });
}

// ---- 手動播報 ----

/** 立刻播一句話（測試用），會打斷目前的語音 */
export function broadcastUrgent(text: string) {
    getQueue().enqueue(text, { interrupt: true });
}

/** 依目前的設定念一句話（測試用；不受總開關限制，使用者明確要求念的） */
export function broadcastMessage(text: string) {
    getQueue().enqueue(text, {});
}

// ---- 播報紀錄 ----

export function getBroadcastLog(): BroadcastLogEntry[] {
    // 回傳同一個參考值（不要複製）—— useSyncExternalStore 靠它判斷有沒有變動
    return log;
}

export function subscribeBroadcastLog(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** 播報紀錄（面板用；最新在前） */
export function useBroadcastLog(): BroadcastLogEntry[] {
    return useSyncExternalStore(
        subscribeBroadcastLog,
        getBroadcastLog,
        getBroadcastLog,
    );
}

/** 目前這檔商品的名稱（給面板顯示用） */
export function getBroadcastContractName(code: string): string {
    const contract = getCachedContract(code);
    return contract?.name || code;
}
