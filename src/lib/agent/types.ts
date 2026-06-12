// src/lib/agent/types.ts — AI Agent core types: provider-agnostic tool
// calls, permission policies, scheduled/triggered tasks, run records.

export type AgentProvider = 'anthropic' | 'openai' | 'codex';

// what the agent is allowed to do with trading tools
//  readonly — no trading tools exposed at all
//  confirm  — place_order returns a proposal; a human must click
//  auto     — place_order executes immediately (risk-engine gated)
export type AgentPolicy = 'readonly' | 'confirm' | 'auto';

export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface ToolResult {
    id: string;
    content: string;
    isError?: boolean;
}

export interface LLMTurn {
    texts: string[];
    toolCalls: ToolCall[];
}

export interface ToolDef {
    name: string;
    description: string;
    schema: Record<string, unknown>; // JSON Schema (input)
    trading?: boolean; // filtered out under readonly policy
}

export interface OrderProposal {
    code: string;
    action: 'Buy' | 'Sell';
    price: number | null;
    quantity: number;
    reason: string;
}

export type AgentBlock =
    | { type: 'text'; text: string }
    | { type: 'proposal'; proposal: OrderProposal; id: string }
    | { type: 'tool'; name: string; summary: string };

// ---- scheduled / triggered tasks ----

export type TaskTrigger =
    | { type: 'daily'; time: string } // 'HH:MM' local
    | { type: 'interval'; minutes: number }
    | {
          type: 'price';
          code: string;
          condition: 'above' | 'below';
          price: number;
          rearmMinutes: number; // 0 → disable after first fire
      }
    | { type: 'order_event' };

export interface AgentTask {
    id: string;
    name: string;
    prompt: string;
    trigger: TaskTrigger;
    policy: AgentPolicy;
    enabled: boolean;
    createdAt: number;
    lastRunAt?: number;
}

export interface RunRecord {
    id: string;
    taskId: string | null; // null → manual chat-initiated
    name: string;
    at: number;
    ok: boolean;
    summary: string; // final text (truncated)
    proposals: number; // proposals awaiting human action
}
