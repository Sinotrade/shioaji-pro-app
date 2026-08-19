import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchAgentStatus,
    sendAgentMessage,
    startAgentConversation,
    streamAgentMessage,
} from './kgi-agent';

function mockJson(status: number, body: unknown) {
    return Promise.resolve(
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        }),
    );
}

describe('Codex chat frontend client', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('loads Codex connection status from the bridge', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(200, {
                connected: true,
                authenticated: true,
                model: 'gpt-test',
                models: [{ id: 'gpt-test' }],
            }),
        );

        await expect(fetchAgentStatus()).resolves.toMatchObject({
            connected: true,
            model: 'gpt-test',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/codex/status',
        );
    });

    it('creates a new Codex conversation through the backend', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(200, {
                conversation_id: 'c1',
                thread_id: 't1',
            }),
        );

        await expect(startAgentConversation()).resolves.toMatchObject({
            conversation_id: 'c1',
            thread_id: 't1',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/codex/conversations',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('posts chat messages with conversation and thread context', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(200, {
                id: 'turn-1',
                role: 'assistant',
                content: 'ok',
                tool_calls: [],
                policy: {
                    market_data_source: 'unavailable_in_phase_1',
                    tool_access_exposed: false,
                    order_execution_exposed: false,
                },
            }),
        );

        await sendAgentMessage('你好', {
            selectedCode: '2330',
            conversationId: 'c1',
            threadId: 't1',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/codex/chat',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    message: '你好',
                    context: { selectedCode: '2330' },
                    conversation_id: 'c1',
                    thread_id: 't1',
                }),
            }),
        );
    });

    it('streams Codex SSE deltas from the backend chat endpoint', async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        [
                            'event: conversation',
                            'data: {"type":"conversation","conversation_id":"c1","thread_id":"t1","model":"gpt-test"}',
                            '',
                            'event: assistant_delta',
                            'data: {"type":"assistant_delta","delta":"Codex "}',
                            '',
                            'event: assistant_delta',
                            'data: {"type":"assistant_delta","delta":"已成功連線"}',
                            '',
                            'event: turn_completed',
                            'data: {"type":"turn_completed","conversation_id":"c1","thread_id":"t1","turn_id":"turn1","content":"Codex 已成功連線","tool_calls":[]}',
                            '',
                            '',
                        ].join('\n'),
                    ),
                );
                controller.close();
            },
        });
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        );
        const events: unknown[] = [];

        await streamAgentMessage(
            '請只回答：Codex 已成功連線',
            { conversationId: 'c1', threadId: 't1' },
            (event) => events.push(event),
        );

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/codex/chat',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Accept: 'text/event-stream',
                }),
            }),
        );
        expect(events).toEqual([
            expect.objectContaining({ type: 'conversation', conversation_id: 'c1' }),
            expect.objectContaining({ type: 'assistant_delta', delta: 'Codex ' }),
            expect.objectContaining({ type: 'assistant_delta', delta: '已成功連線' }),
            expect.objectContaining({ type: 'turn_completed', content: 'Codex 已成功連線' }),
        ]);
    });
});
