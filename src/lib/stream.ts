// src/lib/stream.ts — single combined SSE connection with auto-reconnect.
// Quote state lives here (module-level store) so components can subscribe
// via useSyncExternalStore without prop drilling.

import { getApiBase, getStreamBase } from './runtime';
import { apiPost } from './api';
import type { SseBidAsk, SseIndexQuote, SseTick } from './types/market';
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
    eventId: string,
    publishedAt: string,
) {
    emitContractChange({
        event_id: eventId,
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

function ingestTick(tick: SseTick) {
    const prev = quotes.get(tick.code);
    const prevClose = prev?.tick ? Number(prev.tick.close) : undefined;
    const close = Number(tick.close);
    const lastDir: QuoteState['lastDir'] =
        prevClose === undefined || close === prevClose
            ? (prev?.lastDir ?? 0)
            : close > prevClose
              ? 1
              : -1;
    // flash only on real deals — simtrade (試撮) updates must not blink
    const isRealTrade = !tick.simtrade && tick.volume > 0;
    quotes.set(tick.code, {
        tick,
        bidask: prev?.bidask,
        index: prev?.index,
        lastDir,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: (prev?.flashSeq ?? 0) + (isRealTrade ? 1 : 0),
    });
    emitQuote(tick.code);
    if (isRealTrade) {
        tickTapeListeners.forEach((l) => l(tick));
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
    quotes.set(bidask.code, {
        tick: prev?.tick,
        bidask,
        index: prev?.index,
        lastDir: prev?.lastDir ?? 0,
        seq: (prev?.seq ?? 0) + 1,
        flashSeq: prev?.flashSeq ?? 0,
    });
    emitQuote(bidask.code);
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
            const response = await apiPost<{ success?: boolean; message?: string }>(
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
            const response = await apiPost<{ success: boolean; message: string }>(
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

// Extra named-event listeners (enriched index, scanner, …) share the ONE
// aggregate SSE connection. Since shioaji 1.7.2 the aggregate stream
// carries every event family, so consumers register here instead of
// opening dedicated per-channel EventSources (six HTTP/1.1 streams used
// to exhaust the browser's per-origin connection pool).
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

function connect() {
    if (es) es.close();
    setStatus('connecting');
    // region filters contract_event only; other families are unfiltered
    es = new EventSource(`${getStreamBase()}/api/v1/stream/data?region=TW`);

    es.onopen = () => {
        retryDelay = 1000;
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
        es.addEventListener(ev, (e) => handleTick((e as MessageEvent).data));
    }
    for (const ev of ['bidask_stk', 'bidask_fop']) {
        es.addEventListener(ev, (e) => handleBidAsk((e as MessageEvent).data));
    }
    es.addEventListener('quote_idx', (e) =>
        handleIndexQuote((e as MessageEvent).data),
    );
    es.addEventListener('order_event', (e) => {
        // the server wraps the body one level under its variant name
        // ({state, data:{FuturesOrder:{...}}}) — normalize before fan-out
        const report = normalizeOrderEvent(
            JSON.parse((e as MessageEvent).data),
        );
        if (report) orderEventListeners.forEach((l) => l(report));
    });
    es.addEventListener('contract_event', (event) => {
        const change = JSON.parse(
            (event as MessageEvent).data,
        ) as ContractChangeEvent;
        emitContractChange(change);
    });
    es.addEventListener('heartbeat', () => {
        lastHeartbeat = Date.now();
        setStatus('live');
    });
    for (const name of namedListeners.keys()) {
        attachNamed(es, name);
    }

    es.onerror = () => {
        everDown = true;
        setStatus('down');
        es?.close();
        es = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
    };
}

// The shioaji server's daily maintenance (~08:22 TW) rebuilds its upstream
// client and silently drops every market-data subscription while our SSE
// connection stays up — watch last_maintenance and resubscribe when it moves.
let lastMaintenance: string | null = null;

async function watchMaintenance() {
    try {
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
        connect();
        void watchMaintenance();
        setInterval(watchMaintenance, 60000);
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
