import { describe, expect, it } from 'vitest';
import {
    execReduce,
    execSummary,
    initExec,
    isBrokerFinal,
    potentialOf,
    takeOddOrders,
    type ExecCommand,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type HedgeQuote,
} from './odd-spread-exec';

const SELL_ODD: ExecPlan = {
    direction: 'buyRoundSellOdd',
    mode: 'sequential',
    lots: 1,
    roundPrice: 1085,
    oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }],
    netPerShare: 1.76,
};

// 補單定價：預設以計畫價可送；個別測試可改成不可送
function ctxOf(fn?: (leg: 'odd' | 'round', action: 'Buy' | 'Sell', qty: number) => HedgeQuote): ExecContext & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        calls,
        quoteHedge: (leg, action, qty) => {
            calls.push([leg, action, qty]);
            return fn ? fn(leg, action, qty) : { ok: true, orders: [{ price: leg === 'round' ? 1085 : 1095, quantity: qty }] };
        },
    };
}

function run(plan: ExecPlan, events: ExecEvent[], ctx: ExecContext = ctxOf(), from?: ExecState): { state: ExecState; commands: ExecCommand[] } {
    let state = from ?? initExec(plan);
    const commands: ExecCommand[] = [];
    for (const e of events) {
        const r = execReduce(state, e, ctx);
        state = r.state;
        commands.push(...r.commands);
    }
    return { state, commands };
}

const places = (cmds: ExecCommand[]) => cmds.filter(c => c.kind === 'place');
const oddFilled: ExecEvent[] = [
    { type: 'start' },
    { type: 'placed', key: 'odd:0', orderId: 'A' },
    { type: 'placed', key: 'odd:1', orderId: 'B' },
    { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
    { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
];
const LOTS2: ExecPlan = { ...SELL_ODD, lots: 2, oddOrders: [{ price: 1095, quantity: 999 }, { price: 1095, quantity: 999 }, { price: 1095, quantity: 2 }] };

describe('sequential：零股成交後再送整股', () => {
    it('start 只送零股那一腳（每檔一筆），整股等零股成交確定', () => {
        const { state, commands } = run(SELL_ODD, [{ type: 'start' }]);
        expect(state.phase).toBe('oddPending');
        expect(commands).toEqual([
            { kind: 'place', key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620 },
        ]);
    });

    it('零股全部成交 → 以當下價重新定價送整股 → 整股成交 → done', () => {
        const ctx = ctxOf();
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(r.state.phase).toBe('roundPending');
        expect(ctx.calls).toEqual([['round', 'Buy', 1]]);
        expect(places(r.commands).at(-1)).toEqual({ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 });
        const done = run(SELL_ODD, [
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
        ], ctx, r.state);
        expect(done.state.phase).toBe('done');
        expect(execSummary(done.state).unhedgedShares).toBe(0);
    });

    it('補單以最新價：價格已變，送出的是重新定價後的限價', () => {
        const ctx = ctxOf(() => ({ ok: true, orders: [{ price: 1090, quantity: 1 }] }));
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(places(r.commands).at(-1)).toMatchObject({ leg: 'round', price: 1090, quantity: 1 });
    });

    it('補單超出滑價上限或不足成本：不送，停在未配對待處理，由使用者決定', () => {
        const ctx = ctxOf(() => ({ ok: false, reason: '價格已偏離計畫價超過 2 檔', orders: [{ price: 1100, quantity: 1 }] }));
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(places(r.commands)).toHaveLength(2);
        expect(r.state.phase).toBe('hedgeDecision');
        expect(r.state.pendingHedge).toEqual({ leg: 'round', action: 'Buy', quantity: 1, reason: '價格已偏離計畫價超過 2 檔', orders: [{ price: 1100, quantity: 1 }], version: 1 });
        // 以最新價補單
        const accept = execReduce(r.state, { type: 'hedgeAccept', version: 1, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1105, quantity: 1 }] }, ctx);
        expect(accept.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1105, quantity: 1 }]);
        expect(accept.state.phase).toBe('roundPending');
        // 或取消：保留未配對、結束
        const decline = execReduce(r.state, { type: 'hedgeDecline', version: 1 }, ctx);
        expect(decline.commands).toEqual([]);
        expect(decline.state.phase).toBe('failed');
        expect(execSummary(decline.state).unhedgedShares).toBe(1000);
    });

    it('第一腳成交量未確定前絕不送第二腳（部分成交、仍在委託中）', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 600, status: 'working' },
        ]);
        expect(state.phase).toBe('oddPartial');
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
    });

    it('部分成交後取消：刪剩餘零股，已成交的整張配對整股，零頭列未配對', () => {
        const { state, commands } = run(LOTS2, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'odd:2', orderId: 'C' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 500, status: 'working' },
            { type: 'cancel' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([
            { kind: 'cancel', key: 'odd:1', orderId: 'B' },
            { kind: 'cancel', key: 'odd:2', orderId: 'C' },
        ]);
        const r = run(LOTS2, [
            { type: 'report', key: 'odd:1', filled: 500, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled' },
        ], ctxOf(), state);
        // 1,499 股 → floor = 1 張
        expect(r.commands).toEqual([{ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        const fin = run(LOTS2, [
            { type: 'placed', key: 'round:3', orderId: 'R' },
            { type: 'report', key: 'round:3', filled: 1, status: 'filled' },
        ], ctxOf(), r.state);
        expect(fin.state.phase).toBe('failed');
        expect(execSummary(fin.state)).toMatchObject({ oddFilledShares: 1499, roundFilledLots: 1, unhedgedShares: 499 });
    });

    it('零股不足 1 張就取消：不送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 200, status: 'working' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:0', filled: 200, status: 'cancelled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
        expect(state.phase).toBe('failed');
        expect(execSummary(state).unhedgedShares).toBe(200);
    });

    it('零股確定未送出（placeFailed）→ failed、不送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placeFailed', key: 'odd:0', error: '庫存不足' },
            { type: 'placeFailed', key: 'odd:1', error: '庫存不足' },
        ]);
        expect(state.phase).toBe('failed');
        expect(places(commands)).toHaveLength(2);
    });

    it('冪等：重複 start、重複與倒退的回報都不會重送', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:0', orderId: 'A2' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 100, status: 'working' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toHaveLength(1);
        expect(places(commands)).toHaveLength(3);
        expect(state.slots.find(s => s.key === 'odd:0')?.orderId).toBe('A');
        expect(state.slots.find(s => s.key === 'odd:1')?.filled).toBe(620);
    });

    it('成交先於下單回應：先記成交，回應到了再記委託編號，第二腳只送一次', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toHaveLength(1);
        expect(state.slots.map(s => s.orderId)).toEqual(['A', 'B', undefined]);
        expect(state.phase).toBe('roundPending');
    });

    it('送出途中取消：拿到委託編號立刻刪單；取消前已成交則照計畫送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        const r = execReduce(state, { type: 'report', key: 'odd:1', filled: 620, status: 'filled' }, ctxOf());
        expect(r.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
    });

    it('買零→賣整：買零股、依成交送賣整股', () => {
        const plan: ExecPlan = { direction: 'buyOddSellRound', mode: 'sequential', lots: 1, roundPrice: 1080, oddOrders: [{ price: 1060, quantity: 600 }, { price: 1065, quantity: 400 }] };
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 600, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 400, status: 'filled' },
        ]);
        expect(places(commands).map(c => c.kind === 'place' && `${c.leg}:${c.action}`)).toEqual(['odd:Buy', 'odd:Buy', 'round:Sell']);
        expect(state.phase).toBe('roundPending');
    });

    it('整股補單被刪或被拒：不自動重送，回到未配對待處理', () => {
        const r = run(SELL_ODD, [
            ...oddFilled,
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'cancel' },
            { type: 'report', key: 'round:2', filled: 0, status: 'cancelled' },
        ]);
        expect(places(r.commands)).toHaveLength(3);
        expect(r.state.phase).toBe('hedgeDecision');
        expect(r.state.pendingHedge?.reason).toBe('補單未成交（被拒或已刪除）');
        const failed = run(SELL_ODD, [...oddFilled, { type: 'placeFailed', key: 'round:2', error: 'x' }]);
        expect(places(failed.commands)).toHaveLength(3);
        expect(failed.state.phase).toBe('hedgeDecision');
    });
});

describe('結果不明（unknown）', () => {
    it('可能已送出的錯誤不是終態：不決定第二腳、phase=unknown', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
        ]);
        expect(state.phase).toBe('unknown');
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
        expect(execSummary(state).unknownCount).toBe(1);
    });

    it('事後對上委託並成交 → 照實際成交送第二腳，不少算', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        expect(state.phase).toBe('roundPending');
    });

    it('使用者核對標記未送出 → 依已成交決定；事後又成交（晚到）→ 重新計算並補第二腳', () => {
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:2', orderId: 'C' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
            { type: 'resolveUnknown', key: 'odd:1' },
        ]);
        // 1,001 股 → 1 張
        expect(places(r.commands).filter(c => c.leg === 'round')).toEqual([{ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        const fin = run(LOTS2, [
            { type: 'placed', key: 'round:3', orderId: 'R' },
            { type: 'report', key: 'round:3', filled: 1, status: 'filled' },
        ], ctxOf(), r.state);
        expect(fin.state.phase).toBe('failed');
        // 被標記未送出的那筆其實有送、事後全數成交 → 補 1 張
        const late = run(LOTS2, [
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:1', filled: 999, status: 'filled' },
        ], ctxOf(), fin.state);
        expect(places(late.commands)).toEqual([{ kind: 'place', key: 'round:4', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        expect(late.state.phase).toBe('roundPartial');
    });

    it('unknown 時取消：對上委託編號後立即刪單', () => {
        const { commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placeUnknown', key: 'odd:0', error: 'timeout' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:0', orderId: 'A' }]);
    });
});

describe('終態後的晚到成交', () => {
    it('零股刪單後才回報成交：已結束的執行重新計算並補送第二腳', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'cancelled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(r.state.phase).toBe('failed');
        const late = execReduce(r.state, { type: 'report', key: 'odd:1', filled: 620, status: 'cancelled' }, ctxOf());
        expect(late.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
    });

    it('已選擇不補後又有晚到成交：新的缺口重新列為未配對待處理', () => {
        const ctx = ctxOf(() => ({ ok: false, reason: '不足成本', orders: [] }));
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 1, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled' },
            { type: 'hedgeDecline', version: 1 },
        ], ctx);
        expect(r.state.phase).toBe('failed');
        expect(r.state.waived.round).toBe(1);
        const late = run(LOTS2, [
            { type: 'report', key: 'odd:1', filled: 999, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'cancelled' },
        ], ctx, r.state);
        expect(late.state.phase).toBe('hedgeDecision');
        expect(late.state.pendingHedge?.quantity).toBe(1);
    });
});

describe('sequential：整股先送（firstLeg=round）', () => {
    it('零股賣出股數 = 整股成交股數', () => {
        const plan: ExecPlan = { ...LOTS2, firstLeg: 'round' };
        const ctx = ctxOf((_leg, _a, qty) => ({ ok: true, orders: [{ price: 1095, quantity: 999 }, { price: 1090, quantity: qty - 999 }] }));
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'round:0', orderId: 'R' },
            { type: 'report', key: 'round:0', filled: 1, status: 'working' },
            { type: 'cancel' },
            { type: 'report', key: 'round:0', filled: 1, status: 'cancelled' },
        ], ctx);
        expect(places(commands)).toEqual([
            { kind: 'place', key: 'round:0', leg: 'round', action: 'Buy', price: 1085, quantity: 2 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1095, quantity: 999 },
            { kind: 'place', key: 'odd:2', leg: 'odd', action: 'Sell', price: 1090, quantity: 1 },
        ]);
        expect(state.phase).toBe('oddPending');
    });
});

describe('simultaneous：兩腳同時送', () => {
    const plan: ExecPlan = { ...SELL_ODD, mode: 'simultaneous' };
    it('一次送出全部委託，全部成交 → done', () => {
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
        ]);
        expect(places(commands)).toHaveLength(3);
        expect(state.phase).toBe('done');
    });
    it('取消後一腳沒成交 → 不自動補，列為未配對待處理（附最新價補單建議）', () => {
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        expect(places(commands)).toHaveLength(3);
        expect(state.phase).toBe('hedgeDecision');
        expect(state.pendingHedge).toMatchObject({ leg: 'odd', action: 'Sell', quantity: 620 });
        expect(execSummary(state).unhedgedShares).toBe(380 - 1000);
    });
    it('進行中為 bothPending', () => {
        expect(run(plan, [{ type: 'start' }]).state.phase).toBe('bothPending');
    });
});

describe('刪單結果', () => {
    it('刪單失敗可再按取消重試；等待結果中不重送；受理後仍在委託中可再刪', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'cancel' },
            { type: 'cancel' },
        ]);
        expect(r.commands.filter(c => c.kind === 'cancel')).toHaveLength(2);
        expect(r.state.slots.map(x => x.cancelState)).toEqual(['pending', 'pending']);
        const f = run(SELL_ODD, [
            { type: 'cancelResult', key: 'odd:0', ok: false, error: '網路錯誤' },
            { type: 'cancelResult', key: 'odd:1', ok: true },
        ], ctxOf(), r.state);
        expect(f.state.slots[0]).toMatchObject({ cancelState: 'failed', cancelError: '網路錯誤', status: 'working' });
        expect(f.state.slots[1]).toMatchObject({ cancelState: 'sent' });
        const retry = execReduce(f.state, { type: 'cancel' }, ctxOf());
        expect(retry.commands).toEqual([
            { kind: 'cancel', key: 'odd:0', orderId: 'A' },
            { kind: 'cancel', key: 'odd:1', orderId: 'B' },
        ]);
        expect(retry.state.slots[0]!.cancelError).toBeUndefined();
    });
});

describe('第四輪：總量模型', () => {
    it('標記「未送出」是暫定：委託之後出現（Submitted）就回到委託中、可刪單；多出的補單自動刪', () => {
        const r = run(SELL_ODD, [
            ...oddFilled,
            { type: 'placeUnknown', key: 'round:2', error: 'timeout' },
            { type: 'resolveUnknown', key: 'round:2' },
        ]);
        // 使用者認為沒送出 → 以當下價補一張
        expect(places(r.commands).map(c => c.kind === 'place' && c.key)).toEqual(['odd:0', 'odd:1', 'round:2', 'round:3']);
        expect(r.state.slots.find(x => x.key === 'round:2')).toMatchObject({ status: 'unknown', markedUnsent: true });
        // 原單其實有送到：出現在委託列
        const back = run(SELL_ODD, [
            { type: 'placed', key: 'round:2', orderId: 'R2' },
            { type: 'report', key: 'round:2', filled: 0, status: 'working' },
        ], ctxOf(), r.state);
        expect(back.state.slots.find(x => x.key === 'round:2')).toMatchObject({ status: 'working', markedUnsent: false, orderId: 'R2' });
        // 兩張在途、只需要一張 → 刪最新的補單（還沒拿到委託編號 → 拿到就刪）
        expect(potentialOf(back.state, 'round')).toBe(2);
        expect(back.state.slots.find(x => x.key === 'round:3')).toMatchObject({ cancelWanted: true, surplus: true });
        const got = execReduce(back.state, { type: 'placed', key: 'round:3', orderId: 'R3' }, ctxOf());
        expect(got.commands).toEqual([{ kind: 'cancel', key: 'round:3', orderId: 'R3' }]);
        // 也能由使用者刪回來的那筆
        const cancel = execReduce(got.state, { type: 'cancel' }, ctxOf());
        expect(cancel.commands).toEqual([{ kind: 'cancel', key: 'round:2', orderId: 'R2' }]);
    });

    it('兩腳同時送：補單進行中，刪掉的單晚到成交 → 重算後多出的補單被刪（2,000 股 vs 1 張）', () => {
        const plan: ExecPlan = { ...SELL_ODD, mode: 'simultaneous' };
        const r = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled', cancelled: 620 },
            { type: 'hedgeAccept', version: 1, leg: 'odd', action: 'Sell', quantity: 620, orders: [{ price: 1090, quantity: 620 }] },
            { type: 'placed', key: 'odd:3', orderId: 'H' },
        ]);
        expect(potentialOf(r.state, 'odd')).toBe(1000);
        // 刪單前其實已成交 620（回報晚到）
        const late = execReduce(r.state, { type: 'report', key: 'odd:1', filled: 620, status: 'cancelled' }, ctxOf());
        expect(late.commands).toEqual([{ kind: 'cancel', key: 'odd:3', orderId: 'H' }]);
        expect(late.state.slots.find(x => x.key === 'odd:3')).toMatchObject({ surplus: true, cancelState: 'pending' });
    });

    it('補單在途時不再補；在途量足以補上缺口就不送', () => {
        const r = run(SELL_ODD, [...oddFilled, { type: 'placed', key: 'round:2', orderId: 'R' }, { type: 'report', key: 'round:2', filled: 0, status: 'working' }]);
        expect(places(r.commands)).toHaveLength(3);
        const again = execReduce(r.state, { type: 'report', key: 'odd:0', filled: 380, status: 'filled' }, ctxOf());
        expect(again.commands).toEqual([]);
    });

    it('終態只認券商確認：零成交刪單要刪單量對上才算終態', () => {
        const slot = { key: 'odd:0', leg: 'odd' as const, action: 'Sell' as const, price: 1, quantity: 380, filled: 0 };
        expect(isBrokerFinal({ ...slot, status: 'cancelled' })).toBe(false);
        expect(isBrokerFinal({ ...slot, status: 'cancelled', cancelledQty: 380 })).toBe(true);
        expect(isBrokerFinal({ ...slot, status: 'cancelled', filled: 100, cancelledQty: 280 })).toBe(true);
        expect(isBrokerFinal({ ...slot, status: 'unknown', markedUnsent: true })).toBe(false);
        expect(isBrokerFinal({ ...slot, status: 'failed', local: true })).toBe(true);
        expect(isBrokerFinal({ ...slot, status: 'working' })).toBe(false);
    });

    it('券商終態不被較舊的「委託中」回報蓋回；晚到成交仍累加', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 0, status: 'cancelled', cancelled: 380 },
            { type: 'report', key: 'odd:0', filled: 0, status: 'working' },
        ]);
        expect(r.state.slots[0]!.status).toBe('cancelled');
        const late = execReduce(r.state, { type: 'report', key: 'odd:0', filled: 200, status: 'working' }, ctxOf());
        expect(late.state.slots[0]).toMatchObject({ status: 'cancelled', filled: 200 });
    });
});

describe('第五輪：券商回讀型態與補單確認', () => {
    it('晚到的拒單（Failed、刪單量 0）是終態：計畫 2 張、零股成交 1,001 股、其餘 999 被拒 → 補 1 張', () => {
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'odd:2', orderId: 'C' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'working' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'failed', cancelled: 0 },
        ]);
        expect(potentialOf(r.state, 'odd')).toBe(1001);
        expect(places(r.commands).at(-1)).toEqual({ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1085, quantity: 1 });
    });

    it('全部刪單後回讀仍是 Submitted、刪單量已涵蓋全部 → 終態，照已成交配對', () => {
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'working', cancelled: 999 },
        ]);
        expect(r.state.slots.find(x => x.key === 'odd:1')!.status).toBe('cancelled');
        expect(places(r.commands).at(-1)).toMatchObject({ leg: 'round', quantity: 1 });
    });

    it('部分刪單後仍 Submitted：剩餘量扣掉刪單量', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'report', key: 'odd:1', filled: 100, status: 'working', cancelled: 400 },
        ]);
        expect(r.state.slots.find(x => x.key === 'odd:1')!.status).toBe('working');
        expect(potentialOf(r.state, 'odd')).toBe(380 + 100 + 120);
    });

    it('補單確認：數量與價格凍結；缺口在確認期間變了就不送', () => {
        const ctx = ctxOf(() => ({ ok: false, reason: '超過滑價上限', orders: [{ price: 1100, quantity: 1 }] }));
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 1, status: 'cancelled', cancelled: 998 },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled', cancelled: 2 },
        ], ctx);
        expect(r.state.pendingHedge?.quantity).toBe(1);
        // 使用者確認了 1 張；確認期間晚到成交讓缺口變 2 張（此處以直接改狀態模擬重算後的新缺口）
        const grown = { ...r.state, pendingHedge: { ...r.state.pendingHedge!, quantity: 2 } };
        const v = r.state.pendingHedge!.version;
        const stale = execReduce(grown, { type: 'hedgeAccept', version: v, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx);
        expect(stale.commands).toEqual([]);
        expect(stale.state).toBe(grown);
        // 數量不符或委託總量不符都不送
        expect(execReduce(r.state, { type: 'hedgeAccept', version: v, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 2 }] }, ctx).commands).toEqual([]);
        // 相符 → 只送確認的那一份
        // 版本、腳或方向不同都不送（例如待補改成賣 1 股零股，舊確認不能拿來用）
        expect(execReduce(r.state, { type: 'hedgeAccept', version: v + 1, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx).commands).toEqual([]);
        expect(execReduce(r.state, { type: 'hedgeAccept', version: v, leg: 'odd', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx).commands).toEqual([]);
        expect(execReduce(r.state, { type: 'hedgeAccept', version: v, leg: 'round', action: 'Sell', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx).commands).toEqual([]);
        const ok = execReduce(r.state, { type: 'hedgeAccept', version: v, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx);
        expect(ok.commands).toEqual([{ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1100, quantity: 1 }]);
    });

    it('sidecar 重啟後以標記接回的新 id 取代舊 id（rebind），之後回報照常', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A', gen: 'g0' },
            { type: 'placed', key: 'odd:0', orderId: 'Z', gen: 'g1' }, // 沒有 rebind → 不換
        ]);
        expect(r.state.slots[0]).toMatchObject({ orderId: 'A', idGen: 'g0' });
        const re = execReduce(r.state, { type: 'placed', key: 'odd:0', orderId: 'Z', gen: 'g1', rebind: true }, ctxOf());
        expect(re.state.slots[0]).toMatchObject({ orderId: 'Z', idGen: 'g1', status: 'working' });
    });
});

describe('第六輪：委託編號只在同一伺服器身分可信', () => {
    it('身分變了不以舊編號刪單：登記待重新接回；以標記接回新編號後才刪', () => {
        let gen: string | null = 'g1';
        const ctx: ExecContext = { ...ctxOf(), currentGen: () => gen };
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A', gen: 'g1' },
            { type: 'placed', key: 'odd:1', orderId: 'B', gen: 'g1' },
        ], ctx);
        gen = 'g2'; // sidecar 重啟（串流重連）
        const c = execReduce(r.state, { type: 'cancel' }, ctx);
        expect(c.commands).toEqual([]);
        expect(c.state.slots.map(x => x.cancelWanted)).toEqual([true, true]);
        const re = execReduce(c.state, { type: 'placed', key: 'odd:0', orderId: 'A2', gen: 'g2', rebind: true }, ctx);
        expect(re.commands).toEqual([{ kind: 'cancel', key: 'odd:0', orderId: 'A2' }]);
        // 身分無法判定（串流中斷）也不刪
        gen = null;
        const none = execReduce(re.state, { type: 'placed', key: 'odd:1', orderId: 'B2', gen: null, rebind: true }, ctx);
        expect(none.commands).toEqual([]);
    });
});

describe('第七輪：補單版本、放棄追蹤、零股拆單', () => {
    it('待補內容換腳／方向／數量就換版本；舊版本的確認與拒絕都無效', () => {
        const plan: ExecPlan = { ...SELL_ODD, mode: 'simultaneous' };
        const ctx = ctxOf(() => ({ ok: false, reason: 'x', orders: [{ price: 1100, quantity: 1 }] }));
        const r = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'round:2', filled: 0, status: 'cancelled', cancelled: 1 },
        ], ctx);
        const p1 = r.state.pendingHedge!;
        expect(p1).toMatchObject({ leg: 'round', action: 'Buy', quantity: 1 });
        // 同內容重算 → 版本不變
        const same = execReduce(r.state, { type: 'refresh' }, ctx);
        expect(same.state.pendingHedge!.version).toBe(p1.version);
        // 待補改成賣 1 股零股（此處直接改狀態模擬重算結果）→ 舊確認不能送
        const switched = { ...r.state, pendingHedge: { leg: 'odd' as const, action: 'Sell' as const, quantity: 1, reason: 'y', orders: [{ price: 1095, quantity: 1 }], version: p1.version + 1 } };
        expect(execReduce(switched, { type: 'hedgeAccept', version: p1.version, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] }, ctx).commands).toEqual([]);
        expect(execReduce(switched, { type: 'hedgeDecline', version: p1.version }, ctx).state).toBe(switched);
    });

    it('零股補單超過 999 股自動拆筆（總量不變）', () => {
        const plan: ExecPlan = { ...LOTS2, mode: 'simultaneous' };
        const r = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'round:3', filled: 2, status: 'filled' },
            { type: 'report', key: 'odd:0', filled: 0, status: 'cancelled', cancelled: 999 },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled', cancelled: 999 },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled', cancelled: 2 },
        ]);
        const p = r.state.pendingHedge!;
        expect(p).toMatchObject({ leg: 'odd', quantity: 2000 });
        const ok = execReduce(r.state, { type: 'hedgeAccept', version: p.version, leg: 'odd', action: 'Sell', quantity: 2000, orders: [{ price: 1095, quantity: 2000 }] }, ctxOf());
        expect(ok.commands.map(c => c.kind === 'place' && c.quantity)).toEqual([999, 999, 2]);
    });

    it('「確認沒有送出，結束追蹤」只對已標記未送出的委託有效，之後不再接回', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placeUnknown', key: 'odd:0', error: 'timeout' },
            { type: 'abandonUnknown', key: 'odd:0' }, // 還沒標記 → 無效
        ]);
        expect(r.state.slots[0]!.status).toBe('unknown');
        const m = run(SELL_ODD, [{ type: 'resolveUnknown', key: 'odd:0' }, { type: 'abandonUnknown', key: 'odd:0' }], ctxOf(), r.state);
        expect(m.state.slots[0]).toMatchObject({ status: 'failed', local: true, abandoned: true });
        const late = execReduce(m.state, { type: 'placed', key: 'odd:0', orderId: 'X' }, ctxOf());
        expect(late.state).toBe(m.state);
    });
});

describe('其他', () => {
    it('未開始就取消 → cancelled，之後 start 不送單', () => {
        const { state, commands } = run(SELL_ODD, [{ type: 'cancel' }, { type: 'start' }]);
        expect(state.phase).toBe('cancelled');
        expect(commands).toEqual([]);
    });
    it('計畫為空 → failed', () => {
        expect(run({ ...SELL_ODD, lots: 0 }, [{ type: 'start' }]).state.phase).toBe('failed');
    });
    it('takeOddOrders 依計畫價位取前 N 股', () => {
        expect(takeOddOrders([{ price: 10, quantity: 999 }, { price: 9, quantity: 999 }], 1200)).toEqual([
            { price: 10, quantity: 999 },
            { price: 9, quantity: 201 },
        ]);
    });
});
