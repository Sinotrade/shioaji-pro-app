import {
    type AgentAppCommand,
    type AgentAppCommandErrorCode,
    type AgentAppCommandMap,
    type AgentAppCommandName,
    type AgentAppCommandRequest,
    type AgentAppCommandResponse,
    type AgentAppState,
    type AgentPanelState,
    isAgentAppCommandName,
} from './agent-contract';
import type { ContractInfo } from './types/contract';
import {
    BLOCK_META,
    GRID_LEGACY_SCALE,
    type Block,
    type BlockType,
    type Profile,
    type Workspace,
} from './workspace';

export const AGENT_APP_COMMAND_REQUEST_EVENT =
    'shioaji-pro:agent-app-command:request';
export const AGENT_APP_COMMAND_RESPONSE_EVENT =
    'shioaji-pro:agent-app-command:response';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTRACT_CODE_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

export interface AgentAppCommandContext {
    getWorkspace(): Workspace;
    getProfiles(): readonly Profile[];
    getSelectedContract(): ContractInfo | null;
    getPresetNames(): readonly string[];
    getPreset(name: string): Workspace | undefined;
    resolveContract(code: string): Promise<ContractInfo>;
    selectContract(contract: ContractInfo): void;
    updateWorkspace(workspace: Workspace): void;
    createPanelId(type: BlockType): string;
}

export class AgentAppCommandError extends Error {
    constructor(
        readonly code: AgentAppCommandErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'AgentAppCommandError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function requireString(
    value: unknown,
    label: string,
    pattern?: RegExp,
): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new AgentAppCommandError(
            'invalid_arguments',
            `${label} must be a non-empty string`,
        );
    }
    const normalized = value.trim();
    if (pattern && !pattern.test(normalized)) {
        throw new AgentAppCommandError(
            'invalid_arguments',
            `${label} has an invalid format`,
        );
    }
    return normalized;
}

function isBlockType(value: unknown): value is BlockType {
    return (
        typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(BLOCK_META, value)
    );
}

function validateArgs<K extends AgentAppCommandName>(
    name: K,
    value: unknown,
): AgentAppCommandMap[K]['args'] {
    if (!isRecord(value)) {
        throw new AgentAppCommandError(
            'invalid_arguments',
            `${name} arguments must be an object`,
        );
    }
    switch (name) {
        case 'get_app_state':
        case 'list_panels':
            if (!hasOnlyKeys(value, [])) {
                throw new AgentAppCommandError(
                    'invalid_arguments',
                    `${name} does not accept arguments`,
                );
            }
            return {} as AgentAppCommandMap[K]['args'];
        case 'select_contract':
            if (!hasOnlyKeys(value, ['code'])) break;
            return {
                code: requireString(
                    value.code,
                    'code',
                    CONTRACT_CODE_PATTERN,
                ),
            } as AgentAppCommandMap[K]['args'];
        case 'add_panel':
            if (!hasOnlyKeys(value, ['type']) || !isBlockType(value.type)) {
                break;
            }
            return { type: value.type } as AgentAppCommandMap[K]['args'];
        case 'remove_panel':
            if (!hasOnlyKeys(value, ['id'])) break;
            return {
                id: requireString(value.id, 'id'),
            } as AgentAppCommandMap[K]['args'];
        case 'set_panel_pin': {
            if (!hasOnlyKeys(value, ['id', 'code'])) break;
            const code =
                value.code === null
                    ? null
                    : requireString(
                          value.code,
                          'code',
                          CONTRACT_CODE_PATTERN,
                      );
            return {
                id: requireString(value.id, 'id'),
                code,
            } as AgentAppCommandMap[K]['args'];
        }
        case 'apply_layout':
            if (
                !hasOnlyKeys(value, ['source', 'name']) ||
                (value.source !== 'preset' && value.source !== 'profile')
            ) {
                break;
            }
            return {
                source: value.source,
                name: requireString(value.name, 'name'),
            } as AgentAppCommandMap[K]['args'];
    }
    throw new AgentAppCommandError(
        'invalid_arguments',
        `Invalid arguments for ${name}`,
    );
}

export function parseAgentAppCommandRequest(
    value: unknown,
): AgentAppCommandRequest {
    if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'command'])) {
        throw new AgentAppCommandError(
            'invalid_request',
            'Command request must contain requestId and command',
        );
    }
    const requestId = requireString(
        value.requestId,
        'requestId',
        REQUEST_ID_PATTERN,
    );
    if (
        !isRecord(value.command) ||
        !hasOnlyKeys(value.command, ['name', 'args'])
    ) {
        throw new AgentAppCommandError(
            'invalid_request',
            'command must contain name and args',
        );
    }
    const name = value.command.name;
    if (typeof name !== 'string' || !isAgentAppCommandName(name)) {
        throw new AgentAppCommandError(
            'unsupported',
            'Unsupported app command',
        );
    }
    return {
        requestId,
        command: {
            name,
            args: validateArgs(name, value.command.args),
        } as AgentAppCommand,
    };
}

function panelState(block: Block): AgentPanelState {
    return { id: block.id, type: block.type, pin: block.pin };
}

function contractState(contract: ContractInfo) {
    return {
        code: contract.code,
        name: contract.name,
        securityType: contract.security_type,
    };
}

function appState(context: AgentAppCommandContext): AgentAppState {
    const selected = context.getSelectedContract();
    return {
        selectedContract: selected ? contractState(selected) : null,
        panels: context.getWorkspace().blocks.map(panelState),
        layoutPresets: [...context.getPresetNames()],
        layoutProfiles: context.getProfiles().map((profile) => profile.name),
    };
}

async function resolveValidContract(
    context: AgentAppCommandContext,
    code: string,
): Promise<ContractInfo> {
    try {
        return await context.resolveContract(code);
    } catch {
        throw new AgentAppCommandError(
            'not_found',
            `Contract ${code} was not found`,
        );
    }
}

function findPanel(context: AgentAppCommandContext, id: string): Block {
    const panel = context.getWorkspace().blocks.find((block) => block.id === id);
    if (!panel) {
        throw new AgentAppCommandError('not_found', `Panel ${id} was not found`);
    }
    return panel;
}

export async function executeAgentAppCommand<K extends AgentAppCommandName>(
    command: AgentAppCommand<K>,
    context: AgentAppCommandContext,
): Promise<AgentAppCommandMap[K]['result']> {
    const args = validateArgs(command.name, command.args);
    switch (command.name) {
        case 'get_app_state': {
            return appState(context) as AgentAppCommandMap[K]['result'];
        }
        case 'list_panels':
            return {
                panels: context.getWorkspace().blocks.map(panelState),
            } as AgentAppCommandMap[K]['result'];
        case 'select_contract': {
            const contract = await resolveValidContract(
                context,
                (args as AgentAppCommandMap['select_contract']['args']).code,
            );
            context.selectContract(contract);
            return {
                contract: contractState(contract),
            } as AgentAppCommandMap[K]['result'];
        }
        case 'add_panel': {
            const { type } = args as AgentAppCommandMap['add_panel']['args'];
            const workspace = context.getWorkspace();
            const meta = BLOCK_META[type];
            const existing = meta.singleton
                ? workspace.blocks.find((block) => block.type === type)
                : undefined;
            if (existing) {
                return {
                    panel: panelState(existing),
                    created: false,
                } as AgentAppCommandMap[K]['result'];
            }
            const block: Block = {
                id: context.createPanelId(type),
                type,
                pin: null,
            };
            context.updateWorkspace({
                blocks: [...workspace.blocks, block],
                layout: [
                    ...workspace.layout,
                    {
                        i: block.id,
                        x: 0,
                        y: Infinity,
                        w: meta.defaultSize.w * GRID_LEGACY_SCALE,
                        h: meta.defaultSize.h,
                        minW: meta.defaultSize.minW * GRID_LEGACY_SCALE,
                        minH: meta.defaultSize.minH,
                    },
                ],
            });
            return {
                panel: panelState(block),
                created: true,
            } as AgentAppCommandMap[K]['result'];
        }
        case 'remove_panel': {
            const { id } = args as AgentAppCommandMap['remove_panel']['args'];
            const workspace = context.getWorkspace();
            const removing = findPanel(context, id);
            // Agent 不能移除自己的面板：面板卸載會砍斷進行中的 MCP
            // 回應通道（呼叫端永遠等不到結果），也會關掉使用者正在看
            // 的對話
            if (removing.type === 'assistant') {
                throw new AgentAppCommandError(
                    'unsupported',
                    '不能移除 AI Agent 自己的面板',
                );
            }
            context.updateWorkspace({
                blocks: workspace.blocks.filter((block) => block.id !== id),
                layout: workspace.layout.filter((item) => item.i !== id),
            });
            return { removedId: id } as AgentAppCommandMap[K]['result'];
        }
        case 'set_panel_pin': {
            const { id, code } =
                args as AgentAppCommandMap['set_panel_pin']['args'];
            const initialPanel = findPanel(context, id);
            if (!BLOCK_META[initialPanel.type].pinnable) {
                throw new AgentAppCommandError(
                    'unsupported',
                    `Panel ${id} does not support pinning`,
                );
            }
            const pin = code
                ? (await resolveValidContract(context, code)).code
                : null;
            // Contract resolution may cross the network. Re-read after the
            // await so a concurrent user layout edit is never overwritten by
            // the pre-resolution workspace snapshot.
            const workspace = context.getWorkspace();
            const panel = findPanel(context, id);
            if (!BLOCK_META[panel.type].pinnable) {
                throw new AgentAppCommandError(
                    'unsupported',
                    `Panel ${id} does not support pinning`,
                );
            }
            const updated = { ...panel, pin };
            context.updateWorkspace({
                ...workspace,
                blocks: workspace.blocks.map((block) =>
                    block.id === id ? updated : block,
                ),
            });
            return {
                panel: panelState(updated),
            } as AgentAppCommandMap[K]['result'];
        }
        case 'apply_layout': {
            const { source, name } =
                args as AgentAppCommandMap['apply_layout']['args'];
            const target =
                source === 'preset'
                    ? context.getPreset(name)
                    : context
                          .getProfiles()
                          .find((profile) => profile.name === name)?.workspace;
            if (!target) {
                throw new AgentAppCommandError(
                    'not_found',
                    `${source} layout ${name} was not found`,
                );
            }
            const next = structuredClone(target);
            // Agent 是 singleton。目標版面若有另一個 Agent，就沿用它的
            // 版面槽位但換成目前 live Agent 的 id；這樣既不會卸載正在
            // 執行此 MCP 呼叫的 component-owned response channel，也不會
            // 為了保活而製造兩個 Agent。
            const current = context.getWorkspace();
            const liveAssistant = current.blocks.find(
                (block) => block.type === 'assistant',
            );
            if (liveAssistant) {
                const targetAssistantIds = new Set(
                    next.blocks
                        .filter((block) => block.type === 'assistant')
                        .map((block) => block.id),
                );
                const targetSlot = next.layout.find((item) =>
                    targetAssistantIds.has(item.i),
                );
                next.blocks = [
                    ...next.blocks.filter(
                        (block) => block.type !== 'assistant',
                    ),
                    structuredClone(liveAssistant),
                ];
                next.layout = next.layout.filter(
                    (item) => !targetAssistantIds.has(item.i),
                );
                const currentItem = current.layout.find(
                    (item) => item.i === liveAssistant.id,
                );
                const maxY = next.layout.reduce(
                    (acc, item) => Math.max(acc, item.y + item.h),
                    0,
                );
                next.layout.push(
                    targetSlot
                        ? { ...structuredClone(targetSlot), i: liveAssistant.id }
                        : currentItem
                        ? { ...structuredClone(currentItem), x: 0, y: maxY }
                        : {
                              i: liveAssistant.id,
                              x: 0,
                              y: maxY,
                              w: 72,
                              h: 14,
                              minW: 36,
                              minH: 8,
                          },
                );
            }
            context.updateWorkspace(next);
            return {
                source,
                name,
                panels: next.blocks.map(panelState),
            } as AgentAppCommandMap[K]['result'];
        }
    }
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stableStringify(value[key])}`,
            )
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

function failedResponse(
    requestId: string,
    command: AgentAppCommandName | null,
    error: unknown,
): AgentAppCommandResponse {
    if (error instanceof AgentAppCommandError) {
        return {
            requestId,
            command,
            ok: false,
            error: { code: error.code, message: error.message },
        };
    }
    return {
        requestId,
        command,
        ok: false,
        error: {
            code: 'internal_error',
            message:
                error instanceof Error ? error.message : 'App command failed',
        },
    };
}

export function registerAgentAppCommandHost(
    target: EventTarget,
    context: AgentAppCommandContext | (() => AgentAppState),
    options: { cacheSize?: number; readOnly?: boolean } = {},
): () => void {
    let active = true;
    const cacheSize = Math.max(1, options.cacheSize ?? 4_096);
    const requests = new Map<
        string,
        {
            fingerprint: string;
            response: Promise<AgentAppCommandResponse>;
            settled: boolean;
            retain: boolean;
        }
    >();

    const trimCompletedReads = (targetSize: number) => {
        if (requests.size <= targetSize) return;
        for (const [requestId, entry] of requests) {
            if (!entry.settled || entry.retain) continue;
            requests.delete(requestId);
            if (requests.size <= targetSize) break;
        }
    };

    const respond = (response: AgentAppCommandResponse) => {
        if (!active) return;
        target.dispatchEvent(
            new CustomEvent(AGENT_APP_COMMAND_RESPONSE_EVENT, {
                detail: response,
            }),
        );
    };

    const listener = (event: Event) => {
        const detail = event instanceof CustomEvent ? event.detail : undefined;
        let request: AgentAppCommandRequest;
        try {
            request = parseAgentAppCommandRequest(detail);
        } catch (error) {
            const requestId =
                isRecord(detail) && typeof detail.requestId === 'string'
                    ? detail.requestId
                    : '';
            respond(failedResponse(requestId, null, error));
            return;
        }

        const fingerprint = stableStringify(request.command);
        const previous = requests.get(request.requestId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) {
                respond(
                    failedResponse(
                        request.requestId,
                        request.command.name,
                        new AgentAppCommandError(
                            'conflict',
                            `requestId ${request.requestId} was reused with different payload`,
                        ),
                    ),
                );
                return;
            }
            void previous.response.then(respond);
            return;
        }

        // Mutation request ids are retained for the host lifetime so an old
        // replay cannot execute the side effect again. Completed reads are the
        // only evictable entries; in-flight and mutation entries count toward
        // the same hard cap to bound memory under a noisy caller.
        trimCompletedReads(cacheSize - 1);
        if (requests.size >= cacheSize) {
            respond(
                failedResponse(
                    request.requestId,
                    request.command.name,
                    new AgentAppCommandError(
                        'conflict',
                        'App command request capacity is exhausted',
                    ),
                ),
            );
            return;
        }

        const response = Promise.resolve().then(() => {
            if (!active) {
                throw new AgentAppCommandError('unsupported', 'App command host is no longer active');
            }
            if ((options.readOnly || typeof context === 'function') &&
                request.command.name !== 'get_app_state') {
                throw new AgentAppCommandError('unsupported', 'Only read-only App state is available');
            }
            return typeof context === 'function'
                ? context()
                : executeAgentAppCommand(request.command, context);
        })
            .then(
                (result): AgentAppCommandResponse => ({
                    requestId: request.requestId,
                    command: request.command.name,
                    ok: true,
                    result,
                } as AgentAppCommandResponse),
            )
            .catch((error) =>
                failedResponse(request.requestId, request.command.name, error),
            );
        const entry = {
            fingerprint,
            response,
            settled: false,
            retain:
                request.command.name !== 'get_app_state' &&
                request.command.name !== 'list_panels',
        };
        requests.set(request.requestId, entry);
        void response.then((result) => {
            entry.settled = true;
            respond(result);
            trimCompletedReads(cacheSize);
        });
    };

    target.addEventListener(AGENT_APP_COMMAND_REQUEST_EVENT, listener);
    return () => {
        active = false;
        target.removeEventListener(AGENT_APP_COMMAND_REQUEST_EVENT, listener);
    };
}

export function registerOnboardingAppStateHost(target: EventTarget): () => void {
    // The first-run gate mounts no workspace, selection, or layout controls.
    // Do not report persisted/default panels as if they were mounted.
    return registerAgentAppCommandHost(target, () => ({
        selectedContract: null,
        panels: [],
        layoutPresets: [],
        layoutProfiles: [],
    }));
}

export function requestAgentAppCommand<K extends AgentAppCommandName>(
    target: EventTarget,
    request: AgentAppCommandRequest<K>,
    options: { timeoutMs?: number } = {},
): Promise<AgentAppCommandResponse<K>> {
    const parsed = parseAgentAppCommandRequest(
        request,
    ) as AgentAppCommandRequest<K>;
    const timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
    return new Promise((resolve) => {
        const listener = (event: Event) => {
            if (!(event instanceof CustomEvent)) return;
            const response = event.detail as AgentAppCommandResponse<K>;
            if (
                response?.requestId !== parsed.requestId ||
                response.command !== parsed.command.name
            ) {
                return;
            }
            cleanup();
            resolve(response);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve({
                requestId: parsed.requestId,
                command: parsed.command.name,
                ok: false,
                error: {
                    code: 'timeout',
                    message: `App command timed out after ${timeoutMs}ms`,
                },
            } as AgentAppCommandResponse<K>);
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            target.removeEventListener(
                AGENT_APP_COMMAND_RESPONSE_EVENT,
                listener,
            );
        };
        target.addEventListener(AGENT_APP_COMMAND_RESPONSE_EVENT, listener);
        target.dispatchEvent(
            new CustomEvent(AGENT_APP_COMMAND_REQUEST_EVENT, {
                detail: parsed,
            }),
        );
    });
}
