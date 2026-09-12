import { DEF_BY_TYPE, loadInstances, newInstance, type IndicatorInstance } from './indicator-defs';
import type { Workspace } from './workspace';

export interface IndicatorPanelState {
    revision: string;
    instances: IndicatorInstance[];
}
export class IndicatorControlError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
const copy = <T,>(value: T): T => structuredClone(value);
const EMPTY: IndicatorPanelState = { revision: '', instances: [] };

// Seed each legacy chart separately. Global defaults remain available to
// popouts, previews and the backtest chart; editing a panel never writes them.
export function initializeIndicatorPanels(workspace: Workspace): Workspace {
    let changed = false;
    const blocks = workspace.blocks.map(block => {
        if (block.type !== 'chart') return block;
        const old = block.indicatorState;
        const instances = old ? old.instances.filter(i => DEF_BY_TYPE.has(i.type)) : copy(loadInstances());
        if (old && instances.length === old.instances.length) return block;
        changed = true;
        return { ...block, indicatorState: { revision: crypto.randomUUID(), instances } };
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
        const state = { revision: crypto.randomUUID(), instances: copy(instances) };
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
