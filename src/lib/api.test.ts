import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPost, shouldProxyAgentHarnessMutation } from './api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('agent harness mutation routing', () => {
    it('keeps normal UI orders on the direct HTTP path while disabled', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                false,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });

    it('uses the native capability proxy only for enabled desktop mutations', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(true);
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/data/snapshots',
            ),
        ).toBe(false);
        expect(
            shouldProxyAgentHarnessMutation(
                false,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });
});

it.each(['/api/v1/order/place_order', '/api/v1/order/cancel_order'])('aborts a queued %s request after three seconds and never sends it later', async path => {
    vi.useFakeTimers();
    let sent = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        setTimeout(() => { if (!init.signal?.aborted) sent = true; resolve(new Response('{}')); }, 5000);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = apiPost(path, {});
    const failure = expect(pending).rejects.toMatchObject({ requestTimedOut: true });
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['/api/v1/order/place_order', '/api/v1/order/cancel_order'])('times out %s even when response headers arrive but the body stalls', async path => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve({ ok: true, json: () => new Promise(() => undefined) } as Response);
    }));
    const pending = apiPost(path, {});
    const failure = expect(pending).rejects.toMatchObject({ requestTimedOut: true });
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    expect(signal?.aborted).toBe(true);
});

it('apiPost rechecks before dispatch and hands raw response headers to onResponse before parsing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"ok":1}', { headers: { 'X-Shioaji-Instance': 'inst-A' } }))));
    const seen: (string | null)[] = [];
    const out = await apiPost<{ ok: number }>('/api/v1/order/place_order', {}, {
        beforeDispatch: () => { seen.push('dispatch'); },
        onResponse: r => { seen.push(r.headers.get('X-Shioaji-Instance')); },
    });
    expect(out).toEqual({ ok: 1 });
    expect(seen).toEqual(['dispatch', 'inst-A']);
});
