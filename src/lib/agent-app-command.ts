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
import type { WorkspaceUndoEntry, WorkspaceUndoHistory } from './workspace-history';
import {
    buildWorkspaceFromSpec,
    checkWorkspaceSpec,
    resolveWorkspaceSpecContracts,
    WORKSPACE_SPEC_SCHEMA_ID,
    WORKSPACE_SPEC_TOKEN_PATTERN,
    workspaceRevision,
    workspaceSpecCatalog,
    workspaceToSpec,
    type WorkspaceSpecCheck,
    type WorkspaceSpecIssue,
} from './workspace-spec';

export const AGENT_APP_COMMAND_REQUEST_EVENT =
    'shioaji-pro:agent-app-command:request';
export const AGENT_APP_COMMAND_RESPONSE_EVENT =
    'shioaji-pro:agent-app-command:response';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UNDO_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UNDO_LABEL_MAX = 60;
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
    /** Undo steps for workspace specs; without it the spec commands are unsupported. */
    workspaceHistory?: WorkspaceUndoHistory;
    /** Visible grid rows of the main window, for the viewport warning. */
    getViewportRows?(): number | null;
    /** Render density (1–4) of the main grid, for compaction previews. */
    getGridDensity?(): number | null;
    /** Called after a spec apply or undo lands (toast, activity log). */
    onWorkspaceSpecChange?(event: {
        kind: 'applied' | 'undone';
        entry: WorkspaceUndoEntry;
    }): void;
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
        case 'get_workspace_spec':
            if (!hasOnlyKeys(value, ['columns'])) break;
            if (
                value.columns !== undefined &&
                value.columns !== 24 &&
                value.columns !== 288
            ) {
                throw new AgentAppCommandError(
                    'invalid_arguments',
                    'columns must be 24 or 288',
                );
            }
            return (
                value.columns === undefined ? {} : { columns: value.columns }
            ) as AgentAppCommandMap[K]['args'];
        case 'validate_workspace_spec':
            if (!hasOnlyKeys(value, ['spec']) || !('spec' in value)) break;
            return { spec: value.spec } as AgentAppCommandMap[K]['args'];
        case 'apply_workspace_spec': {
            if (
                !hasOnlyKeys(value, ['spec', 'validationToken', 'label']) ||
                !('spec' in value)
            ) {
                break;
            }
            if (
                typeof value.validationToken !== 'string' ||
                !WORKSPACE_SPEC_TOKEN_PATTERN.test(value.validationToken)
            ) {
                throw new AgentAppCommandError(
                    'invalid_arguments',
                    'validationToken is required: call validate_workspace_spec with the same spec first',
                );
            }
            const label =
                value.label === undefined
                    ? undefined
                    : requireString(value.label, 'label').slice(0, UNDO_LABEL_MAX);
            return {
                spec: value.spec,
                validationToken: value.validationToken,
                ...(label ? { label } : {}),
            } as AgentAppCommandMap[K]['args'];
        }
        case 'undo_workspace_change':
            if (!hasOnlyKeys(value, ['undoId'])) break;
            return (
                value.undoId === undefined
                    ? {}
                    : { undoId: requireString(value.undoId, 'undoId', UNDO_ID_PATTERN) }
            ) as AgentAppCommandMap[K]['args'];
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

function requireHistory(context: AgentAppCommandContext): WorkspaceUndoHistory {
    if (!context.workspaceHistory) {
        throw new AgentAppCommandError(
            'unsupported',
            'Workspace specs are not available in this window',
        );
    }
    return context.workspaceHistory;
}

function undoState(entry: WorkspaceUndoEntry | null) {
    return entry ? { undoId: entry.id, label: entry.label, at: entry.at } : null;
}

// Contract resolution may cross the network. Callers run the final
// structural check synchronously on the workspace as it is after the await,
// with no further await before they act on it.
async function resolveSpec(
    context: AgentAppCommandContext,
    spec: unknown,
): Promise<{ spec: unknown; errors: WorkspaceSpecIssue[] } | WorkspaceSpecCheck> {
    const first = checkWorkspaceSpec(spec, context.getWorkspace());
    if (!first.valid) return first;
    return resolveWorkspaceSpecContracts(spec, (code) =>
        context.resolveContract(code),
    );
}

function checkResolved(
    context: AgentAppCommandContext,
    resolved: { spec: unknown; errors: WorkspaceSpecIssue[] } | WorkspaceSpecCheck,
    current: Workspace,
): WorkspaceSpecCheck {
    if ('valid' in resolved) return resolved;
    const check = checkWorkspaceSpec(resolved.spec, current, {
        viewportRows: context.getViewportRows?.() ?? null,
        density: context.getGridDensity?.() ?? null,
    });
    if (resolved.errors.length) {
        return {
            valid: false,
            errors: [...resolved.errors, ...check.errors],
            warnings: check.warnings,
        };
    }
    return check;
}

function summarizeIssues(check: WorkspaceSpecCheck): string {
    const shown = check.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`);
    const more = check.errors.length > 5 ? ` (+${check.errors.length - 5} more)` : '';
    return `workspace spec is invalid — ${shown.join('; ')}${more}`;
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
                ...workspace,
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
                ...workspace,
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
            // 固定或取消固定都離開連動群組：取消固定＝回到跟隨自選選取
            const { linkGroup: _group, ...rest } = panel;
            const updated = { ...rest, pin };
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
        case 'get_workspace_spec': {
            const history = requireHistory(context);
            const { columns } =
                args as AgentAppCommandMap['get_workspace_spec']['args'];
            const workspace = context.getWorkspace();
            const spec = workspaceToSpec(workspace, columns);
            return {
                spec,
                schema: WORKSPACE_SPEC_SCHEMA_ID,
                viewport: { rows: context.getViewportRows?.() ?? null },
                panelTypes: workspaceSpecCatalog(spec.columns),
                undo: undoState(history.peek(workspace)),
            } as AgentAppCommandMap[K]['result'];
        }
        case 'validate_workspace_spec': {
            const history = requireHistory(context);
            const { spec } =
                args as AgentAppCommandMap['validate_workspace_spec']['args'];
            const resolved = await resolveSpec(context, spec);
            const current = context.getWorkspace();
            const check = checkResolved(context, resolved, current);
            if (!check.valid) {
                return {
                    valid: false,
                    errors: check.errors,
                    warnings: check.warnings,
                    diff: null,
                    validationToken: null,
                    resultSpec: null,
                } as AgentAppCommandMap[K]['result'];
            }
            const preview = buildWorkspaceFromSpec(current, check.normalized);
            return {
                valid: true,
                errors: [],
                warnings: check.warnings,
                diff: check.diff,
                validationToken: history.issueValidation({
                    spec: check.fingerprint,
                    base: workspaceRevision(current),
                }),
                resultSpec: workspaceToSpec(preview, check.normalized.columns),
            } as AgentAppCommandMap[K]['result'];
        }
        case 'apply_workspace_spec': {
            const history = requireHistory(context);
            const { spec, validationToken, label } =
                args as AgentAppCommandMap['apply_workspace_spec']['args'];
            const stale = () =>
                new AgentAppCommandError(
                    'conflict',
                    'The workspace changed since validation; call validate_workspace_spec again and review the diff before applying',
                );
            if (!history.peekValidation(validationToken)) {
                throw new AgentAppCommandError(
                    'conflict',
                    'validationToken is unknown, expired or already used; call validate_workspace_spec with this spec first',
                );
            }
            const resolved = await resolveSpec(context, spec);
            // From here to the mutation there is no await: the revision check,
            // the token consumption and the replacement happen atomically with
            // respect to user edits and other Agent calls.
            const binding = history.peekValidation(validationToken);
            if (!binding) throw stale();
            const before = context.getWorkspace();
            if (workspaceRevision(before) !== binding.base) {
                history.revokeValidation(validationToken);
                throw stale();
            }
            const check = checkResolved(context, resolved, before);
            if (!check.valid) {
                history.revokeValidation(validationToken);
                throw new AgentAppCommandError(
                    'invalid_arguments',
                    summarizeIssues(check),
                );
            }
            if (check.fingerprint !== binding.spec) {
                history.revokeValidation(validationToken);
                throw new AgentAppCommandError(
                    'conflict',
                    'This spec differs from the one validated with this token; validate it before applying',
                );
            }
            history.revokeValidation(validationToken);
            context.updateWorkspace(buildWorkspaceFromSpec(before, check.normalized));
            const stored = context.getWorkspace();
            const entry = history.push(before, stored, label ?? 'Agent 版面變更');
            context.onWorkspaceSpecChange?.({ kind: 'applied', entry });
            return {
                applied: true,
                undo: undoState(entry)!,
                diff: check.diff,
                warnings: check.warnings,
                spec: workspaceToSpec(stored, check.normalized.columns),
            } as AgentAppCommandMap[K]['result'];
        }
        case 'undo_workspace_change': {
            const history = requireHistory(context);
            const { undoId } =
                args as AgentAppCommandMap['undo_workspace_change']['args'];
            const result = history.pop(context.getWorkspace(), undoId);
            if (!result.ok) {
                throw new AgentAppCommandError(
                    result.reason === 'empty' ? 'not_found' : 'conflict',
                    result.reason === 'empty'
                        ? 'There is no workspace change to undo'
                        : result.reason === 'mismatch'
                          ? `undoId ${undoId} is not the latest workspace change`
                          : 'Panels or their settings changed, or another layout was loaded, after this change; undo would discard that work, so it was not applied',
                );
            }
            const restored = structuredClone(result.entry.before);
            context.updateWorkspace(restored);
            context.onWorkspaceSpecChange?.({
                kind: 'undone',
                entry: result.entry,
            });
            return {
                undone: true,
                undoId: result.entry.id,
                label: result.entry.label,
                spec: workspaceToSpec(context.getWorkspace()),
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

const READ_COMMANDS: ReadonlySet<AgentAppCommandName> = new Set([
    'get_app_state',
    'list_panels',
    'get_workspace_spec',
    'validate_workspace_spec',
]);

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
            retain: !READ_COMMANDS.has(request.command.name),
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
