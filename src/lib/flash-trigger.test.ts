// src/lib/flash-trigger.test.ts — #216 rules of the flash ladder's triggers
// and 自動停損停利.
import { describe, expect, it } from 'vitest';
import {
    clickCondition, dragProblem, flashProtectProblem, flashProtectText, ladderMarks, normalizeFlashProtect, normalizeTriggerSend,
    positionEffect, protectConditionProblem, protectEffect, protectedQuantity, triggerConditionProblem, triggerIntent, triggerKind, triggerSendOf,
    type MarkScope, type ProtectionView,
} from './flash-trigger';
import { normalizeFlashOrderOpts } from './flash-account';
import type { TriggerOrder } from './trigger-engine';

const F = { account_type: 'F' as const, broker_id: 'B', account_id: '1' };
const OTHER = { account_type: 'F' as const, broker_id: 'B', account_id: '2' };
const ENV = 'http://x|simulation';
const trig = (t: Partial<TriggerOrder>): TriggerOrder => ({ id: 'tg-1', code: 'TXFR1', condition: 'above', price: 100, action: 'Buy', quantity: 1,
    kind: 'stop', env: ENV, account: F, orderCode: 'TXFJ6', ...t });
const scope: MarkScope = { code: 'TXFR1', account: F, odd: false, env: ENV };

describe('settings', () => {
    it('a saved protect setting is read back; a broken one is dropped, an unusable one never stays on', () => {
        expect(normalizeFlashProtect({ on: true, stopTicks: 8, takeTicks: 16, trail: null })).toEqual({ on: true, stopTicks: 8, takeTicks: 16, trail: null });
        expect(normalizeFlashProtect({ on: true, stopTicks: 0 })).toBeUndefined();
        expect(normalizeFlashProtect('x')).toBeUndefined();
        // no take and no trailing stop: refused by the bracket rules → kept off
        expect(normalizeFlashProtect({ on: true, stopTicks: 8, takeTicks: null, trail: null })?.on).toBe(false);
        expect(normalizeFlashProtect({ on: true, stopTicks: 8, takeTicks: null, trail: { activateTicks: 0, distanceTicks: 4, stepTicks: 1 } })?.on).toBe(true);
    });

    it('trigger send: 市價 or a limit 0–50 ticks', () => {
        expect(normalizeTriggerSend({ type: 'LMT', ticks: 2 })).toEqual({ type: 'LMT', ticks: 2 });
        expect(normalizeTriggerSend({ type: 'LMT', ticks: 99 })).toBeUndefined();
        expect(normalizeTriggerSend({ type: 'MKT' })).toEqual({ type: 'MKT' });
    });

    it('the panel order options keep the new fields; old saves read as before', () => {
        expect(normalizeFlashOrderOpts({ orderType: 'IOC' })).toEqual({ orderType: 'IOC', octype: 'Auto', futuresPriceType: 'MKT' });
        expect(normalizeFlashOrderOpts({ orderType: 'ROD', protect: { on: true, stopTicks: 5, takeTicks: 9, trail: null }, triggerSend: { type: 'LMT', ticks: 1 } }))
            .toMatchObject({ protect: { on: true, stopTicks: 5, takeTicks: 9 }, triggerSend: { type: 'LMT', ticks: 1 } });
    });

    it('problems and text', () => {
        expect(flashProtectProblem({ on: true, stopTicks: 5, takeTicks: null, trail: null })).toContain('移動停損');
        expect(flashProtectText({ on: true, stopTicks: 5, takeTicks: 9, trail: { activateTicks: 1, distanceTicks: 2, stepTicks: 1 } })).toBe('損 5・利 9 檔・移動停損');
    });
});

describe('what a click does', () => {
    it('protection: futures new positions only; stocks whole-lot cash only', () => {
        expect(protectConditionProblem({ market: 'F', odd: false, creditCond: 'Cash', daytradeShort: false, octype: 'Auto' })).toBeNull();
        expect(protectConditionProblem({ market: 'F', odd: false, creditCond: 'Cash', daytradeShort: false, octype: 'New' })).toBeNull();
        expect(protectConditionProblem({ market: 'F', odd: false, creditCond: 'Cash', daytradeShort: false, octype: 'Cover' })).toContain('新倉');
        expect(protectConditionProblem({ market: 'S', odd: true, creditCond: 'Cash', daytradeShort: false })).toContain('零股');
        expect(protectConditionProblem({ market: 'S', odd: false, creditCond: 'MarginTrading', daytradeShort: false })).toContain('現股');
        expect(protectConditionProblem({ market: 'S', odd: false, creditCond: 'Cash', daytradeShort: true })).toContain('當沖');
        // #263 triggers keep the panel's credit condition: only 借券 is refused panel-wide
        expect(triggerConditionProblem({ market: 'S', creditCond: 'Cash', daytradeShort: true })).toBeNull();
        expect(triggerConditionProblem({ market: 'S', creditCond: 'MarginTrading', daytradeShort: false })).toBeNull();
        expect(triggerConditionProblem({ market: 'S', creditCond: 'ShortSelling', daytradeShort: false })).toBeNull();
        expect(triggerConditionProblem({ market: 'S', creditCond: 'SBLShort', daytradeShort: false })).toContain('借券');
        expect(triggerConditionProblem({ market: 'S', creditCond: 'SBLShortPriceExempt', daytradeShort: false })).toContain('借券');
        expect(triggerConditionProblem({ market: 'F', creditCond: 'Cash', daytradeShort: false })).toBeNull();
    });

    it('position effect: same way opens, opposite within the position reduces, beyond it reverses', () => {
        expect(positionEffect(0, 'Buy', 3)).toBe('open');
        expect(positionEffect(2, 'Buy', 3)).toBe('open');
        expect(positionEffect(2, 'Sell', 2)).toBe('reduce');
        expect(positionEffect(2, 'Sell', 3)).toBe('reverse');
        expect(positionEffect(-1, 'Buy', 1)).toBe('reduce');
        // stocks: shares held as lots (1500 shares = 1.5 lots)
        expect(positionEffect(1.5, 'Sell', 1)).toBe('reduce');
        expect(positionEffect(1.5, 'Sell', 2)).toBe('reverse');
    });

    it('a futures 新倉 order always opens (it gets protection even against a position)', () => {
        expect(protectEffect('reduce', 'F', 'New')).toBe('open');
        expect(protectEffect('reverse', 'F', 'New')).toBe('open');
        expect(protectEffect('reduce', 'F', 'Auto')).toBe('reduce');
        expect(protectEffect('reduce', 'S')).toBe('reduce');
    });

    it('direction comes from the traded price; the price itself and no price are refused', () => {
        expect(clickCondition(101, 100)).toBe('above');
        expect(clickCondition(99, 100)).toBe('below');
        expect(clickCondition(100, 100)).toContain('立刻觸發');
        expect(clickCondition(100, null)).toContain('尚未收到成交價');
        expect(triggerKind('above', 'Buy')).toBe('stop');
        expect(triggerKind('below', 'Buy')).toBe('take');
    });

    it('intent: an exit within the position closes (Cover) and skips risk; otherwise an entry', () => {
        expect(triggerIntent({ market: 'F', octype: 'Auto', effect: 'reduce', exitSafe: true })).toEqual({ role: 'exit', octype: 'Cover' });
        expect(triggerIntent({ market: 'F', octype: 'Auto', effect: 'reduce', exitSafe: false })).toEqual({ role: 'entry' });
        expect(triggerIntent({ market: 'F', octype: 'Auto', effect: 'open', exitSafe: true })).toEqual({ role: 'entry' });
        expect(triggerIntent({ market: 'F', octype: 'New', effect: 'reduce', exitSafe: true })).toEqual({ role: 'entry', octype: 'New' });
        expect(triggerIntent({ market: 'F', octype: 'Cover', effect: 'open', exitSafe: true })).toEqual({ role: 'exit', octype: 'Cover' });
        // stocks without a side / quantity: an entry
        expect(triggerIntent({ market: 'S', effect: 'reduce', exitSafe: true })).toEqual({ role: 'entry' });
        expect(triggerIntent({ market: 'S', effect: 'reverse', exitSafe: true })).toEqual({ role: 'entry' });
    });

    // #403 3147: 當沖先賣 1 張, then 觸買 1 張 to cover it — an exit, not an opening entry
    it('intent (stocks): a cash buy within today\'s 當沖先賣 to cover, or a cash sell within the shares held, is an exit', () => {
        const S = { market: 'S' as const, exitSafe: false, effect: 'open' as const };
        // cover buy ≤ 待補 → exit; more than 待補 → entry (the rest would open a long)
        expect(triggerIntent({ ...S, action: 'Buy', qty: 1, coverRoom: 1 })).toEqual({ role: 'exit' });
        expect(triggerIntent({ ...S, action: 'Buy', qty: 2, coverRoom: 1 })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Buy', qty: 1, coverRoom: 0 })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Buy', qty: 1 })).toEqual({ role: 'entry' });
        // the buy positions (#401: a projected short) never decide it
        expect(triggerIntent({ ...S, action: 'Buy', qty: 1, effect: 'reduce', exitSafe: true, coverRoom: 0 })).toEqual({ role: 'entry' });
        // a 融資 buy is no cover
        expect(triggerIntent({ ...S, action: 'Buy', qty: 1, coverRoom: 3, credit: { orderCond: 'MarginTrading' } })).toEqual({ role: 'entry' });
        // a cash sell within plain cash holdings → exit
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: true })).toEqual({ role: 'exit' });
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: true, credit: {} })).toEqual({ role: 'exit' });
        // more than held, holdings not plain cash, or unknown (no position rows: 'open')
        expect(triggerIntent({ ...S, action: 'Sell', qty: 3, effect: 'reverse', exitSafe: true })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: false })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'open', exitSafe: false })).toEqual({ role: 'entry' });
        // 當沖先賣 / 融資 / 融券 sells open (or carry a credit condition): entries
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: true, credit: { daytradeShort: true } })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: true, credit: { orderCond: 'MarginTrading' } })).toEqual({ role: 'entry' });
        expect(triggerIntent({ ...S, action: 'Sell', qty: 1, effect: 'reduce', exitSafe: true, credit: { orderCond: 'ShortSelling' } })).toEqual({ role: 'entry' });
    });

    it('send style: market (range market on futures when the panel says so) or a limit toward a fill', () => {
        const f = { market: 'F' as const, odd: false, mktPriceType: 'MKT' as const };
        expect(triggerSendOf({ type: 'MKT' }, { ...f, action: 'Buy' })).toBeUndefined();
        expect(triggerSendOf({ type: 'MKT' }, { ...f, mktPriceType: 'MKP', action: 'Buy' })).toEqual({ type: 'MKP' });
        expect(triggerSendOf({ type: 'LMT', ticks: 2 }, { ...f, action: 'Buy' })).toEqual({ type: 'LMT', ticks: 2 });
        expect(triggerSendOf({ type: 'LMT', ticks: 2 }, { ...f, action: 'Sell' })).toEqual({ type: 'LMT', ticks: -2 });
        expect(triggerSendOf({ type: 'MKT' }, { market: 'S', odd: false, mktPriceType: 'MKP', action: 'Buy' })).toBeUndefined();
        expect(triggerSendOf({ type: 'LMT', ticks: 2 }, { market: 'S', odd: true, mktPriceType: 'MKT', action: 'Buy' })).toBeUndefined();
    });
});

describe('ladder marks', () => {
    it('shows this panel\'s triggers only: account, product, unit, environment; alerts and time orders never', () => {
        const ts = [
            trig({ id: 'a' }),
            trig({ id: 'b', account: OTHER }),
            trig({ id: 'c', code: '2330', account: { ...F, account_type: 'S' } }),
            trig({ id: 'd', env: 'http://x|production' }),
            trig({ id: 'e', kind: 'alert' }),
            trig({ id: 'f', time: { kind: 'send', at: 1 }, price: 0 }),
            trig({ id: 'g', price: 101, action: 'Sell', condition: 'below', role: 'entry', bracketPlan: { tiers: [{ quantity: 1, takeTicks: 3 }], stopTicks: 2, trail: null, breakeven: null } }),
        ];
        const marks = ladderMarks(ts, [], scope, true);
        expect(marks.get('100.00')?.buy.map(m => m.id)).toEqual(['a']);
        const g = marks.get('101.00')!.sell[0]!;
        expect(g).toMatchObject({ id: 'g', kind: 'trigger', protects: true, editable: true });
        expect(g.title).toContain('成交後附停損停利');
        expect([...marks.keys()]).toEqual(['100.00', '101.00']);
    });

    it('a continuous alias, odd lots and the unknown environment', () => {
        const alias: MarkScope = { ...scope, code: 'TXFJ6', aliasOf: c => (c === 'TXFR1' ? 'TXFJ6' : undefined), env: null };
        expect(ladderMarks([trig({ id: 'a', env: 'http://x|production' })], [], alias, true).get('100.00')?.buy).toHaveLength(1);
        const S = { ...F, account_type: 'S' as const };
        const stock: MarkScope = { code: '2330', account: S, odd: true, env: ENV };
        const odd = trig({ id: 'o', code: '2330', account: S, orderLot: 'IntradayOdd', quantity: 300 });
        const lot = trig({ id: 'l', code: '2330', account: S });
        expect(ladderMarks([odd, lot], [], stock, false).get('100.00')?.buy.map(m => m.id)).toEqual(['o']);
        expect(ladderMarks([odd, lot], [], { ...stock, odd: false }, false).get('100.00')?.buy.map(m => m.id)).toEqual(['l']);
    });

    it('#263 a stock trigger mark says the credit condition it goes out with', () => {
        const S = { ...F, account_type: 'S' as const };
        const stock: MarkScope = { code: '2330', account: S, odd: false, env: ENV };
        const dt = trig({ id: 'd', code: '2330', account: S, action: 'Sell', condition: 'below', role: 'entry', daytradeShort: true });
        const cash = trig({ id: 'c', code: '2330', account: S, price: 101, role: 'entry' });
        const marks = ladderMarks([dt, cash], [], stock, false);
        expect(marks.get('100.00')!.sell[0]!.title).toContain('→ 賣 1 張・現股當沖先賣');
        expect(marks.get('101.00')!.buy[0]!.title).toContain('→ 買 1 張\n');
    });

    it('protection legs and grouped / pending triggers cannot be edited on the ladder', () => {
        const marks = ladderMarks([
            trig({ id: 's', bracketId: 'b1', kind: 'stop', action: 'Sell', condition: 'below', price: 95, quantity: 2 }),
            trig({ id: 't', bracketId: 'b1', kind: 'take', action: 'Sell', condition: 'above', price: 110, quantity: 2 }),
            trig({ id: 'o', group: 'g1', price: 120 }),
            trig({ id: 'p', price: 130, pending: { price: 131, at: 1 } }),
        ], [], scope, true);
        expect(marks.get('95.00')!.sell[0]).toMatchObject({ kind: 'stop', editable: false });
        expect(marks.get('110.00')!.sell[0]).toMatchObject({ kind: 'take', editable: false });
        expect(marks.get('120.00')!.buy[0]!.editable).toBe(false);
        expect(marks.get('130.00')!.buy[0]).toMatchObject({ editable: false, pending: true });
    });

    it('background brackets show their stop / take on the exit side while they hold; protected quantity counts each once', () => {
        const view: ProtectionView = { id: 'bkt:1', quoteCode: 'TXFR1', env: ENV, account: { accountType: 'F', brokerId: 'B', accountId: '1' },
            side: 'Buy', stop: 90, take: 120, position: 3, state: 'protected' };
        const marks = ladderMarks([], [view, { ...view, id: 'bkt:2', state: 'waitingEntry' }, { ...view, id: 'bkt:3', account: { ...view.account, accountId: '2' } }], scope, true);
        expect(marks.get('90.00')!.sell[0]).toMatchObject({ kind: 'stop', quantity: 3, background: true, editable: false });
        expect(marks.get('120.00')!.sell[0]).toMatchObject({ kind: 'take' });
        expect(marks.size).toBe(2);
        const legs = [trig({ id: 's', bracketId: 'b1', kind: 'stop', action: 'Sell', price: 95, quantity: 2 }),
            trig({ id: 't', bracketId: 'b1', kind: 'take', action: 'Sell', price: 110, quantity: 2 })];
        expect(protectedQuantity(legs, [view], scope, true)).toBe(5);
        // odd-lot panels: background brackets are whole lots only
        expect(protectedQuantity([], [view], { ...scope, odd: true }, true)).toBe(0);
    });
});

describe('drag', () => {
    const m = { editable: true, condition: 'above' as const, price: 105 };
    it('moves on the same side of the traded price only', () => {
        expect(dragProblem(m, 108, 100)).toBeNull();
        expect(dragProblem(m, 105, 100)).toBeNull();
        expect(dragProblem(m, 99, 100)).toContain('不能拖過');
        expect(dragProblem(m, 100, 100)).toContain('立刻觸發');
        expect(dragProblem(m, 108, null)).toContain('尚未收到成交價');
        expect(dragProblem({ ...m, editable: false }, 108, 100)).toContain('條件單面板');
    });
});
