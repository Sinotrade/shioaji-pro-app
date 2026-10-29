// src/lib/broadcast/broadcast-debug.ts — 語音播報的主題化除錯記錄器。
//
// 為什麼需要這個：
//   「沒播報」在使用者端看起來只有一句話，但背後可能是六種完全不同的原因：
//     1. 總開關關著
//     2. 該類事件的開關關著
//     3. 商品清單是空的 / 商品沒加
//     4. 報價根本沒進來（沒訂閱到、或合約沒解析）
//     5. 有進來，但這次沒有狀態詞（價格在區間內正常波動）→ 本來就不該念
//     6. 有狀態詞，但被冷卻／去重／過時丟棄擋下
//   沒有這層可見性，使用者只能說「沒聲音」，開發者只能猜。
//
// 設計：這是**旁路的觀測層**，不影響播報行為。
//   - 不改變規則層的判定結果，只「旁註」原因
//   - 面板上有一個除錯區塊顯示即時狀態
//   - `dumpBroadcastDebug()` 可把完整快照丟到 console

import { useSyncExternalStore } from 'react';

/**
 * 為什麼這次沒有播報。
 *
 * 注意：**「沒有狀態詞」不是不播報的原因** —— 依 WpfApp6 的原始行為，
 * 沒有狀態詞時**照樣會播**（「台積電 1900.0」），只是受冷卻限制。
 * 所以未播報只有兩種原因。
 */
export type BroadcastSkipReason =
    | 'first-tick' // 第一筆 tick，只用來定基準
    | 'cooldown'; // 被冷卻擋下（一定是「無狀態詞的一般播報」）

export interface BroadcastTargetDebug {
    code: string;
    name: string;
    /** 合約是否解析成功 */
    contractResolved: boolean;
    /** 解析失敗的原因 */
    contractError?: string;
    /** 合約的 code / target_code（訂閱用哪一個要看這裡） */
    contractCode?: string;
    contractTargetCode?: string | null;
    /** 已訂閱的報價種類 */
    subscribedTypes: string[];
    /** 訂閱成立的時間（用來判斷「訂閱了卻一直沒資料」） */
    subscribedAt?: number;
    /**
     * 已訂閱但一直收不到即時報價。
     *
     * 這不是訂閱失敗（伺服器端 desired=true、matched），而是**當下沒有這種商品的
     * 即時成交**：即時行情只在開盤時段推送（台股盤中 09:00–13:30、盤後定價 14:00–14:30；
     * 期貨另有夜盤），收盤後只剩一次性的 snapshot。
     * 模擬環境與正式環境的行情覆蓋**相同**——不要把「模擬」當成沒有 tick 的原因。
     * 使用者看到「沒聲音」時，必須能分辨「沒開關」與「沒有資料可念」。
     */
    noQuote?: boolean;
    noQuoteReason?: string;
    /** 收到的 tick 數 */
    tickCount: number;
    lastTickAt?: number;
    lastPrice?: number;
    lastHigh?: number;
    lastLow?: number;
    /** 最近一次判定的狀態詞（空字串 = 一般報價，無狀態詞） */
    lastStatus?: string;
    /** 最近一次被擋下的原因 */
    lastSkipReason?: BroadcastSkipReason;
    /** 最近一次被擋下的時間 */
    lastSkipAt?: number;
    /** 最近一次真正播報的句子 */
    lastSpokeText?: string;
    lastSpokeAt?: number;
    /** 被擋下的累計次數（分原因） */
    blocked: { cooldown: number };
}

export interface BroadcastDebugState {
    /** 開關的實際值（不是 UI 顯示，是真的從 settings 讀出來的） */
    switches: {
        enabled: boolean;
        quote: boolean;
        deal: boolean;
        notice: boolean;
    };
    /** 佇列現況 */
    queue: {
        pending: number;
        speakingText?: string;
        speakingSince?: number;
    };
    counters: {
        ticks: number;
        decisions: number;
        spoke: number;
        /** 無狀態詞的一般播報（會被冷卻限制） */
        generalQuotes: number;
        blockedCooldown: number;
        droppedStale: number;
        duplicateSuppressed: number;
        dealEvents: number;
        noticeEvents: number;
        testAnnouncements: number;
    };
    targets: Record<string, BroadcastTargetDebug>;
}

function emptyTarget(code: string): BroadcastTargetDebug {
    return {
        code,
        name: code,
        contractResolved: false,
        subscribedTypes: [],
        tickCount: 0,
        blocked: { cooldown: 0 },
    };
}

let state: BroadcastDebugState = {
    switches: { enabled: false, quote: false, deal: false, notice: false },
    queue: { pending: 0 },
    counters: {
        ticks: 0,
        decisions: 0,
        spoke: 0,
        generalQuotes: 0,
        blockedCooldown: 0,
        droppedStale: 0,
        duplicateSuppressed: 0,
        dealEvents: 0,
        noticeEvents: 0,
        testAnnouncements: 0,
    },
    targets: {},
};

const listeners = new Set<() => void>();

/**
 * `state` 永遠是最新值；`snapshot` 是給 React 看的，**只在 flush 時才換參考值**。
 *
 * 為什麼要分兩個：行情 tick 是高頻的（每秒數十筆），若每次都 emit，
 * 診斷面板本身就會造成重繪風暴——那是在「診斷工具造成問題」。
 * 所以：狀態照收，通知節流到 250ms。
 */
let snapshot: BroadcastDebugState = state;
let lastEmit = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const EMIT_INTERVAL_MS = 250;

function emit() {
    listeners.forEach((l) => l());
}

function flush() {
    flushTimer = null;
    lastEmit = Date.now();
    snapshot = state;
    emit();
}

function scheduleEmit() {
    const wait = EMIT_INTERVAL_MS - (Date.now() - lastEmit);
    if (wait <= 0) {
        flush();
        return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(flush, wait);
}

function update(mutate: (draft: BroadcastDebugState) => void) {
    // 淺層複製：只替換被改到的欄位
    const next: BroadcastDebugState = {
        ...state,
        switches: { ...state.switches },
        queue: { ...state.queue },
        counters: { ...state.counters },
        targets: { ...state.targets },
    };
    mutate(next);
    state = next;
    scheduleEmit();
}

function target(code: string): BroadcastTargetDebug {
    return state.targets[code] ?? emptyTarget(code);
}

// ---- 記錄點 ----

export function debugSwitches(sw: BroadcastDebugState['switches']) {
    const cur = state.switches;
    if (
        cur.enabled === sw.enabled &&
        cur.quote === sw.quote &&
        cur.deal === sw.deal &&
        cur.notice === sw.notice
    ) {
        return; // 沒有變化就不擾動面板
    }
    update((d) => {
        d.switches = { ...sw };
    });
}

export function debugContract(
    code: string,
    info: {
        name: string;
        resolved: boolean;
        error?: string;
        contractCode?: string;
        contractTargetCode?: string | null;
    },
) {
    update((d) => {
        const t = { ...target(code) };
        t.name = info.name;
        t.contractResolved = info.resolved;
        t.contractError = info.error;
        t.contractCode = info.contractCode;
        t.contractTargetCode = info.contractTargetCode ?? null;
        d.targets[code] = t;
    });
}

export function debugSubscribed(code: string, types: string[]) {
    update((d) => {
        const t = { ...target(code) };
        t.subscribedTypes = [...types];
        t.subscribedAt = Date.now();
        d.targets[code] = t;
    });
}

export function debugTick(code: string, price: number, high: number, low: number) {
    update((d) => {
        d.counters.ticks += 1;
        const t = { ...target(code) };
        t.tickCount += 1;
        t.lastTickAt = Date.now();
        t.lastPrice = price;
        t.lastHigh = high;
        t.lastLow = low;
        d.targets[code] = t;
    });
}

export function debugDecision(
    code: string,
    result: {
        status: string;
        speak: boolean;
        reason?: BroadcastSkipReason;
        text?: string;
    },
) {
    update((d) => {
        d.counters.decisions += 1;
        const t = { ...target(code) };
        t.lastStatus = result.status || '（一般報價，無狀態詞）';
        if (result.speak) {
            t.lastSpokeText = result.text;
            t.lastSpokeAt = Date.now();
            d.counters.spoke += 1;
            if (!result.status) d.counters.generalQuotes += 1;
        } else {
            t.lastSkipReason = result.reason;
            t.lastSkipAt = Date.now();
            if (result.reason === 'cooldown') {
                t.blocked.cooldown += 1;
                d.counters.blockedCooldown += 1;
            }
        }
        d.targets[code] = t;
    });
}

export function debugSpoke(text: string, code: string) {
    update((d) => {
        d.counters.spoke += 1;
        d.queue.speakingText = text;
        d.queue.speakingSince = Date.now();
        if (code) {
            const t = { ...target(code) };
            t.lastSpokeText = text;
            t.lastSpokeAt = Date.now();
            d.targets[code] = t;
        }
    });
}

export function debugSpeakingDone() {
    update((d) => {
        d.queue.speakingText = undefined;
        d.queue.speakingSince = undefined;
    });
}

export function debugQueuePending(n: number) {
    update((d) => {
        d.queue.pending = n;
    });
}

export function debugDroppedStale() {
    update((d) => {
        d.counters.droppedStale += 1;
    });
}

export function debugDuplicateSuppressed() {
    update((d) => {
        d.counters.duplicateSuppressed += 1;
    });
}

export function debugNoQuote(code: string, reason: string) {
    update((d) => {
        const t = { ...target(code) };
        t.noQuote = true;
        t.noQuoteReason = reason;
        d.targets[code] = t;
    });
}

export function debugQuoteArrived(code: string) {
    update((d) => {
        const t = { ...target(code) };
        if (!t.noQuote) return;
        t.noQuote = false;
        t.noQuoteReason = undefined;
        d.targets[code] = t;
    });
}

export function debugDealEvent() {
    update((d) => {
        d.counters.dealEvents += 1;
    });
}

export function debugNoticeEvent() {
    update((d) => {
        d.counters.noticeEvents += 1;
    });
}

export function debugTestAnnouncement() {
    update((d) => {
        d.counters.testAnnouncements += 1;
    });
}

// ---- 讀取 ----

export function getBroadcastDebug(): BroadcastDebugState {
    // 回傳 snapshot（不是 state）：參考值在 flush 之間保持不變，React 才不會重繪
    return snapshot;
}

export function useBroadcastDebug(): BroadcastDebugState {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => {
                listeners.delete(l);
            };
        },
        getBroadcastDebug,
    );
}

/** 把完整快照丟到 console（面板上的「診斷」按鈕用） */
export function dumpBroadcastDebug() {
    flush(); // 確保是最新值
    const s = getBroadcastDebug();
    console.group('[broadcast] 診斷快照');
    console.log('開關', s.switches);
    console.log('佇列', s.queue);
    console.log('計數', s.counters);
    console.table(
        Object.values(s.targets).map((t) => ({
            代碼: t.code,
            名稱: t.name,
            合約: t.contractResolved ? 'OK' : `失敗:${t.contractError ?? '?'}`,
            訂閱: t.subscribedTypes.join(',') || '（無）',
            tick數: t.tickCount,
            最後價: t.lastPrice ?? '—',
            最後判定: t.lastStatus ?? '—',
            未播原因: t.lastSkipReason ?? '—',
            已播: t.lastSpokeText ?? '—',
        })),
    );
    console.groupEnd();
}
