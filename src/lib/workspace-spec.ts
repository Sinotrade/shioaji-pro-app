// src/lib/workspace-spec.ts — versioned, Agent-facing workspace description
// (#331 phase 1).
//
// A WorkspaceSpec is the whole visible layout as plain JSON: panel ids, types,
// grid rectangles, link/pin state and a whitelisted set of per-panel display
// settings. It deliberately carries NO account keys, quantities, order
// settings or any other money/identity data — those per-panel fields stay in
// the stored Workspace and are carried over untouched for panels the spec
// keeps by id.
//
// Flow: get (read back) → validate (precise errors, diff, token) → apply
// (requires the token from a validation of the same spec against the same
// workspace; atomic; one undo step).

import type { LayoutItem } from 'react-grid-layout';
import { isLinkGroup, LINK_GROUPS, type LinkGroupId } from './flash-link';
import {
    BLOCK_META,
    CHAIN_KINDS,
    CHAIN_VIEWS,
    CHART_INTERVALS,
    DEFAULT_CHART_INTERVAL,
    GRID_COLS,
    GRID_LEGACY_COLS,
    GRID_LEGACY_SCALE,
    HOLDING_FORMS,
    HOLDING_GROUPINGS,
    toRenderGeom,
    type Block,
    type BlockType,
    type Workspace,
} from './workspace';

export const WORKSPACE_SPEC_VERSION = 1 as const;
export const WORKSPACE_SPEC_SCHEMA_ID =
    'https://github.com/Sinotrade/shioaji-pro-app/schemas/workspace-spec-v1.schema.json';
export const WORKSPACE_SPEC_COLUMNS = [GRID_LEGACY_COLS, GRID_COLS] as const;
export type WorkspaceSpecColumns = (typeof WORKSPACE_SPEC_COLUMNS)[number];
export const WORKSPACE_SPEC_MAX_PANELS = 40;
/** y + h may not exceed this many grid rows (30px each). */
export const WORKSPACE_SPEC_MAX_ROWS = 200;

const PANEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CONTRACT_CODE_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

// ---- per-panel settings whitelist ----

interface SettingDef {
    values: readonly (string | boolean)[];
    field: keyof Block;
    /** Value an absent setting means; none = absent follows the panel's last global choice, so every value is kept. */
    fallback?: string | boolean;
}

/**
 * Settings the spec can read and write, per panel type. Only settings whose
 * panels react to a changed stored value are listed (initial-only props such
 * as the intraday wall grid would not take effect on a kept panel).
 */
export const WORKSPACE_SPEC_SETTINGS: Partial<
    Record<BlockType, Record<string, SettingDef>>
> = {
    chart: {
        interval: {
            values: CHART_INTERVALS,
            field: 'chartInterval',
            fallback: DEFAULT_CHART_INTERVAL,
        },
        session: { values: ['all', 'day'], field: 'chartSession', fallback: 'all' },
        ohlc: { values: [true, false], field: 'chartOhlc', fallback: true },
        high_low: { values: [true, false], field: 'chartHighLow', fallback: true },
    },
    intraday: {
        session: {
            values: ['auto', 'day', 'night'],
            field: 'intradaySession',
            fallback: 'auto',
        },
    },
    chainmap: {
        view: { values: CHAIN_VIEWS, field: 'chainView' },
        kind: { values: CHAIN_KINDS, field: 'chainKind' },
    },
    holdingmap: {
        form: { values: HOLDING_FORMS, field: 'holdingForm' },
        grouping: { values: HOLDING_GROUPINGS, field: 'holdingGrouping' },
    },
};

// Block fields the spec fully owns: an applied spec replaces them (absent =
// default). Every other Block field survives on a kept panel id.
const SPEC_OWNED_FIELDS: readonly (keyof Block)[] = [
    'pin',
    'linkGroup',
    ...Object.values(WORKSPACE_SPEC_SETTINGS).flatMap((defs) =>
        Object.values(defs ?? {}).map((def) => def.field),
    ),
];

// ---- types ----

export type WorkspaceSpecSettings = Record<string, string | boolean>;

export interface WorkspaceSpecPanel {
    id: string;
    type: BlockType;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Contract code the panel is fixed to; null/absent = follows selection. */
    pin?: string | null;
    /** Flash panels only: shared link group A/B/C (requires pin null). */
    link_group?: LinkGroupId;
    settings?: WorkspaceSpecSettings;
}

export interface WorkspaceSpecV1 {
    version: typeof WORKSPACE_SPEC_VERSION;
    columns: WorkspaceSpecColumns;
    panels: WorkspaceSpecPanel[];
    link_groups?: Partial<Record<LinkGroupId, string>>;
}

export interface WorkspaceSpecIssue {
    path: string;
    code: string;
    message: string;
}

export interface WorkspaceSpecDiff {
    added: { id: string; type: BlockType }[];
    removed: { id: string; type: BlockType }[];
    moved: string[];
    resized: string[];
    relinked: string[];
    settings_changed: string[];
    link_groups_changed: boolean;
    destructive: boolean;
}

interface NormalizedPanel {
    id: string;
    type: BlockType;
    x: number;
    y: number;
    w: number;
    h: number;
    pin: string | null;
    linkGroup: LinkGroupId | null;
    settings: WorkspaceSpecSettings;
}

export interface NormalizedWorkspaceSpec {
    columns: WorkspaceSpecColumns;
    /** Rectangles in the stored 288-column grid, after vertical compaction. */
    panels: NormalizedPanel[];
    linkGroups: Partial<Record<LinkGroupId, string>>;
}

export type WorkspaceSpecCheck =
    | {
          valid: false;
          errors: WorkspaceSpecIssue[];
          warnings: WorkspaceSpecIssue[];
      }
    | {
          valid: true;
          errors: [];
          warnings: WorkspaceSpecIssue[];
          normalized: NormalizedWorkspaceSpec;
          diff: WorkspaceSpecDiff;
          /** Binds a validation token to exactly this normalized spec. */
          fingerprint: string;
      };

// ---- helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBlockType(value: unknown): value is BlockType {
    return (
        typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(BLOCK_META, value)
    );
}

export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// FNV-1a, two seeds → 64 bits of hex. A consistency check, not a secret.
function fnv1a(text: string, seed: number): string {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function hashText(text: string): string {
    return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x9e3779b9);
}

export const WORKSPACE_SPEC_TOKEN_PATTERN = /^[0-9a-f]{16}$/;

interface Rect {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Vertical compaction with the same rule react-grid-layout applies on render
 * (sort by row then column; each panel rises until it would collide), so the
 * layout the Agent reads back equals what the grid shows. Collisions are
 * tested on the columns the grid renders at `density` (see toRenderGeom):
 * panels a fraction of a column apart in the stored grid touch on screen.
 * The default density keeps the stored 288-column geometry.
 */
export function compactVertical<T extends Rect>(
    items: readonly T[],
    density: number = GRID_LEGACY_SCALE,
): T[] {
    const render = (r: Rect): Rect => ({ ...r, ...toRenderGeom(r, density) });
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const placed: { item: T; geom: Rect }[] = [];
    for (const item of sorted) {
        const next = { ...item };
        const geom = render(next);
        const collides = (y: number) =>
            placed.find((p) => overlaps(p.geom, { ...geom, y }));
        while (next.y > 0 && !collides(next.y - 1)) next.y -= 1;
        while (true) {
            const hit = collides(next.y);
            if (!hit) break;
            next.y = hit.item.y + hit.item.h;
        }
        placed.push({ item: next, geom: { ...geom, y: next.y } });
    }
    const byId = new Map(placed.map((p) => [p.item.id, p.item]));
    return items.map((item) => byId.get(item.id)!);
}

// ---- workspace → spec ----

function settingsOf(block: Block): WorkspaceSpecSettings | undefined {
    const defs = WORKSPACE_SPEC_SETTINGS[block.type];
    if (!defs) return undefined;
    const out: WorkspaceSpecSettings = {};
    for (const [key, def] of Object.entries(defs)) {
        const raw = block[def.field];
        if (raw === undefined) continue;
        if (!def.values.includes(raw as string | boolean)) continue;
        if (def.fallback !== undefined && raw === def.fallback) continue;
        out[key] = raw as string | boolean;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Read the live workspace as a spec. Uses 24 columns when every panel sits on
 * the 24-column grid (presets, Agent layouts), 288 otherwise so the read-back
 * is lossless. Never includes account, quantity or order settings.
 */
export function workspaceToSpec(
    workspace: Workspace,
    columns?: WorkspaceSpecColumns,
): WorkspaceSpecV1 {
    const layout = new Map(workspace.layout.map((item) => [item.i, item]));
    const cols: WorkspaceSpecColumns =
        columns ??
        (workspace.layout.every(
            (item) => item.x % GRID_LEGACY_SCALE === 0 && item.w % GRID_LEGACY_SCALE === 0,
        )
            ? GRID_LEGACY_COLS
            : GRID_COLS);
    const scale = cols === GRID_LEGACY_COLS ? GRID_LEGACY_SCALE : 1;
    const panels: WorkspaceSpecPanel[] = [];
    for (const block of workspace.blocks) {
        const item = layout.get(block.id);
        if (!item) continue;
        const panel: WorkspaceSpecPanel = {
            id: block.id,
            type: block.type,
            x: Math.round(item.x / scale),
            y: Number.isFinite(item.y) ? item.y : 0,
            w: Math.max(1, Math.round(item.w / scale)),
            h: item.h,
            pin: block.pin ?? null,
        };
        if (block.type === 'flash' && !block.pin && isLinkGroup(block.linkGroup)) {
            panel.link_group = block.linkGroup;
        }
        const settings = settingsOf(block);
        if (settings) panel.settings = settings;
        panels.push(panel);
    }
    const spec: WorkspaceSpecV1 = {
        version: WORKSPACE_SPEC_VERSION,
        columns: cols,
        panels,
    };
    const groups: Partial<Record<LinkGroupId, string>> = {};
    for (const id of LINK_GROUPS) {
        const code = workspace.linkGroups?.[id];
        if (typeof code === 'string' && code) groups[id] = code;
    }
    if (Object.keys(groups).length) spec.link_groups = groups;
    return spec;
}

/** Panel-type catalog in the given spec columns, for the Agent to plan sizes. */
export function workspaceSpecCatalog(columns: WorkspaceSpecColumns) {
    const scale = columns === GRID_LEGACY_COLS ? 1 : GRID_LEGACY_SCALE;
    return Object.fromEntries(
        (Object.keys(BLOCK_META) as BlockType[]).map((type) => {
            const meta = BLOCK_META[type];
            return [
                type,
                {
                    label: meta.label,
                    min_w: meta.defaultSize.minW * scale,
                    min_h: meta.defaultSize.minH,
                    default_w: meta.defaultSize.w * scale,
                    default_h: meta.defaultSize.h,
                    singleton: meta.singleton,
                    pinnable: meta.pinnable,
                    settings: Object.fromEntries(
                        Object.entries(WORKSPACE_SPEC_SETTINGS[type] ?? {}).map(
                            ([key, def]) => [key, { values: def.values, default: def.fallback ?? null }],
                        ),
                    ),
                },
            ];
        }),
    );
}

// ---- validation ----

/**
 * Minimum size in the stored 288-column grid. A kept panel uses its own grid
 * item's limits (what the grid enforces; some presets go below the panel
 * library defaults), a new panel the library defaults.
 */
function panelMinSize(type: BlockType, item?: LayoutItem): { minW: number; minH: number } {
    const meta = BLOCK_META[type].defaultSize;
    const fallbackW = meta.minW * GRID_LEGACY_SCALE;
    return {
        minW: Math.min(fallbackW, typeof item?.minW === 'number' ? item.minW : fallbackW),
        minH: Math.min(meta.minH, typeof item?.minH === 'number' ? item.minH : meta.minH),
    };
}

const TOP_KEYS = ['version', 'columns', 'panels', 'link_groups'];
const PANEL_KEYS = ['id', 'type', 'x', 'y', 'w', 'h', 'pin', 'link_group', 'settings'];

export interface WorkspaceSpecCheckOptions {
    /** Visible grid rows of the current window; enables the viewport warning. */
    viewportRows?: number | null;
    /** Render density of the main grid (1–4); compaction previews use it. */
    density?: number | null;
}

/**
 * Synchronous structural check of an untrusted spec against the current
 * workspace. Contract codes are only format-checked here; resolve them with
 * {@link resolveWorkspaceSpecContracts} before applying.
 */
export function checkWorkspaceSpec(
    input: unknown,
    current: Workspace,
    options: WorkspaceSpecCheckOptions = {},
): WorkspaceSpecCheck {
    const errors: WorkspaceSpecIssue[] = [];
    const warnings: WorkspaceSpecIssue[] = [];
    const err = (path: string, code: string, message: string) =>
        errors.push({ path, code, message });
    const fail = (): WorkspaceSpecCheck => ({ valid: false, errors, warnings });

    if (!isRecord(input)) {
        err('$', 'invalid_type', 'spec must be a JSON object');
        return fail();
    }
    for (const key of Object.keys(input)) {
        if (!TOP_KEYS.includes(key)) {
            err(key, 'unknown_field', `unknown field "${key}"`);
        }
    }
    if (input.version !== WORKSPACE_SPEC_VERSION) {
        err(
            'version',
            'unsupported_version',
            `version must be ${WORKSPACE_SPEC_VERSION} (got ${JSON.stringify(input.version ?? null)})`,
        );
    }
    const columns = input.columns;
    if (columns !== GRID_LEGACY_COLS && columns !== GRID_COLS) {
        err(
            'columns',
            'invalid_value',
            `columns must be ${GRID_LEGACY_COLS} or ${GRID_COLS} (got ${JSON.stringify(columns ?? null)})`,
        );
    }
    if (!Array.isArray(input.panels)) {
        err('panels', 'invalid_type', 'panels must be an array');
        return fail();
    }
    if (input.panels.length === 0) {
        err('panels', 'empty', 'panels must contain at least one panel');
    }
    if (input.panels.length > WORKSPACE_SPEC_MAX_PANELS) {
        err(
            'panels',
            'too_many_panels',
            `at most ${WORKSPACE_SPEC_MAX_PANELS} panels are allowed (got ${input.panels.length})`,
        );
    }
    if (errors.some((e) => e.path === 'columns' || e.path === 'version')) {
        return fail();
    }
    const cols = columns as WorkspaceSpecColumns;
    const scale = cols === GRID_LEGACY_COLS ? GRID_LEGACY_SCALE : 1;

    const currentById = new Map(current.blocks.map((b) => [b.id, b]));
    const currentLayout = new Map(current.layout.map((item) => [item.i, item]));
    const seenIds = new Map<string, number>();
    const singletonSeen = new Map<BlockType, number>();
    const panels: NormalizedPanel[] = [];

    input.panels.forEach((raw: unknown, index: number) => {
        const at = `panels[${index}]`;
        if (!isRecord(raw)) {
            err(at, 'invalid_type', 'panel must be an object');
            return;
        }
        let ok = true;
        for (const key of Object.keys(raw)) {
            if (!PANEL_KEYS.includes(key)) {
                err(`${at}.${key}`, 'unknown_field', `unknown panel field "${key}"`);
                ok = false;
            }
        }
        const id = raw.id;
        if (typeof id !== 'string' || !PANEL_ID_PATTERN.test(id)) {
            err(
                `${at}.id`,
                'invalid_value',
                'id must be 1–64 characters of letters, digits, ".", "_", ":" or "-"',
            );
            ok = false;
        } else if (seenIds.has(id)) {
            err(`${at}.id`, 'duplicate_id', `id "${id}" is already used by panels[${seenIds.get(id)}]`);
            ok = false;
        } else {
            seenIds.set(id, index);
        }
        const type = raw.type;
        if (!isBlockType(type)) {
            err(
                `${at}.type`,
                'invalid_value',
                `unknown panel type ${JSON.stringify(type ?? null)}; see panel_types from get_workspace_spec`,
            );
            return;
        }
        const meta = BLOCK_META[type];
        const existing = typeof id === 'string' ? currentById.get(id) : undefined;
        if (existing && existing.type !== type) {
            err(
                `${at}.type`,
                'type_changed',
                `panel "${id}" is a ${existing.type} panel; keep its type or use a new id for a ${type} panel`,
            );
            ok = false;
        }
        if (meta.singleton) {
            const prior = singletonSeen.get(type);
            if (prior !== undefined) {
                err(
                    `${at}.type`,
                    'singleton',
                    `${meta.label} (${type}) can appear only once; also at panels[${prior}]`,
                );
                ok = false;
            } else {
                singletonSeen.set(type, index);
            }
        }
        const geometry: Record<'x' | 'y' | 'w' | 'h', number> = { x: 0, y: 0, w: 0, h: 0 };
        let geometryOk = true;
        for (const key of ['x', 'y', 'w', 'h'] as const) {
            const v = raw[key];
            const min = key === 'w' || key === 'h' ? 1 : 0;
            if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
                err(`${at}.${key}`, 'invalid_value', `${key} must be an integer ≥ ${min}`);
                geometryOk = false;
            } else {
                geometry[key] = v;
            }
        }
        if (!geometryOk) ok = false;
        if (geometryOk) {
            const limits = panelMinSize(type, existing ? currentLayout.get(existing.id) : undefined);
            if (geometry.x + geometry.w > cols) {
                err(
                    `${at}.w`,
                    'out_of_bounds',
                    `x + w = ${geometry.x + geometry.w} exceeds columns ${cols}`,
                );
                ok = false;
            }
            if (geometry.y + geometry.h > WORKSPACE_SPEC_MAX_ROWS) {
                err(
                    `${at}.h`,
                    'out_of_bounds',
                    `y + h = ${geometry.y + geometry.h} exceeds ${WORKSPACE_SPEC_MAX_ROWS} rows`,
                );
                ok = false;
            }
            if (geometry.w * scale < limits.minW) {
                err(
                    `${at}.w`,
                    'below_min_size',
                    `w = ${geometry.w} is below the minimum ${Math.ceil(limits.minW / scale)} for ${meta.label} (${type})`,
                );
                ok = false;
            }
            if (geometry.h < limits.minH) {
                err(
                    `${at}.h`,
                    'below_min_size',
                    `h = ${geometry.h} is below the minimum ${limits.minH} for ${meta.label} (${type})`,
                );
                ok = false;
            }
        }
        // pin / link group
        let pin: string | null = null;
        if (raw.pin !== undefined && raw.pin !== null) {
            if (typeof raw.pin !== 'string' || !CONTRACT_CODE_PATTERN.test(raw.pin.trim())) {
                err(`${at}.pin`, 'invalid_value', 'pin must be a contract code or null');
                ok = false;
            } else if (!meta.pinnable) {
                err(`${at}.pin`, 'not_pinnable', `${meta.label} (${type}) cannot be pinned to a contract`);
                ok = false;
            } else {
                pin = raw.pin.trim().toUpperCase();
            }
        }
        let linkGroup: LinkGroupId | null = null;
        if (raw.link_group !== undefined && raw.link_group !== null) {
            if (!isLinkGroup(raw.link_group)) {
                err(`${at}.link_group`, 'invalid_value', 'link_group must be "A", "B" or "C"');
                ok = false;
            } else if (type !== 'flash') {
                err(
                    `${at}.link_group`,
                    'not_supported',
                    'link groups are only supported on flash panels; other panels follow the selection (pin null) or a pin',
                );
                ok = false;
            } else if (pin) {
                err(`${at}.link_group`, 'conflict', 'a panel cannot have both pin and link_group');
                ok = false;
            } else {
                linkGroup = raw.link_group;
            }
        }
        // settings
        const settings: WorkspaceSpecSettings = {};
        if (raw.settings !== undefined) {
            const defs = WORKSPACE_SPEC_SETTINGS[type] ?? {};
            if (!isRecord(raw.settings)) {
                err(`${at}.settings`, 'invalid_type', 'settings must be an object');
                ok = false;
            } else {
                for (const [key, value] of Object.entries(raw.settings)) {
                    const def = Object.hasOwn(defs, key) ? defs[key] : undefined;
                    if (!def) {
                        const supported = Object.keys(defs);
                        err(
                            `${at}.settings.${key}`,
                            'unknown_setting',
                            supported.length
                                ? `${type} panels support settings: ${supported.join(', ')}`
                                : `${type} panels have no settings in workspace spec v1`,
                        );
                        ok = false;
                    } else if (!def.values.includes(value as string | boolean)) {
                        err(
                            `${at}.settings.${key}`,
                            'invalid_value',
                            `${key} must be one of ${def.values.map((v) => JSON.stringify(v)).join(', ')}`,
                        );
                        ok = false;
                    } else if (def.fallback === undefined || value !== def.fallback) {
                        settings[key] = value as string | boolean;
                    }
                }
            }
        }
        if (ok && typeof id === 'string') {
            panels.push({
                id,
                type,
                x: geometry.x * scale,
                y: geometry.y,
                w: geometry.w * scale,
                h: geometry.h,
                pin,
                linkGroup,
                settings,
            });
        }
    });

    // link groups
    const linkGroups: Partial<Record<LinkGroupId, string>> = {};
    if (input.link_groups !== undefined) {
        if (!isRecord(input.link_groups)) {
            err('link_groups', 'invalid_type', 'link_groups must be an object');
        } else {
            for (const [key, value] of Object.entries(input.link_groups)) {
                if (!isLinkGroup(key)) {
                    err(`link_groups.${key}`, 'unknown_field', 'link group keys are "A", "B" or "C"');
                } else if (typeof value !== 'string' || !CONTRACT_CODE_PATTERN.test(value.trim())) {
                    err(`link_groups.${key}`, 'invalid_value', 'link group code must be a contract code');
                } else {
                    linkGroups[key] = value.trim().toUpperCase();
                }
            }
        }
    }

    // The Agent's own panel hosts this very command; removing it would cut the
    // response channel and close the user's conversation.
    const assistant = current.blocks.find((b) => b.type === 'assistant');
    if (assistant && !seenIds.has(assistant.id)) {
        err(
            'panels',
            'assistant_required',
            `the spec must keep the AI Agent panel "${assistant.id}" (it hosts this conversation)`,
        );
    }

    if (errors.length) return fail();

    // overlaps (in the stored grid)
    for (let i = 0; i < panels.length; i += 1) {
        for (let j = i + 1; j < panels.length; j += 1) {
            if (overlaps(panels[i]!, panels[j]!)) {
                err(
                    `panels[${seenIds.get(panels[j]!.id)}]`,
                    'overlap',
                    `panel "${panels[j]!.id}" overlaps panel "${panels[i]!.id}"`,
                );
            }
        }
    }
    if (errors.length) return fail();

    // The grid renders at a coarser density. Two panels whose columns overlap
    // in the stored grid but only touch on screen (or the reverse) would pack
    // differently on screen than in the stored layout, and the read-back
    // could not be validated again. Require edges that agree at the live
    // density (columns: 24 always does).
    const density = options.density ?? GRID_LEGACY_SCALE;
    if (density !== GRID_LEGACY_SCALE) {
        const unchanged = (p: NormalizedPanel) => {
            const item = currentLayout.get(p.id);
            return Boolean(
                item && item.x === p.x && item.y === p.y && item.w === p.w && item.h === p.h,
            );
        };
        const xOverlap = (a: { x: number; w: number }, b: { x: number; w: number }) =>
            a.x < b.x + b.w && b.x < a.x + a.w;
        for (let i = 0; i < panels.length; i += 1) {
            for (let j = i + 1; j < panels.length; j += 1) {
                const a = panels[i]!;
                const b = panels[j]!;
                // A pair the user already has on screen, untouched by the
                // spec, is what the grid shows today: never reject it.
                if (unchanged(a) && unchanged(b)) continue;
                if (
                    xOverlap(a, b) !==
                    xOverlap(toRenderGeom(a, density), toRenderGeom(b, density))
                ) {
                    err(
                        `panels[${seenIds.get(b.id)}].x`,
                        'misaligned',
                        `panels "${a.id}" and "${b.id}" are less than one on-screen column apart; align their edges (multiples of ${GRID_LEGACY_SCALE / density} in 288 columns, or use columns: 24)`,
                    );
                }
            }
        }
        if (errors.length) return fail();
    }

    const compacted = compactVertical(panels, density);
    // Safety net: packing at the render density must never produce rectangles
    // that overlap in the stored grid, or the read-back could not validate.
    for (let i = 0; i < compacted.length; i += 1) {
        for (let j = i + 1; j < compacted.length; j += 1) {
            if (overlaps(compacted[i]!, compacted[j]!)) {
                err(
                    `panels[${seenIds.get(compacted[j]!.id)}].x`,
                    'misaligned',
                    `after the grid packs panels upward, "${compacted[j]!.id}" would overlap "${compacted[i]!.id}" by less than one on-screen column; align their edges (or use columns: 24)`,
                );
            }
        }
    }
    if (errors.length) return fail();
    for (const panel of compacted) {
        const original = panels.find((p) => p.id === panel.id)!;
        if (panel.y !== original.y) {
            warnings.push({
                path: `panels[${seenIds.get(panel.id)}].y`,
                code: 'compacted',
                message: `the grid packs panels upward: "${panel.id}" will sit at y = ${panel.y} instead of ${original.y}`,
            });
        }
    }
    const rows = options.viewportRows;
    if (rows && rows > 0) {
        const below = compacted.filter((p) => p.y + p.h > rows).map((p) => p.id);
        if (below.length) {
            warnings.push({
                path: 'panels',
                code: 'exceeds_viewport',
                message: `the window shows ${rows} rows; ${below.map((id) => `"${id}"`).join(', ')} extend below it and need scrolling`,
            });
        }
    }
    for (const group of LINK_GROUPS) {
        const members = compacted.filter((p) => p.linkGroup === group).length;
        if (members && !linkGroups[group]) {
            warnings.push({
                path: 'link_groups',
                code: 'link_group_without_code',
                message: `link group ${group} has members but no code; they show no contract until one is chosen`,
            });
        }
    }

    const normalized: NormalizedWorkspaceSpec = {
        columns: cols,
        panels: compacted,
        linkGroups,
    };
    const diff = diffWorkspaceSpec(current, normalized);
    if (diff.removed.length) {
        warnings.push({
            path: 'panels',
            code: 'removes_panels',
            message: `applying removes ${diff.removed.map((p) => `"${p.id}" (${p.type})`).join(', ')}; their panel settings are discarded (undo restores them)`,
        });
    }
    return {
        valid: true,
        errors: [],
        warnings,
        normalized,
        diff,
        fingerprint: normalizedSpecFingerprint(normalized),
    };
}

function diffWorkspaceSpec(
    current: Workspace,
    next: NormalizedWorkspaceSpec,
): WorkspaceSpecDiff {
    const blocks = new Map(current.blocks.map((b) => [b.id, b]));
    const layout = new Map(current.layout.map((l) => [l.i, l]));
    const nextIds = new Set(next.panels.map((p) => p.id));
    const diff: WorkspaceSpecDiff = {
        added: [],
        removed: current.blocks
            .filter((b) => !nextIds.has(b.id))
            .map((b) => ({ id: b.id, type: b.type })),
        moved: [],
        resized: [],
        relinked: [],
        settings_changed: [],
        link_groups_changed: false,
        destructive: false,
    };
    for (const panel of next.panels) {
        const block = blocks.get(panel.id);
        if (!block) {
            diff.added.push({ id: panel.id, type: panel.type });
            continue;
        }
        const item = layout.get(panel.id);
        if (!item || item.x !== panel.x || item.y !== panel.y) diff.moved.push(panel.id);
        if (!item || item.w !== panel.w || item.h !== panel.h) diff.resized.push(panel.id);
        const linkGroup =
            block.type === 'flash' && !block.pin && isLinkGroup(block.linkGroup)
                ? block.linkGroup
                : null;
        if ((block.pin ?? null) !== panel.pin || linkGroup !== panel.linkGroup) {
            diff.relinked.push(panel.id);
        }
        if (stableStringify(settingsOf(block) ?? {}) !== stableStringify(panel.settings)) {
            diff.settings_changed.push(panel.id);
        }
    }
    const currentGroups = workspaceToSpec(current).link_groups ?? {};
    diff.link_groups_changed =
        stableStringify(currentGroups) !== stableStringify(next.linkGroups);
    diff.destructive = diff.removed.length > 0;
    return diff;
}

/** Fingerprint of a normalized spec (what apply would store). */
export function normalizedSpecFingerprint(normalized: NormalizedWorkspaceSpec): string {
    return hashText(stableStringify(normalized));
}

/**
 * Opaque revision of everything the user can change in the workspace,
 * including fields the spec never shows (accounts, quantities, order and
 * indicator state). Only grid geometry is taken from the layout so a grid
 * re-save of identical positions does not count as an edit. Never returned
 * to the Agent.
 */
export function workspaceRevision(workspace: Workspace): string {
    return hashText(
        stableStringify({
            blocks: workspace.blocks,
            linkGroups: workspace.linkGroups ?? {},
            layout: workspace.layout.map((l) => [l.i, l.x, Number.isFinite(l.y) ? l.y : null, l.w, l.h]),
        }),
    );
}

/** Revision of the panels and their settings, ignoring grid geometry. */
export function workspaceContentRevision(workspace: Workspace): string {
    return hashText(
        stableStringify({
            blocks: workspace.blocks,
            linkGroups: workspace.linkGroups ?? {},
        }),
    );
}

/**
 * Resolve pin and link-group codes to canonical contract codes. Returns
 * issues for codes that do not resolve; the spec is returned with resolved
 * codes so the token covers what will actually be stored.
 */
export async function resolveWorkspaceSpecContracts(
    input: unknown,
    resolve: (code: string) => Promise<{ code: string }>,
): Promise<{ spec: unknown; errors: WorkspaceSpecIssue[] }> {
    if (!isRecord(input)) return { spec: input, errors: [] };
    const errors: WorkspaceSpecIssue[] = [];
    const cache = new Map<string, Promise<string | null>>();
    const lookup = (code: string) => {
        const key = code.trim().toUpperCase();
        let hit = cache.get(key);
        if (!hit) {
            hit = resolve(key).then((c) => c.code, () => null);
            cache.set(key, hit);
        }
        return hit;
    };
    const spec: Record<string, unknown> = { ...input };
    if (Array.isArray(input.panels)) {
        spec.panels = await Promise.all(
            input.panels.map(async (panel: unknown, index: number) => {
                if (!isRecord(panel) || typeof panel.pin !== 'string') return panel;
                if (!CONTRACT_CODE_PATTERN.test(panel.pin.trim())) return panel;
                const code = await lookup(panel.pin);
                if (!code) {
                    errors.push({
                        path: `panels[${index}].pin`,
                        code: 'contract_not_found',
                        message: `contract ${panel.pin} was not found`,
                    });
                    return panel;
                }
                return { ...panel, pin: code };
            }),
        );
    }
    if (isRecord(input.link_groups)) {
        const groups: Record<string, unknown> = { ...input.link_groups };
        for (const [key, value] of Object.entries(input.link_groups)) {
            if (typeof value !== 'string' || !CONTRACT_CODE_PATTERN.test(value.trim())) continue;
            const code = await lookup(value);
            if (!code) {
                errors.push({
                    path: `link_groups.${key}`,
                    code: 'contract_not_found',
                    message: `contract ${value} was not found`,
                });
            } else {
                groups[key] = code;
            }
        }
        spec.link_groups = groups;
    }
    return { spec, errors };
}

// ---- apply ----

/**
 * Build the next workspace from a validated spec. Kept panel ids carry over
 * every field the spec does not own (account keys, quantities, order and
 * indicator state…); new panels start from defaults.
 */
export function buildWorkspaceFromSpec(
    current: Workspace,
    normalized: NormalizedWorkspaceSpec,
): Workspace {
    const existing = new Map(current.blocks.map((b) => [b.id, b]));
    const currentLayout = new Map(current.layout.map((item) => [item.i, item]));
    const blocks: Block[] = [];
    const layout: LayoutItem[] = [];
    for (const panel of normalized.panels) {
        const prior = existing.get(panel.id);
        const base = (prior ? structuredClone(prior) : {}) as Record<string, unknown>;
        for (const field of SPEC_OWNED_FIELDS) delete base[field];
        const block = {
            ...base,
            id: panel.id,
            type: panel.type,
            pin: panel.pin,
        } as Block;
        if (panel.linkGroup) block.linkGroup = panel.linkGroup;
        const defs = WORKSPACE_SPEC_SETTINGS[panel.type] ?? {};
        for (const [key, value] of Object.entries(panel.settings)) {
            const def = Object.hasOwn(defs, key) ? defs[key] : undefined;
            if (def) (block as unknown as Record<string, unknown>)[def.field] = value;
        }
        blocks.push(block);
        const limits = panelMinSize(
            panel.type,
            prior ? currentLayout.get(panel.id) : undefined,
        );
        layout.push({
            i: panel.id,
            x: panel.x,
            y: panel.y,
            w: panel.w,
            h: panel.h,
            minW: limits.minW,
            minH: limits.minH,
        });
    }
    const next: Workspace = { blocks, layout };
    if (Object.keys(normalized.linkGroups).length) {
        next.linkGroups = { ...normalized.linkGroups };
    }
    return next;
}
