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

export const AGENT_APP_COMMANDS = [
    'get_app_state',
    'list_panels',
    'select_contract',
    'add_panel',
    'remove_panel',
    'set_panel_pin',
    'apply_layout',
] as const;

export type AgentAppCommandName = (typeof AGENT_APP_COMMANDS)[number];

export interface AgentPanelState {
    id: string;
    type: import('./workspace').BlockType;
    pin: string | null;
}

export interface AgentAppState {
    selectedContract: {
        code: string;
        name: string;
        securityType: string | null;
    } | null;
    panels: AgentPanelState[];
    layoutPresets: string[];
    layoutProfiles: string[];
}

export interface AgentAppCommandMap {
    get_app_state: {
        args: Record<string, never>;
        result: AgentAppState;
    };
    list_panels: {
        args: Record<string, never>;
        result: { panels: AgentPanelState[] };
    };
    select_contract: {
        args: { code: string };
        result: { contract: NonNullable<AgentAppState['selectedContract']> };
    };
    add_panel: {
        args: { type: import('./workspace').BlockType };
        result: { panel: AgentPanelState; created: boolean };
    };
    remove_panel: {
        args: { id: string };
        result: { removedId: string };
    };
    set_panel_pin: {
        args: { id: string; code: string | null };
        result: { panel: AgentPanelState };
    };
    apply_layout: {
        args: { source: 'preset' | 'profile'; name: string };
        result: {
            source: 'preset' | 'profile';
            name: string;
            panels: AgentPanelState[];
        };
    };
}

export type AgentAppCommand<K extends AgentAppCommandName = AgentAppCommandName> =
    K extends AgentAppCommandName
        ? { name: K; args: AgentAppCommandMap[K]['args'] }
        : never;

export interface AgentAppCommandRequest<
    K extends AgentAppCommandName = AgentAppCommandName,
> {
    requestId: string;
    command: AgentAppCommand<K>;
}

export type AgentAppCommandErrorCode =
    | 'invalid_request'
    | 'invalid_arguments'
    | 'not_found'
    | 'unsupported'
    | 'conflict'
    | 'timeout'
    | 'internal_error';

export type AgentAppCommandResponse<
    K extends AgentAppCommandName = AgentAppCommandName,
> = K extends AgentAppCommandName
    ?
          | {
                requestId: string;
                command: K;
                ok: true;
                result: AgentAppCommandMap[K]['result'];
            }
          | {
                requestId: string;
                command: K | null;
                ok: false;
                error: { code: AgentAppCommandErrorCode; message: string };
            }
    : never;

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

export function isAgentAppCommandName(
    value: string,
): value is AgentAppCommandName {
    return (AGENT_APP_COMMANDS as readonly string[]).includes(value);
}
