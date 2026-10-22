import { describe, expect, it } from 'vitest';
import specSchema from '../../schemas/workspace-spec-v1.schema.json';
import {
    BLOCK_META,
    CHART_INTERVALS,
    DEFAULT_WORKSPACE,
    LAYOUT_PRESETS,
    type Workspace,
} from './workspace';
import {
    buildWorkspaceFromSpec,
    checkWorkspaceSpec,
    compactVertical,
    resolveWorkspaceSpecContracts,
    WORKSPACE_SPEC_SCHEMA_ID,
    WORKSPACE_SPEC_SETTINGS,
    WORKSPACE_SPEC_VERSION,
    workspaceContentRevision,
    workspaceRevision,
    workspaceToSpec,
    type WorkspaceSpecV1,
} from './workspace-spec';

const base = (): Workspace => ({
    blocks: [
        { id: 'watch', type: 'watchlist', pin: null },
        {
            id: 'chart',
            type: 'chart',
            pin: null,
            chartInterval: '1D',
            chartOhlc: false,
            chartOrder: { STK: { qty: 3 } } as never,
        },
        {
            id: 'flash',
            type: 'flash',
            pin: null,
            linkGroup: 'A',
            flashAccounts: { S: 'S:9A95:0123456' } as never,
            flashQty: { lot: 7 } as never,
        },
        { id: 'agent', type: 'assistant', pin: null },
    ],
    layout: [
        { i: 'watch', x: 0, y: 0, w: 48, h: 14, minW: 36, minH: 6 },
        { i: 'chart', x: 48, y: 0, w: 120, h: 14, minW: 72, minH: 7 },
        { i: 'flash', x: 168, y: 0, w: 60, h: 14, minW: 48, minH: 8 },
        { i: 'agent', x: 228, y: 0, w: 60, h: 14, minW: 60, minH: 9 },
    ],
    linkGroups: { A: '2330' },
});

function valid(spec: unknown, ws: Workspace = base(), rows?: number) {
    const check = checkWorkspaceSpec(spec, ws, { viewportRows: rows });
    if (!check.valid) throw new Error(JSON.stringify(check.errors));
    return check;
}

function errorsOf(spec: unknown, ws: Workspace = base()) {
    const check = checkWorkspaceSpec(spec, ws);
    expect(check.valid).toBe(false);
    return check.errors.map((e) => [e.path, e.code]);
}

describe('workspaceToSpec', () => {
    it('reads presets on the 24-column grid with defaults omitted', () => {
        const spec = workspaceToSpec(DEFAULT_WORKSPACE);
        expect(spec.version).toBe(1);
        expect(spec.columns).toBe(24);
        expect(spec.panels[0]).toEqual({
            id: 'watchlist-0',
            type: 'watchlist',
            x: 0,
            y: 0,
            w: 4,
            h: 14,
            pin: null,
        });
    });

    it('falls back to 288 columns when a panel is off the coarse grid', () => {
        const ws = base();
        ws.layout[0] = { ...ws.layout[0]!, w: 50 };
        ws.layout[1] = { ...ws.layout[1]!, x: 50, w: 118 };
        expect(workspaceToSpec(ws).columns).toBe(288);
    });

    it('never exposes account keys, quantities or order settings', () => {
        const spec = workspaceToSpec(base());
        const text = JSON.stringify(spec);
        expect(text).not.toContain('0123456');
        expect(text).not.toContain('9A95');
        expect(text).not.toMatch(/qty|lot|flashAccounts|chartOrder/);
        expect(spec.panels.find((p) => p.id === 'chart')?.settings).toEqual({
            interval: '1D',
            ohlc: false,
        });
        expect(spec.panels.find((p) => p.id === 'flash')).toMatchObject({
            link_group: 'A',
        });
        expect(spec.link_groups).toEqual({ A: '2330' });
    });

    it('round-trips every built-in preset without changes', () => {
        for (const preset of LAYOUT_PRESETS) {
            const ws = structuredClone(preset.workspace);
            const check = valid(workspaceToSpec(ws), ws);
            expect(check.diff.removed).toEqual([]);
            expect(check.diff.added).toEqual([]);
            expect(check.diff.settings_changed).toEqual([]);
            expect(check.diff.relinked).toEqual([]);
        }
    });
});

describe('panel view settings (產業鏈資金流向／持股族群)', () => {
    const empty: Workspace = { blocks: [], layout: [] };
    const settingFields = Object.values(WORKSPACE_SPEC_SETTINGS).flatMap((defs) =>
        Object.values(defs ?? {}).map((def) => def.field),
    );

    it('rebuilding any built-in preset from its spec keeps every panel setting', () => {
        for (const preset of LAYOUT_PRESETS) {
            // validated against the live preset (some legacy presets sit below today's minimum sizes), rebuilt with no prior panels
            const rebuilt = buildWorkspaceFromSpec(empty, valid(workspaceToSpec(preset.workspace), preset.workspace).normalized);
            for (const block of preset.workspace.blocks) {
                const got = rebuilt.blocks.find((b) => b.id === block.id)!;
                for (const field of settingFields) {
                    expect(got[field], `${preset.name} ${block.id}.${field}`).toEqual(block[field]);
                }
            }
        }
    });

    it('an Agent can set and clear a chain panel view; absent follows the last choice', () => {
        const ws: Workspace = {
            blocks: [{ id: 'c', type: 'chainmap', pin: null, chainView: 'heat', chainKind: 'theme' }],
            layout: [{ i: 'c', x: 0, y: 0, w: 168, h: 14 }],
        };
        const spec = workspaceToSpec(ws);
        expect(spec.panels[0]!.settings).toEqual({ view: 'heat', kind: 'theme' });
        spec.panels[0]!.settings = { view: 'rotation' };
        const next = buildWorkspaceFromSpec(ws, valid(spec, ws).normalized);
        expect(next.blocks[0]).toMatchObject({ chainView: 'rotation' });
        expect(next.blocks[0]!.chainKind).toBeUndefined();
        spec.panels[0]!.settings = { view: 'holdings' };
        expect(checkWorkspaceSpec(spec, ws).valid).toBe(false);
    });

    it('holding panels accept 呈現 and 分組 and reject them on other panels', () => {
        const ws: Workspace = {
            blocks: [{ id: 'h', type: 'holdingmap', pin: null }],
            layout: [{ i: 'h', x: 0, y: 0, w: 120, h: 14 }],
        };
        const spec = workspaceToSpec(ws);
        spec.panels[0]!.settings = { form: 'lanes', grouping: 'chain' };
        expect(buildWorkspaceFromSpec(ws, valid(spec, ws).normalized).blocks[0]).toMatchObject({
            holdingForm: 'lanes',
            holdingGrouping: 'chain',
        });
        spec.panels[0]!.settings = { view: 'rank' };
        expect(checkWorkspaceSpec(spec, ws).valid).toBe(false);
    });
});

describe('checkWorkspaceSpec', () => {
    const ok = (): WorkspaceSpecV1 => workspaceToSpec(base());

    it('accepts the read-back spec with an empty diff', () => {
        const check = valid(ok());
        expect(check.diff).toMatchObject({
            added: [],
            removed: [],
            moved: [],
            resized: [],
            destructive: false,
        });
        expect(check.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('reports precise paths for structural errors', () => {
        expect(errorsOf(null)).toEqual([['$', 'invalid_type']]);
        expect(errorsOf({ ...ok(), version: 2 })).toEqual([['version', 'unsupported_version']]);
        expect(errorsOf({ ...ok(), columns: 12 })).toEqual([['columns', 'invalid_value']]);
        expect(errorsOf({ ...ok(), extra: 1 })).toEqual([['extra', 'unknown_field']]);
        expect(errorsOf({ ...ok(), panels: [] })).toContainEqual(['panels', 'empty']);
    });

    it('checks every panel field', () => {
        const spec = ok();
        spec.panels[0] = { ...spec.panels[0]!, w: 2, foo: 1 } as never;
        spec.panels[1] = { ...spec.panels[1]!, type: 'depth', settings: undefined };
        spec.panels[2] = { ...spec.panels[2]!, x: 20, w: 5 };
        expect(errorsOf(spec)).toEqual([
            ['panels[0].foo', 'unknown_field'],
            ['panels[0].w', 'below_min_size'],
            ['panels[1].type', 'type_changed'],
            ['panels[2].w', 'out_of_bounds'],
        ]);
    });

    it('names the minimum size in the message', () => {
        const spec = ok();
        spec.panels[0] = { ...spec.panels[0]!, h: 3 };
        const check = checkWorkspaceSpec(spec, base());
        expect(check.errors[0]!.message).toContain('minimum 6');
        expect(check.errors[0]!.message).toContain('自選清單');
    });

    it('rejects duplicates, singletons, bad pins, link groups and settings', () => {
        const spec = ok();
        spec.panels.push({ id: 'watch', type: 'watchlist', x: 0, y: 14, w: 4, h: 6 });
        spec.panels.push({ id: 'watch2', type: 'watchlist', x: 4, y: 14, w: 4, h: 6 });
        spec.panels.push({ id: 'movers', type: 'movers', x: 8, y: 14, w: 4, h: 6, pin: '2330' });
        spec.panels.push({ id: 'depth', type: 'depth', x: 12, y: 14, w: 4, h: 7, link_group: 'B' });
        spec.panels.push({ id: 'chart2', type: 'chart', x: 16, y: 14, w: 8, h: 7, settings: { interval: '2h', zoom: 3 } as never });
        expect(errorsOf(spec)).toEqual([
            ['panels[4].id', 'duplicate_id'],
            ['panels[4].type', 'singleton'],
            ['panels[5].type', 'singleton'],
            ['panels[6].pin', 'not_pinnable'],
            ['panels[7].link_group', 'not_supported'],
            ['panels[8].settings.interval', 'invalid_value'],
            ['panels[8].settings.zoom', 'unknown_setting'],
        ]);
    });

    it('rejects pin together with link_group', () => {
        const spec = ok();
        spec.panels[2] = { ...spec.panels[2]!, pin: 'TXFR1', link_group: 'A' };
        expect(errorsOf(spec)).toEqual([['panels[2].link_group', 'conflict']]);
    });

    it('requires the live AI Agent panel', () => {
        const spec = ok();
        spec.panels = spec.panels.filter((p) => p.type !== 'assistant');
        expect(errorsOf(spec)).toEqual([['panels', 'assistant_required']]);
    });

    it('rejects overlapping panels', () => {
        const spec = ok();
        spec.panels[1] = { ...spec.panels[1]!, x: 2 };
        spec.panels[1]!.w = 10;
        expect(errorsOf(spec)).toContainEqual(['panels[1]', 'overlap']);
    });

    it('warns about compaction, viewport overflow and removals', () => {
        const spec = ok();
        spec.panels = spec.panels.filter((p) => p.id !== 'watch');
        spec.panels.push({ id: 'tape-new', type: 'tape', x: 0, y: 30, w: 4, h: 30 });
        const check = valid(spec, base(), 20);
        const codes = check.warnings.map((w) => w.code);
        expect(codes).toEqual(['compacted', 'exceeds_viewport', 'removes_panels']);
        expect(check.normalized.panels.find((p) => p.id === 'tape-new')?.y).toBe(0);
        expect(check.diff.removed).toEqual([{ id: 'watch', type: 'watchlist' }]);
        expect(check.diff.added).toEqual([{ id: 'tape-new', type: 'tape' }]);
        expect(check.diff.destructive).toBe(true);
    });

    it('fingerprint follows the normalized spec only', () => {
        const spec = ok();
        const a = valid(spec).fingerprint;
        const changed = structuredClone(spec);
        changed.panels[1]!.settings = { interval: '1m' };
        expect(valid(changed).fingerprint).not.toBe(a);
        // same normalized result (default setting written explicitly) → same fingerprint
        const explicit = structuredClone(spec);
        explicit.panels[0]!.settings = undefined;
        expect(valid(explicit).fingerprint).toBe(a);
    });

    it('returns a precise error for prototype-named settings instead of throwing', () => {
        const spec = ok();
        spec.panels[1]!.settings = JSON.parse('{"constructor":true,"__proto__":{"x":1}}');
        expect(errorsOf(spec)).toEqual([
            ['panels[1].settings.constructor', 'unknown_setting'],
            ['panels[1].settings.__proto__', 'unknown_setting'],
        ]);
    });

    it('rejects edges that disagree at the render density (#331 review)', () => {
        const spec = {
            version: 1,
            columns: 288,
            panels: [
                { id: 'a', type: 'chart', x: 0, y: 0, w: 73, h: 7 },
                { id: 'b', type: 'chart', x: 72, y: 7, w: 72, h: 7 },
            ],
        };
        const empty: Workspace = { blocks: [], layout: [] };
        // stored grid: a [0,73) and b [72,144) share a column so b stays below a
        const exact = checkWorkspaceSpec(spec, empty);
        if (!exact.valid) throw new Error('expected valid');
        expect(exact.normalized.panels.map((p) => p.y)).toEqual([0, 7]);
        // at 24 columns a ends where b starts: the screen would pack b to the top
        const coarse = checkWorkspaceSpec(spec, empty, { density: 1 });
        expect(coarse.valid).toBe(false);
        expect(coarse.errors.map((e) => [e.path, e.code])).toEqual([['panels[1].x', 'misaligned']]);
        // the same pair untouched on screen is exempt from the edge check, but
        // packing would still move B into A's stored columns: rejected
        const live: Workspace = {
            blocks: [{ id: 'a', type: 'chart', pin: null }, { id: 'b', type: 'chart', pin: null }],
            layout: spec.panels.map((p) => ({ i: p.id, x: p.x, y: p.y, w: p.w, h: p.h })),
        };
        expect(checkWorkspaceSpec(spec, live, { density: 1 }).errors.map((e) => e.code)).toEqual(['misaligned']);
        // review case: A (0,0,75,7), C (132,0,72,7), B (72,7,72,7) kept as-is
        const three = {
            version: 1,
            columns: 288,
            panels: [
                { id: 'a', type: 'chart', x: 0, y: 0, w: 75, h: 7 },
                { id: 'c', type: 'chart', x: 132, y: 0, w: 72, h: 7 },
                { id: 'b', type: 'chart', x: 72, y: 7, w: 72, h: 7, settings: { interval: '1D' } },
            ],
        };
        const liveThree: Workspace = {
            blocks: three.panels.map((p) => ({ id: p.id, type: 'chart' as const, pin: null })),
            layout: three.panels.map((p) => ({ i: p.id, x: p.x, y: p.y, w: p.w, h: p.h })),
        };
        expect(checkWorkspaceSpec(three, liveThree, { density: 1 }).valid).toBe(true);
        // removing C would let B rise into A's stored columns: rejected
        const withoutC = { ...three, panels: three.panels.filter((p) => p.id !== 'c') };
        const blocked = checkWorkspaceSpec(withoutC, liveThree, { density: 1 });
        expect(blocked.valid).toBe(false);
        expect(blocked.errors.map((e) => [e.path, e.code])).toEqual([['panels[1].x', 'misaligned']]);
        // aligned edges are fine at every density, and the read-back validates again
        spec.panels[0]!.w = 72;
        for (const density of [1, 2, 3, 4]) {
            const check = checkWorkspaceSpec(spec, empty, { density });
            if (!check.valid) throw new Error(JSON.stringify(check.errors));
            expect(check.normalized.panels.map((p) => p.y)).toEqual([0, 0]);
            const read = workspaceToSpec(buildWorkspaceFromSpec(empty, check.normalized));
            expect(checkWorkspaceSpec(read, empty, { density }).valid).toBe(true);
        }
    });
});

describe('workspace revisions', () => {
    it('workspaceRevision covers hidden fields and geometry but not grid metadata', () => {
        const a = workspaceRevision(base());
        const hidden = base();
        (hidden.blocks[2] as { flashQty?: unknown }).flashQty = { lot: 99 };
        expect(workspaceRevision(hidden)).not.toBe(a);
        const moved = base();
        moved.layout[0] = { ...moved.layout[0]!, h: 20 };
        expect(workspaceRevision(moved)).not.toBe(a);
        const meta = base();
        meta.layout[0] = { ...meta.layout[0]!, minH: 2, moved: false } as never;
        expect(workspaceRevision(meta)).toBe(a);
    });

    it('workspaceContentRevision ignores geometry', () => {
        const moved = base();
        moved.layout[0] = { ...moved.layout[0]!, h: 20 };
        expect(workspaceContentRevision(moved)).toBe(workspaceContentRevision(base()));
        const pinned = base();
        pinned.blocks[1] = { ...pinned.blocks[1]!, pin: '2330' };
        expect(workspaceContentRevision(pinned)).not.toBe(workspaceContentRevision(base()));
    });
});

describe('buildWorkspaceFromSpec', () => {
    it('builds the issue #331 research layout (25% / 50% / 25%)', () => {
        const spec: WorkspaceSpecV1 = {
            version: 1,
            columns: 24,
            panels: [
                { id: 'agent', type: 'assistant', x: 0, y: 14, w: 6, h: 10 },
                { id: 'watch', type: 'watchlist', x: 0, y: 0, w: 6, h: 14 },
                { id: 'intra-r', type: 'intraday', x: 6, y: 0, w: 12, h: 10, settings: { session: 'day' } },
                { id: 'chart', type: 'chart', x: 6, y: 10, w: 12, h: 14, settings: { interval: '1D' } },
                { id: 'depth-r', type: 'depth', x: 18, y: 0, w: 6, h: 10 },
                { id: 'tape-r', type: 'tape', x: 18, y: 10, w: 6, h: 14 },
            ],
        };
        const check = valid(spec);
        const next = buildWorkspaceFromSpec(base(), check.normalized);
        expect(next.layout.find((l) => l.i === 'chart')).toEqual({
            i: 'chart', x: 72, y: 10, w: 144, h: 14, minW: 72, minH: 7,
        });
        const chart = next.blocks.find((b) => b.id === 'chart')!;
        // kept panel: spec-owned fields replaced, hidden settings preserved
        expect(chart.chartInterval).toBe('1D');
        expect(chart.chartOhlc).toBeUndefined();
        expect(chart.chartOrder).toEqual({ STK: { qty: 3 } });
        expect(next.blocks.find((b) => b.id === 'intra-r')).toEqual({
            id: 'intra-r', type: 'intraday', pin: null, intradaySession: 'day',
        });
        expect(next.blocks.some((b) => b.id === 'flash')).toBe(false);
        expect(next.linkGroups).toBeUndefined();
        expect(workspaceToSpec(next)).toEqual({
            ...spec,
            panels: spec.panels.map((p) => ({ pin: null, ...p })),
        });
    });

    it('keeps flash account keys when the flash panel is kept', () => {
        const spec = workspaceToSpec(base());
        spec.panels[2] = { ...spec.panels[2]!, link_group: undefined, pin: 'TXFR1' };
        delete spec.panels[2]!.link_group;
        const next = buildWorkspaceFromSpec(base(), valid(spec).normalized);
        const flash = next.blocks.find((b) => b.id === 'flash')!;
        expect(flash.flashAccounts).toEqual({ S: 'S:9A95:0123456' });
        expect(flash.pin).toBe('TXFR1');
        expect(flash.linkGroup).toBeUndefined();
    });

    it('stores a default setting as absent', () => {
        const spec = workspaceToSpec(base());
        spec.panels[1]!.settings = { interval: '5m', ohlc: true };
        const next = buildWorkspaceFromSpec(base(), valid(spec).normalized);
        const chart = next.blocks.find((b) => b.id === 'chart')!;
        expect('chartInterval' in chart).toBe(false);
        expect('chartOhlc' in chart).toBe(false);
    });
});

describe('resolveWorkspaceSpecContracts', () => {
    it('canonicalizes codes and reports unknown ones with paths', async () => {
        const spec = workspaceToSpec(base());
        spec.panels[1]!.pin = 'txfr1';
        spec.panels[2] = { ...spec.panels[2]! };
        spec.link_groups = { A: 'BAD' };
        const out = await resolveWorkspaceSpecContracts(spec, async (code) => {
            if (code === 'BAD') throw new Error('nope');
            return { code: code === 'TXFR1' ? 'TXFR1' : code };
        });
        expect((out.spec as WorkspaceSpecV1).panels[1]!.pin).toBe('TXFR1');
        expect(out.errors).toEqual([
            { path: 'link_groups.A', code: 'contract_not_found', message: 'contract BAD was not found' },
        ]);
    });
});

describe('compactVertical', () => {
    it('packs panels upward like react-grid-layout', () => {
        const out = compactVertical([
            { id: 'a', x: 0, y: 5, w: 10, h: 4 },
            { id: 'b', x: 0, y: 20, w: 5, h: 2 },
            { id: 'c', x: 10, y: 3, w: 4, h: 2 },
        ]);
        expect(out.map((r) => [r.id, r.y])).toEqual([['a', 0], ['b', 4], ['c', 0]]);
    });
});

describe('workspace spec JSON schema', () => {
    it('stays in sync with the TypeScript validator', () => {
        expect(specSchema.$id).toBe(WORKSPACE_SPEC_SCHEMA_ID);
        expect(specSchema.properties.version.const).toBe(WORKSPACE_SPEC_VERSION);
        expect(specSchema.properties.columns.enum).toEqual([24, 288]);
        expect(specSchema.$defs.panel.properties.type.enum).toEqual(Object.keys(BLOCK_META));
        expect(specSchema.$defs.chartSettings.properties.interval.enum).toEqual([...CHART_INTERVALS]);
        expect(Object.keys(specSchema.$defs.chartSettings.properties)).toEqual(
            Object.keys(WORKSPACE_SPEC_SETTINGS.chart!),
        );
        expect(Object.keys(specSchema.$defs.intradaySettings.properties)).toEqual(
            Object.keys(WORKSPACE_SPEC_SETTINGS.intraday!),
        );
        expect(Object.keys(specSchema.$defs.chainmapSettings.properties)).toEqual(
            Object.keys(WORKSPACE_SPEC_SETTINGS.chainmap!),
        );
        expect(Object.keys(specSchema.$defs.holdingmapSettings.properties)).toEqual(
            Object.keys(WORKSPACE_SPEC_SETTINGS.holdingmap!),
        );
        for (const [type, defs] of [['chainmap', specSchema.$defs.chainmapSettings], ['holdingmap', specSchema.$defs.holdingmapSettings]] as const) {
            for (const [key, def] of Object.entries(WORKSPACE_SPEC_SETTINGS[type]!)) {
                expect((defs.properties as Record<string, { enum: unknown[] }>)[key]!.enum, `${type}.${key}`).toEqual([...def.values]);
            }
        }
        expect(Object.keys(WORKSPACE_SPEC_SETTINGS)).toEqual(['chart', 'intraday', 'chainmap', 'holdingmap']);
    });
});
