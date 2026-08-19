import { getKgiBackendBase } from './broker/config';
import { kgiGet, kgiPost } from './broker/backend';

export interface AgentChatResponse {
    id: string;
    conversation_id?: string;
    thread_id?: string;
    role: 'assistant';
    content: string;
    tool_calls: unknown[];
    policy: {
        market_data_source: 'unavailable_in_phase_1';
        tool_access_exposed: false;
        order_execution_exposed: false;
    };
}

export interface AgentStatus {
    connected: boolean;
    authenticated: boolean;
    model: string | null;
    models: { id?: string; name?: string; description?: string | null }[];
    account?: { authenticated?: boolean } | null;
    started_at?: number;
    error?: string | null;
}

export interface AgentConversationStart {
    conversation_id: string;
    thread_id: string;
}

export type AgentStreamEvent =
    | {
          type: 'conversation';
          conversation_id: string;
          thread_id: string;
          model?: string | null;
      }
    | {
          type: 'turn_started';
          conversation_id: string;
          thread_id: string;
          turn_id: string;
      }
    | { type: 'assistant_delta'; delta: string }
    | {
          type: 'turn_completed';
          conversation_id: string;
          thread_id: string;
          turn_id: string;
          content: string;
          tool_calls: unknown[];
      }
    | { type: 'warning'; message: string }
    | { type: 'error'; message: string; code?: number };

export function fetchAgentStatus() {
    return kgiGet<AgentStatus>('/api/v1/codex/status');
}

export function startAgentConversation() {
    return kgiPost<AgentConversationStart>('/api/v1/codex/conversations', {});
}

export function sendAgentMessage(
    message: string,
    context: {
        selectedCode?: string | null;
        conversationId?: string | null;
        threadId?: string | null;
    } = {},
) {
    return kgiPost<AgentChatResponse>('/api/v1/codex/chat', {
        message,
        context: { selectedCode: context.selectedCode },
        conversation_id: context.conversationId,
        thread_id: context.threadId,
    });
}

export async function streamAgentMessage(
    message: string,
    context: {
        selectedCode?: string | null;
        conversationId?: string | null;
        threadId?: string | null;
    } = {},
    onEvent: (event: AgentStreamEvent) => void,
) {
    const res = await fetch(`${getKgiBackendBase()}/api/v1/codex/chat`, {
        method: 'POST',
        headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message,
            context: { selectedCode: context.selectedCode },
            conversation_id: context.conversationId,
            thread_id: context.threadId,
            stream: true,
        }),
    });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`.trim());
    }
    if (!res.body) throw new Error('Codex stream response has no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        buffer = consumeSseBuffer(buffer, onEvent);
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n');
    consumeSseBuffer(`${buffer}\n\n`, onEvent);
}

function consumeSseBuffer(
    buffer: string,
    onEvent: (event: AgentStreamEvent) => void,
) {
    let cursor = 0;
    while (true) {
        const next = buffer.indexOf('\n\n', cursor);
        if (next === -1) break;
        const raw = buffer.slice(cursor, next);
        cursor = next + 2;
        const parsed = parseSseEvent(raw);
        if (parsed) onEvent(parsed);
    }
    return buffer.slice(cursor);
}

function parseSseEvent(raw: string): AgentStreamEvent | null {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    return JSON.parse(dataLines.join('\n')) as AgentStreamEvent;
}
