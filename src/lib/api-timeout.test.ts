import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
}));

vi.mock('./runtime', () => ({
    getApiBase: () => 'http://127.0.0.1:21322',
    isTauri: true,
}));
vi.mock('./agent-harness-state', () => ({
    isAgentHarnessEnabled: () => false,
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.fetch }));

import { apiPost } from './api';

describe('apiPost timeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.fetch.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('clears the abort timer after a successful request', async () => {
        let signal: AbortSignal | undefined;
        mocks.fetch.mockImplementation(
            async (_url: string, init?: RequestInit) => {
                signal = init?.signal ?? undefined;
                return new Response('{}', { status: 200 });
            },
        );

        await expect(
            apiPost('/api/v1/agent/test', {}, { timeoutMs: 100 }),
        ).resolves.toEqual({});
        expect(signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(100);
        expect(signal?.aborted).toBe(false);
    });

    it('aborts a pending request when the timeout expires', async () => {
        mocks.fetch.mockImplementation(
            (_url: string, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(new DOMException('aborted', 'AbortError'));
                    });
                }),
        );

        const request = apiPost('/api/v1/agent/test', {}, { timeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);

        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    });
});
