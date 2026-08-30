import { describe, expect, it, vi } from 'vitest';

import type { AgentAppCommandResponse } from './agent-contract';
import {
    AGENT_APP_COMMAND_REQUEST_EVENT,
    AGENT_APP_COMMAND_RESPONSE_EVENT,
    AgentAppCommandError,
    executeAgentAppCommand,
    parseAgentAppCommandRequest,
    registerAgentAppCommandHost,
    requestAgentAppCommand,
    type AgentAppCommandContext,
} from './agent-app-command';
import type { ContractInfo } from './types/contract';
import {
    LAYOUT_PRESETS,
    type BlockType,
    type Profile,
    type Workspace,
} from './workspace';

const contract = (code: string, name = `Name ${code}`): ContractInfo =>
    ({
        code,
        name,
        security_type: 'STK',
    }) as ContractInfo;

function fixture(options: {
    workspace?: Workspace;
    profileWorkspace?: Workspace;
} = {}) {
    let workspace: Workspace = options.workspace ?? {
        blocks: [
            { id: 'chart-1', type: 'chart', pin: null },
            { id: 'watchlist-1', type: 'watchlist', pin: null },
        ],
        layout: [
            { i: 'chart-1', x: 0, y: 0, w: 120, h: 10 },
            { i: 'watchlist-1', x: 120, y: 0, w: 48, h: 10 },
        ],
    };
    let selected: ContractInfo | null = contract('2330', '台積電');
    const profileWorkspace: Workspace = options.profileWorkspace ?? {
        blocks: [{ id: 'depth-p', type: 'depth', pin: '2317' }],
        layout: [{ i: 'depth-p', x: 0, y: 0, w: 96, h: 10 }],
    };
    const profiles: Profile[] = [
        { name: '我的版面', workspace: profileWorkspace },
    ];
    const resolveContract = vi.fn(async (code: string) => {
        if (code === 'BAD') throw new Error('not found');
        return contract(code);
    });
    let sequence = 0;
    const context: AgentAppCommandContext = {
        getWorkspace: () => workspace,
        getProfiles: () => profiles,
        getSelectedContract: () => selected,
        getPresetNames: () => LAYOUT_PRESETS.map((preset) => preset.name),
        getPreset: (name) =>
            LAYOUT_PRESETS.find((preset) => preset.name === name)?.workspace,
        resolveContract,
        selectContract: (next) => {
            selected = next;
        },
        updateWorkspace: (next) => {
            workspace = next;
        },
        createPanelId: (type: BlockType) => `${type}-${++sequence}`,
    };
    return {
        context,
        resolveContract,
        workspace: () => workspace,
        selected: () => selected,
        profileWorkspace,
    };
}

describe('agent app command validation', () => {
    it('accepts a typed request and normalizes strings', () => {
        expect(
            parseAgentAppCommandRequest({
                requestId: ' request-1 ',
                command: {
                    name: 'select_contract',
                    args: { code: ' 2330 ' },
                },
            }),
        ).toEqual({
            requestId: 'request-1',
            command: { name: 'select_contract', args: { code: '2330' } },
        });
    });

    it.each([
        {
            requestId: 'bad id',
            command: { name: 'list_panels', args: {} },
        },
        {
            requestId: 'r1',
            command: { name: 'add_panel', args: { type: 'browser' } },
        },
        {
            requestId: 'r1',
            command: {
                name: 'select_contract',
                args: { code: '2330', extra: true },
            },
        },
        {
            requestId: 'r1',
            command: { name: 'click_at', args: { x: 1, y: 2 } },
        },
    ])('rejects malformed or non-semantic payload %#', (request) => {
        expect(() => parseAgentAppCommandRequest(request)).toThrow(
            AgentAppCommandError,
        );
    });
});

describe('semantic workspace commands', () => {
    it('queries app state and panels with supported layout choices', async () => {
        const { context } = fixture();
        const state = await executeAgentAppCommand(
            { name: 'get_app_state', args: {} },
            context,
        );
        expect(state.selectedContract).toEqual({
            code: '2330',
            name: '台積電',
            securityType: 'STK',
        });
        expect(state.panels.map((panel) => panel.id)).toEqual([
            'chart-1',
            'watchlist-1',
        ]);
        expect(state.layoutPresets).toEqual(
            LAYOUT_PRESETS.map((preset) => preset.name),
        );
        expect(state.layoutProfiles).toEqual(['我的版面']);

        await expect(
            executeAgentAppCommand(
                { name: 'list_panels', args: {} },
                context,
            ),
        ).resolves.toEqual({ panels: state.panels });
    });

    it('selects only a resolvable contract', async () => {
        const { context, selected } = fixture();
        await expect(
            executeAgentAppCommand(
                { name: 'select_contract', args: { code: '2317' } },
                context,
            ),
        ).resolves.toMatchObject({ contract: { code: '2317' } });
        expect(selected()?.code).toBe('2317');
        await expect(
            executeAgentAppCommand(
                { name: 'select_contract', args: { code: 'BAD' } },
                context,
            ),
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('adds supported panels and makes singleton addition idempotent', async () => {
        const { context, workspace } = fixture();
        await expect(
            executeAgentAppCommand(
                { name: 'add_panel', args: { type: 'depth' } },
                context,
            ),
        ).resolves.toMatchObject({
            panel: { id: 'depth-1', type: 'depth', pin: null },
            created: true,
        });
        expect(workspace().blocks.at(-1)?.id).toBe('depth-1');
        expect(workspace().layout.at(-1)?.i).toBe('depth-1');

        await expect(
            executeAgentAppCommand(
                { name: 'add_panel', args: { type: 'watchlist' } },
                context,
            ),
        ).resolves.toEqual({
            panel: { id: 'watchlist-1', type: 'watchlist', pin: null },
            created: false,
        });
        expect(
            workspace().blocks.filter((panel) => panel.type === 'watchlist'),
        ).toHaveLength(1);
    });

    it('removes existing panels and rejects unknown ids', async () => {
        const { context, workspace } = fixture();
        await executeAgentAppCommand(
            { name: 'remove_panel', args: { id: 'chart-1' } },
            context,
        );
        expect(workspace().blocks.some((panel) => panel.id === 'chart-1')).toBe(
            false,
        );
        expect(workspace().layout.some((item) => item.i === 'chart-1')).toBe(
            false,
        );
        await expect(
            executeAgentAppCommand(
                { name: 'remove_panel', args: { id: 'missing' } },
                context,
            ),
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('pins only pinnable panels to resolvable contracts', async () => {
        const { context, workspace, resolveContract } = fixture();
        await expect(
            executeAgentAppCommand(
                {
                    name: 'set_panel_pin',
                    args: { id: 'chart-1', code: '2317' },
                },
                context,
            ),
        ).resolves.toEqual({
            panel: { id: 'chart-1', type: 'chart', pin: '2317' },
        });
        expect(workspace().blocks[0]?.pin).toBe('2317');
        await expect(
            executeAgentAppCommand(
                {
                    name: 'set_panel_pin',
                    args: { id: 'chart-1', code: null },
                },
                context,
            ),
        ).resolves.toEqual({
            panel: { id: 'chart-1', type: 'chart', pin: null },
        });
        expect(workspace().blocks[0]?.pin).toBeNull();

        resolveContract.mockImplementationOnce(async (code: string) => {
            const current = context.getWorkspace();
            context.updateWorkspace({
                blocks: [
                    ...current.blocks,
                    { id: 'depth-concurrent', type: 'depth', pin: null },
                ],
                layout: [
                    ...current.layout,
                    {
                        i: 'depth-concurrent',
                        x: 0,
                        y: 20,
                        w: 96,
                        h: 10,
                    },
                ],
            });
            return contract(code);
        });
        await executeAgentAppCommand(
            {
                name: 'set_panel_pin',
                args: { id: 'chart-1', code: '2454' },
            },
            context,
        );
        expect(
            workspace().blocks.find((panel) => panel.id === 'depth-concurrent'),
        ).toBeDefined();
        expect(workspace().blocks[0]?.pin).toBe('2454');
        await expect(
            executeAgentAppCommand(
                {
                    name: 'set_panel_pin',
                    args: { id: 'watchlist-1', code: '2317' },
                },
                context,
            ),
        ).rejects.toMatchObject({ code: 'unsupported' });
        await expect(
            executeAgentAppCommand(
                {
                    name: 'set_panel_pin',
                    args: { id: 'chart-1', code: 'BAD' },
                },
                context,
            ),
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('applies an existing preset or profile by name', async () => {
        const { context, workspace, profileWorkspace } = fixture();
        const preset = LAYOUT_PRESETS[0];
        expect(preset).toBeDefined();
        await executeAgentAppCommand(
            {
                name: 'apply_layout',
                args: { source: 'preset', name: preset!.name },
            },
            context,
        );
        expect(workspace()).toEqual(preset!.workspace);
        expect(workspace()).not.toBe(preset!.workspace);

        await executeAgentAppCommand(
            {
                name: 'apply_layout',
                args: { source: 'profile', name: '我的版面' },
            },
            context,
        );
        expect(workspace()).toEqual(profileWorkspace);
        expect(workspace()).not.toBe(profileWorkspace);
        await expect(
            executeAgentAppCommand(
                {
                    name: 'apply_layout',
                    args: { source: 'profile', name: '不存在' },
                },
                context,
            ),
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('preserves the live Agent when the target already has another Agent', async () => {
        const live: Workspace = {
            blocks: [
                { id: 'assistant-live', type: 'assistant', pin: null },
                { id: 'chart-live', type: 'chart', pin: null },
            ],
            layout: [
                { i: 'assistant-live', x: 0, y: 0, w: 72, h: 14 },
                { i: 'chart-live', x: 72, y: 0, w: 96, h: 14 },
            ],
        };
        const target: Workspace = {
            blocks: [
                { id: 'assistant-saved', type: 'assistant', pin: null },
            ],
            layout: [
                { i: 'assistant-saved', x: 0, y: 0, w: 72, h: 14 },
            ],
        };
        const { context, workspace } = fixture({
            workspace: live,
            profileWorkspace: target,
        });

        await executeAgentAppCommand(
            {
                name: 'apply_layout',
                args: { source: 'profile', name: '我的版面' },
            },
            context,
        );

        expect(workspace().blocks.map((block) => block.id)).toEqual([
            'assistant-live',
        ]);
        expect(workspace().layout.map((item) => item.i)).toEqual([
            'assistant-live',
        ]);
        expect(workspace().layout[0]).toMatchObject({
            i: 'assistant-live',
            x: 0,
            y: 0,
            w: 72,
            h: 14,
        });
    });
});

describe('CustomEvent request/response transport', () => {
    it('deduplicates repeated in-flight and completed request ids', async () => {
        const target = new EventTarget();
        const { context, resolveContract } = fixture();
        const stop = registerAgentAppCommandHost(target, context);
        const request = {
            requestId: 'same-request',
            command: { name: 'select_contract' as const, args: { code: '2317' } },
        };
        const [first, second] = await Promise.all([
            requestAgentAppCommand(target, request),
            requestAgentAppCommand(target, request),
        ]);
        expect(first).toEqual(second);
        expect(first.ok).toBe(true);
        expect(resolveContract).toHaveBeenCalledTimes(1);

        const completed = await requestAgentAppCommand(target, request);
        expect(completed).toEqual(first);
        expect(resolveContract).toHaveBeenCalledTimes(1);
        stop();
    });

    it('never evicts completed mutations and bounds pending requests', async () => {
        const target = new EventTarget();
        const { context, resolveContract } = fixture();
        let release!: (value: ContractInfo) => void;
        resolveContract.mockImplementationOnce(
            () =>
                new Promise<ContractInfo>((resolve) => {
                    release = resolve;
                }),
        );
        const stop = registerAgentAppCommandHost(target, context, {
            cacheSize: 1,
        });
        const mutation = {
            requestId: 'retained-mutation',
            command: {
                name: 'select_contract' as const,
                args: { code: '2317' },
            },
        };
        const pending = requestAgentAppCommand(target, mutation);
        await Promise.resolve();
        await expect(
            requestAgentAppCommand(target, {
                requestId: 'over-capacity',
                command: { name: 'list_panels', args: {} },
            }),
        ).resolves.toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        release(contract('2317'));
        const first = await pending;
        await expect(requestAgentAppCommand(target, mutation)).resolves.toEqual(
            first,
        );
        expect(resolveContract).toHaveBeenCalledTimes(1);
        stop();
    });

    it('rejects reuse of a request id with a different payload', async () => {
        const target = new EventTarget();
        const { context } = fixture();
        const stop = registerAgentAppCommandHost(target, context);
        await requestAgentAppCommand(target, {
            requestId: 'reused',
            command: { name: 'list_panels', args: {} },
        });
        const response = await requestAgentAppCommand(target, {
            requestId: 'reused',
            command: { name: 'get_app_state', args: {} },
        });
        expect(response).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });
        stop();
    });

    it('returns a structured timeout and removes its response listener', async () => {
        const target = new EventTarget();
        const remove = vi.spyOn(target, 'removeEventListener');
        await expect(
            requestAgentAppCommand(
                target,
                {
                    requestId: 'timeout-1',
                    command: { name: 'list_panels', args: {} },
                },
                { timeoutMs: 5 },
            ),
        ).resolves.toMatchObject({
            ok: false,
            error: { code: 'timeout' },
        });
        expect(remove).toHaveBeenCalledWith(
            AGENT_APP_COMMAND_RESPONSE_EVENT,
            expect.any(Function),
        );
    });

    it('ignores a response for another command with the same request id', async () => {
        const target = new EventTarget();
        target.addEventListener(
            AGENT_APP_COMMAND_REQUEST_EVENT,
            (event) => {
                const request = (event as CustomEvent).detail as {
                    requestId: string;
                };
                target.dispatchEvent(
                    new CustomEvent(AGENT_APP_COMMAND_RESPONSE_EVENT, {
                        detail: {
                            requestId: request.requestId,
                            command: 'get_app_state',
                            ok: true,
                            result: {},
                        },
                    }),
                );
                target.dispatchEvent(
                    new CustomEvent(AGENT_APP_COMMAND_RESPONSE_EVENT, {
                        detail: {
                            requestId: request.requestId,
                            command: 'list_panels',
                            ok: true,
                            result: { panels: [] },
                        },
                    }),
                );
            },
            { once: true },
        );
        await expect(
            requestAgentAppCommand(target, {
                requestId: 'matched-command',
                command: { name: 'list_panels', args: {} },
            }),
        ).resolves.toMatchObject({
            ok: true,
            command: 'list_panels',
            result: { panels: [] },
        });
    });

    it('returns structured validation failures from malformed events', async () => {
        const target = new EventTarget();
        const { context } = fixture();
        const stop = registerAgentAppCommandHost(target, context);
        const response = new Promise<AgentAppCommandResponse>((resolve) => {
            target.addEventListener(
                AGENT_APP_COMMAND_RESPONSE_EVENT,
                (event) => resolve((event as CustomEvent).detail),
                { once: true },
            );
        });
        target.dispatchEvent(
            new CustomEvent(AGENT_APP_COMMAND_REQUEST_EVENT, {
                detail: {
                    requestId: 'invalid-1',
                    command: { name: 'add_panel', args: { type: 'browser' } },
                },
            }),
        );
        await expect(response).resolves.toMatchObject({
            requestId: 'invalid-1',
            ok: false,
            error: { code: 'invalid_arguments' },
        });
        stop();
    });
});
