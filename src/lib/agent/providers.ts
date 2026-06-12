// src/lib/agent/providers.ts — provider adapters. Each session keeps its
// own native message history; the runner only sees normalized turns
// (text blocks + tool calls) and feeds back tool results.

import { isTauri } from '../runtime';
import type { LLMTurn, ToolDef, ToolResult } from './types';

// OpenAI blocks browser CORS — route through the Tauri HTTP plugin on
// desktop; Anthropic allows browsers with the dangerous-access header
async function llmFetch(url: string, init: RequestInit): Promise<Response> {
    if (isTauri) {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch(url, init as Parameters<typeof tauriFetch>[1]);
    }
    return fetch(url, init);
}

export interface ProviderSession {
    sendUser(text: string): void;
    pushToolResults(results: ToolResult[]): void;
    next(): Promise<LLMTurn>; // one model call
}

// ---- Anthropic ----

interface AnthContent {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
}

export function anthropicSession(
    apiKey: string,
    model: string,
    system: string,
    tools: ToolDef[],
): ProviderSession {
    const messages: { role: string; content: unknown }[] = [];
    return {
        sendUser(text) {
            messages.push({ role: 'user', content: text });
        },
        pushToolResults(results) {
            messages.push({
                role: 'user',
                content: results.map((r) => ({
                    type: 'tool_result',
                    tool_use_id: r.id,
                    content: r.content,
                    ...(r.isError ? { is_error: true } : {}),
                })),
            });
        },
        async next() {
            const res = await llmFetch(
                'https://api.anthropic.com/v1/messages',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: JSON.stringify({
                        model,
                        max_tokens: 2000,
                        system,
                        tools: tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            input_schema: t.schema,
                        })),
                        messages,
                    }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`,
                );
            }
            const data = (await res.json()) as { content: AnthContent[] };
            messages.push({ role: 'assistant', content: data.content });
            return {
                texts: data.content
                    .filter((c) => c.type === 'text' && c.text)
                    .map((c) => c.text!),
                toolCalls: data.content
                    .filter((c) => c.type === 'tool_use' && c.id && c.name)
                    .map((c) => ({
                        id: c.id!,
                        name: c.name!,
                        input: c.input ?? {},
                    })),
            };
        },
    };
}

// ---- Codex subscription (Responses API on the ChatGPT backend) ----
// Reverse-engineered endpoint used by the Codex CLI itself — quota counts
// against the subscription's rolling window. Desktop only.

import { borrowCodexCredentials } from './codex-auth';

interface ResponseItem {
    type: string;
    role?: string;
    content?: { type: string; text?: string }[];
    call_id?: string;
    name?: string;
    arguments?: string;
    id?: string;
    [k: string]: unknown;
}

export function codexSession(
    model: string,
    system: string,
    tools: ToolDef[],
): ProviderSession {
    const input: unknown[] = [];
    return {
        sendUser(text) {
            input.push({
                role: 'user',
                content: [{ type: 'input_text', text }],
            });
        },
        pushToolResults(results) {
            for (const r of results) {
                input.push({
                    type: 'function_call_output',
                    call_id: r.id,
                    output: r.content,
                });
            }
        },
        async next() {
            const cred = await borrowCodexCredentials();
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cred.accessToken}`,
            };
            if (cred.accountId) {
                headers['ChatGPT-Account-ID'] = cred.accountId;
            }
            const res = await llmFetch(
                'https://chatgpt.com/backend-api/codex/responses',
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        instructions: system,
                        input,
                        tools: tools.map((t) => ({
                            type: 'function',
                            name: t.name,
                            description: t.description,
                            parameters: t.schema,
                        })),
                        store: false,
                        stream: true,
                    }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `Codex ${res.status}: ${(await res.text()).slice(0, 200)}`,
                );
            }
            // the endpoint only streams — collect the SSE and parse the
            // completed output items
            const text = await res.text();
            const items: ResponseItem[] = [];
            for (const line of text.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                    const ev = JSON.parse(payload) as {
                        type?: string;
                        item?: ResponseItem;
                    };
                    if (
                        ev.type === 'response.output_item.done' &&
                        ev.item
                    ) {
                        items.push(ev.item);
                    }
                } catch {
                    // partial line — skip
                }
            }
            // echo assistant items into the running input for continuity
            for (const item of items) {
                if (item.type === 'message' || item.type === 'function_call') {
                    input.push(item);
                }
            }
            return {
                texts: items
                    .filter((i) => i.type === 'message')
                    .flatMap(
                        (i) =>
                            i.content
                                ?.filter(
                                    (c) =>
                                        c.type === 'output_text' && c.text,
                                )
                                .map((c) => c.text!) ?? [],
                    ),
                toolCalls: items
                    .filter(
                        (i) => i.type === 'function_call' && i.call_id && i.name,
                    )
                    .map((i) => {
                        let parsed: Record<string, unknown> = {};
                        try {
                            parsed = JSON.parse(i.arguments || '{}');
                        } catch {
                            // malformed arguments
                        }
                        return {
                            id: i.call_id!,
                            name: i.name!,
                            input: parsed,
                        };
                    }),
            };
        },
    };
}

// ---- OpenAI (chat completions + function calling) ----

interface OaToolCall {
    id: string;
    function: { name: string; arguments: string };
}

export function openaiSession(
    apiKey: string,
    model: string,
    system: string,
    tools: ToolDef[],
): ProviderSession {
    const messages: Record<string, unknown>[] = [
        { role: 'system', content: system },
    ];
    return {
        sendUser(text) {
            messages.push({ role: 'user', content: text });
        },
        pushToolResults(results) {
            for (const r of results) {
                messages.push({
                    role: 'tool',
                    tool_call_id: r.id,
                    content: r.content,
                });
            }
        },
        async next() {
            const res = await llmFetch(
                'https://api.openai.com/v1/chat/completions',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        tools: tools.map((t) => ({
                            type: 'function',
                            function: {
                                name: t.name,
                                description: t.description,
                                parameters: t.schema,
                            },
                        })),
                    }),
                },
            );
            if (!res.ok) {
                throw new Error(
                    `OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`,
                );
            }
            const data = (await res.json()) as {
                choices: {
                    message: {
                        content: string | null;
                        tool_calls?: OaToolCall[];
                    };
                }[];
            };
            const msg = data.choices[0]?.message;
            if (!msg) throw new Error('OpenAI: empty response');
            messages.push({
                role: 'assistant',
                content: msg.content ?? null,
                ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
            });
            return {
                texts: msg.content ? [msg.content] : [],
                toolCalls: (msg.tool_calls ?? []).map((tc) => {
                    let input: Record<string, unknown> = {};
                    try {
                        input = JSON.parse(tc.function.arguments || '{}');
                    } catch {
                        // malformed arguments — pass empty
                    }
                    return { id: tc.id, name: tc.function.name, input };
                }),
            };
        },
    };
}
