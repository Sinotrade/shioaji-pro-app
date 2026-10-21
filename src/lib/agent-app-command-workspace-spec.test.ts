import { describe, expect, it, vi } from 'vitest';

import {
    AgentAppCommandError,
    executeAgentAppCommand,
    parseAgentAppCommandRequest,
    registerAgentAppCommandHost,
    requestAgentAppCommand,
    type AgentAppCommandContext,
} from './agent-app-command';
import type { AgentAppCommand } from './agent-contract';
import type { ContractInfo } from './types/contract';
import type { BlockType, Workspace } from './workspace';
import { WorkspaceUndoHistory } from './workspace-history';
import type { WorkspaceSpecV1 } from './workspace-spec';

const contract = (code: string) =>
    ({ code, name: `Name ${code}`, security_type: 'STK' }) as ContractInfo;

function fixture() {
    let workspace: Workspace = {
        blocks: [
            { id: 'agent', type: 'assistant', pin: null },
            { id: 'chart-1', type: 'chart', pin: null, chartInterval: '60m' },
            {
                id: 'flash-1',
                type: 'flash',
                pin: null,
                flashAccounts: { S: 'S:9A95:0123456' } as never,
            },
        ],
        layout: [
            { i: 'agent', x: 0, y: 0, w: 72, h: 14, minW: 60, minH: 9 },
            { i: 'chart-1', x: 72, y: 0, w: 144, h: 14, minW: 72, minH: 7 },
            { i: 'flash-1', x: 216, y: 0, w: 72, h: 14, minW: 48, minH: 8 },
        ],
    };
    const history = new WorkspaceUndoHistory();
    const events: string[] = [];
    const resolveContract = vi.fn(async (code: string) => {
        if (code === 'BAD') throw new Error('not found');
        return contract(code);
    });
    const context: AgentAppCommandContext = {
        getWorkspace: () => workspace,
        getProfiles: () => [],
        getSelectedContract: () => null,
        getPresetNames: () => [],
        getPreset: () => undefined,
        resolveContract,
        selectContract: () => {},
        updateWorkspace: (next) => {
            workspace = next;
        },
        createPanelId: (type: BlockType) => `${type}-new`,
        workspaceHistory: history,
        getViewportRows: () => 24,
        onWorkspaceSpecChange: ({ kind, entry }) => events.push(`${kind}:${entry.label}`),
    };
    const run = <C extends AgentAppCommand>(command: C) =>
        executeAgentAppCommand(command, context) as Promise<any>;
    return {
        context,
        history,
        events,
        run,
        workspace: () => workspace,
        setWorkspace: (next: Workspace) => {
            workspace = next;
        },
    };
}

const research = (): WorkspaceSpecV1 => ({
    version: 1,
    columns: 24,
    panels: [
        { id: 'watch', type: 'watchlist', x: 0, y: 0, w: 6, h: 14 },
        { id: 'chart-1', type: 'chart', x: 6, y: 0, w: 12, h: 14, settings: { interval: '1D' } },
        { id: 'depth', type: 'depth', x: 18, y: 0, w: 6, h: 8, pin: '2330' },
        { id: 'tape', type: 'tape', x: 18, y: 8, w: 6, h: 6 },
        { id: 'agent', type: 'assistant', x: 0, y: 14, w: 6, h: 10 },
    ],
});

describe('workspace spec commands', () => {
    it('get returns the spec, schema, catalog, viewport and no undo', async () => {
        const { run } = fixture();
        const result = await run({ name: 'get_workspace_spec', args: {} });
        expect(result.schema).toContain('workspace-spec-v1');
        expect(result.spec.columns).toBe(24);
        expect(result.spec.panels[1]).toMatchObject({ id: 'chart-1', settings: { interval: '60m' } });
        expect(JSON.stringify(result)).not.toContain('0123456');
        expect(result.viewport).toEqual({ rows: 24 });
        expect(result.panelTypes.chart).toMatchObject({ min_w: 6, min_h: 7, settings: { interval: { default: '5m' } } });
        expect(result.undo).toBeNull();
        const fine = await run({ name: 'get_workspace_spec', args: { columns: 288 } });
        expect(fine.spec.panels[1]).toMatchObject({ x: 72, w: 144 });
        expect(fine.panelTypes.chart.min_w).toBe(72);
    });

    it('validate reports errors without a token, and a diff + token when valid', async () => {
        const { run, workspace } = fixture();
        const bad = research();
        bad.panels[2]!.pin = 'BAD';
        bad.panels[3]!.h = 2;
        const invalid = await run({ name: 'validate_workspace_spec', args: { spec: bad } });
        expect(invalid).toMatchObject({ valid: false, validationToken: null, diff: null });
        expect(invalid.errors.map((e: any) => e.path)).toEqual(['panels[3].h']);
        bad.panels[3]!.h = 6;
        const unresolved = await run({ name: 'validate_workspace_spec', args: { spec: bad } });
        expect(unresolved.errors).toEqual([
            { path: 'panels[2].pin', code: 'contract_not_found', message: 'contract BAD was not found' },
        ]);
        const ok = await run({ name: 'validate_workspace_spec', args: { spec: research() } });
        expect(ok.valid).toBe(true);
        expect(ok.validationToken).toMatch(/^[0-9a-f]{16}$/);
        expect(ok.diff).toMatchObject({
            added: [
                { id: 'watch', type: 'watchlist' },
                { id: 'depth', type: 'depth' },
                { id: 'tape', type: 'tape' },
            ],
            removed: [{ id: 'flash-1', type: 'flash' }],
            destructive: true,
        });
        expect(ok.resultSpec.panels.find((p: any) => p.id === 'agent')).toMatchObject({ y: 14 });
        // validation never mutates
        expect(workspace().blocks.map((b) => b.id)).toEqual(['agent', 'chart-1', 'flash-1']);
    });

    it('apply requires the token from validating the same spec on the same workspace', async () => {
        const { run, setWorkspace, workspace } = fixture();
        await expect(
            run({ name: 'apply_workspace_spec', args: { spec: research() } } as never),
        ).rejects.toMatchObject({ code: 'invalid_arguments' });
        const { validationToken } = await run({ name: 'validate_workspace_spec', args: { spec: research() } });
        const changed = research();
        changed.panels[1]!.settings = { interval: '1m' };
        await expect(
            run({ name: 'apply_workspace_spec', args: { spec: changed, validationToken } }),
        ).rejects.toMatchObject({ code: 'conflict' });
        // the user edits the layout after validation
        const edited = structuredClone(workspace());
        edited.layout[1]!.h = 20;
        setWorkspace(edited);
        await expect(
            run({ name: 'apply_workspace_spec', args: { spec: research(), validationToken } }),
        ).rejects.toBeInstanceOf(AgentAppCommandError);
        expect(workspace()).toBe(edited);
    });

    it('apply is atomic, keeps hidden panel state, and creates one undo step', async () => {
        const { run, workspace, history, events } = fixture();
        const before = structuredClone(workspace());
        const spec = research();
        spec.panels.push({ id: 'flash-1', type: 'flash', x: 6, y: 14, w: 6, h: 10, pin: 'TXFR1' });
        const { validationToken } = await run({ name: 'validate_workspace_spec', args: { spec } });
        const applied = await run({
            name: 'apply_workspace_spec',
            args: { spec, validationToken, label: '處置股研究' },
        });
        expect(applied.applied).toBe(true);
        expect(applied.undo.label).toBe('處置股研究');
        expect(applied.spec.panels.map((p: any) => p.id)).toEqual(['watch', 'chart-1', 'depth', 'tape', 'agent', 'flash-1']);
        const flash = workspace().blocks.find((b) => b.id === 'flash-1')!;
        expect(flash.flashAccounts).toEqual({ S: 'S:9A95:0123456' });
        expect(workspace().blocks.find((b) => b.id === 'chart-1')!.chartInterval).toBe('1D');
        expect(events).toEqual(['applied:處置股研究']);
        expect(history.peek(workspace())?.id).toBe(applied.undo.undoId);
        const read = await run({ name: 'get_workspace_spec', args: {} });
        expect(read.spec).toEqual(applied.spec);
        expect(read.undo.undoId).toBe(applied.undo.undoId);

        const undone = await run({ name: 'undo_workspace_change', args: { undoId: applied.undo.undoId } });
        expect(undone).toMatchObject({ undone: true, label: '處置股研究' });
        expect(workspace()).toEqual(before);
        expect(events).toEqual(['applied:處置股研究', 'undone:處置股研究']);
        await expect(
            run({ name: 'undo_workspace_change', args: {} }),
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('refuses to undo once panels were added or another layout loaded', async () => {
        const { run, workspace, setWorkspace } = fixture();
        const { validationToken } = await run({ name: 'validate_workspace_spec', args: { spec: research() } });
        const applied = await run({ name: 'apply_workspace_spec', args: { spec: research(), validationToken } });
        await run({ name: 'add_panel', args: { type: 'intraday' } });
        await expect(
            run({ name: 'undo_workspace_change', args: {} }),
        ).rejects.toMatchObject({ code: 'conflict' });
        const grown = workspace();
        setWorkspace({
            ...grown,
            blocks: grown.blocks.filter((b) => b.type !== 'intraday'),
            layout: grown.layout.filter((l) => !l.i.startsWith('intraday')),
        });
        await expect(
            run({ name: 'undo_workspace_change', args: { undoId: 'other-id' } }),
        ).rejects.toMatchObject({ code: 'conflict' });
        await expect(
            run({ name: 'undo_workspace_change', args: { undoId: applied.undo.undoId } }),
        ).resolves.toMatchObject({ undone: true });
    });

    it('is unsupported without a workspace history', async () => {
        const { context } = fixture();
        const bare = { ...context, workspaceHistory: undefined };
        await expect(
            executeAgentAppCommand({ name: 'get_workspace_spec', args: {} }, bare),
        ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('parses arguments strictly', () => {
        const parse = (name: string, args: unknown) =>
            parseAgentAppCommandRequest({ requestId: 'r1', command: { name, args } });
        expect(() => parse('get_workspace_spec', { columns: 12 })).toThrow('columns');
        expect(() => parse('validate_workspace_spec', {})).toThrow();
        expect(() => parse('apply_workspace_spec', { spec: {}, validationToken: 'nope' })).toThrow('validate_workspace_spec');
        expect(() => parse('undo_workspace_change', { undoId: '' })).toThrow();
        expect(parse('apply_workspace_spec', { spec: {}, validationToken: '0123456789abcdef', label: ' x ' }).command.args)
            .toEqual({ spec: {}, validationToken: '0123456789abcdef', label: 'x' });
    });

    it('treats get/validate as evictable reads and keeps apply replays idempotent', async () => {
        const { context, workspace } = fixture();
        const target = new EventTarget();
        const off = registerAgentAppCommandHost(target, context);
        try {
            const validated = await requestAgentAppCommand(target, {
                requestId: 'v1',
                command: { name: 'validate_workspace_spec', args: { spec: research() } },
            });
            expect(validated.ok).toBe(true);
            const token = validated.ok ? (validated.result as any).validationToken : '';
            const request = {
                requestId: 'a1',
                command: { name: 'apply_workspace_spec' as const, args: { spec: research(), validationToken: token } },
            };
            const first = await requestAgentAppCommand(target, request);
            const replay = await requestAgentAppCommand(target, request);
            expect(first.ok).toBe(true);
            expect(replay).toEqual(first);
            expect(workspace().blocks.map((b) => b.id)).toContain('watch');
        } finally {
            off();
        }
    });
});
