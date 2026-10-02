// src/lib/odd-spread.ts — 整零價差（整股 vs 盤中零股）試算，純函式。
//
// 兩個方向各算一次：
// - 買整→賣零：整股以賣價（ask）買進 N 張，零股以買價（bid）賣出 N×1,000 股
// - 買零→賣整：零股以賣價（ask）買進 N×1,000 股，整股以買價（bid）賣出 N 張
//
// 對手價往下吃檔：整股那一腳一定是整張，零股那一腳往下吃多檔湊滿股數，
// 每檔各送一筆限價（零股每筆上限 999 股，超過就拆筆）。每筆委託各自計
// 手續費（整股最低 20 元、零股最低 1 元）與賣出證交稅，損益以整數元計。
//
// 費用規則與下單面板試算共用 lib/utils/contract-cost（stockTradeFee／
// stockSellTax）。

import { isOddLot, ODD_LOT_MAX_SHARES, SHARES_PER_LOT } from './odd-lot';
import type { Trade } from './types/order';
import type { StockPosition } from './types/portfolio';
import { remainingWorkingOrderQuantity } from './working-order-quantity';
import { priceCents, STOCK_MIN_FEE_ODD, STOCK_MIN_FEE_ROUND, stockSellTax, stockTradeFee } from './utils/contract-cost';

/** 一檔報價。整股 vol 單位為「張」，零股為「股」。 */
export interface BookLevel {
    price: number;
    vol: number;
}

/** 單一市場的委託簿，bids 由高到低、asks 由低到高（最佳價在前）。 */
export interface SideBook {
    bids: BookLevel[];
    asks: BookLevel[];
}

export type SpreadDirection = 'buyRoundSellOdd' | 'buyOddSellRound';

export const DIRECTION_LABEL: Record<SpreadDirection, string> = {
    buyRoundSellOdd: '買整 → 賣零',
    buyOddSellRound: '買零 → 賣整',
};

export const DIRECTION_PATH_LABEL: Record<SpreadDirection, string> = {
    buyRoundSellOdd: '整股賣一 → 零股買一',
    buyOddSellRound: '零股賣一 → 整股買一',
};

export interface FeeSettings {
    /** 手續費折數（6 折 = 0.6、無折扣 = 1） */
    discount: number;
    /** 賣出證交稅率（0.003 = 0.3%） */
    taxRate: number;
    /** 每筆最低手續費（券商訂定）；省略時整股 20 元、零股 1 元 */
    minFeeRound?: number;
    minFeeOdd?: number;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = { discount: 1, taxRate: 0.003 };

const minFee = (fees: FeeSettings, odd: boolean) => (odd ? fees.minFeeOdd ?? STOCK_MIN_FEE_ODD : fees.minFeeRound ?? STOCK_MIN_FEE_ROUND);

/** 一筆要送出的限價委託。整股 quantity 為張、零股為股。 */
export interface LegOrder {
    price: number;
    quantity: number;
}

export interface LegPlan {
    odd: boolean;
    action: 'Buy' | 'Sell';
    /** 本腳總股數 */
    shares: number;
    /** 依價位拆好的委託（零股每筆 ≤ 999 股；整股一筆，價格為最差檔） */
    orders: LegOrder[];
    /** 吃到的各檔（價格 × 股數），供畫面列出 */
    fills: { price: number; shares: number }[];
    /** 成交金額（分） */
    notionalCents: number;
    fee: number;
    tax: number;
    /** 委託簿量不足以湊滿股數 */
    short: boolean;
}

export type SpreadBlock = 'noQuote' | 'belowCost' | 'oddDepth' | 'roundDepth' | 'inventory';

export const BLOCK_LABEL: Record<SpreadBlock, string> = {
    noQuote: '等待報價',
    belowCost: '價差未達成本',
    oddDepth: '零股量不足',
    roundDepth: '整股量不足',
    inventory: '庫存不足',
};

export interface SpreadQuote {
    direction: SpreadDirection;
    /** 買進那一腳的對手價（最佳一檔） */
    buyPrice: number | null;
    /** 賣出那一腳的對手價（最佳一檔） */
    sellPrice: number | null;
    /** 毛價差 元/股（賣 − 買） */
    grossPerShare: number | null;
    /** 毛價差 bps（相對買價，四捨五入到整數） */
    grossBps: number | null;
    /** 以最佳一檔價格試算、扣兩腳手續費與賣出稅後的 元/股 */
    netPerShare: number | null;
    /** 本次張數（整股那一腳） */
    lots: number;
    /** 零股那一腳股數 */
    oddShares: number;
    buyLeg: LegPlan | null;
    sellLeg: LegPlan | null;
    /** 往下吃檔後、扣費用的加權淨價差 元/股 */
    weightedNetPerShare: number | null;
    /** 預估損益（元，以配對股數計） */
    pnl: number | null;
    /** 委託簿能做到、且每多一張仍賺錢的最大張數（不含庫存限制） */
    maxLots: number;
    block: SpreadBlock | null;
    canExecute: boolean;
}

export interface SpreadInput {
    round: SideBook;
    odd: SideBook;
    /** 整股張數 */
    lots: number;
    /** 零股股數；省略時配對為 lots × 1,000 */
    oddShares?: number;
    fees: FeeSettings;
    /** 可賣的現股庫存（股）；null＝未知（不允許送出賣腳） */
    inventoryShares: number | null;
}

function validLevels(levels: BookLevel[]): BookLevel[] {
    return levels.filter(l => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.vol) && l.vol > 0);
}

/** 往下吃檔湊滿 shares 股（unit=每單位股數；整股 1,000、零股 1） */
function walk(levels: BookLevel[], shares: number, unit: number): { fills: { price: number; shares: number }[]; short: boolean } {
    const fills: { price: number; shares: number }[] = [];
    let left = shares;
    for (const l of validLevels(levels)) {
        if (left <= 0) break;
        const take = Math.min(left, Math.floor(l.vol) * unit);
        if (take <= 0) continue;
        fills.push({ price: l.price, shares: take });
        left -= take;
    }
    return { fills, short: left > 0 };
}

/** 零股每筆上限 999 股：同一價位超過就拆筆 */
export function sliceOddOrders(fills: { price: number; shares: number }[]): LegOrder[] {
    const out: LegOrder[] = [];
    for (const f of fills) {
        let left = f.shares;
        while (left > 0) {
            const q = Math.min(ODD_LOT_MAX_SHARES, left);
            out.push({ price: f.price, quantity: q });
            left -= q;
        }
    }
    return out;
}

function legCosts(orders: LegOrder[], odd: boolean, action: 'Buy' | 'Sell', fees: FeeSettings) {
    let notionalCents = 0;
    let fee = 0;
    let tax = 0;
    for (const o of orders) {
        const shares = odd ? o.quantity : o.quantity * SHARES_PER_LOT;
        const cents = priceCents(o.price) * shares;
        notionalCents += cents;
        fee += stockTradeFee(cents, { odd, discount: fees.discount, minFee: minFee(fees, odd) });
        if (action === 'Sell') tax += stockSellTax(cents, fees.taxRate);
    }
    return { notionalCents, fee, tax };
}

/** 規劃一腳：依對手簿往下吃檔、拆委託、算費用 */
export function planLeg(book: SideBook, odd: boolean, action: 'Buy' | 'Sell', shares: number, fees: FeeSettings): LegPlan {
    // 買進吃賣方（asks），賣出吃買方（bids）
    const levels = action === 'Buy' ? book.asks : book.bids;
    const { fills, short } = walk(levels, shares, odd ? 1 : SHARES_PER_LOT);
    if (odd) {
        // 零股每檔各送一筆（超過 999 股拆筆），每筆各自計最低手續費
        const orders = sliceOddOrders(fills);
        return { odd, action, shares, orders, fills, ...legCosts(orders, true, action, fees), short };
    }
    // 整股一筆限價、價格取吃到的最差檔（可成交到各檔），費用以各檔成交金額合計
    const filled = fills.reduce((s, f) => s + f.shares, 0);
    const notionalCents = fills.reduce((s, f) => s + priceCents(f.price) * f.shares, 0);
    const orders = fills.length ? [{ price: fills[fills.length - 1]!.price, quantity: filled / SHARES_PER_LOT }] : [];
    return {
        odd, action, shares, orders, fills, notionalCents,
        fee: stockTradeFee(notionalCents, { odd: false, discount: fees.discount, minFee: minFee(fees, false) }),
        tax: action === 'Sell' ? stockSellTax(notionalCents, fees.taxRate) : 0,
        short,
    };
}

function legs(direction: SpreadDirection) {
    return direction === 'buyRoundSellOdd'
        ? { buyOdd: false, sellOdd: true }
        : { buyOdd: true, sellOdd: false };
}

function planPnl(buy: LegPlan, sell: LegPlan): { pnl: number; matched: number } {
    const matched = Math.min(buy.shares, sell.shares);
    if (matched <= 0) return { pnl: 0, matched: 0 };
    // 配對股數的損益：兩腳平均價差 × 配對股數 − 全部費用與稅
    // 兩腳股數相同（配對）時為精確整數；未配對時按平均價比例計
    const grossCents = buy.shares === sell.shares
        ? sell.notionalCents - buy.notionalCents
        : Math.round((sell.notionalCents / sell.shares - buy.notionalCents / buy.shares) * matched);
    const pnl = Math.round(grossCents / 100) - buy.fee - sell.fee - buy.tax - sell.tax;
    return { pnl, matched };
}

function bestPrice(levels: BookLevel[]): number | null {
    const l = validLevels(levels)[0];
    return l ? l.price : null;
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

/** 以最佳一檔（假設量無限）試算 shares 股的淨價差 元/股 */
function topOfBookNet(direction: SpreadDirection, buyPrice: number, sellPrice: number, lots: number, oddShares: number, fees: FeeSettings): number {
    const { buyOdd, sellOdd } = legs(direction);
    const inf = (p: number): SideBook => ({ bids: [{ price: p, vol: Number.MAX_SAFE_INTEGER / 1e6 }], asks: [{ price: p, vol: Number.MAX_SAFE_INTEGER / 1e6 }] });
    const buy = planLeg(inf(buyPrice), buyOdd, 'Buy', buyOdd ? oddShares : lots * SHARES_PER_LOT, fees);
    const sell = planLeg(inf(sellPrice), sellOdd, 'Sell', sellOdd ? oddShares : lots * SHARES_PER_LOT, fees);
    const { pnl, matched } = planPnl(buy, sell);
    return matched > 0 ? pnl / matched : 0;
}

function planFor(direction: SpreadDirection, round: SideBook, odd: SideBook, lots: number, oddShares: number, fees: FeeSettings) {
    const { buyOdd, sellOdd } = legs(direction);
    const buy = planLeg(buyOdd ? odd : round, buyOdd, 'Buy', buyOdd ? oddShares : lots * SHARES_PER_LOT, fees);
    const sell = planLeg(sellOdd ? odd : round, sellOdd, 'Sell', sellOdd ? oddShares : lots * SHARES_PER_LOT, fees);
    return { buy, sell, ...planPnl(buy, sell) };
}

/** 委託簿能做到、每多一張仍賺錢的最大張數（配對 1 張 = 1,000 股） */
export function maxProfitableLots(direction: SpreadDirection, round: SideBook, odd: SideBook, fees: FeeSettings, cap = 500): number {
    let best = 0;
    let prev = 0;
    for (let n = 1; n <= cap; n++) {
        const p = planFor(direction, round, odd, n, n * SHARES_PER_LOT, fees);
        if (p.buy.short || p.sell.short) break;
        if (p.pnl <= 0 || p.pnl - prev <= 0) break;
        best = n;
        prev = p.pnl;
    }
    return best;
}

/** 單一方向的完整試算 */
export function quoteDirection(direction: SpreadDirection, input: SpreadInput): SpreadQuote {
    const lots = Math.max(0, Math.trunc(input.lots));
    const oddShares = Math.max(0, Math.trunc(input.oddShares ?? lots * SHARES_PER_LOT));
    const { buyOdd, sellOdd } = legs(direction);
    const buyBook = buyOdd ? input.odd : input.round;
    const sellBook = sellOdd ? input.odd : input.round;
    const buyPrice = bestPrice(buyBook.asks);
    const sellPrice = bestPrice(sellBook.bids);
    const empty: SpreadQuote = {
        direction, buyPrice, sellPrice,
        grossPerShare: null, grossBps: null, netPerShare: null,
        lots, oddShares, buyLeg: null, sellLeg: null,
        weightedNetPerShare: null, pnl: null, maxLots: 0,
        block: 'noQuote', canExecute: false,
    };
    if (buyPrice === null || sellPrice === null) return empty;
    const grossPerShare = round2(sellPrice - buyPrice);
    const grossBps = Math.round((grossPerShare / buyPrice) * 10_000);
    const qLots = Math.max(1, lots);
    const qOdd = Math.max(1, oddShares);
    const netPerShare = round2(topOfBookNet(direction, buyPrice, sellPrice, qLots, qOdd, input.fees));
    const base = { ...empty, grossPerShare, grossBps, netPerShare, block: null as SpreadBlock | null };
    base.maxLots = maxProfitableLots(direction, input.round, input.odd, input.fees);
    if (lots <= 0 || oddShares <= 0) return { ...base, block: 'noQuote' };
    const p = planFor(direction, input.round, input.odd, lots, oddShares, input.fees);
    const result: SpreadQuote = {
        ...base,
        buyLeg: p.buy,
        sellLeg: p.sell,
        weightedNetPerShare: p.matched > 0 ? round2(p.pnl / p.matched) : null,
        pnl: p.pnl,
    };
    // belowCost 必須是唯一阻擋原因，才能由面板提供虧損確認。
    const oddLeg = buyOdd ? p.buy : p.sell;
    const roundLeg = buyOdd ? p.sell : p.buy;
    if (oddLeg.short) return { ...result, block: 'oddDepth' };
    if (roundLeg.short) return { ...result, block: 'roundDepth' };
    const sellShares = p.sell.shares;
    if (input.inventoryShares === null || input.inventoryShares < sellShares) {
        return { ...result, block: 'inventory' };
    }
    if (netPerShare <= 0 || p.pnl <= 0) return { ...result, block: 'belowCost' };
    return { ...result, block: null, canExecute: true };
}

export function quoteBoth(input: SpreadInput): Record<SpreadDirection, SpreadQuote> {
    return {
        buyRoundSellOdd: quoteDirection('buyRoundSellOdd', input),
        buyOddSellRound: quoteDirection('buyOddSellRound', input),
    };
}

// ---- 價格梯：共用價格欄，左整股、右零股 ----

export interface SpreadLadderRow {
    price: number;
    roundBid?: number;
    roundAsk?: number;
    oddBid?: number;
    oddAsk?: number;
    /** 可套利價位：零股買價高於整股賣一，或零股賣價低於整股買一 */
    cross: boolean;
    roundLast: boolean;
    oddLast: boolean;
}

const pk = (p: number) => priceCents(p);

/**
 * 合併兩邊委託簿成價格梯（由高到低）。step 提供時補齊中間的跳動點，
 * 讓兩市場的價位對齊成連續的梯子。
 */
export function buildSpreadLadder(
    round: SideBook,
    odd: SideBook,
    opts: { roundLast?: number | null; oddLast?: number | null; step?: (price: number, dir: 1 | -1) => number; maxRows?: number } = {},
): SpreadLadderRow[] {
    const rows = new Map<number, SpreadLadderRow>();
    const row = (price: number) => {
        const k = pk(price);
        let r = rows.get(k);
        if (!r) {
            r = { price, cross: false, roundLast: false, oddLast: false };
            rows.set(k, r);
        }
        return r;
    };
    for (const l of validLevels(round.bids)) row(l.price).roundBid = l.vol;
    for (const l of validLevels(round.asks)) row(l.price).roundAsk = l.vol;
    for (const l of validLevels(odd.bids)) row(l.price).oddBid = l.vol;
    for (const l of validLevels(odd.asks)) row(l.price).oddAsk = l.vol;
    if (rows.size === 0) return [];
    if (opts.step) {
        const keys = [...rows.keys()];
        const hi = Math.max(...keys);
        const lo = Math.min(...keys);
        let p = rows.get(lo)!.price;
        for (let i = 0; i < 400; i++) {
            const n = opts.step(p, 1);
            if (!(n > p) || pk(n) > hi) break;
            row(n);
            p = n;
        }
    }
    const roundBestBid = bestPrice(round.bids);
    const roundBestAsk = bestPrice(round.asks);
    const lastKey = (v: number | null | undefined) => (v !== null && v !== undefined && v > 0 ? pk(v) : null);
    const rLast = lastKey(opts.roundLast);
    const oLast = lastKey(opts.oddLast);
    const out = [...rows.values()].sort((a, b) => b.price - a.price);
    for (const r of out) {
        const k = pk(r.price);
        r.cross = (r.oddBid !== undefined && roundBestAsk !== null && pk(r.price) > pk(roundBestAsk))
            || (r.oddAsk !== undefined && roundBestBid !== null && pk(r.price) < pk(roundBestBid));
        r.roundLast = rLast === k;
        r.oddLast = oLast === k;
    }
    if (opts.maxRows && out.length > opts.maxRows) {
        // 保留兩邊最佳價附近：以整股買一／賣一中點為中心截取
        const mid = roundBestBid !== null && roundBestAsk !== null ? (roundBestBid + roundBestAsk) / 2 : out[Math.floor(out.length / 2)]!.price;
        let idx = out.findIndex(r => r.price <= mid);
        if (idx < 0) idx = out.length - 1;
        const start = Math.max(0, Math.min(out.length - opts.maxRows, idx - Math.floor(opts.maxRows / 2)));
        return out.slice(start, start + opts.maxRows);
    }
    return out;
}

// ---- 使用者設定（手續費折數、證交稅率） ----

export interface OddSpreadPrefs {
    discount: number;
    /** null＝依商品預設（一般股票 0.3%、ETF 0.1%、債券 ETF 停徵期間 0） */
    taxRate: number | null;
    /** 每筆最低手續費（元，券商訂定） */
    minFeeRound: number;
    minFeeOdd: number;
    /** 第二腳補單最多容許偏離計畫價幾檔 */
    maxSlipTicks: number;
}

export const ODD_SPREAD_PREFS_KEY = 'sj-pro-odd-spread-prefs-v1';
export const DEFAULT_MAX_SLIP_TICKS = 2;

function numIn(v: unknown, lo: number, hi: number, fallback: number, integer = false): number {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < lo || n > hi) return fallback;
    return integer ? Math.trunc(n) : n;
}

export function sanitizePrefs(v: unknown): OddSpreadPrefs {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const d = Number(o.discount);
    const t = o.taxRate === null || o.taxRate === undefined ? null : Number(o.taxRate);
    return {
        discount: Number.isFinite(d) && d > 0 && d <= 1 ? d : 1,
        taxRate: t !== null && Number.isFinite(t) && t >= 0 && t <= 0.01 ? t : null,
        minFeeRound: numIn(o.minFeeRound, 0, 1000, STOCK_MIN_FEE_ROUND),
        minFeeOdd: numIn(o.minFeeOdd, 0, 1000, STOCK_MIN_FEE_ODD),
        maxSlipTicks: numIn(o.maxSlipTicks, 0, 50, DEFAULT_MAX_SLIP_TICKS, true),
    };
}

export function loadOddSpreadPrefs(): OddSpreadPrefs {
    try {
        const raw = localStorage.getItem(ODD_SPREAD_PREFS_KEY);
        return sanitizePrefs(raw ? JSON.parse(raw) : null);
    } catch {
        return sanitizePrefs(null);
    }
}

export function saveOddSpreadPrefs(p: OddSpreadPrefs): void {
    try {
        localStorage.setItem(ODD_SPREAD_PREFS_KEY, JSON.stringify(sanitizePrefs(p)));
    } catch {
        // 本機儲存不可用時只在本次有效
    }
}

// ---- 可賣庫存：現股多單 − 同帳戶同商品未成交的賣單 ----

/** 可賣現股（股）。positions／trades 須已限定為同一帳戶；賣單不論整股或零股
 * 都占用同一批庫存（整股 × 1,000 股）。 */
export function sellableShares(
    positions: Pick<StockPosition, 'code' | 'direction' | 'quantity' | 'cond'>[],
    trades: Trade[],
    code: string,
): number {
    const held = positions
        .filter(p => p.code === code && p.direction === 'Buy' && (!p.cond || p.cond === 'Cash'))
        .reduce((a, p) => a + p.quantity, 0);
    const reserved = trades
        .filter(t => t.contract.code === code && t.order.action === 'Sell')
        .reduce((a, t) => {
            const left = remainingWorkingOrderQuantity(t);
            return left > 0 ? a + (isOddLot(t.order.order_lot) ? left : left * SHARES_PER_LOT) : a;
        }, 0);
    return Math.max(0, held - reserved);
}

// ---- 第二腳補單重新定價 ----

export type HedgePricing = { ok: true; orders: LegOrder[] } | { ok: false; reason: string; orders: LegOrder[] };

/**
 * 以當下委託簿為第二腳（quantity：整股張、零股股）重新定價。可自動送出的條件：
 * 最差成交價相對計畫價的不利偏離 ≤ maxSlipTicks 檔，且每股不利偏離小於計畫
 * 時的加權淨價差（仍賺錢）。不符合時回 ok=false 與以最新價建議的委託，
 * 交由使用者決定。
 */
export function repriceHedge(args: {
    book: SideBook;
    odd: boolean;
    action: 'Buy' | 'Sell';
    quantity: number;
    plannedPrice: number;
    netPerShare: number;
    maxSlipTicks: number;
    step: (price: number, dir: 1 | -1) => number;
    fees: FeeSettings;
}): HedgePricing {
    const { book, odd, action, quantity, plannedPrice, netPerShare, maxSlipTicks, step, fees } = args;
    const shares = odd ? quantity : quantity * SHARES_PER_LOT;
    const leg = planLeg(book, odd, action, shares, fees);
    if (leg.fills.length === 0) return { ok: false, reason: `${odd ? '零股' : '整股'}沒有對手報價`, orders: [] };
    const orders = leg.orders.map(o => ({ ...o }));
    if (leg.short) {
        const got = orders.reduce((a, o) => a + o.quantity, 0);
        const last = orders[orders.length - 1]!;
        orders[orders.length - 1] = { ...last, quantity: last.quantity + quantity - got };
        return { ok: false, reason: `${odd ? '零股' : '整股'}對手量不足`, orders: odd ? sliceOddOrders(orders.map(o => ({ price: o.price, shares: o.quantity }))) : orders };
    }
    const worst = leg.fills[leg.fills.length - 1]!.price;
    const adverse = action === 'Buy' ? worst - plannedPrice : plannedPrice - worst;
    if (adverse <= 0) return { ok: true, orders };
    // 數不利方向的跳動檔數（依升降單位）
    let ticks = 0;
    let p = plannedPrice;
    const dir: 1 | -1 = action === 'Buy' ? 1 : -1;
    while (ticks <= maxSlipTicks && (dir === 1 ? priceCents(p) < priceCents(worst) : priceCents(p) > priceCents(worst))) {
        const n = step(p, dir);
        if (n === p) break;
        p = n;
        ticks++;
    }
    if (ticks > maxSlipTicks) return { ok: false, reason: `價格已偏離計畫價超過 ${maxSlipTicks} 檔（${fmt(plannedPrice)} → ${fmt(worst)}）`, orders };
    if (adverse >= netPerShare) return { ok: false, reason: `以最新價 ${fmt(worst)} 補單已不足成本`, orders };
    return { ok: true, orders };
}

const fmt = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: 2 });
