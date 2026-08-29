export const AGENT_APP_TOOL_CONTRACT_VERSION = 1 as const;

export const AGENT_APP_TOOL_CAPABILITIES = [
    'market.read',
    'account.read',
    'ui.control',
    'task.manage',
    'trade.preview',
    'trade.execute',
] as const;

export type AgentAppToolCapability =
    (typeof AGENT_APP_TOOL_CAPABILITIES)[number];

export type AgentTradeOperationState =
    | 'previewed'
    | 'awaiting_confirmation'
    | 'submitted'
    | 'reconciled'
    | 'rejected'
    | 'unknown_outcome';

export interface AgentTradeOperation {
    clientOperationId: string;
    state: AgentTradeOperationState;
    requestDigest: string;
    createdAt: number;
    updatedAt: number;
    orderId?: string;
    error?: string;
}

export const AGENT_RESTART_POLICY = {
    conversations: 'restore',
    taskHistory: 'restore',
    pendingApprovals: 'expire',
    capabilityGrants: 'expire',
    controlledAuto: 'pause',
} as const;

export function isAgentAppToolCapability(
    value: string,
): value is AgentAppToolCapability {
    return (AGENT_APP_TOOL_CAPABILITIES as readonly string[]).includes(value);
}
