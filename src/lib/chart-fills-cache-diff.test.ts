// 快取版和冷算版每一步結果相同（固定種子）：盤中加成交、改成交、彈出視窗複本、重複委託、新棒、換週期
import { expect, it } from 'vitest';
import { createProjectionCache, projectChartFills } from './chart-fills';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';
import type { AccountedTrade, Deal } from './types/order';
import type { Account } from './types/portfolio';

function rng(a: number) { return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const fAccount: Account = { account_type: 'F', broker_id: 'A', account_id: '1', person_id: '', signed: true, username: 'u' };
const fut: ContractBase = { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null };
const stk: ContractBase = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null };
const stkAccount: Account = { ...fAccount, account_type: 'S' };
const t0 = Date.parse('2026-10-13T12:30:00+08:00') / 1000;
const wall0 = Date.parse('2026-10-13T12:30:00Z') / 1000;

const bar = (time: number): Candle => ({ time, open: 100, high: 100, low: 100, close: 100, volume: 1 });
const deal = (seq: string, ts = t0): Deal => ({ seq, ts, price: 100, quantity: 1 });
const trade = (deals: Deal[], account = fAccount, contract = fut): AccountedTrade => ({ account, contract,
    order: { id: 'o1', seqno: 's', ordno: 'n', action: 'Buy', price: 100, quantity: 9, account },
    status: { id: 'o1', status: 'PartFilled', status_code: '00', order_quantity: 9, deal_quantity: deals.length,
        cancel_quantity: 0, modified_price: 0, msg: '', deals } });

it('快取版與冷算版逐步一致（固定種子 200 組 × 60 步）', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
        const r = rng(seed);
        const contract = seed % 2 ? fut : stk;
        const account = seed % 2 ? fAccount : stkAccount;
        const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
        const mkDeal = (): Deal => ({ seq: pick(['1', '2', '3']), ts: t0 + Math.floor(r() * 3600), price: pick([100, 101]), quantity: 1 });
        const mkTrade = (id = pick(['o1', 'o2', 'o3'])): AccountedTrade => ({ account, contract,
            order: { id, seqno: 's', ordno: 'n', action: pick(['Buy', 'Sell'] as const), price: 100, quantity: 9, account },
            status: { id, status: 'PartFilled', status_code: '00', order_quantity: 9, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [mkDeal()] } });
        const withDeals = (t: AccountedTrade, deals: Deal[]) => ({ ...t, status: { ...t.status, deals } });
        const cache = createProjectionCache();
        let trades = [mkTrade()];
        let minutes = 5;
        let bars: Candle[] = [];
        const grow = (n: number) => { for (let i = 0; i < n; i += 1) bars.push({ time: wall0 + 60 * minutes * (bars.length + 1), open: 1, high: 1, low: 1, close: 1, volume: 1 }); };
        grow(4);
        const ops = [
            () => { trades = [...trades, mkTrade()]; },
            () => { const i = Math.floor(r() * trades.length); trades = trades.map((t, j) => j === i ? withDeals(t, [...t.status.deals, mkDeal()]) : t); },
            () => { const i = Math.floor(r() * trades.length); trades = trades.map((t, j) => j === i ? withDeals(t, t.status.deals.map((d, k) => k === 0 ? { ...d, ts: d.ts + 300 } : d)) : t); },
            () => { trades = structuredClone(trades); },
            () => { const t = pick(trades); trades = [...trades, r() < 0.5 ? structuredClone(t) : withDeals(t, [...t.status.deals, mkDeal()])]; },
            () => { const i = Math.floor(r() * trades.length); trades = trades.map((t, j) => j === i ? withDeals(t, t.status.deals.slice(0, -1)) : t); },
            () => { if (trades.length > 1) trades = trades.slice(1); },
            () => grow(1),
            () => { minutes = pick([1, 5, 15]); bars = []; grow(Math.floor(r() * 60)); },
        ];
        for (let step = 0; step < 60; step += 1) {
            pick(ops)();
            const input = { trades, contract, account, bars, minutes, dayOnly: false };
            expect(projectChartFills(input, cache), `seed ${seed} step ${step}`).toEqual(projectChartFills(input));
        }
    }
});

it('換月分界依序從無到兩個時間再回到無，每一步與冷算相同', () => {
    const cache = createProjectionCache();
    const contract = { ...fut, code: 'TXFR1', target_code: fut.code };
    const deals = [deal('1'), deal('2', t0 + 300), deal('3', t0 + 600)];
    const trades = [trade(deals), trade(deals, fAccount, { ...fut, code: 'TXFI6' })];
    const input = { trades, contract, account: fAccount, bars: [300, 600, 900].map(offset => bar(wall0 + offset)), minutes: 5, dayOnly: false };
    for (const rollover of [null, { previous: 'TXFI6', cutoff: t0 + 180 }, { previous: 'TXFI6', cutoff: t0 + 480 }, null]) {
        const next = { ...input, rollover };
        const actual = projectChartFills(next, cache);
        expect(actual).toEqual(projectChartFills(next));
        expect(actual.fills).toHaveLength(3);
    }
});

it('同識別帳戶換物件與資料、帳戶集合增減空集合及重複帳戶，每一步與冷算相同', () => {
    const cache = createProjectionCache();
    const updated = { ...fAccount, username: '更新後', signed: false };
    const second = { ...fAccount, account_id: '2' };
    const input = { trades: [trade([deal('1')]), trade([deal('2')], second)], contract: fut,
        bars: [bar(wall0 + 300)], minutes: 5, dayOnly: false };
    for (const scope of [
        { account: fAccount }, { account: updated },
        { account: undefined, accounts: [fAccount] }, { account: undefined, accounts: [fAccount, second] },
        { account: undefined, accounts: [fAccount] }, { account: undefined, accounts: [] },
        { account: undefined, accounts: [fAccount, fAccount, second, second] },
    ]) {
        const next = { ...input, ...scope };
        expect(projectChartFills(next, cache)).toEqual(projectChartFills(next));
    }
});

it('日夜盤成交與對應棒同時存在，僅日盤關開關每一步與冷算相同', () => {
    const cache = createProjectionCache();
    const input = { trades: [trade([deal('day'), deal('night', t0 + 5 * 3600)])], contract: fut, account: fAccount,
        bars: [bar(wall0 + 300), bar(wall0 + 5 * 3600 + 300)], minutes: 5 };
    for (const dayOnly of [false, true, false]) {
        const next = { ...input, dayOnly };
        const actual = projectChartFills(next, cache);
        expect(actual).toEqual(projectChartFills(next));
        expect(actual.fills).toHaveLength(dayOnly ? 1 : 2);
    }
});

it('期貨委託交易所在 TAIFEX 與 TIM 間來回，重複回報每一步與冷算相同', () => {
    const cache = createProjectionCache();
    const first = trade([deal('1')]);
    const report = trade([deal('1'), deal('2', t0 + 60)]);
    const input = { contract: fut, account: fAccount, bars: [bar(wall0 + 300)], minutes: 5, dayOnly: false };
    for (const exchange of ['TAIFEX', 'TIM', 'TAIFEX'] as ContractBase['exchange'][]) {
        const next = { ...input, trades: [first, report].map(row => ({ ...row, contract: { ...row.contract, exchange } })) };
        const actual = projectChartFills(next, cache);
        expect(actual).toEqual(projectChartFills(next));
        expect(actual.fills).toHaveLength(2);
    }
});
