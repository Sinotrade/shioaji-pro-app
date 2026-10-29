// src/lib/broadcast/broadcast-hub.ts — 語音播報的中樞。
//
// 負責四件事：
//   1. 記錄「要播報哪些商品」（行情類；清單由唯一的語音播報面板提供）
//   2. 為這些商品訂閱行情（沿用 quote-ownership 的 retain/release 計數）
//   3. 接上三類事件來源：行情 tick、成交／委託回報、通知／條件單
//   4. 把事件送進規則層 → 佇列 → 語音引擎
//
// 為什麼做成 module singleton：語音出口只有一個，多個來源共用同一個
// 佇列才能做全域去重（同一商品同句話只念一次）。
//
// 三類事件都是「開關控制」，預設全部關閉（見 broadcast-settings.ts）。

import { useSyncExternalStore } from 'react';
import { getCachedContract, ensureContract } from '../contracts-cache';
import type { OrderEventReport } from '../order-report';
import { retainQuote } from '../quote-ownership';
import { getQuote, onOrderEvent, subscribeQuoteStore } from '../stream';
import { onNotice, type AppNotice } from '../trade';
import { getTtsEngine } from '../tts';
import type { TtsEngine } from '../tts';
import type { ContractInfo } from '../types/contract';
import type { QuoteTypeName } from '../types/market';
import { BroadcastQueue, STALE_AFTER_MS } from './broadcast-queue';
import {
    debugContract,
    debugDecision,
    debugDealEvent,
    debugNoQuote,
    debugNoticeEvent,
    debugQuoteArrived,
    debugSubscribed,
    debugSwitches,
    debugTestAnnouncement,
    debugTick,
    getBroadcastDebug,
} from './broadcast-debug';
import { describeNoticeVoice, describeOrderVoice } from './broadcast-events';
import {
    createSymbolState,
    evaluateBroadcast,
    type SymbolBroadcastState,
} from './broadcast-rule';
import { toSpeakName } from './broadcast-name';
import { getBroadcastSettings } from './broadcast-settings';

export interface BroadcastLogEntry {
    code: string;
    name: string;
    text: string;
    at: number;
}

const LOG_LIMIT = 50;

const states = new Map<string, SymbolBroadcastState>();
// 每筆訂閱記住它的合約代碼：移除時要連帶清掉同一個 key 的播報狀態
// 與行情 store 的 listener（少解除 listener 會造成「移除商品後仍持續播報」）
const subscriptions = new Map<
    string,
    { release: () => void; unsubscribe: () => void; contractCode: string }
>();
// 正在解析合約、尚未完成訂閱的代號。
// 沒有這層的話，「移除 → 立刻加回來」會讓兩個 attach 同時進行 → 重複訂閱。
const attaching = new Set<string>();
// 「訂閱了卻沒資料」的判定計時器
const noQuoteTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 訂閱後多久還沒收到 tick 就判定「這個環境沒有這種商品的即時報價」 */
const NO_QUOTE_GRACE_MS = 8000;
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
 *
 * rate 傳的是「抽象刻度 -10~10」，各 engine 自行映射成自己的語意。
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
        probe: () => engine.probe(),
        speak: (text, options) => {
            const settings = getBroadcastSettings();
            return engine.speak(text, {
                rate: options?.rate ?? settings.rate,
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

// ---- 行情清單（由唯一的語音播報面板提供）----

let quoteCodes: string[] = [];

/** 設定要播報行情的商品清單（單一設定中心，不分面板） */
export function setBroadcastQuoteCodes(codes: string[]) {
    const next = [...new Set(codes.filter(Boolean))];
    if (next.length === quoteCodes.length && next.every((c, i) => c === quoteCodes[i])) {
        return;
    }
    quoteCodes = next;
    sync();
}

/** 清空行情清單（面板卸載時） */
export function clearBroadcastQuoteCodes() {
    if (quoteCodes.length === 0) return;
    quoteCodes = [];
    sync();
}

/** 目前要播報行情的商品 */
export function getBroadcastQuoteCodes(): string[] {
    return [...quoteCodes];
}

// ---- 訂閱管理 ----

function desiredCodes(): Set<string> {
    return new Set(quoteCodes);
}

function sync() {
    const desired = desiredCodes();

    for (const [code, entry] of subscriptions) {
        if (desired.has(code)) continue;
        entry.release();
        // ★ 解除行情 store 的 listener。
        // 少了這行，只要還有其他元件持有這檔商品的行情訂閱（例如自選清單），
        // tick 就會繼續進來 → 被移除的商品會一直播報下去。
        entry.unsubscribe();
        subscriptions.delete(code);
        const timer = noQuoteTimers.get(code);
        if (timer) {
            clearTimeout(timer);
            noQuoteTimers.delete(code);
        }
        // 這檔商品的播報狀態也一併清掉，下次加入時重新從第一筆開始
        states.delete(code);
        states.delete(entry.contractCode);
    }

    for (const code of desired) {
        if (subscriptions.has(code)) continue;
        // 已經在解析中的不要重複 attach（否則會有兩份 listener）
        if (attaching.has(code)) continue;
        void attach(code);
    }
}

async function attach(code: string) {
    attaching.add(code);
    let resolved = false;
    try {
        let contract: ContractInfo;
        try {
            contract = await ensureContract(code);
        } catch (e) {
            // 解析不到合約（代號打錯 / 尚未開盤）→ 稍後再試
            debugContract(code, {
                name: code,
                resolved: false,
                error: e instanceof Error ? e.message : String(e),
            });
            scheduleRetry();
            return;
        }
        resolved = true;
        debugContract(code, {
            name: contract.name || code,
            resolved: true,
            contractCode: contract.code,
            contractTargetCode: contract.target_code ?? null,
        });
        if (!desiredCodes().has(code)) return;

        const type: QuoteTypeName = contract.security_type === 'IND' ? 'Quote' : 'Tick';
        const release = retainQuote(contract, type);
        const unsubscribe = subscribeQuoteStore(contract.code, () => {
            onTick(contract, code);
        });
        debugSubscribed(code, [type]);
        // 「訂閱了卻一直沒資料」要講清楚：伺服器端可能訂閱成功（desired=true），
        // 但當下不是這個商品的交易時段 → 上游沒有這種商品的即時成交可推。
        // 模擬與正式環境的行情覆蓋相同，不要誤導成「模擬環境沒有股票 tick」。
        // 沒有這段，使用者只會看到「沒聲音」，分不出是沒開關還是沒資料。
        const timer = setTimeout(() => {
            noQuoteTimers.delete(code);
            const t = getBroadcastDebug().targets[code];
            if (!t || t.tickCount > 0) return;
            debugNoQuote(
                code,
                '已訂閱但沒有即時報價 —— 當下可能不是該商品的交易時段（台股盤中 09:00–13:30、盤後定價 14:00–14:30；期貨另有夜盤），語音播報不會有聲',
            );
        }, NO_QUOTE_GRACE_MS);
        noQuoteTimers.set(code, timer);
        // 以「面板填的代號」當 key：合約代碼可能跟輸入不同（target_code 别名）
        subscriptions.set(code, { release, unsubscribe, contractCode: contract.code });
    } finally {
        attaching.delete(code);
        // 解析期間商品被移除又加回來 → 這次 attach 會在「已不在清單」時放棄，
        // 要補一次同步，否則這檔商品會停在「沒訂閱」的狀態。
        // 合約解析失敗時不在這裡重試（否則會立刻打轉），交給 scheduleRetry。
        if (resolved && desiredCodes().has(code) && !subscriptions.has(code)) {
            sync();
        }
    }
}

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        sync();
    }, 5000);
}

// ---- 事件來源 1/3：行情 tick ----

function onTick(contract: ContractInfo, panelCode: string) {
    // 這檔商品可能已經被移出播報清單：
    //   - 解除 listener 與清單更新之間有時間差
    //   - 其他元件（例如自選清單）仍持有它的行情訂閱時，tick 還是會進來
    // 被移出清單的商品就不該再播報 —— 這是解除 listener 之外的第二道防線。
    if (!desiredCodes().has(panelCode)) return;
    const settings = getBroadcastSettings();
    // 開關狀態要在任何 early return 之前先記錄，
    // 否則面板看不出「為什麼沒播報」。
    debugSwitches({
        enabled: settings.enabled,
        quote: settings.quoteEnabled,
        deal: settings.dealEnabled,
        notice: settings.noticeEnabled,
    });
    if (!settings.enabled || !settings.quoteEnabled) return;

    const quote = getQuote(contract.code);
    const tick = quote?.tick;
    const index = quote?.index;

    const price = Number(tick?.close ?? index?.close ?? 0);
    if (!Number.isFinite(price) || price <= 0) return;
    if (tick?.simtrade) return;

    const high = Number(tick?.high ?? index?.high ?? price);
    const low = Number(tick?.low ?? index?.low ?? price);

    const code = contract.code;
    debugTick(code, price, high, low);
    debugQuoteArrived(code);

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
    debugDecision(code, {
        status: decision.status,
        speak: decision.speak,
        reason: decision.reason,
        text: decision.text,
    });
    if (!decision.speak) return;

    // 行情類用商品代號去重（同商品同句話不重複念，保留 WPF 行為）
    getQueue().enqueue(decision.text, { symbolCode: code });
}

// ---- 事件來源 2/3：成交／委託回報 ----

function onOrderEventReport(ev: OrderEventReport) {
    const settings = getBroadcastSettings();
    debugDealEvent();
    if (!settings.enabled || !settings.dealEnabled) return;
    const text = describeOrderVoice(ev);
    if (!text) return;
    // 不帶 symbolCode → 不做「同商品同句話」去重。
    // 兩筆一樣價位的成交是兩件事，都要念。
    // （SSE 重播的重複由 stream 層的 eventId 去重處理，不靠這裡。）
    getQueue().enqueue(text, {});
}

// ---- 事件來源 3/3：通知／條件單 ----

function onNoticeReport(n: AppNotice) {
    const settings = getBroadcastSettings();
    debugNoticeEvent();
    if (!settings.enabled || !settings.noticeEnabled) return;
    const text = describeNoticeVoice(n);
    if (!text) return;
    getQueue().enqueue(text, {});
}

// ---- 啟動 ----

let sourcesStarted = false;

/**
 * 訂閱三類事件來源。冪等。
 *
 * 語音播報是 app 級能力，不該因為面板被關掉就不播 ——
 * 所以訂閱在模組載入時就建立，而不是由面板掛載時啟動。
 */
export function ensureBroadcastSources() {
    if (sourcesStarted) return;
    sourcesStarted = true;
    onOrderEvent((ev) => onOrderEventReport(ev));
    onNotice((n) => onNoticeReport(n));
}

ensureBroadcastSources();

// ---- 手動播報 ----

/** 把當前開關狀態同步到除錯面板（面板掛載時呼叫一次） */
export function syncBroadcastDebugSwitches() {
    const s = getBroadcastSettings();
    debugSwitches({
        enabled: s.enabled,
        quote: s.quoteEnabled,
        deal: s.dealEnabled,
        notice: s.noticeEnabled,
    });
}

/** 立刻播一句話（測試用），會打斷目前的語音 */
export function broadcastUrgent(text: string) {
    debugTestAnnouncement();
    getQueue().enqueue(text, { interrupt: true });
}

/** 依目前的設定念一句話（測試用；不受總開關限制，使用者明確要求念的） */
export function broadcastMessage(text: string) {
    debugTestAnnouncement();
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
