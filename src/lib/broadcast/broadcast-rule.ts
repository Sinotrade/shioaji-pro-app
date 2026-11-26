// src/lib/broadcast/broadcast-rule.ts — 播報判定（純函式，無平台相依）。
//
// 規則語意參考公司內部既有桌面版的播報邏輯；本檔以純函式重寫，
// 行為由以下條件完整定義，閱讀時不需對照任何外部專案。
// 這裡是整套語音播報的「腦」：決定「這時候該不該念、念什麼」。
// 做成純函式的好處：可以用 vitest 完整覆蓋，不用真的出聲。

export type BroadcastStatus =
    | 'limit-up'
    | 'limit-down'
    | 'new-high'
    | 'new-low'
    | 'high'
    | 'low'
    | '';

/** 狀態詞 → 播報時接在價格後面的文字（前置逗號讓語氣銜接自然） */
export const STATUS_TEXT: Record<BroadcastStatus, string> = {
    'limit-up': '，漲停',
    'limit-down': '，跌停',
    'new-high': '，創新高',
    'new-low': '，破新低',
    high: '，最高價',
    low: '，最低價',
    '': '',
};

/**
 * Shioaji 行情 tick 的 chg_type 語意：
 * 1=漲停 2=漲 3=平盤 4=跌 5=跌停
 */
export const CHG_TYPE_LIMIT_UP = 1;
export const CHG_TYPE_LIMIT_DOWN = 5;

export interface TickSnapshot {
    price: number;
    high: number;
    low: number;
    /** SSE tick 的 chg_type；沒有時用漲跌停價比對 */
    chgType?: number;
}

export interface LimitPrices {
    limitUp?: number;
    limitDown?: number;
}

export interface SymbolBroadcastState {
    /** 上一次「真正念出去」的價格；-1 = 尚未初始化（第一筆不播報） */
    lastPrice: number;
    /** 高點水位標竿；-1 = 尚未初始化 */
    lastHigh: number;
    /** 低點水位標竿；-1 = 尚未初始化 */
    lastLow: number;
    /** 上一次播報的時間（epoch ms）；-1 = 尚未播報過 */
    lastSpeakAt: number;
}

export function createSymbolState(): SymbolBroadcastState {
    return { lastPrice: -1, lastHigh: -1, lastLow: -1, lastSpeakAt: -1 };
}

export interface BroadcastDecision {
    /** 判定後的狀態（已推進水位標竿） */
    state: SymbolBroadcastState;
    status: BroadcastStatus;
    /** 要念的完整句子；空字串代表這次不念 */
    text: string;
    speak: boolean;
    /**
     * 這次「沒有播報」的原因。
     *
     * 注意：**「沒有狀態詞」不是不播報的原因** ——
     * 沒有狀態詞時照樣會播（「台積電 1900.0」），只是受冷卻限制。
     * 所以不播報只有兩種原因。
     */
    reason?: 'first-tick' | 'cooldown';
}

export interface BroadcastRuleOptions {
    /** 冷卻時間（毫秒）；只對「沒有狀態詞」的一般播報生效 */
    cooldownMs: number;
    now: number;
}

export function evaluateBroadcast(
    state: SymbolBroadcastState,
    tick: TickSnapshot,
    limits: LimitPrices,
    speakName: string,
    options: BroadcastRuleOptions,
): BroadcastDecision {
    let { lastPrice, lastHigh, lastLow, lastSpeakAt } = state;

    // 第一筆只拿來定基準，不播報
    if (lastPrice === -1) {
        return {
            state: { ...state, lastPrice: tick.price },
            status: '',
            text: '',
            speak: false,
            reason: 'first-tick',
        };
    }

    if (lastHigh === -1 && tick.high > 0) lastHigh = tick.high;
    if (lastLow === -1 && tick.low > 0) lastLow = tick.low;

    const status = detectStatus(tick, limits, lastPrice, lastHigh, lastLow);

    // 水位標竿一定要在冷卻判斷「之前」推進：就算這次被冷卻擋下，
    // 這檔商品的高低點基準還是得跟著市場走；否則冷卻期間的創新高會被吞掉。
    if (tick.high > lastHigh) lastHigh = tick.high;
    if (tick.low > 0 && tick.low < lastLow) lastLow = tick.low;

    const statusText = STATUS_TEXT[status];

    // 智慧冷卻：只有「沒有狀態詞」的一般播報受冷卻限制。
    // 有狀態詞 = 重要事件（漲停／創新高…），要立刻念，不等冷卻。
    if (
        statusText === '' &&
        lastSpeakAt >= 0 &&
        options.now - lastSpeakAt < options.cooldownMs
    ) {
        return {
            state: { lastPrice, lastHigh, lastLow, lastSpeakAt },
            status: '',
            text: '',
            speak: false,
            reason: 'cooldown',
        };
    }

    return {
        state: {
            lastPrice: tick.price,
            lastHigh,
            lastLow,
            lastSpeakAt: options.now,
        },
        status,
        text: `${speakName} ${tick.price}${statusText}`,
        speak: true,
    };
}

function detectStatus(
    tick: TickSnapshot,
    limits: LimitPrices,
    lastPrice: number,
    lastHigh: number,
    lastLow: number,
): BroadcastStatus {
    // 漲跌停優先：chg_type 是 Shioaji 的權威判定，沒有時才用價格比對
    if (tick.chgType === CHG_TYPE_LIMIT_UP) return 'limit-up';
    if (tick.chgType === CHG_TYPE_LIMIT_DOWN) return 'limit-down';
    const limitUp = limits.limitUp ?? 0;
    const limitDown = limits.limitDown ?? 0;
    if (limitUp > 0 && tick.price >= limitUp) return 'limit-up';
    if (limitDown > 0 && tick.price <= limitDown) return 'limit-down';

    if (lastHigh > 0 && tick.high > lastHigh && tick.price === tick.high) {
        return 'new-high';
    }
    if (
        lastLow > 0 &&
        tick.low > 0 &&
        tick.low < lastLow &&
        tick.price === tick.low
    ) {
        return 'new-low';
    }
    if (tick.high > 0 && tick.price === tick.high && lastPrice < tick.high) {
        return 'high';
    }
    if (
        tick.low > 0 &&
        tick.price > 0 &&
        tick.price === tick.low &&
        lastPrice > tick.low
    ) {
        return 'low';
    }
    return '';
}
