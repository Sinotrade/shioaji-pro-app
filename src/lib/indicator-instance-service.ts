import { DEF_BY_TYPE, loadInstances, newInstance, type IndicatorInstance } from './indicator-defs';
import type { Workspace } from './workspace';

export interface IndicatorPanelState {
    revision: string;
    instances: IndicatorInstance[];
    // A panel-only seed marker lets the research layout receive its initial
    // indicators once without restoring them after the user removes one.
    presetVersion?: string;
}
export class IndicatorControlError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
const copy = <T,>(value: T): T => structuredClone(value);
const EMPTY: IndicatorPanelState = { revision: '', instances: [] };
const V9_RESEARCH_PRESET = 'v9-research-v5-macd17';

function researchEma(period: number, color: string): IndicatorInstance {
    const instance = newInstance('ema');
    instance.params.period = period;
    instance.styles = { ...instance.styles, line: { ...instance.styles?.line, color, width: 2 } };
    return instance;
}

function v9ResearchInstances(): IndicatorInstance[] {
    return [
        newInstance('vwap'),
        researchEma(3, '#ff4d6d'),
        researchEma(8, '#f6c94c'),
        newInstance('bbi'),
        newInstance('boll'),
        newInstance('atrdefense'),
        newInstance('v9macd'),
        newInstance('v9kdj'),
        newInstance('v8trend'),
    ];
}

function hasParams(instance: IndicatorInstance, expected: Record<string, number>) {
    return Object.entries(expected).every(([key, value]) => instance.params[key] === value);
}

// Only replace the exact v1 default bundle. A chart with any customised
// setting stays intact; new visual layers are merely added below.
function isUntouchedV1Bundle(instances: IndicatorInstance[]) {
    if (instances.length !== 5) return false;
    return instances.some(i => i.type === 'vwap')
        && instances.some(i => i.type === 'ema' && hasParams(i, { period: 20 }))
        && instances.some(i => i.type === 'supertrend' && hasParams(i, { period: 10, mult: 3 }))
        && instances.some(i => i.type === 'macd' && hasParams(i, { fast: 12, slow: 26, signal: 9 }))
        && instances.some(i => i.type === 'kd' && hasParams(i, { period: 9, k: 3, d: 3 }));
}

function mergeV9ResearchInstances(instances: IndicatorInstance[]): IndicatorInstance[] {
    if (isUntouchedV1Bundle(instances)) return v9ResearchInstances();
    const present = new Set(instances.map((instance) => instance.type));
    return [
        ...instances,
        // An existing generic MACD/KDJ may be intentionally tuned. In that
        // case keep it and add only the missing V9-only visual layers.
        ...v9ResearchInstances().filter((instance) => {
            if (instance.type === 'ema') {
                return !instances.some((current) => current.type === 'ema'
                    && current.params.period === instance.params.period);
            }
            return !present.has(instance.type)
                && !((instance.type === 'v9macd' && present.has('macd'))
                    || (instance.type === 'v9kdj' && present.has('kd')));
        }),
    ];
}

function addV9Ema3(instances: IndicatorInstance[]): IndicatorInstance[] {
    if (instances.some((instance) => instance.type === 'ema' && instance.params.period === 3)) {
        return instances;
    }
    return [...instances, researchEma(3, '#ff4d6d')];
}

// Seed each legacy chart separately. Global defaults remain available to
// popouts, previews and the backtest chart; editing a panel never writes them.
export function initializeIndicatorPanels(workspace: Workspace): Workspace {
    let changed = false;
    const blocks = workspace.blocks.map(block => {
        if (block.type !== 'chart') return block;
        const old = block.indicatorState;
        let instances = old
            ? old.instances.filter(i => DEF_BY_TYPE.has(i.type))
            : copy(loadInstances());
        const shouldSeedV9 = block.id === 'chart-v9' && old?.presetVersion !== V9_RESEARCH_PRESET;
        if (shouldSeedV9) {
            // v2 already seeded the other research layers. Add only EMA3 so
            // intentionally removed indicators and tuned settings stay untouched.
            instances = old?.presetVersion === 'v9-research-v3' || old?.presetVersion === 'v9-research-v4' ? instances
                : old?.presetVersion === 'v9-research-v2' ? addV9Ema3(instances)
                    : mergeV9ResearchInstances(instances);
            // User explicitly requested 45/117/17. Migrate only the previous
            // 45/117/21 research preset; preserve other custom parameters.
            instances = instances.map(instance => (instance.type === 'v9macd' || instance.type === 'macd')
                && hasParams(instance, { fast: 45, slow: 117, signal: 21 })
                ? { ...instance, params: { ...instance.params, signal: 17 } } : instance);
            instances = instances.map(instance => instance.type === 'atrdefense' ? {
                ...instance, styles: { ...instance.styles,
                    up: { ...instance.styles?.up, color: '#fb7185', width: 3, plot: 'step' },
                    down: { ...instance.styles?.down, color: '#4ade80', width: 3, plot: 'step' } },
            } : instance);
        }
        if (old && instances.length === old.instances.length && !shouldSeedV9) return block;
        changed = true;
        return {
            ...block,
            indicatorState: {
                revision: crypto.randomUUID(),
                instances,
                ...(block.id === 'chart-v9' ? { presetVersion: V9_RESEARCH_PRESET } : {}),
            },
        };
    });
    return changed ? { ...workspace, blocks } : workspace;
}

export class IndicatorInstanceService {
    private listeners = new Set<() => void>();
    private mounted = new Map<string, number>();
    private focused: string | undefined;
    constructor(private context: { getWorkspace(): Workspace; updateWorkspace(w: Workspace): void }) {}
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    notify = () => { for (const listener of this.listeners) listener(); };
    pruneMissingDefinitions() {
        const workspace = this.context.getWorkspace();
        let changed = false;
        const blocks = workspace.blocks.map(block => {
            const state = block.indicatorState;
            if (!state) return block;
            const instances = state.instances.filter(i => DEF_BY_TYPE.has(i.type));
            if (instances.length === state.instances.length) return block;
            changed = true;
            return { ...block, indicatorState: { revision: crypto.randomUUID(), instances } };
        });
        if (changed) { this.context.updateWorkspace({ ...workspace, blocks }); this.notify(); }
    }
    registerPanel(id: string) {
        this.mounted.set(id, (this.mounted.get(id) ?? 0) + 1);
        return () => {
            const count = (this.mounted.get(id) ?? 1) - 1;
            if (count) this.mounted.set(id, count);
            else { this.mounted.delete(id); if (this.focused === id) this.focused = undefined; }
        };
    }
    focus(id: string) { if (this.mounted.has(id)) this.focused = id; }
    resolvePanel(id?: string) {
        const target = id ?? this.focused;
        const panels = this.context.getWorkspace().blocks.filter(b => b.type === 'chart' && this.mounted.has(b.id));
        if (!target || !panels.some(b => b.id === target)) {
            throw new IndicatorControlError('not_found', `Select a mounted K-line panel or specify panel_id. Available: ${panels.map(b => b.id).join(', ') || 'none'}`);
        }
        return target;
    }
    snapshot = (id: string): IndicatorPanelState => this.context.getWorkspace().blocks.find(b => b.id === id && b.type === 'chart')?.indicatorState ?? EMPTY;
    replace(id: string, instances: IndicatorInstance[], expectedRevision: string) {
        const workspace = this.context.getWorkspace();
        const current = this.snapshot(id);
        if (!current.revision || current.revision !== expectedRevision) {
            throw new IndicatorControlError('conflict', 'Indicator settings changed. Read the panel again before editing.');
        }
        if (instances.length > 100) throw new IndicatorControlError('invalid_arguments', 'At most 100 indicator instances per panel');
        for (const instance of instances) {
            const previous = current.instances.find(i => i.id === instance.id);
            if (!previous || previous.type !== instance.type || JSON.stringify(previous.params) !== JSON.stringify(instance.params)) this.parameters(instance.type, instance.params);
        }
        const state = {
            revision: crypto.randomUUID(),
            instances: copy(instances),
            ...(current.presetVersion ? { presetVersion: current.presetVersion } : {}),
        };
        this.context.updateWorkspace({ ...workspace, blocks: workspace.blocks.map(b => b.id === id ? { ...b, indicatorState: state } : b) });
        this.notify();
        return state;
    }
    private parameters(type: string, params: Record<string, number>) {
        const def = DEF_BY_TYPE.get(type);
        if (!def) throw new IndicatorControlError('not_found', `Unknown indicator type: ${type}`);
        for (const [key, value] of Object.entries(params)) {
            const p = def.params.find(p => p.key === key);
            if (!p || !Number.isFinite(value) || value < p.min || value > p.max) {
                throw new IndicatorControlError('invalid_arguments', `Invalid parameter ${key} for ${type}`);
            }
            const steps = (value - p.min) / (p.step ?? 1);
            if (Math.abs(steps - Math.round(steps)) > 1e-7) throw new IndicatorControlError('invalid_arguments', `Parameter ${key} must follow step ${p.step ?? 1}`);
        }
    }
    mount(id: string, type: string, params: Record<string, number> = {}) {
        this.parameters(type, params);
        const state = this.snapshot(id);
        const instance = newInstance(type);
        instance.params = { ...instance.params, ...params };
        this.parameters(type, instance.params);
        const next = this.replace(id, [...state.instances, instance], state.revision);
        return { panel_id: id, revision: next.revision, instance: copy(instance) };
    }
    update(id: string, instanceId: string, patch: { params?: Record<string, number>; hidden?: boolean; index?: number }, expectedRevision?: string) {
        const state = this.snapshot(id);
        const old = state.instances.find(i => i.id === instanceId);
        if (!old) throw new IndicatorControlError('not_found', 'Indicator instance not found');
        const instance = { ...old, ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }), params: { ...old.params, ...patch.params } };
        if (patch.params) this.parameters(old.type, instance.params);
        const list = state.instances.map(i => i.id === instanceId ? instance : i);
        if (patch.index !== undefined) {
            if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= list.length) throw new IndicatorControlError('invalid_arguments', 'index is outside the panel instance list');
            list.splice(list.findIndex(i => i.id === instanceId), 1);
            list.splice(patch.index, 0, instance);
        }
        const next = this.replace(id, list, expectedRevision ?? state.revision);
        return { panel_id: id, revision: next.revision, instance: copy(instance) };
    }
    remove(id: string, instanceId: string, expectedRevision?: string) {
        const state = this.snapshot(id);
        if (!state.instances.some(i => i.id === instanceId)) throw new IndicatorControlError('not_found', 'Indicator instance not found');
        const next = this.replace(id, state.instances.filter(i => i.id !== instanceId), expectedRevision ?? state.revision);
        return { panel_id: id, revision: next.revision, removed_id: instanceId };
    }
}
