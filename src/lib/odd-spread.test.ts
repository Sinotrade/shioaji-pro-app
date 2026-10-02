import { describe, expect, it } from 'vitest';
import {
    buildSpreadLadder,
    maxProfitableLots,
    planLeg,
    quoteBoth,
    quoteDirection,
    repriceHedge,
    sanitizePrefs,
    sellableShares,
    sliceOddOrders,
    type SideBook,
    type SpreadInput,
} from './odd-spread';
import { applyRateYuan, isBondEtfCode, priceCents, stockSellTax, stockTaxRate, stockTradeFee } from './utils/contract-cost';
import type { ContractInfo } from './types/contract';
import type { Trade } from './types/order';

// 設計稿（2330，6 折、證交稅 0.3%）的五檔
const ROUND: SideBook = {
    asks: [
        { price: 1085, vol: 2317 },
        { price: 1090, vol: 1038 },
        { price: 1095, vol: 655 },
        { price: 1100, vol: 412 },
    ],
    bids: [
        { price: 1080, vol: 1904 },
        { price: 1075, vol: 822 },
        { price: 1070, vol: 530 },
    ],
};
const ODD: SideBook = {
    asks: [{ price: 1100, vol: 86 }],
    bids: [
        { price: 1095, vol: 380 },
        { price: 1090, vol: 1020 },
        { price: 1085, vol: 640 },
        { price: 1080, vol: 3410 },
        { price: 1075, vol: 2200 },
        { price: 1070, vol: 150 },
    ],
};
const FEES = { discount: 0.6, taxRate: 0.003 };

function input(over: Partial<SpreadInput> = {}): SpreadInput {
    return { round: ROUND, odd: ODD, lots: 1, fees: FEES, inventoryShares: 3420, ...over };
}

describe('台股手續費／證交稅（contract-cost）', () => {
    it('整股最低 20 元、零股最低 1 元', () => {
        expect(stockTradeFee(priceCents(10) * 1000, { odd: false })).toBe(20); // 14.25 → 20
        expect(stockTradeFee(priceCents(10) * 10, { odd: true })).toBe(1); // 0.14 → 1
        expect(stockTradeFee(0, { odd: true })).toBe(0);
    });
    it('折數後四捨五入，以整數運算避免 .5 邊界誤差', () => {
        // 1,085 × 1,000 × 0.1425% × 0.6 = 927.675 → 928
        expect(stockTradeFee(priceCents(1085) * 1000, { odd: false, discount: 0.6 })).toBe(928);
        // 無折扣：1,085,000 × 0.1425% = 1,546.125 → 1,546
        expect(stockTradeFee(priceCents(1085) * 1000, { odd: false })).toBe(1546);
        // 0.5 邊界：10.5 元 → 11（浮點 0.1425% 相乘會落在 10.499999…）
        expect(applyRateYuan(1_050_000, 0.00001)).toBe(0); // 0.105 元
        expect(applyRateYuan(10_500_000, 0.0001)).toBe(11); // 105,000 元 × 0.01% = 10.5 → 11
    });
    it('證交稅四捨五入到元', () => {
        expect(stockSellTax(priceCents(1095) * 380, 0.003)).toBe(1248); // 1,248.3
        expect(stockSellTax(priceCents(1090) * 620, 0.003)).toBe(2027); // 2,027.4
        expect(stockSellTax(priceCents(10.05) * 1000, 0.001)).toBe(10); // 10.05
    });
});

describe('sliceOddOrders', () => {
    it('零股每筆 ≤ 999 股，同價位超過就拆筆', () => {
        expect(sliceOddOrders([{ price: 100, shares: 2500 }, { price: 99, shares: 10 }])).toEqual([
            { price: 100, quantity: 999 },
            { price: 100, quantity: 999 },
            { price: 100, quantity: 502 },
            { price: 99, quantity: 10 },
        ]);
    });
});

describe('planLeg', () => {
    it('零股賣出往下吃檔：1,095×380、1,090×620，每筆各計費與稅', () => {
        const leg = planLeg(ODD, true, 'Sell', 1000, FEES);
        expect(leg.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 620 }]);
        expect(leg.orders).toEqual([{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }]);
        expect(leg.fee).toBe(356 + 578);
        expect(leg.tax).toBe(1248 + 2027);
        expect(leg.short).toBe(false);
    });
    it('整股一筆、以吃到的最差檔為限價', () => {
        const leg = planLeg(ROUND, false, 'Buy', 3000_000, FEES);
        expect(leg.fills.map(f => f.price)).toEqual([1085, 1090]);
        expect(leg.orders).toEqual([{ price: 1090, quantity: 3000 }]);
        expect(leg.short).toBe(false);
    });
    it('量不足標記 short', () => {
        const leg = planLeg(ODD, true, 'Buy', 1000, FEES);
        expect(leg.short).toBe(true);
        expect(leg.fills).toEqual([{ price: 1100, shares: 86 }]);
    });
});

describe('quoteDirection — 設計稿數字', () => {
    it('買整→賣零：+10.00 元/股、92 bps、淨 +4.85、加權 +1.76、損益 +1,763、可執行', () => {
        const q = quoteDirection('buyRoundSellOdd', input());
        expect(q.buyPrice).toBe(1085);
        expect(q.sellPrice).toBe(1095);
        expect(q.grossPerShare).toBe(10);
        expect(q.grossBps).toBe(92);
        expect(q.netPerShare).toBe(4.85);
        expect(q.sellLeg?.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 620 }]);
        // 6,900 − 928 − (356+578) − (1,248+2,027)。設計稿的 1,762 是零股合併一筆
        // 計費的近似；實際每檔各一筆委託、各自四捨五入，得 1,763。
        expect(q.pnl).toBe(1763);
        expect(q.weightedNetPerShare).toBe(1.76);
        expect(q.maxLots).toBe(1);
        expect(q.block).toBeNull();
        expect(q.canExecute).toBe(true);
    });
    it('買零→賣整：−20.00 元/股、−182 bps、淨 −25.10，但零股量不足優先阻擋', () => {
        const q = quoteDirection('buyOddSellRound', input());
        expect(q.buyPrice).toBe(1100);
        expect(q.sellPrice).toBe(1080);
        expect(q.grossPerShare).toBe(-20);
        expect(q.grossBps).toBe(-182);
        expect(q.netPerShare).toBe(-25.1);
        expect(q.block).toBe('oddDepth');
        expect(q.canExecute).toBe(false);
        expect(q.maxLots).toBe(0);
    });
    it('quoteBoth 兩個方向各算一次', () => {
        const both = quoteBoth(input());
        expect(both.buyRoundSellOdd.canExecute).toBe(true);
        expect(both.buyOddSellRound.canExecute).toBe(false);
    });
});

describe('quoteDirection — 擋下原因', () => {
    it('最佳價未達成本，量足且庫存足時才回 belowCost，保留完整虧損試算', () => {
        const odd: SideBook = { bids: [{ price: 1080, vol: 5000 }], asks: [{ price: 1100, vol: 5000 }] };
        const q = quoteDirection('buyRoundSellOdd', input({ odd }));
        expect(q.block).toBe('belowCost');
        expect(q.canExecute).toBe(false);
        expect(q.pnl).toBe(-10091);
        expect(q.sellLeg?.orders.map(o => o.quantity)).toEqual([999, 1]);
        expect(quoteDirection('buyRoundSellOdd', input({ odd, inventoryShares: 999 })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ odd, inventoryShares: null })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ odd, round: { ...ROUND, asks: [{ price: 1085, vol: 1 }] }, lots: 2 })).block).toBe('roundDepth');
        expect(quoteDirection('buyRoundSellOdd', input({ odd, lots: 0 })).block).toBe('noQuote');
    });
    it('零股量不足', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 8 }));
        expect(q.block).toBe('oddDepth');
        expect(q.canExecute).toBe(false);
    });
    it('加權後不賺 → 價差未達成本（最佳一檔仍賺）', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 2 }));
        expect(q.netPerShare).toBeGreaterThan(0);
        expect(q.pnl).toBeLessThanOrEqual(0);
        expect(q.block).toBe('belowCost');
    });
    it('庫存不足或未知 → 不可執行', () => {
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: 999 })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: null })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: 1000 })).canExecute).toBe(true);
    });
    it('整股量不足', () => {
        const round: SideBook = { asks: [{ price: 1085, vol: 1 }], bids: ROUND.bids };
        const odd: SideBook = { asks: ODD.asks, bids: [{ price: 1200, vol: 5000 }] };
        const q = quoteDirection('buyRoundSellOdd', input({ round, odd, lots: 2 }));
        expect(q.block).toBe('roundDepth');
    });
    it('沒有報價', () => {
        const q = quoteDirection('buyOddSellRound', input({ odd: { bids: [], asks: [] } }));
        expect(q.block).toBe('noQuote');
        expect(q.grossPerShare).toBeNull();
    });
    it('買零→賣整有利時可執行，整股賣出檢查庫存', () => {
        const odd: SideBook = { asks: [{ price: 1060, vol: 600 }, { price: 1065, vol: 900 }], bids: [] };
        const q = quoteDirection('buyOddSellRound', input({ odd, inventoryShares: 1000 }));
        expect(q.buyLeg?.orders).toEqual([{ price: 1060, quantity: 600 }, { price: 1065, quantity: 400 }]);
        expect(q.sellLeg?.orders).toEqual([{ price: 1080, quantity: 1 }]);
        // 賣 1,080,000 − 買 (636,000 + 426,000) = 18,000；費 923 + (544 + 364)；稅 3,240
        expect(q.pnl).toBe(18000 - 923 - 544 - 364 - 3240);
        expect(q.canExecute).toBe(true);
        expect(quoteDirection('buyOddSellRound', input({ odd, inventoryShares: 420 })).block).toBe('inventory');
    });
    it('未配對：零股股數另設，損益以配對股數計', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 1, oddShares: 500 }));
        expect(q.sellLeg?.shares).toBe(500);
        expect(q.buyLeg?.shares).toBe(1000);
        expect(q.sellLeg?.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 120 }]);
    });
});

describe('maxProfitableLots', () => {
    it('多一張不再多賺就停止', () => {
        const odd: SideBook = { asks: [], bids: [{ price: 1100, vol: 2500 }, { price: 1086, vol: 5000 }] };
        expect(maxProfitableLots('buyRoundSellOdd', ROUND, odd, FEES)).toBe(3);
    });
});

describe('buildSpreadLadder', () => {
    const step = (p: number, dir: 1 | -1) => p + dir * 5;
    it('共用價格欄、補齊跳動點、標出可套利價位與最後成交價', () => {
        const rows = buildSpreadLadder(ROUND, ODD, { roundLast: 1085, oddLast: 1095, step });
        expect(rows.map(r => r.price)).toEqual([1100, 1095, 1090, 1085, 1080, 1075, 1070]);
        const at = (p: number) => rows.find(r => r.price === p)!;
        expect(at(1095)).toMatchObject({ roundAsk: 655, oddBid: 380, cross: true, oddLast: true, roundLast: false });
        expect(at(1090).cross).toBe(true);
        expect(at(1085)).toMatchObject({ roundAsk: 2317, oddBid: 640, cross: false, roundLast: true });
        expect(at(1100)).toMatchObject({ roundAsk: 412, oddAsk: 86, cross: false });
        expect(at(1080).cross).toBe(false);
    });
    it('零股賣價低於整股買一也算可套利', () => {
        const odd: SideBook = { asks: [{ price: 1075, vol: 10 }], bids: [] };
        const rows = buildSpreadLadder(ROUND, odd);
        expect(rows.find(r => r.price === 1075)!.cross).toBe(true);
    });
    it('補齊中間價位、依 maxRows 截取', () => {
        const rows = buildSpreadLadder(
            { bids: [{ price: 100, vol: 1 }], asks: [{ price: 101, vol: 1 }] },
            { bids: [{ price: 90, vol: 1 }], asks: [{ price: 110, vol: 1 }] },
            { step: (p, d) => p + d, maxRows: 5 },
        );
        expect(rows).toHaveLength(5);
        expect(rows.map(r => r.price)).toEqual([102, 101, 100, 99, 98]);
    });
    it('沒有報價時為空', () => {
        expect(buildSpreadLadder({ bids: [], asks: [] }, { bids: [], asks: [] })).toEqual([]);
    });
});

describe('sanitizePrefs', () => {
    it('折數 0～1、稅率 0～1%，其餘回預設', () => {
        expect(sanitizePrefs({ discount: 0.6, taxRate: 0.0015 })).toMatchObject({ discount: 0.6, taxRate: 0.0015 });
        expect(sanitizePrefs({ discount: 6, taxRate: 3 })).toMatchObject({ discount: 1, taxRate: null });
        expect(sanitizePrefs(null)).toMatchObject({ discount: 1, taxRate: null });
    });
});

describe('每筆最低手續費可設定（券商訂定）', () => {
    it('提高零股每筆最低手續費：每筆都收，損益變少', () => {
        const base = quoteDirection('buyRoundSellOdd', input());
        const hi = quoteDirection('buyRoundSellOdd', input({ fees: { ...FEES, minFeeOdd: 400 } }));
        // 380 股那筆手續費 356 → 400
        expect(hi.pnl).toBe(base.pnl! - (400 - 356));
        expect(stockTradeFee(priceCents(10) * 10, { odd: true, minFee: 5 })).toBe(5);
        expect(stockTradeFee(priceCents(10) * 1000, { odd: false, minFee: 1 })).toBe(14); // 14.25 → 14，最低 1 不影響
    });
});

describe('sellableShares', () => {
    const pos = [
        { code: '2330', direction: 'Buy' as const, quantity: 3420, cond: 'Cash' },
        { code: '2330', direction: 'Buy' as const, quantity: 1000, cond: 'MarginTrading' },
        { code: '2317', direction: 'Buy' as const, quantity: 5000, cond: 'Cash' },
    ];
    const t = (action: string, lot: string, quantity: number, deal: number, status = 'Submitted', code = '2330') => ({
        contract: { code },
        order: { id: `${action}${lot}${quantity}`, action, price: 1000, quantity, order_lot: lot },
        status: { status, order_quantity: quantity, deal_quantity: deal, cancel_quantity: 0, deals: [] },
    }) as unknown as Trade;
    it('現股多單扣掉未成交賣單（整股 × 1,000、零股以股）', () => {
        expect(sellableShares(pos, [], '2330')).toBe(3420);
        expect(sellableShares(pos, [t('Sell', 'Common', 2, 0), t('Sell', 'IntradayOdd', 300, 100)], '2330')).toBe(3420 - 2000 - 200);
        // 買單、已成交完、別檔都不扣
        expect(sellableShares(pos, [t('Buy', 'Common', 1, 0), t('Sell', 'Common', 1, 1, 'Filled'), t('Sell', 'Common', 1, 0, 'Submitted', '2317')], '2330')).toBe(3420);
        expect(sellableShares(pos, [t('Sell', 'Common', 9, 0)], '2330')).toBe(0);
    });
});

describe('repriceHedge', () => {
    const step = (p: number, d: 1 | -1) => p + d * 5;
    const args = { odd: false, action: 'Buy' as const, quantity: 1, plannedPrice: 1085, netPerShare: 12, maxSlipTicks: 2, step, fees: FEES };
    it('當下價格不比計畫差 → 以最新價送', () => {
        expect(repriceHedge({ ...args, book: { bids: [], asks: [{ price: 1080, vol: 5 }] } })).toEqual({ ok: true, orders: [{ price: 1080, quantity: 1 }] });
    });
    it('偏離在上限內且仍賺 → 可送', () => {
        expect(repriceHedge({ ...args, book: { bids: [], asks: [{ price: 1095, vol: 5 }] } })).toEqual({ ok: true, orders: [{ price: 1095, quantity: 1 }] });
    });
    it('超過滑價上限 → 不送，附最新價建議', () => {
        const r = repriceHedge({ ...args, book: { bids: [], asks: [{ price: 1100, vol: 5 }] } });
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toContain('超過 2 檔');
        expect(r.orders).toEqual([{ price: 1100, quantity: 1 }]);
    });
    it('上限內但已不足成本 → 不送', () => {
        const r = repriceHedge({ ...args, netPerShare: 8, book: { bids: [], asks: [{ price: 1095, vol: 5 }] } });
        expect(r.ok === false && r.reason).toContain('不足成本');
    });
    it('賣出方向：價格往下為不利；零股依 999 拆筆', () => {
        const r = repriceHedge({ ...args, odd: true, action: 'Sell', quantity: 1000, plannedPrice: 1090, book: { bids: [{ price: 1085, vol: 5000 }], asks: [] } });
        expect(r).toEqual({ ok: true, orders: [{ price: 1085, quantity: 999 }, { price: 1085, quantity: 1 }] });
    });
    it('沒有報價或量不足 → 不送', () => {
        expect(repriceHedge({ ...args, book: { bids: [], asks: [] } })).toMatchObject({ ok: false, orders: [] });
        expect(repriceHedge({ ...args, quantity: 3, book: { bids: [], asks: [{ price: 1085, vol: 1 }] } })).toMatchObject({ ok: false, orders: [{ price: 1085, quantity: 3 }] });
    });
});

describe('債券 ETF 證交稅停徵', () => {
    const c = (code: string) => ({ code, security_type: 'STK' }) as unknown as ContractInfo;
    it('代號 B 結尾停徵到 2026-12-31，之後回到 ETF 0.1%', () => {
        expect(isBondEtfCode('00679B')).toBe(true);
        expect(isBondEtfCode('00680L')).toBe(false);
        expect(stockTaxRate(c('00679B'), Date.parse('2026-12-31T23:59:00+08:00'))).toBe(0);
        expect(stockTaxRate(c('00679B'), Date.parse('2027-01-01T00:00:00+08:00'))).toBe(0.001);
        expect(stockTaxRate(c('0050'), Date.parse('2026-09-30T10:00:00+08:00'))).toBe(0.001);
        expect(stockTaxRate(c('2330'), Date.parse('2026-09-30T10:00:00+08:00'))).toBe(0.003);
    });
});

describe('sanitizePrefs — 最低手續費與補單滑價', () => {
    it('預設整股 20、零股 1、滑價 2 檔；超出範圍回預設', () => {
        expect(sanitizePrefs({})).toMatchObject({ minFeeRound: 20, minFeeOdd: 1, maxSlipTicks: 2 });
        expect(sanitizePrefs({ minFeeRound: 0, minFeeOdd: 5, maxSlipTicks: 4 })).toMatchObject({ minFeeRound: 0, minFeeOdd: 5, maxSlipTicks: 4 });
        expect(sanitizePrefs({ minFeeRound: -1, minFeeOdd: 'x', maxSlipTicks: 99 })).toMatchObject({ minFeeRound: 20, minFeeOdd: 1, maxSlipTicks: 2 });
    });
});
