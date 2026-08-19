// src/lib/stream.ts — KGI bridge SSE connection with auto-reconnect.
// Quote state lives here (module-level store) so components can subscribe
// via useSyncExternalStore without prop drilling.

import { kgiPost } from './broker/backend';
import { getKgiBackendBase, getKgiStreamBase } from './broker/config';
import type { SseBidAsk, SseIndexQuote, SseKBar, SseTick } from './types/market';
import {
    normalizeOrderEvent,
    type OrderEventReport,
} from './order-report';

export type StreamStatus = 'connecting' | 'live' | 'down';

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
    kbar?: SseKBar;
    index?: SseIndexQuote;
    lastDir: 1 | -1 | 0; // direction of last price move, for flash effects
    seq: number; // bumps on every update (tick or bidask)
    flashSeq: number; // bumps only on real trades (not simtrade/bidask)
}

type Listener = () => void;

const quotes = new Map<string, QuoteState>();
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

const quoteListeners = new Map<string, Set<Listener>>();
const statusListeners = new Set<Listener>();
const orderEventListeners = new Set<(ev: OrderEventReport) => void>();
const tickTapeListeners = new Set<(tick: SseTick) => void>();
const contractEventListeners = new Set<
    (event: ContractChangeEvent) => void
>();

function emitContractChange(event: ContractChangeEvent) {
    contractEventListeners.forEach((listener) => listener(event));
}

function emitFullContractRefresh(
    action: 'RECONNECT' | 'MAINTENANCE',
    publishedAt = new Date().toISOString(),
) {
    emitContractChange({
        event_id: `${action.toLowerCase()}-${Date.now()}`,
        action,
        region: 'TW',
        security_type: null,
        published_at: publishedAt,
        base_changed: true,
        info_changed: true,
        info_scope: 'ALL',
        info_shards: [],
    });
}

// React 通知採 50ms 批次 — 開盤 tick 風暴（多面板×多檔訂閱）下逐筆
// 同步喚醒所有 useSyncExternalStore 訂閱者，會被 React 19 判定成巢狀
// 無限更新（Maximum update depth exceeded）而整頁炸掉。行情資料本身
// （quotes map）仍逐筆即時寫入，只有「通知 React 重繪」合併節流。
// 刻意用 setTimeout 而非 rAF：rAF 會夾進 React 併發渲染的 frame 節奏，
// 啟動風暴時 flush 落在 render 中間仍會觸發巢狀更新告警。
const QUOTE_FLUSH_MS = 50;
const dirtyQuoteCodes = new Set<string>();
let quoteFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushQuoteEmits() {
    quoteFlushTimer = null;
    const codes = Array.from(dirtyQuoteCodes);
    dirtyQuoteCodes.clear();
    for (const code of codes) {
        quoteListeners.get(code)?.forEach((l) => {
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

function emitQuote(code: string) {
    dirtyQuoteCodes.add(code);
    if (quoteFlushTimer === null) {
        quoteFlushTimer = setTimeout(flushQuoteEmits, QUOTE_FLUSH_MS);
    }
}

function setStatus(s: StreamStatus) {
    if (status !== s) {
        status = s;
        statusListeners.forEach((l) => l());
    }
}

function handleTick(raw: string) {
    const tick = JSON.parse(raw) as SseTick;
    if (tick.intraday_odd) return; // board shows regular-lot stream only
    ingestTick(tick);
    const alias = codeAlias.get(tick.code);
    if (alias) ingestTick({ ...tick, code: alias });
}

function missingPayloadValue(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value === 'number') return !Number.isFinite(value);
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

function mergePayload<T extends object>(
    prev: T | undefined,
    next: T,
): T {
    if (!prev) return next;
    const merged: Record<string, unknown> = {
        ...(prev as Record<string, unknown>),
        ...(next as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(next as Record<string, unknown>)) {
        if (missingPayloadValue(value) && key in prev) {
            merged[key] = (prev as Record<string, unknown>)[key];
        }
    }
    return merged as T;
}

function ingestTick(tick: SseTick) {
    const prev = quotes.get(tick.code);
    const mergedTick = mergePayload(prev?.tick, tick);
    const prevClose = prev?.tick ? Number(prev.tick.close) : undefined;
    const close = Number(mergedTick.close);
    if (!Number.isFinite(close)) return;
    const lastDir: QuoteState['lastDir'] =
        prevClose === undefined || close === prevClose
            ? (prev?.lastDir ?? 0)
            : close > prevClose
              ? 1
              : -1;
    // flash only on real deals — simtrade (試撮) updates must not blink
    const isRealTrade = !tick.simtrade && Number(tick.volume ?? 0) > 0;
    quotes.set(tick.code, {
        tick: mergedTick,
        bidask: prev?.bidask,
        kbar: prev?.kbar,
        index: prev?.index,
        lastDir,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: (prev?.flashSeq ?? 0) + (isRealTrade ? 1 : 0),
    });
    emitQuote(tick.code);
    if (isRealTrade) {
        tickTapeListeners.forEach((l) => l(mergedTick));
    }
}

function handleBidAsk(raw: string) {
    const bidask = JSON.parse(raw) as SseBidAsk;
    if (bidask.intraday_odd) return;
    ingestBidAsk(bidask);
    const alias = codeAlias.get(bidask.code);
    if (alias) ingestBidAsk({ ...bidask, code: alias });
}

function ingestBidAsk(bidask: SseBidAsk) {
    const prev = quotes.get(bidask.code);
    const mergedBidAsk = mergePayload(prev?.bidask, bidask);
    quotes.set(bidask.code, {
        tick: prev?.tick,
        bidask: mergedBidAsk,
        kbar: prev?.kbar,
        index: prev?.index,
        lastDir: prev?.lastDir ?? 0,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: prev?.flashSeq ?? 0,
    });
    emitQuote(bidask.code);
}

function compactDateTime(value: unknown): { date: string; time: string } {
    const raw = String(value ?? '');
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 14) {
        return {
            date: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
            time: `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`,
        };
    }
    if (digits.length >= 12) {
        return {
            date: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
            time: `${digits.slice(8, 10)}:${digits.slice(10, 12)}:00`,
        };
    }
    return { date: '', time: '' };
}

function handleKBar(raw: string) {
    const source = JSON.parse(raw) as Record<string, unknown>;
    const dt = compactDateTime(source.datetime ?? source.date_time);
    const kbar: SseKBar = {
        code: String(source.code ?? source.symbol ?? ''),
        date: dt.date,
        time: dt.time,
        timeframe: Number(source.timeframe ?? source.minute ?? 1) || 1,
        open: source.open === undefined ? '' : String(source.open),
        high: source.high === undefined ? '' : String(source.high),
        low: source.low === undefined ? '' : String(source.low),
        close: source.close === undefined ? '' : String(source.close),
        volume:
            source.volume === undefined ? Number.NaN : Number(source.volume),
        total_amount:
            source.total_amount === undefined
                ? undefined
                : String(source.total_amount),
    };
    if (!kbar.code || !Number.isFinite(Number(kbar.close))) return;
    ingestKBar(kbar);
    const alias = codeAlias.get(kbar.code);
    if (alias) ingestKBar({ ...kbar, code: alias });
}

function ingestKBar(kbar: SseKBar) {
    const prev = quotes.get(kbar.code);
    const mergedKBar = mergePayload(prev?.kbar, kbar);
    quotes.set(kbar.code, {
        tick: prev?.tick,
        bidask: prev?.bidask,
        kbar: mergedKBar,
        index: prev?.index,
        lastDir: prev?.lastDir ?? 0,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: prev?.flashSeq ?? 0,
    });
    emitQuote(kbar.code);
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

// Index quote providers may preserve upstream field names in SSE
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
        change_price: optionalString(source, 'change_price'),
        change_rate: optionalString(source, 'change_rate'),
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
    const mergedIndex = mergePayload(prev?.index, index);
    const previousClose = prev?.index ? Number(prev.index.close) : undefined;
    const close = Number(mergedIndex.close);
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
        kbar: prev?.kbar,
        index: mergedIndex,
        lastDir,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: (prev?.flashSeq ?? 0) + (moved ? 1 : 0),
    });
    emitQuote(index.code);
}

// Registry of every quote subscription made this session, replayed after
// the SSE connection recovers.
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
    subscriptionRegistry.set(`${body.code}:${body.quote_type}`, body);
}

export function unregisterSubscription(code: string, quoteType: string) {
    subscriptionRegistry.delete(`${code}:${quoteType}`);
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

let resubscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;

async function resubscribeAll() {
    let failed = false;
    for (const body of subscriptionRegistry.values()) {
        try {
            const response = await kgiPost<{ success?: boolean; message?: string }>(
                '/api/v1/stream/subscribe',
                body,
            );
            if (response.success === false) {
                throw new Error(response.message || '行情重新訂閱失敗');
            }
        } catch {
            failed = true;
        }
    }
    for (const { path, body } of capabilityRegistry.values()) {
        try {
            const response = await kgiPost<{ success: boolean; message: string }>(
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
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let everDown = false;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let lastMaintenanceSeen = '';

// Extra named-event listeners (future enriched index, scanner, …) share the
// aggregate KGI bridge SSE connection.
const namedListeners = new Map<string, Set<(raw: string) => void>>();

function attachNamed(source: EventSource, name: string) {
    source.addEventListener(name, (event) => {
        const set = namedListeners.get(name);
        set?.forEach((listener) => listener((event as MessageEvent).data));
    });
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

function connectKgi() {
    if (es) es.close();
    setStatus('connecting');
    es = new EventSource(`${getKgiStreamBase()}/api/v1/stream/data?region=TW`);

    es.onopen = () => {
        retryDelay = 1000;
        setStatus('live');
        if (everDown) {
            everDown = false;
            emitFullContractRefresh('RECONNECT');
            void resubscribeAll();
        }
    };

    es.addEventListener('status', (event) => {
        try {
            const payload = JSON.parse((event as MessageEvent).data) as {
                status?: string;
            };
            setStatus(
                payload.status === 'connected' || payload.status === 'mock'
                    ? 'live'
                    : 'down',
            );
        } catch {
            setStatus('down');
        }
    });
    es.addEventListener('tick_stk', (event) =>
        handleTick((event as MessageEvent).data),
    );
    es.addEventListener('tick_fop', (event) =>
        handleTick((event as MessageEvent).data),
    );
    es.addEventListener('bidask_stk', (event) =>
        handleBidAsk((event as MessageEvent).data),
    );
    es.addEventListener('bidask_fop', (event) =>
        handleBidAsk((event as MessageEvent).data),
    );
    es.addEventListener('kbar', (event) =>
        handleKBar((event as MessageEvent).data),
    );
    es.addEventListener('quote_idx', (event) =>
        handleIndexQuote((event as MessageEvent).data),
    );
    es.addEventListener('order_event', (event) => {
        try {
            const report = normalizeOrderEvent(
                JSON.parse((event as MessageEvent).data),
            );
            if (report) orderEventListeners.forEach((listener) => listener(report));
        } catch (err) {
            console.error('[stream] order_event parse failed', err);
        }
    });
    es.addEventListener('contract_event', (event) => {
        try {
            emitContractChange(
                JSON.parse((event as MessageEvent).data) as ContractChangeEvent,
            );
        } catch (err) {
            console.error('[stream] contract_event parse failed', err);
        }
    });
    es.addEventListener('heartbeat', () => {
        lastHeartbeat = Date.now();
    });
    for (const name of namedListeners.keys()) {
        attachNamed(es, name);
    }
    es.onerror = () => {
        setStatus('down');
        everDown = true;
        es?.close();
        es = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connectKgi, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
    };
}

async function watchMaintenance() {
    try {
        const response = await fetch(`${getKgiBackendBase()}/api/v1/health`, {
            cache: 'no-store',
        });
        if (!response.ok) return;
        const health = (await response.json()) as {
            last_maintenance?: string;
            timestamp?: string;
        };
        const marker = health.last_maintenance;
        if (!marker) return;
        if (!lastMaintenanceSeen) {
            lastMaintenanceSeen = marker;
            return;
        }
        if (marker !== lastMaintenanceSeen) {
            lastMaintenanceSeen = marker;
            emitFullContractRefresh('MAINTENANCE', health.timestamp);
            void resubscribeAll();
        }
    } catch {
        // Health polling is advisory; SSE reconnect is the primary recovery path.
    }
}

let started = false;
export function ensureStream() {
    if (!started) {
        started = true;
        connectKgi();
        void watchMaintenance();
        maintenanceTimer = setInterval(() => {
            void watchMaintenance();
        }, 60000);
    }
}

// ---- store API (for useSyncExternalStore) ----

export function subscribeQuoteStore(code: string, listener: Listener) {
    let set = quoteListeners.get(code);
    if (!set) {
        set = new Set();
        quoteListeners.set(code, set);
    }
    set.add(listener);
    return () => {
        set.delete(listener);
    };
}

export function getQuote(code: string): QuoteState | undefined {
    return quotes.get(code);
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

export const __streamTest = {
    handleTick,
    handleBidAsk,
    handleIndexQuote,
    handleKBar,
    getQuote,
    reset() {
        quotes.clear();
        dirtyQuoteCodes.clear();
        if (quoteFlushTimer) clearTimeout(quoteFlushTimer);
        quoteFlushTimer = null;
    },
};

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
    import.meta.hot.accept(() => {
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        import.meta.hot?.invalidate();
    });
}
