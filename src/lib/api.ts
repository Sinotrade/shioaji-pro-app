// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';
import { isAgentHarnessEnabled } from './tauri';

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

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    // Serialize once in the WebView, then let the native bridge sign and send
    // these exact bytes. It also transparently sends unsigned when attached to
    // an older server whose harness is disabled.
    if (shouldProxyAgentHarnessMutation(isTauri, isAgentHarnessEnabled(), path)) {
        const bodyText = JSON.stringify(body);
        const { invoke } = await import('@tauri-apps/api/core');
        const proxied = await invoke<{ status: number; body: string }>(
            'agent_harness_post',
            { url: base() + path, body: bodyText },
        );
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
