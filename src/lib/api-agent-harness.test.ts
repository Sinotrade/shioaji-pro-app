import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('./runtime', () => ({
    getApiBase: () => 'http://127.0.0.1:21322',
    isTauri: true,
}));
vi.mock('./agent-harness-state', () => ({
    isAgentHarnessEnabled: () => true,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { apiPost } from './api';

describe('agent harness native POST proxy', () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
    });

    it('sends the exact serialized mutation through the native bridge', async () => {
        const browserFetch = vi.spyOn(globalThis, 'fetch');
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{"trade_id":"t-1"}',
        });

        await expect(
            apiPost<{ trade_id: string }>('/api/v1/order/place_order', {
                code: '2330',
                quantity: 1,
            }),
        ).resolves.toEqual({ trade_id: 't-1' });
        expect(mocks.invoke).toHaveBeenCalledWith('agent_harness_post', {
            url: 'http://127.0.0.1:21322/api/v1/order/place_order',
            body: '{"code":"2330","quantity":1}',
            agentInitiated: false,
        });
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });

    it('marks an Agent mutation for native production approval', async () => {
        mocks.invoke.mockResolvedValue({ status: 200, body: '{}' });

        await apiPost('/api/v1/order/place_order', { code: '2330' }, {
            agentInitiated: true,
        });

        expect(mocks.invoke).toHaveBeenCalledWith('agent_harness_post', {
            url: 'http://127.0.0.1:21322/api/v1/order/place_order',
            body: '{"code":"2330"}',
            agentInitiated: true,
        });
    });

    it('surfaces a rejected native mutation without direct HTTP fallback', async () => {
        const browserFetch = vi.spyOn(globalThis, 'fetch');
        mocks.invoke.mockResolvedValue({
            status: 403,
            body: '{"message":"capability denied"}',
        });

        await expect(
            apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }),
        ).rejects.toThrow('403 capability denied');
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });

    it('marks native approval denial as a mutation that never started', async () => {
        mocks.invoke.mockRejectedValue(
            'AGENT_MUTATION_NOT_STARTED: 使用者未核准這筆 Agent 交易',
        );

        const error = await apiPost(
            '/api/v1/order/place_order',
            { code: '2330' },
            { agentInitiated: true },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ mutationNotStarted: true });
        expect((error as Error).message).toContain('使用者未核准');
    });
});
