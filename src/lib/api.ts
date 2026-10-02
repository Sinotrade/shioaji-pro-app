// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';
import { isAgentHarnessEnabled } from './agent-harness-state';
import { serverIdentityVerified } from './server-identity';
import { getTradingMirrorFresh } from './trading-mirror-lease';
import { getServerModeVersion } from './server-info-store';

// resolved per request — the server port can move at runtime (e.g. the boot
// flow discovers the default port occupied and starts on a fallback), and a
// module-load-time capture kept every request on the dead old port
// (the stuck-at-載入交易終端 bug)
const base = () => getApiBase();

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

async function doFetch(url: string, init?: RequestInit, beforeDispatch?: () => void | Promise<void>): Promise<Response> {
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
        const preparation = beforeDispatch?.();
        if (preparation) await preparation;
        if (init?.signal?.aborted) throw abortReason(init.signal);
        return tauriFetch(url, init);
    }
    const preparation = beforeDispatch?.();
    if (preparation) await preparation;
    if (init?.signal?.aborted) throw abortReason(init.signal);
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
async function throwApiError(res: Response): Promise<never> {
    let detail = '';
    try {
        const data = (await res.json()) as {
            message?: string;
            details?: unknown;
        };
        detail =
            data.message ??
            (typeof data.details === 'string' ? data.details : '');
        if (data.details && typeof data.details !== 'string') {
            detail += ` ${JSON.stringify(data.details)}`;
        }
    } catch {
        // non-JSON body — fall back to status text
    }
    throw Object.assign(
        new Error(`${res.status} ${detail || res.statusText}`.trim()),
        { status: res.status },
    );
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
        beforeDispatch?: () => void | Promise<void>;
        // 讀取回應標頭（例如 X-Shioaji-Instance，SDK 1.7.8+）；在解析 body 前呼叫
        onResponse?: (res: Response) => void;
    },
): Promise<T> {
    // Trade reports are account-scoped; market-data subscriptions are not.
    // Loading the native transport (or serializing the body) can outlive a
    // mode change, even when the final mode is the same as the initial one.
    const mutation = AGENT_HARNESS_MUTATIONS.has(path);
    const mutationBase = base();
    const mutationVersion = getServerModeVersion();
    const assertMutationCurrent = () => {
        if (mutation && (base() !== mutationBase || getServerModeVersion() !== mutationVersion
            || !getTradingMirrorFresh() || (isTauri && !serverIdentityVerified()))) {
            throw Object.assign(new Error('交易環境已切換或主視窗狀態已變更，委託尚未送出'), { mutationNotStarted: true, tradingGateRejected: true });
        }
    };
    const subscriptionVersion = path === '/api/v1/auth/subscribe_trade' ? getServerModeVersion() : undefined;
    const assertSubscriptionCurrent = () => {
        if (subscriptionVersion !== undefined && getServerModeVersion() !== subscriptionVersion) {
            throw Object.assign(new Error('訂閱期間伺服器模式已變更，未送出請求；請重新訂閱'),
                { subscriptionNotStarted: true as const });
        }
    };
    const beforeDispatch = () => {
        assertSubscriptionCurrent();
        const preparation = opts?.beforeDispatch?.();
        const afterPreparation = () => { assertMutationCurrent(); assertSubscriptionCurrent(); };
        if (preparation) return Promise.resolve(preparation).then(afterPreparation);
        afterPreparation();
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
        const bodyText = JSON.stringify(body);
        const { invoke } = await import('@tauri-apps/api/core');
        let proxied: { status: number; body: string; headers?: Record<string, string> };
        const preparation = beforeDispatch();
        if (preparation) await preparation;
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
                throw Object.assign(
                    new Error(message.slice(marker.length).trim()),
                    { mutationNotStarted: true },
                );
            }
            throw error;
        }
        const headers = new Headers(proxied.headers);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        const res = new Response(proxied.body, {
            status: proxied.status,
            headers,
        });
        opts?.onResponse?.(res);
        if (!res.ok) await throwApiError(res);
        return res.json() as Promise<T>;
    }
    const timedMutation = path === '/api/v1/order/place_order' || path === '/api/v1/order/cancel_order';
    return runWithTimeout(async signal => {
        const res = await doFetch(base() + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        }, beforeDispatch);
        opts?.onResponse?.(res);
        if (!res.ok) await throwApiError(res);
        return res.json() as Promise<T>;
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
