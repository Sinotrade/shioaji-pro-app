import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPost, shouldProxyAgentHarnessMutation } from './api';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

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

describe('apiPost timeout', () => {
    it('aborts a stalled opt-in request', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(init.signal?.reason),
                    );
                }),
            ),
        );

        const request = apiPost('/api/v1/data/index_components', {}, {
            timeoutMs: 5_000,
        });
        const rejected = expect(request).rejects.toBeInstanceOf(Error);
        await vi.advanceTimersByTimeAsync(5_000);
        await rejected;
    });

    it('clears the timer after success instead of emitting a late abort', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | null | undefined;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                signal = init?.signal;
                return Promise.resolve(
                    new Response('{}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                );
            }),
        );

        await apiPost('/api/v1/data/index_components', {}, {
            timeoutMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(signal?.aborted).toBe(false);
    });
});
