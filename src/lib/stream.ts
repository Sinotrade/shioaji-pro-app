// src/lib/stream.ts — single combined SSE connection with auto-reconnect.
// Quote state lives here (module-level store) so components can subscribe
// via useSyncExternalStore without prop drilling.

import { getApiBase, getStreamBase } from './runtime';
import { serverUrlBlocked } from './server-read-gate';
import { apiPost } from './api';
import type { SseBidAsk, SseIndexQuote, SseTick } from './types/market';
import { rememberIndexClose } from './index-close-quote';
import {
    normalizeOrderEvent,
    type OrderEventReport,
} from './order-report';
import { reportLedger, usReportLedger } from './report-ledger';
import { markStage } from './startup-timing';
import { isChildWindow } from './window-role';
import { forgetServerInfo, knownServerInfo } from './server-info-store';
import { createSharedStream, type StreamWire } from './shared-stream';
import { invalidateTradingMirror } from './trading-mirror-lease';
import { invalidateProductCatalog } from './product-catalog-version';
import { normalizeUsBidAsk, normalizeUsTick, recordUsTick, type RawUsBidAsk, type RawUsTick } from './us/us-quotes';
import { postUsStreamAction, probeUsStreamPath, usStreamDataPath, usStreamEventNames, usStreamKindOfEvent, US_STREAM_LEGACY_NAMES, US_STREAM_NAMES } from './us/us-stream-names';
import { isUsTickFullRejection, isUsTickRegistryKey, noteUsTickFullRejected, rememberUsTickWire, usTickFullKnownAbsent, usTickWire, type UsTickWire } from './us/us-tick-wire';
import { subscribeUsTickDetail } from './us/us-tick-prefs';

/** `stale`: the EventSource still looks open but no heartbeat or event
 *  arrived within the watchdog window (e.g. the sidecar behind a proxy was
 *  restarted). Treated like `down` everywhere: not LIVE, reconnecting. */
export type StreamStatus = 'connecting' | 'live' | 'down' | 'stale';

export interface ContractChangeEvent {
    event_id: string;
    action: string;
    region: string;
    security_type: string | null;
    published_at: string;
    base_changed: boolean;
    info_changed: boolean;
    info_scope: 'ALL' | 'SHARDS' | null;
    info_shards: string[];
}

export interface QuoteState {
    tick?: SseTick;
    bidask?: SseBidAsk;
    index?: SseIndexQuote;
    lastDir: 1 | -1 | 0; // direction of last price move, for flash effects
    seq: number; // bumps on every update (tick or bidask)
    flashSeq: number; // bumps only on real trades (not simtrade/bidask)
}

type Listener = () => void;

const quotes = new Map<string, QuoteState>();
// 盤中零股（intraday_odd）行情：同一個 code 的零股 tick／五檔是另一個市場
// （分開撮合、量以股計），存在獨立的 store，永遠不和整股行情混在一起（#204）
const oddQuotes = new Map<string, QuoteState>();
// continuous-month aliases (e.g. TXFR1): SSE events carry the resolved
// contract code (e.g. TXFF6); map it back to the display code.
const codeAlias = new Map<string, string>();

export function registerCodeAlias(actual: string, alias: string) {
    if (actual && alias && actual !== alias) {
        codeAlias.set(actual, alias);
    }
}

// resolve an actual contract code (e.g. TXFF6 from positions/orders) back
// to the display alias the user is watching (e.g. TXFR1)
export function getAliasFor(actualCode: string): string | undefined {
    return codeAlias.get(actualCode);
}
let status: StreamStatus = 'connecting';
let lastHeartbeat = 0;
const ownerListeners = new Set<() => void>();
export function isStreamOwner() { return shared?.isOwner() === true; }
export function subscribeStreamOwner(listener: () => void) {
    ownerListeners.add(listener);
    return () => { ownerListeners.delete(listener); };
}

const quoteListeners = new Map<string, Set<Listener>>();
const oddQuoteListeners = new Map<string, Set<Listener>>();
const statusListeners = new Set<Listener>();
const orderEventListeners = new Set<(ev: OrderEventReport) => void>();
const tickTapeListeners = new Set<(tick: SseTick) => void>();
const bidAskListeners = new Set<(bidask: SseBidAsk) => void>();
const oddTickListeners = new Set<(tick: SseTick) => void>();
const contractEventListeners = new Set<
    (event: ContractChangeEvent) => void
>();

function emitContractChange(event: ContractChangeEvent) {
    invalidateProductCatalog(event);
    contractEventListeners.forEach((listener) => listener(event));
}

function emitFullContractRefresh(
    action: 'RECONNECT' | 'MAINTENANCE',
    eventId: string,
    publishedAt: string,
) {
    const change: ContractChangeEvent = {
        event_id: eventId,
        action,
        region: 'TW',
        security_type: null,
        published_at: publishedAt,
        base_changed: true,
        info_changed: true,
        info_scope: 'ALL',
        info_shards: [],
    };
    emitContractChange(change);
    shared?.publish({ kind: 'event', name: 'contract_event', raw: JSON.stringify(change) });
}

// React 通知採 50ms 批次 — 開盤 tick 風暴（多面板×多檔訂閱）下逐筆
// 同步喚醒所有 useSyncExternalStore 訂閱者，會被 React 19 判定成巢狀
// 無限更新（Maximum update depth exceeded）而整頁炸掉。行情資料本身
// （quotes map）仍逐筆即時寫入，只有「通知 React 重繪」合併節流。
// 刻意用 setTimeout 而非 rAF：rAF 會夾進 React 併發渲染的 frame 節奏，
// 啟動風暴時 flush 落在 render 中間仍會觸發巢狀更新告警。
const QUOTE_FLUSH_MS = 50;
const dirtyQuoteCodes = new Set<string>();
const dirtyOddQuoteCodes = new Set<string>();
let quoteFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushDirty(dirty: Set<string>, listeners: Map<string, Set<Listener>>) {
    const codes = Array.from(dirty);
    dirty.clear();
    for (const code of codes) {
        listeners.get(code)?.forEach((l) => {
            // 單一 listener 拋錯不能中斷整批 flush — dirty set 已清空，
            // 中斷會讓其他 code 的更新無聲丟失直到下一筆 tick
            try {
                l();
            } catch (err) {
                console.error('[stream] quote listener threw', err);
            }
        });
    }
}

function flushQuoteEmits() {
    quoteFlushTimer = null;
    flushDirty(dirtyQuoteCodes, quoteListeners);
    flushDirty(dirtyOddQuoteCodes, oddQuoteListeners);
}

function emitQuote(code: string, oddLot = false) {
    (oddLot ? dirtyOddQuoteCodes : dirtyQuoteCodes).add(code);
    if (quoteFlushTimer === null) {
        quoteFlushTimer = setTimeout(flushQuoteEmits, QUOTE_FLUSH_MS);
    }
}

// 連線世代：串流每次「非 live → live」就＋1。sidecar 重啟必然中斷串流，所以同一
// 世代內的伺服器程序不變；process-local 的 trade_id 只在同一世代可信（整零價差）。
// 看門狗 stale→live 也會＋1（保守：多一次以標記重新接回，不會誤信）。
let connectionEpoch = 0;
/** 目前的串流連線世代（0＝本頁尚未連上） */
export function streamConnectionEpoch(): number {
    return status === 'live' ? connectionEpoch : -1;
}

function setStatus(s: StreamStatus) {
    if (status !== s) {
        if (s === 'live') connectionEpoch += 1;
        status = s;
        statusListeners.forEach((l) => l());
    }
    if (shared?.isOwner()) shared.publish({ kind: 'status', status: s, heartbeat: lastHeartbeat });
}

function handleTick(raw: string) {
    const tick = JSON.parse(raw) as SseTick;
    if (tick.intraday_odd) {
        // 零股：獨立 store、不進 onAnyTick（成交明細／整股觸價只看整股）
        ingestOddTick(tick);
        return;
    }
    ingestTick(tick);
    const alias = codeAlias.get(tick.code);
    if (alias) ingestTick({ ...tick, code: alias });
}

// 美股（#198）：轉成 SseTick／SseBidAsk，code 是 `US:CODE`，與台股同一個 store
function handleUsTick(raw: string) {
    let parsed: ReturnType<typeof normalizeUsTick>;
    try { parsed = normalizeUsTick(JSON.parse(raw) as RawUsTick); } catch { return; }
    if (!parsed) return;
    // 先記 meta（session 等）再送 tick：onAnyTick 監聽者（美股庫存計價時段）讀得到這筆的 session
    recordUsTick(parsed.meta);
    ingestTick(parsed.tick);
}

function handleUsBidAsk(raw: string) {
    let bidask: SseBidAsk | null;
    try { bidask = normalizeUsBidAsk(JSON.parse(raw) as RawUsBidAsk); } catch { return; }
    if (bidask) ingestBidAsk(bidask);
}

// 美股行情走獨立 SSE（/stream/data/tick_stk_us、/bidask_stk_us；1.8.0 前是 us_tick、
// us_bidask，新路徑 404 就退回舊路徑，見 us-stream-names.ts），只在有美股訂閱時
// 由串流擁有者開啟；收到的事件照樣轉給彈出視窗（shared publish）。
let usStreamRefs = 0;
/** 其他（非擁有者）視窗有美股訂閱：擁有者要替它們開美股 SSE 並轉送事件 */
let remoteUsWanted = false;
const US_WANT_KEY = 'us-quotes';
const usWanted = () => usStreamRefs > 0 || remoteUsWanted;
const usSources = new Map<string, EventSource>();
let usReopenTimer: ReturnType<typeof setTimeout> | null = null;
/** 美股成交 SSE 斷線或斷線後重連（期間可能漏收成交；庫存即時價要作廢） */
const usTickStreamResetListeners = new Set<() => void>();
let usTickStreamDropped = false;
/** 轉送給彈出視窗用的事件名（只走 shared wire，不是伺服器的 SSE 事件） */
const US_TICK_RESET_WIRE = 'us_tick_stream_reset';
function emitUsTickStreamReset() {
    usTickStreamResetListeners.forEach(l => l());
}
/** 擁有者：通知自己，並經 shared wire 轉給彈出視窗（與美股成交轉送同一條） */
function broadcastUsTickStreamReset() {
    emitUsTickStreamReset();
    shared?.publish({ kind: 'event', name: US_TICK_RESET_WIRE, raw: '' });
}
export function onUsTickStreamReset(listener: () => void) {
    usTickStreamResetListeners.add(listener);
    return () => {
        usTickStreamResetListeners.delete(listener);
    };
}

const US_QUOTE_STREAM_KINDS = ['tick', 'bidask'] as const;

function openUsStreams() {
    if (!usWanted() || typeof EventSource === 'undefined') return;
    if (shared && !shared.isOwner()) return;
    if (serverUrlBlocked(getStreamBase()) !== null) { scheduleUsReopen(); return; }
    for (const kind of US_QUOTE_STREAM_KINDS) {
        if (usSources.has(kind)) continue;
        const base = getApiBase();
        const source = new EventSource(`${getStreamBase()}${usStreamDataPath(kind, base)}`);
        let opened = false;
        // 新舊事件名稱都收：sidecar 只會用其中一個名字送
        for (const name of usStreamEventNames(kind)) {
            source.addEventListener(name, (event) => {
                const raw = (event as MessageEvent).data as string;
                shared?.publish({ kind: 'event', name, raw });
                if (kind === 'tick') handleUsTick(raw); else handleUsBidAsk(raw);
            });
        }
        source.onerror = () => {
            source.close();
            if (usSources.get(kind) === source) usSources.delete(kind);
            if (kind === 'tick') { usTickStreamDropped = true; broadcastUsTickStreamReset(); }
            // 從沒開成功：可能是 sidecar 不認得這套名稱（404），查一次，換了名稱就馬上重開
            if (!opened) {
                void probeUsStreamPath(kind, base).then((switched) => {
                    if (switched && usWanted() && !usSources.has(kind)) openUsStreams();
                });
            }
            scheduleUsReopen();
        };
        source.onopen = () => {
            opened = true;
            if (kind !== 'tick' || !usTickStreamDropped) return;
            usTickStreamDropped = false;
            broadcastUsTickStreamReset();
        };
        usSources.set(kind, source);
    }
}

function scheduleUsReopen() {
    if (usReopenTimer || !usWanted()) return;
    usReopenTimer = setTimeout(() => { usReopenTimer = null; openUsStreams(); }, 3000);
}

/** 有美股行情訂閱時保持美股 SSE 開著；回傳釋放函式 */
export function retainUsQuoteStreams(): () => void {
    usStreamRefs++;
    if (usStreamRefs === 1) shared?.want(US_WANT_KEY, true);
    openUsStreams();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        usStreamRefs--;
        if (usStreamRefs > 0) return;
        shared?.want(US_WANT_KEY, false);
        if (!remoteUsWanted) closeUsStreams();
    };
}

/** 關掉美股 SSE（釋放最後一個訂閱，或這個視窗交出串流擁有權） */
function closeUsStreams() {
    usSources.forEach(source => source.close());
    usSources.clear();
    if (usReopenTimer) { clearTimeout(usReopenTimer); usReopenTimer = null; }
}

function nextTickState(prev: QuoteState | undefined, tick: SseTick): QuoteState {
    const prevClose = prev?.tick ? Number(prev.tick.close) : undefined;
    const close = Number(tick.close);
    const lastDir: QuoteState['lastDir'] =
        prevClose === undefined || close === prevClose
            ? (prev?.lastDir ?? 0)
            : close > prevClose
              ? 1
              : -1;
    const isRealTrade = !tick.simtrade && tick.volume > 0;
    return {
        tick,
        bidask: prev?.bidask,
        index: prev?.index,
        lastDir,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: (prev?.flashSeq ?? 0) + (isRealTrade ? 1 : 0),
    };
}

function ingestOddTick(tick: SseTick) {
    oddQuotes.set(tick.code, nextTickState(oddQuotes.get(tick.code), tick));
    emitQuote(tick.code, true);
    if (!tick.simtrade && tick.volume > 0) oddTickListeners.forEach((l) => l(tick));
}

function ingestTick(tick: SseTick) {
    const state = nextTickState(quotes.get(tick.code), tick);
    quotes.set(tick.code, state);
    emitQuote(tick.code);
    // flash only on real deals — simtrade (試撮) updates must not blink
    if (!tick.simtrade && tick.volume > 0) {
        tickTapeListeners.forEach((l) => l(tick));
    }
}

function nextBidAskState(prev: QuoteState | undefined, bidask: SseBidAsk): QuoteState {
    return {
        tick: prev?.tick,
        bidask,
        index: prev?.index,
        lastDir: prev?.lastDir ?? 0,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: prev?.flashSeq ?? 0,
    };
}

function handleBidAsk(raw: string) {
    const bidask = JSON.parse(raw) as SseBidAsk;
    if (bidask.intraday_odd) {
        oddQuotes.set(bidask.code, nextBidAskState(oddQuotes.get(bidask.code), bidask));
        emitQuote(bidask.code, true);
        return;
    }
    ingestBidAsk(bidask);
    const alias = codeAlias.get(bidask.code);
    if (alias) ingestBidAsk({ ...bidask, code: alias });
}

function ingestBidAsk(bidask: SseBidAsk) {
    quotes.set(bidask.code, nextBidAskState(quotes.get(bidask.code), bidask));
    emitQuote(bidask.code);
    bidAskListeners.forEach((l) => l(bidask));
}

const INDEX_UPSTREAM_ALIASES: Record<string, string> = {
    limit_up_count: 'RaiseStop',
    raise_count: 'Raise',
    flat_count: 'Flat',
    fall_count: 'Fall',
    limit_down_count: 'FallStop',
};

function indexField(
    raw: Record<string, unknown>,
    name: string,
): unknown {
    const pascal = name
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    return raw[name] ?? raw[pascal] ?? raw[INDEX_UPSTREAM_ALIASES[name] ?? ''];
}

function optionalString(raw: Record<string, unknown>, name: string) {
    const value = indexField(raw, name);
    return value === undefined || value === null ? undefined : String(value);
}

function optionalNumber(raw: Record<string, unknown>, name: string) {
    const value = indexField(raw, name);
    if (value === undefined || value === null) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

// Shioaji Server 1.7 preserves the upstream QuoteIdxV1 field names in SSE
// (Date, Time, Reference, Close...). Normalize once at the stream boundary so
// the rest of the frontend can use the same lower-case shape as tick events.
export function normalizeIndexQuote(raw: string): SseIndexQuote {
    const source = JSON.parse(raw) as Record<string, unknown>;
    return {
        code: String(indexField(source, 'code') ?? ''),
        exchange: String(indexField(source, 'exchange') ?? ''),
        date: String(indexField(source, 'date') ?? ''),
        time: String(indexField(source, 'time') ?? ''),
        datetime: optionalString(source, 'datetime'),
        reference: String(indexField(source, 'reference') ?? ''),
        open: String(indexField(source, 'open') ?? ''),
        high: String(indexField(source, 'high') ?? ''),
        low: String(indexField(source, 'low') ?? ''),
        close: String(indexField(source, 'close') ?? ''),
        amount_sum: optionalString(source, 'amount_sum'),
        amount: optionalString(source, 'amount'),
        volume: optionalNumber(source, 'volume'),
        vol_sum: optionalNumber(source, 'vol_sum'),
        count: optionalNumber(source, 'count'),
        count_sum: optionalNumber(source, 'count_sum'),
        no_trade: optionalNumber(source, 'no_trade'),
        limit_up_count: optionalNumber(source, 'limit_up_count'),
        raise_count: optionalNumber(source, 'raise_count'),
        flat_count: optionalNumber(source, 'flat_count'),
        fall_count: optionalNumber(source, 'fall_count'),
        limit_down_count: optionalNumber(source, 'limit_down_count'),
        estimate_amount_sum: optionalString(source, 'estimate_amount_sum'),
    };
}

function handleIndexQuote(raw: string) {
    const index = normalizeIndexQuote(raw);
    if (!index.code || !Number.isFinite(Number(index.close))) return;
    const prev = quotes.get(index.code);
    const previousClose = prev?.index ? Number(prev.index.close) : undefined;
    const close = Number(index.close);
    const moved = previousClose !== undefined && close !== previousClose;
    const lastDir: QuoteState['lastDir'] =
        previousClose === undefined || close === previousClose
            ? (prev?.lastDir ?? 0)
            : close > previousClose
              ? 1
              : -1;
    quotes.set(index.code, {
        tick: prev?.tick,
        bidask: prev?.bidask,
        index,
        lastDir,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: (prev?.flashSeq ?? 0) + (moved ? 1 : 0),
    });
    emitQuote(index.code);
    rememberIndexClose(index);
}

// registry of every quote subscription made this session — replayed after
// the SSE connection recovers (covers shioaji-server restarts)
const subscriptionRegistry = new Map<string, Record<string, unknown>>();
const capabilityRegistry = new Map<
    string,
    { path: string; body: Record<string, unknown> }
>();

export function registerSubscription(body: {
    security_type: string | null;
    exchange: string | null;
    code: string;
    target_code: string | null;
    quote_type: string;
    intraday_odd: boolean;
}) {
    subscriptionRegistry.set(subscriptionKey(body.code, body.quote_type, body.intraday_odd), body);
}

/** 整股與零股是兩個獨立訂閱：key 帶零股旗標，重連重播兩者都會還原 */
function subscriptionKey(code: string, quoteType: string, oddLot = false) {
    return `${code}:${quoteType}${oddLot ? ':odd' : ''}`;
}

export function unregisterSubscription(code: string, quoteType: string, oddLot = false) {
    subscriptionRegistry.delete(subscriptionKey(code, quoteType, oddLot));
}

/** Bodies replayed after a reconnect (diagnostics / tests). */
export function getRegisteredSubscriptions(): Record<string, unknown>[] {
    return [...subscriptionRegistry.values()];
}

// 巢狀 body 的訂閱（如 managed 組合合約 {contract:{legs,...}}）— key 用
// 組合 code（同時是 SSE 事件身分），body 原樣重播
export function registerSubscriptionRaw(
    code: string,
    quoteType: string,
    body: Record<string, unknown>,
) {
    subscriptionRegistry.set(`${code}:${quoteType}`, body);
}

export function registerCapabilitySubscription(
    key: string,
    path: string,
    body: Record<string, unknown>,
) {
    capabilityRegistry.set(key, { path, body });
}

export function unregisterCapabilitySubscription(key: string) {
    capabilityRegistry.delete(key);
}

/** 已登記的訂閱 body（美股退訂要用訂閱時實際送出的 quote_type） */
export function getRegisteredSubscription(code: string, quoteType: string): Record<string, unknown> | undefined {
    return subscriptionRegistry.get(`${code}:${quoteType}`);
}

type StreamPost = (path: 'subscribe' | 'unsubscribe', body: Record<string, unknown>) => Promise<void>;

/** 訂閱／退訂請求等回應的上限：逾時當作「結果不確定」（請求可能已送達） */
export const STREAM_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 行情訂閱請求加上逾時。逾時不取消請求本身（可能已送達），只是不再等它；
 * 呼叫端依 isDefiniteStreamFailure 判斷結果是否確定。逾時的錯誤帶著原本的請求
 * （late），呼叫端可以在它之後才完成時再對帳一次（見 ensureUsTickKind）。
 */
export function withStreamTimeout<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('行情訂閱請求逾時，結果不確定'), { requestTimedOut: true as const, late: request })),
            STREAM_REQUEST_TIMEOUT_MS);
    });
    return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}

/** sidecar 明確回了「沒做」（HTTP 錯誤狀態、success=false、或請求根本沒送出） */
export function isDefiniteStreamFailure(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false;
    const x = e as { status?: unknown; streamRejected?: unknown; subscriptionNotStarted?: unknown; mutationNotStarted?: unknown; message?: unknown };
    if (x.streamRejected === true || x.subscriptionNotStarted === true || x.mutationNotStarted === true) return true;
    if (typeof x.status === 'number') return true;
    return typeof x.message === 'string' && /^\d{3}\b/.test(x.message);
}

const postStream: StreamPost = async (path, body) => {
    const response = await withStreamTimeout(apiPost<{ success?: boolean; message?: string }>(
        `/api/v1/stream/${path}`,
        body,
    ));
    if (response.success === false) {
        throw Object.assign(new Error(response.message || '行情重新訂閱失敗'), { streamRejected: true as const });
    }
};

export const usBaseChanged = () => Object.assign(new Error('伺服器位址已變更，美股行情訂閱未完成'), { subscriptionNotStarted: true as const });

// ---- 美股逐筆的每商品鎖 ----
//
// 同一個商品的美股逐筆操作（消費者訂閱／退訂、設定切換改訂、重連重播）一律排隊，
// 一次只有一個在飛：registry 永遠是「目前實際訂著（或最後一次嘗試）」的種類，
// 不會有改訂途中被重播或退訂用到舊種類、留下 Tick＋TickFull 或沒人管的 TickFull。
// 每個請求都有逾時（STREAM_REQUEST_TIMEOUT_MS），卡住的回應不會永遠占著鎖。
// key＝registry key（US:CODE:Tick）。
const usTickLocks = new Map<string, Promise<unknown>>();

export function withUsTickLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = usTickLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    usTickLocks.set(key, tail);
    void tail.then(() => { if (usTickLocks.get(key) === tail) usTickLocks.delete(key); });
    return run;
}

// ---- 美股逐筆：要對帳的商品 ----
//
// sidecar 的美股退訂是冪等的（沒訂也回 200 success；Solace 另發的 "Subscription Not Found"
// 事件本 App 沒有訂閱、不會顯示），而 Tick 與 TickFull 可以同時訂（成交重複、分不出來）。
// 所以不追蹤「哪一種可能在」，只記「這個商品的結果不確定、要對帳」：
//   對帳／換訂＝退掉另一種 → 訂上要的那種，兩步都要 2xx 才算完成；任何失敗、逾時都留著
//   旗標，不先訂新的，由 5 秒後的對帳（或重連重播）再跑一次。
// 旗標以伺服器位址（base）區分；就算帶到重啟後的 sidecar，也只是多送冪等的退訂／訂閱。
const usTickReconcile = new Set<string>();
const reconcileKey = (base: string, key: string) => `${base}|${key}`;

export function needsUsTickReconcile(key: string, base = getApiBase()): boolean {
    return usTickReconcile.has(reconcileKey(base, key));
}

export function setUsTickReconcile(key: string, on: boolean, base = getApiBase()) {
    if (on) usTickReconcile.add(reconcileKey(base, key));
    else usTickReconcile.delete(reconcileKey(base, key));
}

export const otherUsTickKind = (kind: UsTickWire): UsTickWire => (kind === 'Tick' ? 'TickFull' : 'Tick');

/**
 * 退訂一種：2xx 才算完成。TickFull 在確定不支援它的舊 sidecar 上不必退；被舊 sidecar
 * 以 400 拒絕（不認得）也代表本來就不在。其他失敗（含 429、5xx、逾時）照樣丟出。
 */
export async function dropUsTickKind(kind: UsTickWire, base: string, post: (path: 'unsubscribe', kind: UsTickWire) => Promise<unknown>) {
    if (kind === 'TickFull' && usTickFullKnownAbsent(base)) return;
    try {
        await post('unsubscribe', kind);
    } catch (e) {
        if (kind !== 'TickFull' || !isUsTickFullRejection(e)) throw e;
        if (getApiBase() === base) noteUsTickFullRejected(base);
    }
}

/**
 * 把 key 的美股逐筆換成（或補訂）wanted。present：可能訂著的種類（registry、上一次載入
 * 記下的）；其中有另一種、或這個商品要對帳時，先退掉另一種。送出訂閱前呼叫
 * beforeSubscribe（registry 先記要訂的種類：結果不確定時關閉／重播也找得到它），
 * sessionStorage 也先記。TickFull 被舊 sidecar 以 400 拒絕就改訂 Tick。
 * 任何一步失敗都標記要對帳後丟出。必須在 withUsTickLock(key) 裡呼叫。
 */
export async function ensureUsTickKind<R>(opts: {
    key: string;
    base: string;
    present: (UsTickWire | undefined)[];
    wanted: UsTickWire;
    post: (path: 'subscribe' | 'unsubscribe', kind: UsTickWire) => Promise<R>;
    beforeSubscribe: (kind: UsTickWire) => void;
}): Promise<{ wire: UsTickWire; response: R }> {
    const { key, base, post } = opts;
    const code = key.slice(0, -':Tick'.length);
    let wire = opts.wanted;
    try {
        if (needsUsTickReconcile(key, base) || opts.present.includes(otherUsTickKind(wire))) {
            await dropUsTickKind(otherUsTickKind(wire), base, (path, k) => post(path, k));
        }
        if (getApiBase() !== base) throw usBaseChanged();
        rememberUsTickWire(base, code, wire);
        opts.beforeSubscribe(wire);
        let response: R;
        try {
            response = await post('subscribe', wire);
        } catch (e) {
            if (wire !== 'TickFull' || !isUsTickFullRejection(e) || getApiBase() !== base) throw e;
            noteUsTickFullRejected(base);
            wire = 'Tick';
            rememberUsTickWire(base, code, wire);
            opts.beforeSubscribe(wire);
            response = await post('subscribe', wire);
        }
        setUsTickReconcile(key, false, base);
        return { wire, response };
    } catch (e) {
        setUsTickReconcile(key, true, base);
        reconcileWhenLateRequestLands(e, key, base);
        throw e;
    }
}

/**
 * 逾時的訂閱／退訂之後才在 sidecar 生效時（例如逾時後的對帳已經退了 TickFull、訂了 Tick，
 * 原本那筆 TickFull 訂閱才完成），結果又變了：再標記對帳、5 秒後跑一次，
 * 不讓 Tick 與 TickFull 同時在、或要的那種被晚到的退訂拿掉。
 */
function reconcileWhenLateRequestLands(e: unknown, key: string, base: string) {
    const late = (e as { requestTimedOut?: unknown; late?: unknown } | null)?.late;
    if ((e as { requestTimedOut?: unknown } | null)?.requestTimedOut !== true || !(late instanceof Promise)) return;
    late.then(() => {
        if (getApiBase() !== base) return;
        setUsTickReconcile(key, true, base);
        scheduleUsTickReconcile();
    }, () => undefined);
}

/**
 * 重播美股逐筆：依目前設定與 sidecar 重新決定 TickFull／Tick（使用者可能換了設定、
 * sidecar 可能換了版本），在每商品鎖裡讀 registry，經 ensureUsTickKind 換訂或補訂。
 * onlyIfStale：設定切換／對帳用，種類已對、也不用對帳就不動。
 */
function replayUsTick(key: string, post: StreamPost, onlyIfStale = false): Promise<void> {
    return withUsTickLock(key, async () => {
        const registered = subscriptionRegistry.get(key);
        if (!registered) return; // 排隊期間已經被退訂
        const base = getApiBase();
        const wanted = usTickWire();
        const current: UsTickWire = registered.quote_type === 'TickFull' ? 'TickFull' : 'Tick';
        if (onlyIfStale && current === wanted && !needsUsTickReconcile(key, base)) return;
        await ensureUsTickKind({
            key, base, present: [current], wanted,
            post: (path, kind) => post(path, { ...registered, quote_type: kind }),
            beforeSubscribe: (kind) => {
                if (subscriptionRegistry.has(key)) subscriptionRegistry.set(key, kind === current ? registered : { ...registered, quote_type: kind });
            },
        });
    });
}

// ---- 美股成交資料設定切換（Tick ⇄ TickFull）：即時改訂目前訂閱中的美股逐筆 ----
//
// 只動登記的種類跟現在該用的不同的商品（先退舊的再訂新的，見 replayUsTick），
// 一次一輪、與重連重播錯開；同樣照 50 筆／5 秒的節奏。失敗的留到 5 秒後再試。
let usTickSwitching: Promise<void> = Promise.resolve();
/** 已排隊、還沒開始的那一輪：連續觸發只跑一輪 */
let usTickSwitchQueued: Promise<void> | null = null;
let usTickSwitchRetry: ReturnType<typeof setTimeout> | null = null;

async function switchUsTicksOnce() {
    if (replaying) await replaying.catch(() => undefined);
    const pace = makePacer();
    const post: StreamPost = async (path, body) => { await pace(); await postStream(path, body); };
    let failed = false;
    for (const [key, body] of [...subscriptionRegistry.entries()]) {
        if (!isUsTickRegistryKey(key)) continue;
        // 正在改訂中（鎖住）的商品一定要排進來：完成後才知道是不是已經對了
        if (body.quote_type === usTickWire() && !needsUsTickReconcile(key) && !usTickLocks.has(key)) continue;
        try {
            await replayUsTick(key, post, true);
        } catch {
            failed = true;
        }
    }
    if (failed) scheduleUsTickReconcile();
}

/** 5 秒後跑一次美股逐筆對帳（訂閱結果不確定時用） */
export function scheduleUsTickReconcile() {
    if (usTickSwitchRetry) return;
    usTickSwitchRetry = setTimeout(() => {
        usTickSwitchRetry = null;
        void resubscribeUsTicks();
    }, 5000);
}

/** 美股逐筆依目前設定改訂（設定切換時自動呼叫；回傳下一輪完成的 promise） */
export function resubscribeUsTicks(): Promise<void> {
    if (usTickSwitchQueued) return usTickSwitchQueued;
    const run = () => {
        usTickSwitchQueued = null;
        return switchUsTicksOnce();
    };
    const next = usTickSwitching.then(run, run);
    usTickSwitchQueued = next;
    usTickSwitching = next;
    return next;
}

try {
    subscribeUsTickDetail(() => { void resubscribeUsTicks(); });
} catch {
    // 測試整個 mock 掉 us-tick-prefs 時略過
}

let resubscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;

// Replay after a reconnect is paced: Shioaji documents 50 subscriptions per
// 5 s. A restart/stale reconnect (now also driven by the heartbeat watchdog)
// must not burst the whole registry at once. One replay at a time.
export const REPLAY_BATCH = 40;
export const REPLAY_WINDOW_MS = 5000;
let replaying: Promise<void> | null = null;
/** 每 REPLAY_BATCH 筆等滿一個 REPLAY_WINDOW_MS 視窗 */
function makePacer() {
    let sent = 0;
    let windowStart = Date.now();
    return async () => {
        if (sent > 0 && sent % REPLAY_BATCH === 0) {
            const wait = windowStart + REPLAY_WINDOW_MS - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            windowStart = Date.now();
        }
        sent++;
    };
}
let replayAgain = false;
function replay(onlyCapabilities: boolean): Promise<void> {
    if (replaying) { replayAgain = true; return replaying; }
    replaying = replayOnce(onlyCapabilities).finally(() => {
        replaying = null;
        if (replayAgain) { replayAgain = false; void resubscribeAll(); }
    });
    return replaying;
}
function resubscribeAll(): Promise<void> { return replay(false); }
/** 測試用：直接跑一次重播（不經 SSE 重連） */
export function replayRegisteredSubscriptionsForTest(): Promise<void> { return replay(false); }
function resubscribeCapabilities(): Promise<void> {
    return capabilityRegistry.size ? replay(true) : Promise.resolve();
}
async function replayOnce(onlyCapabilities = false) {
    let failed = false;
    const pace = makePacer();
    const post = postStream;
    for (const [key, body] of onlyCapabilities ? [] : [...subscriptionRegistry.entries()]) {
        await pace();
        try {
            if (isUsTickRegistryKey(key)) {
                // 這個商品還有操作在飛：不在這裡等它（不讓一個卡住的商品拖住整批重播），
                // 算這一輪失敗，5 秒後重播時再處理
                if (usTickLocks.has(key)) { failed = true; continue; }
                await replayUsTick(key, post);
            } else await post('subscribe', body);
        } catch {
            failed = true;
        }
    }
    for (const { path, body } of [...capabilityRegistry.values()]) {
        await pace();
        try {
            // 美股停牌：依 sidecar 用新（halt_stk_us）或舊（us_halt）名稱，404／405 自動換
            const response = usStreamKindOfEvent(path) === 'halt'
                ? await postUsStreamAction<{ success: boolean; message: string }>('subscribe', 'halt', body)
                : await apiPost<{ success: boolean; message: string }>(
                    `/api/v1/stream/subscribe/${path}`,
                    body,
                );
            if (!response.success) throw new Error(response.message);
        } catch {
            failed = true;
        }
    }
    if (failed && !resubscribeRetryTimer) {
        resubscribeRetryTimer = setTimeout(() => {
            resubscribeRetryTimer = null;
            void resubscribeAll();
        }, 5000);
    }
}

let es: EventSource | null = null;
let shared: ReturnType<typeof createSharedStream> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let everDown = false;

// Extra named-event listeners (enriched index, scanner, …) share the ONE
// aggregate SSE connection. Since shioaji 1.7.2 the aggregate stream
// carries every event family, so consumers register here instead of
// opening dedicated per-channel EventSources (six HTTP/1.1 streams used
// to exhaust the browser's per-origin connection pool).
const namedListeners = new Map<string, Set<(raw: string) => void>>();
// These families may have consumers only in follower popouts. The owner must
// subscribe to their SSE names even when it has no local listener.
const sharedNamedEvents = ['index_components', 'calculated_index', 'scanner', 'kbar', 'heartbeat'];
const attachedNamed = new Set<string>();

function attachNamed(source: EventSource, name: string) {
    if (attachedNamed.has(name)) return;
    attachedNamed.add(name);
    source.addEventListener(name, (event) => {
        markActivity();
        dispatchNamed(name, (event as MessageEvent).data);
    });
}

function dispatchNamed(name: string, raw: string) {
    // heartbeat is already forwarded by the core listener below.
    if (name !== 'heartbeat') shared?.publish({ kind: 'event', name, raw });
    namedListeners.get(name)?.forEach((listener) => listener(raw));
}

export function onStreamEvent(
    name: string,
    listener: (raw: string) => void,
) {
    let set = namedListeners.get(name);
    if (!set) {
        set = new Set();
        namedListeners.set(name, set);
        if (es) attachNamed(es, name);
    }
    set.add(listener);
    return () => {
        namedListeners.get(name)?.delete(listener);
    };
}

// ---- heartbeat watchdog ----
// The sidecar heartbeats every 30 s (1.7.5/1.7.6; docs/design/debug-monitor.md).
// A proxied EventSource can stay "open" after the sidecar behind it died, so
// silence longer than two periods plus slack marks the stream STALE, closes
// it and reconnects through the normal backoff. Local only: the watchdog never
// issues any HTTP request itself.
export const HEARTBEAT_PERIOD_MS = 30_000;
export const STALE_AFTER_MS = 2 * HEARTBEAT_PERIOD_MS + 15_000;
export const WATCHDOG_TICK_MS = 5000;
// A check this late means the WebView/tab was suspended: queued events may
// not have been delivered yet, so allow one heartbeat period before STALE.
const RESUME_GAP_MS = 15_000;
// Connections that open but never deliver a heartbeat (e.g. a buffering
// proxy) keep escalating the retry delay instead of resetting to 1 s.
const SILENT_RETRY_MAX_MS = 5 * 60_000;
let lastActivity = 0;
let lastCheckAt = 0;
let graceUntil = 0;
let heartbeatSinceOpen = false;
let silentConnections = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
function markActivity() {
    lastActivity = Date.now();
}
const NORMAL_RETRY_MAX_MS = 15_000;
/** `cap` bounds this and the following delay: connection errors use the
 *  normal backoff; only a connection that opened but never delivered a
 *  heartbeat may escalate beyond it. */
function scheduleReconnect(cap = NORMAL_RETRY_MAX_MS, fixedDelayMs?: number) {
    everDown = true;
    es?.close();
    es = null;
    if (retryTimer) clearTimeout(retryTimer);
    if (fixedDelayMs !== undefined) {
        // one-off quick retry: leaves the backoff sequence untouched
        retryTimer = setTimeout(() => { if (shared?.isOwner()) connect(); }, fixedDelayMs);
        return;
    }
    const delay = Math.min(retryDelay, cap);
    retryTimer = setTimeout(() => { if (shared?.isOwner()) connect(); }, delay);
    retryDelay = Math.min(delay * 2, cap);
}

// ---- first connection of this page (startup, issue #142) ----
// Native timing showed LIVE landing a steady ~3.5 s after the SSE connect
// although the sidecar answers the stream at once (its heartbeat interval's
// first tick is immediate) — the shape of two failed attempts under the
// 1 s → 2 s backoff. Until this page's stream has opened once, the first
// few failures retry after 250 ms instead; after that (or once it opened)
// the normal backoff applies unchanged. Marks record exactly what happened.
export const STARTUP_FAST_RETRIES = 3;
export const STARTUP_RETRY_MS = 250;
// a drop in the first seconds of a page (the connection opened during page
// load) is treated like a startup failure too
export const STARTUP_WINDOW_MS = 15_000;
let openedOnce = false;
let openedAt: number | null = null;
let startupFailures = 0;
let heartbeatSeen = false;
const pageAge = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Number.POSITIVE_INFINITY;
/** When this page's stream first opened (epoch ms), or null. */
export function streamOpenedAt(): number | null {
    return openedAt;
}
// Every stream mark names its page: a cold start spans two pages (before
// and after the post-start reload), each with its own connection, and one
// timeline must not read as "the stream opened, then was replaced".
const PAGE_TAG = typeof performance !== 'undefined' && performance.timeOrigin
    ? `page=${Math.round(performance.timeOrigin) % 100_000}`
    : 'page=?';
let connectStartedAt = 0;
function markStream(
    stage: 'stream-connect' | 'stream-open' | 'stream-error' | 'stream-heartbeat' | 'stream-restart',
    detail?: string,
) {
    if (!isChildWindow()) markStage(stage, detail ? `${PAGE_TAG} ${detail}` : PAGE_TAG);
}

// ---- cold-start hold ----
// On a cold start the first page only exists until the server turns healthy
// and boot reloads it: a stream opened there connects to a server that is
// not up yet (the failures seen natively) and is torn down by the reload a
// moment later. Boot holds the connection on that page and releases it on
// every path that does NOT reload; the hold also expires on its own so a
// missed release can never leave the App without a stream.
export const STREAM_HOLD_MAX_MS = 30_000;
let held = false;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let pendingConnect = false;
export function holdStream() {
    if (held || started) return; // only before the first connection
    held = true;
    holdTimer = setTimeout(() => releaseStream('hold expired'), STREAM_HOLD_MAX_MS);
}
export function releaseStream(reason = 'released') {
    if (!held) return;
    held = false;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (pendingConnect) {
        pendingConnect = false;
        if (shared?.isOwner()) startConnection(reason);
    }
}
let lastCheckGap = 0;
function checkWatchdog() {
    if (shared && !shared.isOwner()) return;
    const now = Date.now();
    const gap = lastCheckAt > 0 ? now - lastCheckAt : 0;
    // One grace per resume: only when this check is late but the previous one
    // was on time and the stream was not already silent then. A throttled
    // background timer (every 20–60 s) is late on every check and must not
    // renew the grace forever.
    const staleAtPreviousCheck = lastActivity > 0 && lastCheckAt - lastActivity > STALE_AFTER_MS;
    if (gap > RESUME_GAP_MS && lastCheckGap <= RESUME_GAP_MS && !staleAtPreviousCheck && now >= graceUntil) {
        graceUntil = now + HEARTBEAT_PERIOD_MS;
    }
    lastCheckGap = gap;
    lastCheckAt = now;
    if (!es || status !== 'live' || !lastActivity) return;
    if (now < graceUntil || now - lastActivity <= STALE_AFTER_MS) return;
    const silent = !heartbeatSinceOpen;
    if (silent) silentConnections++;
    setStatus('stale');
    markStream('stream-restart', `reason=${silent ? 'silent' : 'stale'}`);
    scheduleReconnect(silent ? SILENT_RETRY_MAX_MS : NORMAL_RETRY_MAX_MS);
}
/** Watchdog diagnostics for Debug: consecutive connections that opened but
 *  went stale without any heartbeat, and the current retry delay. */
export function getStreamWatchdog() {
    return { silentConnections, retryDelayMs: retryDelay, staleAfterMs: STALE_AFTER_MS };
}

function listen(source: EventSource, name: string, handler: (event: MessageEvent) => void) {
    source.addEventListener(name, (event) => {
        markActivity();
        const message = event as MessageEvent;
        shared?.publish({ kind: 'event', name, raw: message.data });
        handler(message);
    });
}

function dispatchWire(wire: StreamWire) {
    if (wire.kind === 'status') {
        if (wire.heartbeat) lastHeartbeat = wire.heartbeat;
        setStatus(wire.status);
        return;
    }
    // 擁有者轉來的美股成交 SSE 斷線／重連：不是行情活動，不碰看門狗
    if (wire.name === US_TICK_RESET_WIRE) { emitUsTickStreamReset(); return; }
    markActivity();
    const { name, raw } = wire;
    if (name === 'tick_stk' || name === 'tick_fop') handleTick(raw);
    else if (name === 'bidask_stk' || name === 'bidask_fop') handleBidAsk(raw);
    else if (name === 'quote_idx') handleIndexQuote(raw);
    else if (name === US_STREAM_NAMES.tick || name === US_STREAM_LEGACY_NAMES.tick) handleUsTick(raw);
    else if (name === US_STREAM_NAMES.bidask || name === US_STREAM_LEGACY_NAMES.bidask) handleUsBidAsk(raw);
    else if (name === 'order_event') handleOrderEvent(raw);
    else if (name === 'contract_event') {
        const change = JSON.parse(raw) as ContractChangeEvent;
        emitContractChange(change);
        // Each popout owns its capability subscriptions. A new SSE owner
        // cannot replay another window's local registry, so each follower
        // restores its own after a reconnect or daily maintenance.
        if (change.action === 'RECONNECT' || change.action === 'MAINTENANCE') void resubscribeCapabilities();
    }
    else if (name === 'heartbeat') {
        lastHeartbeat = Date.now();
        setStatus('live');
    }
    // heartbeat also has a named subscriber (trigger activity).
    if (namedListeners.has(name)) namedListeners.get(name)?.forEach(listener => listener(raw));
}

function handleOrderEvent(raw: string) {
    const report = normalizeOrderEvent(JSON.parse(raw));
    if (!report) return;
    // 美股回報另用一本 ledger：它的跳號只讓美股委託重新對帳，不標記台股
    const admitted = (report.market === 'us' ? usReportLedger : reportLedger).admit(
        { base: getApiBase(), simulation: knownServerInfo()?.simulation },
        report.eventId,
        report.kind,
    );
    if (admitted.duplicate) return;
    orderEventListeners.forEach((l) => l(report));
}

// #285: a stream that is already open (e.g. a reload that skipped the boot
// hold) is closed the moment boot refuses the server it points at
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('sj-pro-api-base-changed', () => {
        if (es && serverUrlBlocked(getStreamBase()) !== null) {
            setStatus('down');
            scheduleReconnect(NORMAL_RETRY_MAX_MS);
        }
    });
}

function connect() {
    // Only the Web Locks owner may create an EventSource, including retries
    // queued before ownership was handed to another window.
    if (shared && !shared.isOwner()) return;
    forgetServerInfo(getApiBase());
    if (es) {
        // never expected while a connection is live: record it if it happens
        markStream('stream-restart', 'reason=connect-while-open');
        es.close();
    }
    connectStartedAt = Date.now();
    // Keep STALE visible until the reconnect actually opens.
    setStatus(status === 'stale' ? 'stale' : 'connecting');
    // #285: never stream from another program's server this App did not
    // adopt — retry later (the App's own server replaces it, or the block
    // is lifted)
    if (serverUrlBlocked(getStreamBase()) !== null) {
        setStatus('down');
        scheduleReconnect(NORMAL_RETRY_MAX_MS);
        return;
    }
    // region filters contract_event only; other families are unfiltered
    es = new EventSource(`${getStreamBase()}/api/v1/stream/data?region=TW`);
    attachedNamed.clear();

    es.onopen = () => {
        if (!openedOnce) {
            openedOnce = true;
            openedAt = Date.now();
            markStream('stream-open', `failures=${startupFailures} after=${openedAt - connectStartedAt}ms`);
        }
        // A connection only proves healthy once a heartbeat arrives; until
        // then keep the backoff so silent connections do not loop every ~80 s.
        if (silentConnections === 0) retryDelay = 1000;
        heartbeatSinceOpen = false;
        markActivity();
        setStatus('live');
        // SSE does not replay contract changes missed while disconnected —
        // re-query on every successful connection so a daily update cannot
        // stay stale.
        const now = new Date().toISOString();
        emitFullContractRefresh('RECONNECT', `reconnect:${now}`, now);
        if (everDown) {
            everDown = false;
            void resubscribeAll(); // server may have restarted — replay subs
        }
    };

    for (const ev of ['tick_stk', 'tick_fop']) {
        listen(es, ev, (e) => handleTick((e as MessageEvent).data));
    }
    for (const ev of ['bidask_stk', 'bidask_fop']) {
        listen(es, ev, (e) => handleBidAsk((e as MessageEvent).data));
    }
    listen(es, 'quote_idx', (e) =>
        handleIndexQuote((e as MessageEvent).data),
    );
    listen(es, 'order_event', (e) => handleOrderEvent(e.data));
    listen(es, 'contract_event', (event) => {
        const change = JSON.parse(
            (event as MessageEvent).data,
        ) as ContractChangeEvent;
        emitContractChange(change);
    });
    listen(es, 'heartbeat', () => {
        if (!heartbeatSeen) {
            heartbeatSeen = true;
            markStream('stream-heartbeat');
        }
        lastHeartbeat = Date.now();
        heartbeatSinceOpen = true;
        silentConnections = 0;
        retryDelay = 1000;
        setStatus('live');
    });
    for (const name of [...sharedNamedEvents, ...namedListeners.keys()]) {
        attachNamed(es, name);
    }

    es.onerror = () => {
        if (shared && !shared.isOwner()) return;
        setStatus('down');
        if (!openedOnce || pageAge() < STARTUP_WINDOW_MS) {
            startupFailures++;
            const fast = startupFailures <= STARTUP_FAST_RETRIES;
            markStream(
                'stream-error',
                `failure=${startupFailures}${openedOnce ? ' after open' : ''} retry=${fast ? STARTUP_RETRY_MS : Math.min(retryDelay, NORMAL_RETRY_MAX_MS)}ms`,
            );
            if (fast) {
                scheduleReconnect(NORMAL_RETRY_MAX_MS, STARTUP_RETRY_MS);
                return;
            }
        }
        // A refused/failed connection is a normal outage (e.g. sidecar
        // restarting): normal backoff, even after silent connections.
        scheduleReconnect(NORMAL_RETRY_MAX_MS);
    };
}

// The shioaji server's daily maintenance (~08:22 TW) rebuilds its upstream
// client and silently drops every market-data subscription while our SSE
// connection stays up — watch last_maintenance and resubscribe when it moves.
let lastMaintenance: string | null = null;

async function watchMaintenance() {
    if (shared && !shared.isOwner()) return;
    try {
        if (serverUrlBlocked(getApiBase()) !== null) return;
        const res = await fetch(`${getApiBase()}/api/v1/health`);
        if (!res.ok) return;
        const h = (await res.json()) as { last_maintenance?: string };
        const lm = h.last_maintenance ?? null;
        if (lastMaintenance !== null && lm !== lastMaintenance) {
            await resubscribeAll();
            // Contract events are not replayed. The server can rebuild its
            // client while this EventSource reconnects, so use maintenance as
            // a compensating signal and re-query cached Contract V2 info.
            emitFullContractRefresh(
                'MAINTENANCE',
                `maintenance:${lm ?? Date.now()}`,
                lm ?? new Date().toISOString(),
            );
        }
        lastMaintenance = lm;
    } catch {
        // server unreachable — SSE reconnect path handles resubscription
    }
}

let started = false;
export function ensureStream() {
    if (!started) {
        started = true;
        shared = createSharedStream({
            name: `sj-market-stream:${typeof location === 'undefined' ? 'test' : location.origin}:${getApiBase()}:${getStreamBase()}`,
            main: !isChildWindow(),
            onOwn: () => {
                if (isChildWindow()) invalidateTradingMirror();
                ownerListeners.forEach(listener => listener());
                // 接手擁有權：這個視窗已有的美股訂閱要重新開美股 SSE
                openUsStreams();
                everDown = true;
                if (held) pendingConnect = true;
                else startConnection();
            },
            onRelease: () => {
                ownerListeners.forEach(listener => listener());
                pendingConnect = false;
                es?.close();
                es = null;
                // 交出擁有權：美股 SSE 跟著關，由新的擁有者開
                remoteUsWanted = false;
                closeUsStreams();
                if (retryTimer) clearTimeout(retryTimer);
                retryTimer = null;
                setStatus('connecting');
            },
            onWire: dispatchWire,
            onMissing: () => { if (status === 'live') setStatus('down'); },
            onRemoteWants: (keys) => {
                remoteUsWanted = keys.has(US_WANT_KEY);
                if (usWanted()) openUsStreams(); else closeUsStreams();
            },
            snapshot: () => ({ kind: 'status', status, heartbeat: lastHeartbeat }),
        });
        // 串流建立前就有的美股訂閱：同樣告訴擁有者
        if (usStreamRefs > 0) shared.want(US_WANT_KEY, true);
        lastCheckAt = Date.now();
        watchdogTimer = setInterval(checkWatchdog, WATCHDOG_TICK_MS);
        setInterval(watchMaintenance, 60000);
    }
}

function startConnection(reason?: string) {
    if (shared && !shared.isOwner()) return;
    markStream('stream-connect', reason);
    connect();
    void watchMaintenance();
}

// ---- store API (for useSyncExternalStore) ----

export function subscribeQuoteStore(code: string, listener: Listener, oddLot = false) {
    const listeners = oddLot ? oddQuoteListeners : quoteListeners;
    let set = listeners.get(code);
    if (!set) {
        set = new Set();
        listeners.set(code, set);
    }
    set.add(listener);
    return () => {
        set.delete(listener);
    };
}

/** `oddLot`: the 盤中零股 store (shares), never the regular-lot one. */
export function getQuote(code: string, oddLot = false): QuoteState | undefined {
    return (oddLot ? oddQuotes : quotes).get(code);
}

export function subscribeStatusStore(listener: Listener) {
    statusListeners.add(listener);
    return () => {
        statusListeners.delete(listener);
    };
}

export function getStreamStatus(): StreamStatus {
    return status;
}

export function getLastHeartbeat(): number {
    return lastHeartbeat;
}

export function getSubscriptionCount(): number {
    return subscriptionRegistry.size;
}

export function onOrderEvent(listener: (ev: OrderEventReport) => void) {
    orderEventListeners.add(listener);
    return () => {
        orderEventListeners.delete(listener);
    };
}

export function onAnyTick(listener: (tick: SseTick) => void) {
    tickTapeListeners.add(listener);
    return () => {
        tickTapeListeners.delete(listener);
    };
}

/** Every regular-lot best bid / ask update (#226 對手價 triggers). */
export function onAnyBidAsk(listener: (bidask: SseBidAsk) => void) {
    bidAskListeners.add(listener);
    return () => {
        bidAskListeners.delete(listener);
    };
}

/** Real (non-simtrade) 盤中零股 trades — kept apart from onAnyTick. */
export function onOddLotTick(listener: (tick: SseTick) => void) {
    oddTickListeners.add(listener);
    return () => {
        oddTickListeners.delete(listener);
    };
}

export function onContractEvent(
    listener: (event: ContractChangeEvent) => void,
) {
    contractEventListeners.add(listener);
    return () => {
        contractEventListeners.delete(listener);
    };
}

// 模組層有 SSE 連線、計時器與 listener 註冊 — HMR 熱換會疊出第二條
// SSE 連線與殭屍 listener（每 tick 重複灌、CPU 飆高）。一變更就整頁
// 重載，開發期不會再累積疊層。
if (import.meta.hot) {
    import.meta.hot.dispose(() => { if (watchdogTimer) clearInterval(watchdogTimer); shared?.close(); es?.close(); });
    import.meta.hot.accept(() => {
        import.meta.hot?.invalidate();
    });
}
