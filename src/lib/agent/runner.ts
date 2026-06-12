// src/lib/agent/runner.ts — the agentic loop: model ↔ tools until the
// model stops calling tools (or the round cap). Provider-agnostic.

import { getAgentConfig } from './config';
import {
    anthropicSession,
    codexSession,
    openaiSession,
    type ProviderSession,
} from './providers';
import { buildSystemPrompt } from './skill';
import { skillCatalogue } from './skills';
import { executeTool, toolsForPolicy } from './tools';
import type { AgentBlock, AgentPolicy, ToolResult } from './types';

const MAX_ROUNDS = 10;

export interface AgentSession {
    send(text: string, onBlocks: (blocks: AgentBlock[]) => void): Promise<void>;
    policy: AgentPolicy;
}

export function createAgentSession(
    overridePolicy?: AgentPolicy,
): AgentSession {
    const cfg = getAgentConfig();
    const policy = overridePolicy ?? cfg.policy;
    if (cfg.provider !== 'codex' && !cfg.apiKey) {
        throw new Error(
            cfg.provider === 'anthropic'
                ? '尚未設定 Anthropic API Key'
                : '尚未設定 OpenAI API Key',
        );
    }
    const system = buildSystemPrompt(policy) + skillCatalogue();
    const tools = toolsForPolicy(policy);
    const session: ProviderSession =
        cfg.provider === 'anthropic'
            ? anthropicSession(cfg.apiKey, cfg.model, system, tools)
            : cfg.provider === 'openai'
              ? openaiSession(cfg.apiKey, cfg.model, system, tools)
              : codexSession(cfg.model, system, tools);

    return {
        policy,
        async send(text, onBlocks) {
            session.sendUser(text);
            for (let round = 0; round < MAX_ROUNDS; round++) {
                const turn = await session.next();
                const blocks: AgentBlock[] = turn.texts.map((t) => ({
                    type: 'text' as const,
                    text: t,
                }));
                if (turn.toolCalls.length === 0) {
                    if (blocks.length) onBlocks(blocks);
                    return;
                }
                const results: ToolResult[] = [];
                for (const call of turn.toolCalls) {
                    try {
                        const { result, proposal } = await executeTool(
                            call.name,
                            call.input,
                            policy,
                        );
                        if (proposal) {
                            blocks.push({
                                type: 'proposal',
                                proposal,
                                id: call.id,
                            });
                        } else if (call.name !== 'use_skill') {
                            blocks.push({
                                type: 'tool',
                                name: call.name,
                                summary: JSON.stringify(result).slice(0, 80),
                            });
                        }
                        results.push({
                            id: call.id,
                            content: JSON.stringify(result),
                        });
                    } catch (e) {
                        results.push({
                            id: call.id,
                            content: JSON.stringify({
                                error:
                                    e instanceof Error
                                        ? e.message
                                        : String(e),
                            }),
                            isError: true,
                        });
                    }
                }
                if (blocks.length) onBlocks(blocks);
                session.pushToolResults(results);
            }
            onBlocks([
                { type: 'text', text: '（已達單次執行的工具回合上限）' },
            ]);
        },
    };
}
