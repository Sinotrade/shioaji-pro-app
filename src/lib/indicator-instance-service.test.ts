import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEF_BY_TYPE } from './indicator-defs';
import { customType, deleteCustom, saveCustom } from './custom-indicators';
import { IndicatorInstanceService, initializeIndicatorPanels } from './indicator-instance-service';
import { loadWorkspace, saveWorkspace, type Workspace } from './workspace';

function setup() {
    let workspace = initializeIndicatorPanels({ blocks: [
        { id: 'a', type: 'chart', pin: null }, { id: 'b', type: 'chart', pin: null },
        { id: 'watch', type: 'watchlist', pin: null },
    ], layout: [] });
    const service = new IndicatorInstanceService({ getWorkspace: () => workspace,
        updateWorkspace: (next) => { workspace = next; saveWorkspace(next); } });
    service.registerPanel('a');
    service.registerPanel('b');
    return { service, getWorkspace: () => workspace, setWorkspace: (next: Workspace) => { workspace = next; } };
}

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); } });
});
afterEach(() => { deleteCustom('numeric-oracle'); vi.unstubAllGlobals(); });

describe('IndicatorInstanceService', () => {
    it('cleans deleted definitions from live panels and restored profiles', () => {
        const { service, getWorkspace } = setup();
        const mounted = service.mount('a', 'sma', { period: 3 });
        const savedProfile = structuredClone(getWorkspace());
        const definition = DEF_BY_TYPE.get('sma')!;
        try {
            DEF_BY_TYPE.delete('sma');
            service.pruneMissingDefinitions();
            expect(service.snapshot('a').instances).toEqual([]);
            expect(service.snapshot('a').revision).not.toBe(mounted.revision);
            const restored = initializeIndicatorPanels(savedProfile);
            expect(restored.blocks[0]!.indicatorState!.instances).toEqual([]);
            expect(restored.blocks[0]!.indicatorState!.revision).not.toBe(mounted.revision);
        } finally { DEF_BY_TYPE.set('sma', definition); }
    });
    it('migrates global defaults once into independent persistent panel state', () => {
        const defaults = [{ id: 'legacy', type: 'sma', params: { period: 5 }, colors: {}, hidden: true }];
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(defaults));
        const { service, getWorkspace } = setup();
        expect(service.snapshot('a').instances).toEqual(defaults);
        expect(service.snapshot('b').instances).toEqual(defaults);
        expect(getWorkspace().blocks[2]!.indicatorState).toBeUndefined();
        service.update('a', 'legacy', { params: { period: 7 }, hidden: false });
        expect(service.snapshot('b').instances[0]).toEqual(defaults[0]);
        expect(JSON.parse(localStorage.getItem('sj-pro-indicators-v2')!)).toEqual(defaults);
        const reloaded = initializeIndicatorPanels(loadWorkspace());
        expect(reloaded).toEqual(getWorkspace());
        expect(initializeIndicatorPanels(reloaded)).toBe(reloaded);
        expect(reloaded.blocks[0]!.indicatorState!.instances[0]!.params.period).toBe(7);
    });

    it('preserves already initialized empty panels during migration', () => {
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([{ id: 'legacy', type: 'sma', params: { period: 5 }, colors: {} }]));
        const state = { revision: 'existing', instances: [] };
        const ws = initializeIndicatorPanels({ blocks: [
            { id: 'empty', type: 'chart', pin: null, indicatorState: state },
            { id: 'legacy', type: 'chart', pin: null },
        ], layout: [] });
        expect(ws.blocks[0]!.indicatorState).toBe(state);
        expect(ws.blocks[1]!.indicatorState!.instances).toHaveLength(1);
    });

    it('updates, reorders, hides and removes one instance, with revisions and notifications', () => {
        const { service } = setup();
        const listener = vi.fn();
        const stop = service.subscribe(listener);
        const first = service.mount('a', 'sma', { period: 2 });
        const second = service.mount('a', 'ema', { period: 3 });
        const before = service.snapshot('a').revision;
        const updated = service.update('a', second.instance.id, { params: { period: 4 }, hidden: true, index: 0 }, before);
        expect(updated.revision).not.toBe(before);
        expect(service.snapshot('a').instances.map(i => i.id)).toEqual([second.instance.id, first.instance.id]);
        expect(updated.instance).toMatchObject({ hidden: true, params: { period: 4 } });
        updated.instance.params.period = 99;
        expect(service.snapshot('a').instances[0]!.params.period).toBe(4);
        expect(() => service.remove('a', first.instance.id, before)).toThrow(/changed/);
        service.remove('a', first.instance.id, updated.revision);
        expect(service.snapshot('a').instances).toHaveLength(1);
        expect(service.snapshot('b').instances).toHaveLength(0);
        expect(listener).toHaveBeenCalledTimes(4);
        stop();
        service.update('a', second.instance.id, { hidden: false });
        expect(listener).toHaveBeenCalledTimes(4);
    });

    it.each<Record<string, number>>([{ period: 0 }, { period: 501 }, { period: NaN }, { period: Infinity }, { surprise: 2 }, { period: 2.5 }])('rejects invalid parameters without mutation: %j', (params) => {
        const { service } = setup();
        const before = structuredClone(service.snapshot('a'));
        expect(() => service.mount('a', 'sma', params)).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
        expect(service.snapshot('a')).toEqual(before);
    });

    it('rejects stale invalid saved defaults after merging with explicit mount params', () => {
        const { service } = setup();
        localStorage.setItem('sj-pro-ind-defaults-v1', JSON.stringify({ sma: { params: { period: 9999 } } }));
        expect(() => service.mount('a', 'sma')).toThrow(/Invalid parameter/);
        expect(service.snapshot('a').instances).toEqual([]);
    });

    it('rejects unknown types, instances, stale revisions and out-of-range ordering', () => {
        const { service } = setup();
        expect(() => service.mount('a', 'not-real')).toThrow(/Unknown indicator/);
        const item = service.mount('a', 'sma');
        expect(() => service.update('a', 'missing', { hidden: true })).toThrow(/not found/);
        expect(() => service.update('a', item.instance.id, { index: 1 })).toThrow(/index/);
        expect(() => service.update('a', item.instance.id, { hidden: true }, 'old-revision')).toThrow(/changed/);
        expect(service.snapshot('a').revision).toBe(item.revision);
    });

    it('clears focused unmounted panels and rejects deleted panels even if registration remains', () => {
        const { service, getWorkspace, setWorkspace } = setup();
        expect(() => service.resolvePanel()).toThrow(/Select/);
        const unmount = service.registerPanel('temp');
        setWorkspace({ ...getWorkspace(), blocks: [...getWorkspace().blocks, { id: 'temp', type: 'chart', pin: null }] });
        service.focus('temp');
        expect(service.resolvePanel()).toBe('temp');
        unmount();
        expect(() => service.resolvePanel()).toThrow(/Select/);
        service.focus('a');
        expect(service.resolvePanel()).toBe('a');
        setWorkspace({ ...getWorkspace(), blocks: getWorkspace().blocks.filter(b => b.id !== 'a') });
        expect(() => service.resolvePanel()).toThrow(/Select/);
        expect(() => service.resolvePanel('watch')).toThrow(/Select/);
        expect(service.resolvePanel('b')).toBe('b');
    });

    it('mounts and retunes a custom chart definition against a hand-calculated numeric oracle', () => {
        const { service } = setup();
        saveCustom({ id: 'numeric-oracle', name: 'Oracle', short: 'OR', desc: '', category: 'overlay',
            params: [{ key: 'period', label: 'Period', min: 1, max: 10, def: 2 }],
            outputs: [{ key: 'mean', label: 'Mean', kind: 'line', color: '#ffffff' }],
            source: 'plot("mean", ta.sma(close, p.period));', updatedAt: 1 });
        const receipt = service.mount('a', customType('numeric-oracle'), { period: 2 });
        const bars = [2, 4, 8, 10].map((close, i) => ({ time: 1000 + i * 60, open: close, high: close, low: close, close, volume: 100 }));
        const compute = () => DEF_BY_TYPE.get(receipt.instance.type)!.compute(bars, service.snapshot('a').instances[0]!.params).mean;
        expect(compute()).toEqual([{ time: 1000 }, { time: 1060, value: 3 }, { time: 1120, value: 6 }, { time: 1180, value: 9 }]);
        service.update('a', receipt.instance.id, { params: { period: 3 } });
        expect(compute()).toEqual([{ time: 1000 }, { time: 1060 }, { time: 1120, value: 14 / 3 }, { time: 1180, value: 22 / 3 }]);
    });
});
