import { describe, expect, it, vi } from 'vitest';

// the hooks' stores are not under test (and need a browser)
vi.mock('./trading-state', () => ({ useTradingState: () => ({}) }));
vi.mock('./company-data', () => ({ companyData: {} }));
import { FlowBook, SESSION_SLOTS, type GroupFlow, type KBarEvent } from './chain-flow';
import type { Theme } from './company-data/types';
import {
    buildAssigner,
    buyKey,
    dayPnlOf,
    detectFlips,
    fromPositions,
    othersNote,
    portfolioView,
    todayBuys,
    type CardInfo,
    type HeldGroup,
    type RawHolding,
} from './portfolio-sector';
import type { Trade } from './types/order';
import type { AccountedPosition } from './types/portfolio';

const DATE = '2026-10-22';
// 2026-10-22 10:30 Taipei
const NOW_MS = Date.parse('2026-10-22T10:30:00+08:00');
const TODAY_S = Math.floor(Date.parse('2026-10-22T09:15:00+08:00') / 1000);
const YESTERDAY_S = TODAY_S - 86_400;

const ACC1 = { broker_id: '9A95', account_id: '1', account_type: 'S', person_id: 'P', signed: true, username: 'u' };
const ACC2 = { ...ACC1, account_id: '2' };

const holding = (over: Partial<RawHolding>): RawHolding => ({
    code: '2330',
    shares: 1000,
    cost: 100,
    last: 100,
    todayShares: 0,
    todayCost: 0,
    ...over,
});

const trade = (over: {
    code?: string;
    action?: 'Buy' | 'Sell';
    lot?: string;
    cond?: string;
    type?: string;
    account?: '1' | '2';
    deals: { price: number; quantity: number; ts?: number }[];
}): Trade =>
    ({
        contract: { code: over.code ?? '2330', security_type: 'STK', exchange: 'TSE', region: 'TW', target_code: null },
        order: {
            id: 'x',
            seqno: '',
            ordno: '',
            action: over.action ?? 'Buy',
            price: 0,
            quantity: 1,
            order_lot: over.lot ?? 'Common',
            order_cond: over.cond ?? 'Cash',
            account: { broker_id: '9A95', account_id: over.account ?? '1', account_type: over.type ?? 'S' },
        },
        status: {
            id: 'x',
            status: 'Filled',
            status_code: '',
            order_quantity: 1,
            deal_quantity: 1,
            cancel_quantity: 0,
            modified_price: 0,
            msg: '',
            deals: over.deals.map((d, i) => ({ seq: String(i), price: d.price, quantity: d.quantity, ts: d.ts ?? TODAY_S })),
        },
    }) as unknown as Trade;

describe('todayBuys', () => {
    it('sums today’s cash buy fills per account in shares with the volume-weighted price', () => {
        const buys = todayBuys(
            [
                trade({ deals: [{ price: 100, quantity: 1 }, { price: 103, quantity: 2 }] }),
                trade({ lot: 'IntradayOdd', deals: [{ price: 106, quantity: 500 }] }),
                trade({ action: 'Sell', deals: [{ price: 110, quantity: 1 }] }),
                trade({ cond: 'MarginTrading', deals: [{ price: 99, quantity: 1 }] }),
                trade({ type: 'F', code: 'TXFK6', deals: [{ price: 99, quantity: 1 }] }),
                trade({ deals: [{ price: 90, quantity: 1, ts: YESTERDAY_S }] }),
                trade({ account: '2', deals: [{ price: 50, quantity: 1 }] }),
            ],
            NOW_MS,
        );
        expect([...buys.keys()].sort()).toEqual([buyKey(ACC1, '2330'), buyKey(ACC2, '2330')]);
        const b = buys.get(buyKey(ACC1, '2330'))!;
        expect(b.shares).toBe(3500);
        expect(b.avg).toBeCloseTo((100 * 1000 + 103 * 2000 + 106 * 500) / 3500);
        expect(buys.get(buyKey(ACC2, '2330'))).toEqual({ shares: 1000, avg: 50 });
    });

    it('accepts millisecond and nanosecond deal timestamps', () => {
        const ms = TODAY_S * 1000;
        const ns = TODAY_S * 1e9;
        const buys = todayBuys([trade({ deals: [{ price: 10, quantity: 1, ts: ms }, { price: 20, quantity: 1, ts: ns }] })], NOW_MS);
        expect(buys.get(buyKey(ACC1, '2330'))?.shares).toBe(2000);
    });
});

describe('dayPnlOf', () => {
    it('moves carried shares from the reference', () => {
        expect(dayPnlOf(holding({}), 106, 100)).toBe(6000);
    });

    it('moves shares bought today from their fill price', () => {
        // 1000 carried + 1000 bought today at 105; reference 100, last 106
        const h = holding({ shares: 2000, todayShares: 1000, todayCost: 105_000 });
        expect(dayPnlOf(h, 106, 100)).toBe(1000 * 6 + 1000 * 1);
    });

    it('is 0 without a reference', () => {
        expect(dayPnlOf(holding({}), 106, null)).toBe(0);
    });
});

describe('fromPositions', () => {
    const pos = (over: Partial<AccountedPosition & { yd_quantity: number; cond: string }>): AccountedPosition =>
        ({ id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 100, last_price: 101, pnl: 0, yd_quantity: 1000, account: ACC1, ...over }) as AccountedPosition;

    it('merges long cash rows by code with a weighted cost and today’s bought shares', () => {
        const rows = fromPositions(
            [
                pos({ quantity: 4000, price: 103, yd_quantity: 1000 }),
                pos({ code: '2454', direction: 'Sell' }),
                pos({ code: '2317', cond: 'MarginTrading' }),
                pos({ code: '2603', quantity: 0 }),
                { id: 2, code: 'TXFK6', direction: 'Buy', quantity: 1, price: 1, last_price: 1, pnl: 0 } as unknown as AccountedPosition,
            ],
            [trade({ deals: [{ price: 104, quantity: 3 }] })],
            NOW_MS,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ code: '2330', shares: 4000, cost: 103, todayShares: 3000, todayCost: 312_000 });
        expect(dayPnlOf(rows[0]!, 106, 100)).toBe(1000 * 6 + 3000 * 2);
    });

    it('never lets one account’s buys reclassify another account’s carried shares', () => {
        // account 1 bought 1000 at 105 and sold them all; account 2 holds 1000 carried
        const rows = fromPositions([pos({ account: ACC2 })], [trade({ deals: [{ price: 105, quantity: 1 }] })], NOW_MS);
        expect(rows[0]).toMatchObject({ shares: 1000, todayShares: 0 });
        expect(dayPnlOf(rows[0]!, 106, 100)).toBe(6000);
    });

    it('caps today’s buys by the row (bought and partly sold again)', () => {
        const rows = fromPositions([pos({ quantity: 500, yd_quantity: 0, price: 104 })], [trade({ deals: [{ price: 104, quantity: 2 }] })], NOW_MS);
        expect(dayPnlOf(rows[0]!, 106, 100)).toBe(500 * 2);
    });

    it('without fills: a row new today moves from its cost, an added part from the reference', () => {
        const fresh = fromPositions([pos({ yd_quantity: 0, price: 103 })], [], NOW_MS);
        expect(dayPnlOf(fresh[0]!, 106, 100)).toBe(3000);
        const added = fromPositions([pos({ quantity: 2000, yd_quantity: 1000, price: 103 })], [], NOW_MS);
        expect(dayPnlOf(added[0]!, 106, 100)).toBe(12000);
    });
});

const bar = (code: string, slot: number, close: number, amount: number): KBarEvent => ({
    code,
    date: DATE,
    slot,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    amount,
});

const card = (code: string, industry: string, industryCode: string, market = 'twse', over: Partial<CardInfo> = {}): CardInfo => ({
    code,
    name: code,
    market,
    industry,
    industryCode,
    chain: null,
    tier: null,
    mainTheme: null,
    ...over,
});

const member = (code: string) => ({ id: `tw.${code}`, stage: 's', tier: 'mid', detail: null, as_of: null, confidence: 'high' }) as Theme['members'][number];
const theme = (id: string, name: string, codes: string[], kind = 'theme'): Theme =>
    ({ id, kind, name, aliases: [], related: [], stages: [], members: codes.map(member), as_of: null }) as Theme;

describe('buildAssigner', () => {
    const cards = new Map([
        ['2330', card('2330', '半導體業', '24', 'twse', { mainTheme: 'theme.ai' })],
        ['5274', card('5274', '半導體業', '24', 'tpex')],
        ['0050', { ...card('0050', '', '', 'twse'), industry: null, industryCode: null }],
    ]);
    const themes = [theme('theme.cowos', 'CoWoS', ['2330']), theme('theme.ai', 'AI 伺服器', ['2330', '5274']), theme('theme.asic', 'ASIC', ['2330'])];

    it('族群 groups by industry and lists both markets’ stream groups', () => {
        const a = buildAssigner('sector', themes, cards);
        expect(a('2330').group).toMatchObject({ id: 'ind.24', name: '半導體業', icKeys: ['IX0001:24', 'IX0043:24'] });
        expect(a('5274').group.id).toBe('ind.24');
        expect(a('0050').group.id).toBe('none');
    });

    it('題材 uses the primary theme only and keeps the others for the tooltip', () => {
        const a = buildAssigner('theme', themes, cards);
        const r = a('2330');
        expect(r.group.name).toBe('AI 伺服器');
        expect(r.others).toEqual(['CoWoS', 'ASIC']);
        expect(a('5274').others).toEqual([]);
        expect(othersNote(r.others, '題材')).toBe('\n其他題材：CoWoS、ASIC');
        expect(othersNote(['a', 'b', 'c'], '題材', 2)).toBe('\n其他題材：a、b 等 3 個');
        expect(othersNote([], '題材')).toBe('');
    });
});

describe('portfolioView', () => {
    const cards = new Map([
        ['A', card('A', '甲業', '01')],
        ['B', card('B', '甲業', '01')],
        ['C', card('C', '乙業', '02')],
    ]);
    const assign = buildAssigner('sector', [], cards);
    const book = () => {
        const b = new FlowBook();
        for (const code of ['A', 'B', 'C']) b.seed(code, { ref: 100, close: 100, totalAmount: 0, shares: null, slot: 0 });
        for (let s = 0; s < 12; s += 1) {
            b.addBar(bar('A', s, 100 + (s + 1), 1000)); // rising: inflow
            b.addBar(bar('B', s, 100, 500)); // flat
            b.addBar(bar('C', s, 100 - (s + 1) * 0.5, 2000)); // falling: outflow
        }
        return b;
    };
    const holdings: RawHolding[] = [
        holding({ code: 'A', shares: 1000, cost: 90 }),
        holding({ code: 'B', shares: 2000, cost: 100 }),
        holding({ code: 'C', shares: 1000, cost: 120, todayShares: 1000, todayCost: 96_000 }),
    ];

    it('values holdings at the book price and groups them with the 10-minute window', () => {
        const v = portfolioView(holdings, assign, book(), 11, (c) => c);
        const a = v.stocks.find((s) => s.code === 'A')!;
        expect(a.last).toBe(112);
        expect(a.value).toBe(112_000);
        expect(a.pnl).toBe(22_000);
        expect(a.dayPnl).toBe(12_000);
        const c = v.stocks.find((s) => s.code === 'C')!;
        expect(c.last).toBe(94);
        expect(c.dayPnl).toBe(-2000); // from the 96 fill, not the 100 reference
        expect(v.total).toBe(112_000 + 200_000 + 94_000);
        expect(v.groups.map((g) => g.id)).toEqual(['ind.01', 'ind.02']);
        const g1 = v.groups[0]!;
        expect(g1.weight).toBeCloseTo(312_000 / v.total);
        // window = slots 2..11: A +1000 each, B flat
        expect(g1.recent.net).toBe(10_000);
        expect(g1.recent.turnover).toBe(15_000);
        expect(g1.recent.ratio).toBeCloseTo((10_000 / 15_000) * 100);
        expect(v.groups[1]!.recent.net).toBe(-20_000);
        expect(v.alignedShare).toBeCloseTo(312_000 / v.total);
        expect(v.dayPnl).toBe(12_000 + 0 - 2000);
    });

    it('takes 族群 flow from the external source when it has one', () => {
        const turnover = new Float64Array(SESSION_SLOTS);
        const net = new Float64Array(SESSION_SLOTS);
        turnover[11] = 400;
        net[11] = -300;
        const ext: GroupFlow = {
            count: 900,
            turnover,
            net,
            cumNet: net,
            flow5: -300,
            turnover5: 400,
            accel: null,
            total: 400,
            pct: -1.5,
            breadth: { up: 0, flat: 0, down: 0 },
        };
        const v = portfolioView(holdings, assign, book(), 11, (c) => c, (def) => (def.id === 'ind.01' ? ext : null));
        const g1 = v.groups.find((g) => g.id === 'ind.01')!;
        expect(g1.flow).toBe(ext);
        expect(g1.recent).toEqual({ net: -300, turnover: 400, ratio: -75 });
        expect(g1.members).toBe(900);
        expect(v.groups.find((g) => g.id === 'ind.02')!.recent.net).toBe(-20_000); // book fallback
    });

    it('has no window before the first bar', () => {
        const v = portfolioView(holdings, assign, book(), null, (c) => c);
        expect(v.groups[0]!.recent).toEqual({ net: 0, turnover: 0, ratio: null });
        expect(v.alignedShare).toBe(0);
    });
});

describe('detectFlips', () => {
    const g = (id: string, ratio: number | null): HeldGroup => ({ id, name: id, stocks: [], recent: { net: 0, turnover: 0, ratio } }) as unknown as HeldGroup;

    it('alerts when a group crosses to the other side beyond the dead band', () => {
        const first = detectFlips(new Map(), [g('a', 5), g('b', -4), g('none', 9)], 10);
        expect(first.alerts).toEqual([]);
        const second = detectFlips(first.next, [g('a', -3.5), g('b', 1), g('none', -9)], 11);
        expect(second.alerts).toEqual([{ groupId: 'a', name: 'a', slot: 11, to: 'out', held: 0 }]);
        expect(second.next.get('b')).toBe(-1); // inside the dead band keeps its side
        const third = detectFlips(second.next, [g('a', null), g('b', 3)], 12);
        expect(third.alerts.map((x) => [x.groupId, x.to])).toEqual([['b', 'in']]);
        expect(third.next.get('a')).toBe(-1);
    });
});
