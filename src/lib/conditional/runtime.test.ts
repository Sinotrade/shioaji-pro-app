// src/lib/conditional/runtime.test.ts — 全部暫停 and 全平並取消 step 1 (#226).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerOrder } from '../trigger-engine';

const F = { account_type: 'F' as const, broker_id: 'b', account_id: 'a' };
const m = vi.hoisted(() => ({
    triggers: [] as unknown[],
    pause: vi.fn(async (_id: string, _on: boolean) => undefined),
    remove: vi.fn(async (_id: string) => undefined),
    dismiss: vi.fn(async () => undefined),
    handled: vi.fn(async () => undefined),
    bgPause: vi.fn(async () => undefined),
    group: vi.fn(async (_ids: string[], _a: string) => undefined),
    pauseStopsExits: false,
}));
vi.mock('../trigger-engine', () => ({
    getDisplayTriggers: () => m.triggers, setTriggerPaused: m.pause, removeTrigger: m.remove, onTimedFlatten: () => undefined,
    setTriggerGroup: m.group,
}));
vi.mock('../bracket', () => ({ getBrackets: () => [], dismissBracket: m.dismiss }));
vi.mock('../execution/background', () => ({ getBackgroundPrograms: () => [], markBackgroundHandled: m.handled,
    pauseBackgroundProgram: m.bgPause, resumeBackgroundProgram: m.bgPause }));
vi.mock('../trade', () => ({ notify: vi.fn() }));
vi.mock('./settings', () => ({ getConditionalSettings: () => ({ pauseStopsExits: m.pauseStopsExits }) }));

const { pauseAll, stopConditionalInScope } = await import('./runtime');

const t = (over: Partial<TriggerOrder>): TriggerOrder => ({ id: 'x', code: 'TXFR1', orderCode: 'TXFJ6', condition: 'below', price: 1,
    action: 'Sell', quantity: 1, kind: 'stop', env: 'e', account: F, ...over });

beforeEach(() => {
    for (const f of [m.pause, m.remove, m.dismiss, m.handled, m.bgPause]) f.mockClear();
    m.pauseStopsExits = false;
    m.triggers = [t({ id: 'entry', role: 'entry' }), t({ id: 'stop' }), t({ id: 'time', time: { kind: 'send', at: 1 } }),
        t({ id: 'leg', bracketId: 'b1' }), t({ id: 'alert', kind: 'alert' }), t({ id: 'held', role: 'entry', pending: { price: 1, at: 1 } })];
});

describe('pauseAll', () => {
    it('pauses new entries only by default: stop / take, bracket legs, alerts and 待確認 stay', async () => {
        const r = await pauseAll(true);
        expect(m.pause.mock.calls.map(c => c[0])).toEqual(['entry', 'time']);
        expect(r.changed).toBe(2);
    });

    it('with the setting on, protective stops pause too (bracket legs never)', async () => {
        m.pauseStopsExits = true;
        await pauseAll(true);
        expect(m.pause.mock.calls.map(c => c[0])).toEqual(['entry', 'stop', 'time']);
    });

    it('全部恢復 resumes only what is paused', async () => {
        m.triggers = [t({ id: 'p', role: 'entry', paused: true }), t({ id: 'q', role: 'entry' })];
        await pauseAll(false);
        expect(m.pause.mock.calls).toEqual([['p', false]]);
    });
});

describe('stopConditionalInScope', () => {
    it('removes the conditional orders of the product in scope (bracket legs go with their bracket)', async () => {
        m.triggers = [t({ id: 'a' }), t({ id: 'b', code: 'MXFR1', orderCode: 'MXFJ6' }), t({ id: 'leg', bracketId: 'b1' })];
        const r = await stopConditionalInScope({ type: 'code', codes: ['TXFJ6'], account: null });
        expect(m.remove.mock.calls.map(c => c[0])).toEqual(['a']);
        expect(r.stopped).toBe(1);
    });

    it('a 二擇一 in scope is removed as one group', async () => {
        m.triggers = [t({ id: 'u', group: 'g' }), t({ id: 'd', group: 'g' })];
        await stopConditionalInScope({ type: 'all' });
        expect(m.group.mock.calls).toEqual([[['u', 'd'], 'remove']]);
        expect(m.remove).not.toHaveBeenCalled();
    });
});
