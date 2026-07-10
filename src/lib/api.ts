// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';

// resolved per request — the server port can move at runtime (e.g. the boot
// flow discovers the default port occupied and starts on a fallback), and a
// module-load-time capture kept every request on the dead old port
// (the stuck-at-載入交易終端 bug)
const base = () => getApiBase();

// Future server capability integration. Disabled until rshioaji ships an
// approved mutation-authorization protocol.
const SERVER_TRADING_CAPABILITY_ENABLED = false;

// The desktop webview enforces CORS but the shioaji server doesn't answer
// preflight OPTIONS (405) — route requests through Tauri's Rust-side fetch,
// which has no CORS, when running in the app.
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

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const mutationPaths = new Set([
        '/api/v1/order/place_order',
        '/api/v1/order/cancel_order',
        '/api/v1/order/update_price',
        '/api/v1/order/update_qty',
        '/api/v1/order/place_comboorder',
        '/api/v1/order/cancel_comboorder',
        '/api/v1/order/reserve_stock',
        '/api/v1/order/reserve_earmarking',
    ]);
    if (SERVER_TRADING_CAPABILITY_ENABLED && isTauri && mutationPaths.has(path)) {
        const health = await doFetch(base() + '/api/v1/health');
        if (!health.ok) await throwApiError(health);
        const negotiation = (await health.json()) as {
            agent_capabilities?: {
                version?: number;
                mutation_auth_required?: boolean;
                broker_transport?: string;
            };
        };
        const capability = negotiation.agent_capabilities;
        if (capability) {
            if (
                capability.version !== 1 ||
                capability.mutation_auth_required !== true ||
                capability.broker_transport !== 'unix'
            ) {
                throw new Error('daemon trading capability protocol 不相容');
            }
            const { invoke } = await import('@tauri-apps/api/core');
            const proxied = await invoke<{ status: number; body: string }>(
                'agent_trading_ui_post',
                { url: base() + path, payload: body },
            );
            const res = new Response(proxied.body, {
                status: proxied.status,
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) await throwApiError(res);
            return res.json() as Promise<T>;
        }
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
