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
 * 注意：**「沒有狀態詞」不是不播報的原因** ——
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

// ---- 時間軸 trace（實測用） ----
//
// 為什麼快照不夠：
//   上面的 state 回答的是「現在是什麼狀態」，實測時真正要回答的是
//   「剛剛依序發生了什麼」——tick 有沒有進來、判定為什麼不念、
//   是不是被冷卻擋掉。快照看不到順序，順序才是診斷的線索。
//
// 設計約束（與上面同一原則：旁路觀測，不影響播報行為）：
//   - 不改任何判定結果，只在既有記錄點旁註一行
//   - 有界：最多 TRACE_LIMIT 筆，超過丟最舊的（實測可能連續跑數小時）
//   - 抗洪：同一個 (kind, code) 在 TRACE_COLLAPSE_MS 內只留一筆並累計次數。
//     tick 每秒數十筆，不折疊的話 200 筆只夠存幾秒，等於沒有記錄。

export type BroadcastTraceKind =
    | 'switch'
    | 'contract'
    | 'subscribe'
    | 'decision'
    | 'speak'
    | 'speak-done'
    | 'speak-error'
    | 'no-quote'
    | 'quote-arrived'
    | 'deal'
    | 'notice'
    | 'test'
    | 'dropped'
    | 'duplicate';

export interface BroadcastTraceEntry {
    /** 第一次發生的時間（ms epoch） */
    at: number;
    kind: BroadcastTraceKind;
    code?: string;
    text: string;
    /** 被折疊掉的相同事件數（0 = 只有這一筆） */
    repeat: number;
}

// 200 筆在實測中只夠記 2.5 分鐘（冷卻／去重的雜訊佔絕大多數：
// 一次實測約 2 分半就把 200 筆寫滿，匯出時已滿 200/200、最早只回到 2 分半前）。
// 1000 筆約 100KB，對記憶體無感，但足以覆蓋一次完整的實測流程。
const TRACE_LIMIT = 1000;
const TRACE_COLLAPSE_MS = 1000;

let trace: BroadcastTraceEntry[] = [];

// ---- trace 開關（診斷用，**預設關**）----
//
// 為什麼預設關：trace 是「查問題時才需要」的東西，平常交易沒必要一直記錄。
// 關閉時 pushTrace 直接 return —— 不取時間、不配置物件，成本趨近 0。
// 刻意用獨立的 localStorage key，而不是混進播報設定（broadcast-settings）：
// 它是開發／診斷旗標，不是使用者要調的產品設定，也不該進設定檔契約。
const TRACE_STORAGE_KEY = 'shioaji-pro.broadcast.trace-enabled';

function readTraceEnabled(): boolean {
    try {
        return globalThis.localStorage?.getItem(TRACE_STORAGE_KEY) === '1';
    } catch {
        // 沒有 localStorage（測試環境、隱私模式）→ 當成關閉
        return false;
    }
}

let traceEnabled = readTraceEnabled();

export function isBroadcastTraceEnabled(): boolean {
    return traceEnabled;
}

export function setBroadcastTraceEnabled(on: boolean) {
    traceEnabled = on;
    try {
        globalThis.localStorage?.setItem(TRACE_STORAGE_KEY, on ? '1' : '0');
    } catch {
        // 存不起來不影響本次 session 的行為
    }
}

function pushTrace(kind: BroadcastTraceKind, text: string, code?: string) {
    if (!traceEnabled) return;
    const now = Date.now();
    const last = trace[trace.length - 1];
    // 折疊的判斷必須含 text：同商品同種類但**內容不同**的兩筆是兩件事。
    // 真實案例：21:14:52.169「不念（first-tick）」與 21:14:52.307「念 «…2160»」
    // 相隔 138ms；只看 (kind, code) 會把「念」吞進「不念」，匯出檔就出現
    // 「只判定不念」卻又有 speak 的自相矛盾。
    if (
        last &&
        last.kind === kind &&
        last.code === code &&
        last.text === text &&
        now - last.at < TRACE_COLLAPSE_MS
    ) {
        // 折疊：不新增一行，只把上一筆的次數 +1（參考值一定換新，陣列本身不變長）
        trace = [...trace.slice(0, -1), { ...last, repeat: last.repeat + 1 }];
        return;
    }
    trace = [...trace, { at: now, kind, code, text, repeat: 0 }].slice(
        -TRACE_LIMIT,
    );
}

export function getBroadcastTrace(): BroadcastTraceEntry[] {
    return trace;
}

export function clearBroadcastTrace() {
    trace = [];
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function clockText(at: number): string {
    const d = new Date(at);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(
        d.getMilliseconds(),
    ).padStart(3, '0')}`;
}

function stampText(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
        d.getHours(),
    )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 把 trace 變成可直接貼上／存檔的純文字。
 *
 * 為什麼不是 console.table：實測完要把結果貼給別人看，table 一貼就散掉。
 * 這裡刻意連「目前狀態」一起輸出，讓這份檔案單獨看就能診斷，
 * 不必再回頭去猜當時的開關與計數。
 */
export function formatBroadcastTrace(
    entries: BroadcastTraceEntry[] = trace,
    now = Date.now(),
): string {
    // 這裡刻意讀 state 而不是 snapshot：snapshot 是為了 React 重繪穩定而節流
    // （250ms），但匯出是一次性的，讀到節流前的舊值會讓「目前狀態」看起來是空的。
    const s = state;
    const lines: string[] = [];
    lines.push('[shioaji-pro] 語音播報 trace');
    lines.push(`匯出時間：${stampText(now)}`);
    lines.push(
        `記錄狀態：${traceEnabled ? '開' : '關（除錯區的「記錄 trace」打開後才會記錄）'}`,
    );
    lines.push(
        `記錄筆數：${entries.length} / ${TRACE_LIMIT}（同一事件 ${TRACE_COLLAPSE_MS}ms 內折疊，次數記在行尾）`,
    );
    lines.push('');
    lines.push('---- 目前狀態 ----');
    lines.push(
        `開關：總=${s.switches.enabled ? '開' : '關'} 行情=${
            s.switches.quote ? '開' : '關'
        } 成交=${s.switches.deal ? '開' : '關'} 通知=${
            s.switches.notice ? '開' : '關'
        }`,
    );
    lines.push(
        `佇列：待播 ${s.queue.pending}${
            s.queue.speakingText ? ` · 正在念「${s.queue.speakingText}」` : ''
        }`,
    );
    lines.push(
        `計數：tick ${s.counters.ticks} · 判定 ${s.counters.decisions} · 已播 ${s.counters.spoke} · 一般報價 ${s.counters.generalQuotes} · 冷卻擋 ${s.counters.blockedCooldown} · 去重擋 ${s.counters.duplicateSuppressed} · 過時丟棄 ${s.counters.droppedStale} · 成交 ${s.counters.dealEvents} · 通知 ${s.counters.noticeEvents} · 測試 ${s.counters.testAnnouncements}`,
    );
    const targets = Object.values(s.targets);
    if (targets.length === 0) {
        lines.push('商品：（沒有播報商品）');
    }
    for (const t of targets) {
        lines.push(
            `商品 ${t.code}${t.name && t.name !== t.code ? ` ${t.name}` : ''}：合約${
                t.contractResolved ? 'OK' : `失敗(${t.contractError ?? '?'})`
            } · 訂閱${t.subscribedTypes.join(',') || '（無）'} · tick ${
                t.tickCount
            } · 最後價 ${t.lastPrice ?? '—'} · 最後判定 ${
                t.lastStatus ?? '—'
            } · 未播原因 ${t.lastSkipReason ?? '—'}${
                t.noQuote ? ` · 無即時報價(${t.noQuoteReason ?? '?'})` : ''
            }`,
        );
    }
    lines.push('');
    lines.push('---- 時間軸 ----');
    if (entries.length === 0) {
        lines.push(
            traceEnabled
                ? '（沒有記錄 —— 面板沒開、事件開關沒開，或這段時間沒有 tick／事件）'
                : '（trace 記錄未開啟 —— 除錯區的「記錄 trace」打開後才會開始記錄）',
        );
    } else {
        for (const e of entries) {
            const suffix = e.repeat > 0 ? `  (×${e.repeat + 1})` : '';
            const code = e.code ? ` ${e.code}` : '';
            lines.push(
                `${clockText(e.at)}  ${e.kind.padEnd(14, ' ')}${code} ${
                    e.text
                }${suffix}`,
            );
        }
    }
    // 去掉每行行尾空白：對齊用的 padEnd 與選填欄位會在行尾留下空白
    return lines.join('\n').replace(/[ \t]+$/gm, '');
}

/**
 * 面板「匯出 trace」按鈕：直接下載成 .txt。
 *
 * 為什麼用下載而不是複製到剪貼簿：Edge `--app` 視窗要開 devtools 才看得到
 * console，而 clipboard 在非 https／非使用者手勢下常常沒權限。下載是唯一
 * 兩個都不用管的路徑。開頭加 BOM，Windows 記事本才不會把中文顯示成亂碼。
 */
export function downloadBroadcastTrace() {
    flush(); // 確保「目前狀態」是最新值
    const at = Date.now();
    const text = formatBroadcastTrace(trace, at);
    const d = new Date(at);
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(
        d.getDate(),
    )}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const blob = new Blob([`\uFEFF${text}`], {
        type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `broadcast-trace-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
    pushTrace(
        'switch',
        `總=${sw.enabled ? '開' : '關'} 行情=${sw.quote ? '開' : '關'} 成交=${
            sw.deal ? '開' : '關'
        } 通知=${sw.notice ? '開' : '關'}`,
    );
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
    pushTrace(
        'contract',
        info.resolved
            ? `合約解析 OK（${info.contractCode ?? '?'}）`
            : `合約解析失敗：${info.error ?? '?'}`,
        code,
    );
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
    pushTrace('subscribe', `訂閱 ${types.join(',') || '（無）'}`, code);
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
    // 折疊後每檔每秒最多一行；價格取自同一個 tick 剛寫入的 lastPrice
    const price = state.targets[code]?.lastPrice;
    const priceText = price === undefined ? '' : ` ＠${price}`;
    pushTrace(
        'decision',
        result.speak
            ? `念 «${result.text ?? ''}»${priceText}${
                  result.status ? `（狀態：${result.status}）` : ''
              }`
            : `不念（原因：${result.reason ?? '?'}${priceText}）`,
        code,
    );
    update((d) => {
        d.counters.decisions += 1;
        const t = { ...target(code) };
        t.lastStatus = result.status || '（一般報價，無狀態詞）';
        if (result.speak) {
            // 這裡刻意**不**計入 counters.spoke、也**不**寫 lastSpokeText：
            // 「判定要念」不等於「真的念了」——進佇列後還可能被去重擋下或過時丟棄。
            // 一次實測的 200 筆窗口中：判定要念 34 次，真正 speak 只有 7 次。若兩處都 +1，面板的「已播」
            // 會把「想播」加進「已播」，使用者看到的數字就不是事實。
            // 這兩個欄位只由 debugSpoke()（佇列真正發聲時）更新。
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
    pushTrace('speak', `«${text}»`, code || undefined);
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

/**
 * 一句話念完。
 *
 * `elapsedMs` 是「從送出到真的結束」的時間，用來抓「假念完」：
 * 一次實測中出現過 speak → speak-done
 * 只隔 **27ms**，而同一句話正常要 1.9 秒。那種情況多半是被中斷或根本沒發聲，
 * 但沒有秒數就完全看不出來，所以這裡把它寫進 trace。
 */
export function debugSpeakingDone(elapsedMs?: number) {
    if (elapsedMs === undefined) {
        pushTrace('speak-done', '念完');
    } else if (elapsedMs < 300) {
        pushTrace(
            'speak-done',
            `念完，但只花 ${elapsedMs}ms —— 可疑：可能被中斷或沒真的發聲（正常一句約 1～2 秒）`,
        );
    } else {
        pushTrace('speak-done', `念完（${(elapsedMs / 1000).toFixed(1)} 秒）`);
    }
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

export function debugSpeakFailed(reason: string, elapsedMs?: number) {
    pushTrace(
        'speak-error',
        `${reason}${elapsedMs === undefined ? '' : `（${elapsedMs}ms 後失敗）`}`,
    );
}

export function debugDroppedStale(code?: string) {
    pushTrace('dropped', '過時丟棄（佇列裡已經不是最新報價）', code);
    update((d) => {
        d.counters.droppedStale += 1;
    });
}

export function debugDuplicateSuppressed(code?: string) {
    pushTrace('duplicate', '去重擋下（同商品同句話）', code);
    update((d) => {
        d.counters.duplicateSuppressed += 1;
    });
}

export function debugNoQuote(code: string, reason: string) {
    pushTrace('no-quote', reason, code);
    update((d) => {
        const t = { ...target(code) };
        t.noQuote = true;
        t.noQuoteReason = reason;
        d.targets[code] = t;
    });
}

export function debugQuoteArrived(code: string) {
    // tick 每一筆都會呼叫這裡，所以只在「之前判定沒報價 → 現在收到了」記一筆
    if (target(code).noQuote) pushTrace('quote-arrived', '報價進來了', code);
    update((d) => {
        const t = { ...target(code) };
        if (!t.noQuote) return;
        t.noQuote = false;
        t.noQuoteReason = undefined;
        d.targets[code] = t;
    });
}

export function debugDealEvent() {
    pushTrace('deal', '收到成交／委託回報');
    update((d) => {
        d.counters.dealEvents += 1;
    });
}

export function debugNoticeEvent() {
    pushTrace('notice', '收到通知／條件單事件');
    update((d) => {
        d.counters.noticeEvents += 1;
    });
}

export function debugTestAnnouncement() {
    pushTrace('test', '手動測試播報');
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
