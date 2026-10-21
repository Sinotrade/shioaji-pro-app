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
    exits: [] as unknown[],
    programs: [] as unknown[],
}));
vi.mock('../trigger-engine', () => ({
    getDisplayTriggers: () => m.triggers, setTriggerPaused: m.pause, removeTriggerStrict: m.remove, onTimedFlatten: () => undefined,
    getExits: () => m.exits,
    setTriggerGroup: m.group,
}));
vi.mock('../bracket', () => ({ getBrackets: () => [], dismissBracket: m.dismiss }));
vi.mock('../execution/background', () => ({ getBackgroundPrograms: () => m.programs, markBackgroundHandled: m.handled,
    pauseBackgroundProgram: m.bgPause, resumeBackgroundProgram: m.bgPause }));
vi.mock('../trade', () => ({ notify: vi.fn() }));
vi.mock('./settings', () => ({ getConditionalSettings: () => ({ pauseStopsExits: m.pauseStopsExits }) }));

const { pauseAll, stopConditionalInScope, waitInFlight } = await import('./runtime');
const { pauseAllButton } = await import('./pause-all');

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
        // the time order here is a 指定時間送單 without role → not an entry; 收盤前平倉 likewise keeps running
        expect(m.pause.mock.calls.map(c => c[0])).toEqual(['entry']);
        expect(r.changed).toBe(1);
    });

    it('with the setting on, protective stops pause too (bracket legs never)', async () => {
        m.pauseStopsExits = true;
        await pauseAll(true);
        expect(m.pause.mock.calls.map(c => c[0])).toEqual(['entry', 'stop', 'time']);
    });

    it('全部恢復 resumes every paused one, whatever the setting is now', async () => {
        m.triggers = [t({ id: 'stop', paused: true }), t({ id: 'e', role: 'entry', paused: true })];
        await pauseAll(false);
        expect(m.pause.mock.calls).toEqual([['stop', false], ['e', false]]);
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

describe('waitInFlight', () => {
    it('waits while a conditional order in scope is still sending; gives up after the limit', async () => {
        vi.useFakeTimers();
        m.exits = [{ status: 'sending', account: F, orderCode: 'TXFJ6' }];
        const p = waitInFlight({ type: 'all' }, 1000);
        await vi.advanceTimersByTimeAsync(1200);
        expect(await p).toBe(false);
        m.exits = [{ status: 'working', account: F, orderCode: 'TXFJ6' }];
        expect(await waitInFlight({ type: 'all' }, 1000)).toBe(true);
        vi.useRealTimers();
    });

    it('a background program in scope whose order is still leaving keeps it waiting', async () => {
        vi.useFakeTimers();
        m.exits = [];
        m.programs = [{ binding: { account: { accountType: 'F', brokerId: 'b', accountId: 'a' }, contract: { orderCode: 'TXFJ6', quoteCode: 'TXFR1' } },
            levels: [{ orders: [{ status: 'pendingSubmit' }] }] }];
        const p = waitInFlight({ type: 'all' }, 500);
        await vi.advanceTimersByTimeAsync(700);
        expect(await p).toBe(false);
        m.programs = [];
        vi.useRealTimers();
    });
});

describe('pauseAllButton', () => {
    it('pause while anything runs; resume only when only paused ones are left; otherwise a disabled pause', () => {
        expect(pauseAllButton(true, true)).toEqual({ mode: 'pause', disabled: false });
        expect(pauseAllButton(false, true)).toEqual({ mode: 'resume', disabled: false });
        expect(pauseAllButton(false, false)).toEqual({ mode: 'pause', disabled: true });
    });
});

describe('flattenSummary / leftovers (2330 QA 10/12)', () => {
    it('the summary says 張＋股 and what is still held', async () => {
        const { flattenSummary } = await import('./runtime');
        const acct = { account_type: 'S' as const, broker_id: 'b', account_id: 's' };
        const text = flattenSummary({ stopped: 0, cancelled: 0, cancelFailed: [], notSent: [], skipped: [],
            sent: [{ code: '2330', action: 'Sell', quantity: 8006, market: 'stock', account: acct }],
            remaining: [{ code: '2330', action: 'Sell', quantity: 7000, market: 'stock', account: acct }] });
        const { plainText, revealText } = await import('../privacy');
        expect(plainText(text)).toContain('送出平倉 2330 賣 8 張＋6 股');
        expect(text).not.toContain('8006');
        expect(plainText(text)).toContain('需要你處理：2330 仍有 多單 7 張 未平倉');
        // #268: 平倉量／剩餘量是持倉數量，遮金額時（之後才開也一樣）不露
        const masked = revealText(text, { priv: false, privMoney: true });
        expect(masked).toContain('送出平倉 2330 賣 •••••');
        expect(masked).toContain('2330 仍有 多單 ••••• 未平倉');
        expect(masked).not.toMatch(/8 張|7 張/);
    });

    it('leftovers: a product fully closed later clears its entry; others stay', async () => {
        const { recordFlattenLeftovers, getFlattenLeftovers, __resetFlattenLeftoversForTest } = await import('./flatten-leftovers');
        __resetFlattenLeftoversForTest();
        const acct = { account_type: 'S' as const, broker_id: 'b', account_id: 's' };
        const o = (code: string, quantity: number) => ({ account: acct, code, action: 'Sell' as const, quantity, market: 'stock' as const });
        recordFlattenLeftovers([o('2330', 8006), o('2317', 1000)], [o('2330', 7000), o('2317', 1000)], 'env', 1);
        expect(getFlattenLeftovers().map(l => [l.order.code, l.order.quantity])).toEqual([['2330', 7000], ['2317', 1000]]);
        recordFlattenLeftovers([o('2330', 7000)], [], 'env', 2);
        expect(getFlattenLeftovers().map(l => l.order.code)).toEqual(['2317']);
    });
});
