// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';
import { isAgentHarnessEnabled } from './agent-harness-state';

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

async function doFetch(url: string, init?: RequestInit): Promise<Response> {
    if (isTauri) {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch(url, init);
    }
    return fetch(url, init);
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
    throw new Error(
        `${res.status} ${detail || res.statusText}`.trim(),
    );
}

export async function apiGet<T>(path: string): Promise<T> {
    const res = await doFetch(base() + path);
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}

export async function apiPost<T>(
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number; agentInitiated?: boolean },
): Promise<T> {
    // Serialize once in the WebView, then let the native bridge sign and send
    // these exact bytes. The native bridge fails closed when Harness is absent
    // or disabled; it never falls back to an unsigned protected mutation.
    if (shouldProxyAgentHarnessMutation(isTauri, isAgentHarnessEnabled(), path)) {
        const bodyText = JSON.stringify(body);
        const { invoke } = await import('@tauri-apps/api/core');
        let proxied: { status: number; body: string };
        try {
            proxied = await invoke<{ status: number; body: string }>(
                'agent_harness_post',
                {
                    url: base() + path,
                    body: bodyText,
                    agentInitiated: opts?.agentInitiated === true,
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
        const res = new Response(proxied.body, {
            status: proxied.status,
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) await throwApiError(res);
        return res.json() as Promise<T>;
    }
    const res = await doFetch(base() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // opt-in only — order paths must never abort an in-flight request
        // (an aborted POST tells us nothing about whether it was executed)
        signal: opts?.timeoutMs
            ? AbortSignal.timeout(opts.timeoutMs)
            : undefined,
    });
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
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
