// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';
import { foreignServerBlockedError, serverReadsHeld, serverUrlBlocked } from './server-read-gate';
import { isAgentHarnessEnabled } from './agent-harness-state';
import { serverIdentityVerified } from './server-identity';
import { getTradingMirrorFresh } from './trading-mirror-lease';
import { getServerModeVersion } from './server-info-store';
import { classifyHttpOrderError } from './order-outcome';
import { isMainWindow } from './main-window-commands';
import { popoutOrderPost } from './popout-order';

// resolved per request — the server port can move at runtime (e.g. the boot
// flow discovers the default port occupied and starts on a fallback), and a
// module-load-time capture kept every request on the dead old port
// (the stuck-at-載入交易終端 bug)
const base = () => getApiBase();

/** The same request against the API base as it is now (a request built
 * before boot's decision is sent where boot decided — or nowhere). */
function rebase(url: string): string {
    try {
        const u = new URL(url);
        const now = new URL(base());
        if (u.host === now.host && u.protocol === now.protocol) return url;
        return `${now.origin}${u.pathname}${u.search}`;
    } catch {
        return url;
    }
}

const AGENT_HARNESS_MUTATIONS = new Set([
    '/api/v1/order/place_order',
    '/api/v1/order/cancel_order',
    '/api/v1/order/update_price',
    '/api/v1/order/update_qty',
    '/api/v1/order/place_comboorder',
    '/api/v1/order/cancel_comboorder',
    '/api/v1/order/reserve_stock',
    '/api/v1/order/reserve_earmarking',
]);

// shioaji-pro-desktop ensure_agent_command_window: agent_harness_post is
// main-window only and returns this exact text before sending anything.
const NATIVE_MAIN_WINDOW_ONLY = '此視窗無權呼叫 Agent 原生命令';

export function shouldProxyAgentHarnessMutation(
    desktop: boolean,
    enabled: boolean,
    path: string,
): boolean {
    return desktop && enabled && AGENT_HARNESS_MUTATIONS.has(path);
}

export function shouldRejectUnsignedAgentMutation(
    desktop: boolean,
    enabled: boolean,
    path: string,
    agentInitiated: boolean,
): boolean {
    return (
        desktop &&
        agentInitiated &&
        !enabled &&
        AGENT_HARNESS_MUTATIONS.has(path)
    );
}

const WEBVIEW_INFO_MAX_IN_FLIGHT = 4; // leave browser connections free for SSE reconnects
const WEBVIEW_INFO_RETRY_MS = 5_000;
const webviewInfoSlots = new Map<string, { inFlight: number; waiters: Array<() => void> }>();
const webviewInfoRetryAt = new Map<string, number>();

function loopbackContractInfoOrigin(url: string, init?: RequestInit): string | undefined {
    if (init?.method && init.method.toUpperCase() !== 'GET') return undefined;
    try {
        const parsed = new URL(url);
        return (
            (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname === '127.0.0.1' &&
            /^\/api\/v1\/data\/contracts\/[^/]+\/info$/.test(parsed.pathname)
        ) ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('aborted', 'AbortError');
}

async function withWebviewInfoSlot<T>(origin: string, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    let slots = webviewInfoSlots.get(origin);
    if (!slots) {
        slots = { inFlight: 0, waiters: [] };
        webviewInfoSlots.set(origin, slots);
    }
    if (slots.inFlight < WEBVIEW_INFO_MAX_IN_FLIGHT) {
        slots.inFlight++;
    } else {
        await new Promise<void>((resolve, reject) => {
            const grant = () => {
                signal?.removeEventListener('abort', onAbort);
                resolve(); // transfer the occupied slot to this waiter
            };
            const onAbort = () => {
                const index = slots.waiters.indexOf(grant);
                if (index >= 0) slots.waiters.splice(index, 1);
                reject(abortReason(signal!));
            };
            slots.waiters.push(grant);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }
    try {
        if (signal?.aborted) throw abortReason(signal);
        return await request();
    } finally {
        const next = slots.waiters.shift();
        if (next) next();
        else {
            slots.inFlight--;
            if (slots.inFlight === 0) webviewInfoSlots.delete(origin);
        }
    }
}

async function doFetch(url: string, init?: RequestInit, beforeDispatch?: (url: string) => void): Promise<Response> {
    // #285: an App launch reads nothing until boot has checked the server
    const held = serverReadsHeld();
    if (held) {
        await held;
        // the decision may have moved or blocked the server meanwhile
        url = rebase(url);
    }
    // #285: another program's server this App did not adopt is never read
    // — fail here at once (never hand the transport an unroutable address)
    const blocked = serverUrlBlocked(url);
    if (blocked !== null) throw foreignServerBlockedError(blocked);
    if (isTauri) {
        // Info is read-only and frequently requested in parallel by watchlists.
        // The WebView can reach the loopback sidecar directly, avoiding the
        // plugin-http queue. Keep the native transport for WebViews that reject
        // the local origin or certificate; never retry a caller-aborted request.
        const infoOrigin = loopbackContractInfoOrigin(url, init);
        if (infoOrigin && Date.now() >= (webviewInfoRetryAt.get(infoOrigin) ?? 0)) {
            try {
                return await withWebviewInfoSlot(infoOrigin, init?.signal ?? undefined, async () => {
                    if (Date.now() < (webviewInfoRetryAt.get(infoOrigin) ?? 0)) {
                        throw new Error('WebView Info transport unavailable');
                    }
                    try {
                        const response = await fetch(url, init);
                        // fetch() resolves at headers. Buffer the small Info
                        // body before releasing this slot so slow bodies cannot
                        // occupy all browser connections during an SSE reconnect.
                        const body = await response.arrayBuffer();
                        return new Response(
                            [204, 205, 304].includes(response.status) ? null : body,
                            { status: response.status, statusText: response.statusText, headers: response.headers },
                        );
                    } catch (error) {
                        if (!init?.signal?.aborted) webviewInfoRetryAt.set(infoOrigin, Date.now() + WEBVIEW_INFO_RETRY_MS);
                        throw error;
                    }
                });
            } catch (error) {
                if (init?.signal?.aborted) throw error;
            }
        }
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        beforeDispatch?.(url);
        return tauriFetch(url, init);
    }
    beforeDispatch?.(url);
    return fetch(url, init);
}

async function runWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    mutation = false,
): Promise<T> {
    if (!timeoutMs) return operation(new AbortController().signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => {
            reject(mutation
                ? Object.assign(new Error('連線忙碌，委託送出結果未確認；請求可能已送達，請先查詢委託，勿直接重送'), {
                    mutationOutcomeUnknown: true as const,
                    requestTimedOut: true as const,
                })
                : new DOMException('aborted', 'AbortError'));
            controller.abort();
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timedOut]);
    } finally {
        globalThis.clearTimeout(timer!);
    }
}

// shioaji errors come back as JSON: {"code":400,"message":"...","details":...}
// surface that message instead of a bare "400 Bad Request" — the message is
// what tells you it's CA / unsigned account / bad params (issue #1 support)
//
// Order mutations (#249): the gateway answers 409 OrderOutcomeUnknown when the
// order was written but not acknowledged (it may exist), 503 NotConnected when
// it was never sent. Shioaji 1.7.8+ passes those through with
// details.error_code; 1.7.7 turns 409 into 400 with the code in the message.
// Mark them here so every caller sees the same outcome flags. An unknown
// outcome deliberately carries no 4xx `status` and its message does not start
// with the status digits: callers that read "4xx = rejected, safe to resend"
// (e.g. the Agent idempotency classifier) must not treat it as not sent.
async function throwApiError(res: Response, path?: string): Promise<never> {
    let detail = '';
    let errorCode: string | undefined;
    try {
        const data = (await res.json()) as {
            message?: string;
            details?: unknown;
        };
        detail =
            data.message ??
            (typeof data.details === 'string' ? data.details : '');
        if (data.details && typeof data.details !== 'string') {
            const code = (data.details as { error_code?: unknown }).error_code;
            if (typeof code === 'string') errorCode = code;
            detail += ` ${JSON.stringify(data.details)}`;
        }
    } catch {
        // non-JSON body — fall back to status text
    }
    const text = (detail || res.statusText).trim();
    const outcome = path && ORDER_OUTCOME_PATHS.has(path)
        ? classifyHttpOrderError(res.status, errorCode, text)
        : null;
    if (outcome === 'unknown') {
        throw Object.assign(
            new Error(`委託結果不確定（HTTP ${res.status}${errorCode ? ` ${errorCode}` : ''}）：${text}`),
            { httpStatus: res.status, errorCode, mutationOutcomeUnknown: true as const, orderOutcomeUnknown: true as const },
        );
    }
    throw Object.assign(
        new Error(`${res.status} ${text}`.trim()),
        {
            status: res.status,
            ...(errorCode ? { errorCode } : {}),
            ...(outcome === 'not-sent' ? { mutationNotStarted: true as const, orderNotConnected: true as const } : {}),
        },
    );
}

/** The native proxy's answer (this window's or the main window's) as a response. */
async function finishProxied<T>(proxied: { status: number; body: string; headers?: Record<string, string> }, path: string,
    onResponse?: (res: Response) => void): Promise<T> {
    const headers = new Headers(proxied.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = new Response(proxied.body, { status: proxied.status, headers });
    onResponse?.(res);
    if (!res.ok) await throwApiError(res, path);
    return parseDispatchedBody<T>(res, path);
}

// Order-sending paths whose HTTP errors are classified (#249).
const ORDER_OUTCOME_PATHS = new Set([
    '/api/v1/order/place_order',
    '/api/v1/order/place_comboorder',
]);

// 2xx 但 body 讀不完／解析失敗：委託可能已成立 → 結果不確定
async function parseDispatchedBody<T>(res: Response, path: string): Promise<T> {
    try {
        return (await res.json()) as T;
    } catch (error) {
        throw markDispatchedOrderError(error, path, true);
    }
}

// After the request may have left (beforeDispatch passed), a transport error
// on an order-sending path is ambiguous: the order may exist. Errors from the
// pre-dispatch gates are rethrown untouched.
function markDispatchedOrderError(error: unknown, path: string, dispatched: boolean): unknown {
    if (!dispatched || !ORDER_OUTCOME_PATHS.has(path)) return error;
    // 原生橋接可能丟字串（例如 'UI trading proxy request failed: timeout'）
    if (typeof error !== 'object' || error === null) {
        return Object.assign(new Error(String(error)), { mutationOutcomeUnknown: true as const });
    }
    const e = error as Record<string, unknown>;
    if (e.mutationNotStarted === true || e.mutationOutcomeUnknown === true || typeof e.status === 'number') return error;
    return Object.assign(error, { mutationOutcomeUnknown: true as const });
}

export async function apiGet<T>(path: string, opts?: { signal?: AbortSignal; headers?: HeadersInit }): Promise<T> {
    const res = await doFetch(base() + path, opts);
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}

export async function apiPost<T>(
    path: string,
    body: unknown,
    opts?: {
        timeoutMs?: number; agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean;
        /** 送出前一刻呼叫；直接 fetch 的路徑會帶上實際送出的 URL（啟動閘門改派之後） */
        beforeDispatch?: (url?: string) => void;
        // 讀取回應標頭（例如 X-Shioaji-Instance，SDK 1.7.8+）；在解析 body 前呼叫
        onResponse?: (res: Response) => void;
    },
): Promise<T> {
    // Trade reports are account-scoped; market-data subscriptions are not.
    // Loading the native transport (or serializing the body) can outlive a
    // mode change, even when the final mode is the same as the initial one.
    const subscriptionVersion = path === '/api/v1/auth/subscribe_trade' ? getServerModeVersion() : undefined;
    const beforeDispatch = (url?: string) => {
        if (subscriptionVersion !== undefined && getServerModeVersion() !== subscriptionVersion) {
            throw Object.assign(new Error('訂閱期間伺服器模式已變更，未送出請求；請重新訂閱'),
                { subscriptionNotStarted: true as const });
        }
        opts?.beforeDispatch?.(url);
    };
    if (isTauri && AGENT_HARNESS_MUTATIONS.has(path) && !serverIdentityVerified()) {
        throw Object.assign(
            new Error('伺服器身分尚未驗證，已暫停交易操作；請等待重新連線'),
            { mutationNotStarted: true },
        );
    }
    if (AGENT_HARNESS_MUTATIONS.has(path) && !getTradingMirrorFresh()) {
        throw Object.assign(new Error('主視窗交易狀態未同步，委託尚未送出；請重新開啟主視窗'), { mutationNotStarted: true as const });
    }
    const harnessEnabled = isAgentHarnessEnabled();
    if (
        shouldRejectUnsignedAgentMutation(
            isTauri,
            harnessEnabled,
            path,
            opts?.agentInitiated === true,
        )
    ) {
        throw Object.assign(
            new Error('Agent Harness 未啟用，拒絕 unsigned Agent mutation'),
            { mutationNotStarted: true },
        );
    }
    // Serialize once in the WebView, then let the native bridge sign and send
    // these exact bytes. The native bridge fails closed when Harness is absent
    // or disabled; it never falls back to an unsigned protected mutation.
    if (shouldProxyAgentHarnessMutation(isTauri, harnessEnabled, path)) {
        const blockedPort = serverUrlBlocked(base());
        if (blockedPort !== null) throw foreignServerBlockedError(blockedPort);
        const bodyText = JSON.stringify(body);
        let proxied: { status: number; body: string; headers?: Record<string, string> };
        if (!isMainWindow()) {
            // a popped-out window: its own narrower native command (flash
            // popouts only, order endpoints only, one-time id, approved server
            // mode — checked natively). Never resent; not sent / unknown kept.
            if (opts?.agentInitiated) {
                throw Object.assign(new Error('這個操作只能在主視窗執行，這筆沒有送出'), { mutationNotStarted: true });
            }
            proxied = await popoutOrderPost(path, bodyText, beforeDispatch);
            try {
                return await finishProxied<T>(proxied, path, opts?.onResponse);
            } catch (error) {
                // the request went out: an unreadable answer is an unknown outcome
                // for every popout mutation (cancel / update too), never "not sent"
                const e = error as Record<string, unknown> | null;
                if (e && typeof e === 'object' && (e.mutationNotStarted === true || e.mutationOutcomeUnknown === true || typeof e.status === 'number')) throw error;
                throw Object.assign(error instanceof Error ? error : new Error(String(error)), { mutationOutcomeUnknown: true as const });
            }
        }
        const { invoke } = await import('@tauri-apps/api/core');
        beforeDispatch();
        let dispatched = true;
        try {
            proxied = await invoke<typeof proxied>(
                'agent_harness_post',
                {
                    url: base() + path,
                    body: bodyText,
                    agentInitiated: opts?.agentInitiated === true,
                    ...(opts?.agentCallId ? { agentCallId: opts.agentCallId, agentAuto: opts.agentAuto === true } : {}),
                },
            );
        } catch (error) {
            const message = String(error);
            const marker = 'AGENT_MUTATION_NOT_STARTED:';
            if (message.startsWith(marker)) {
                dispatched = false;
                throw Object.assign(
                    new Error(message.slice(marker.length).trim()),
                    { mutationNotStarted: true },
                );
            }
            // The native proxy only serves the main window and refuses any
            // other window first, before any HTTP (#244: a popout flash
            // panel's cancel showed only "失敗或結果未知").
            if (message === NATIVE_MAIN_WINDOW_ONLY) {
                dispatched = false;
                throw Object.assign(
                    new Error('彈出視窗目前不能下單或刪單，這筆沒有送出；請在主視窗操作'),
                    { mutationNotStarted: true },
                );
            }
            throw markDispatchedOrderError(error, path, dispatched);
        }
        return finishProxied<T>(proxied, path, opts?.onResponse);
    }
    const timedMutation = path === '/api/v1/order/place_order' || path === '/api/v1/order/cancel_order';
    return runWithTimeout(async signal => {
        let dispatched = false;
        let res: Response;
        try {
            res = await doFetch(base() + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            }, (url) => { beforeDispatch(url); dispatched = true; });
        } catch (error) {
            throw markDispatchedOrderError(error, path, dispatched);
        }
        opts?.onResponse?.(res);
        if (!res.ok) await throwApiError(res, path);
        return parseDispatchedBody<T>(res, path);
    }, opts?.timeoutMs ?? (timedMutation ? 3000 : undefined), timedMutation);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(base() + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
    const res = await doFetch(base() + path, {
        method: 'DELETE',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}
