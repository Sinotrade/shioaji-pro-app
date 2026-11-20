// src/lib/tw-account-detail.ts — 台股（證券 S／期貨 F）庫存明細與沖銷明細
//
// 形狀對照 shioaji 1.8 原始碼（src/api/api_v1/portf/position_detail.rs、profit_loss_detail.rs、
// src/server/http/portf.rs）與 sw（swrelaystation/api/v1/endpoints/portfolio/*_detail.py）：
//   POST /portfolio/position_detail    {account…, detail_id: position_unit 列的 id}
//     S → StockPositionDetail { date, code, quantity(張，SDK 不帶 unit → sw 預設 Common，零股截成 0),
//          price, last_price, dseq, direction, pnl, currency, fee, cond, ex_dividends, interest,
//          margintrading_amt, collateral }
//     F → FuturePositionDetail { date, code, quantity(未平口數), entry_quantity(原始口數), price,
//          last_price, dseq, direction, pnl, currency, fee }
//   POST /portfolio/profit_loss_detail {account…, detail_id: profit_loss 列的 id, unit}
//     S → StockProfitDetail { date, code, quantity(unit=Share 為股數), dseq, fee, tax, currency, price,
//          cost, rep_margintrading_amt, rep_collateral, rep_margin, shortselling_fee, ex_dividend_amt,
//          interest, trade_type, cond }
//     F → FutureProfitDetail { date, code, quantity, dseq, fee, tax, currency, direction, entry_date,
//          entry_quantity, entry_seqno, entry_price, cover_price, pnl }
//
// detail_id 是 sidecar 的程序內快取索引：position_detail 對照「最近一次」position_unit，
// profit_loss_detail 對照「最近一次」profit_loss（不分日期區間，同帳戶共用一份）。
// 今日損益、30 日損益兩個面板各自查 profit_loss，會互相蓋掉快取，所以：
// - 沖銷明細：先用該列的日期重查一次 profit_loss（刷新快取），找回同一列的 id 再查明細，
//   兩步之間本 App 同帳戶的其他 profit_loss 排隊（profit-loss-cache-lock）；
// - 庫存明細：查完核對回來的代碼／方向／條件和這一列一致，不一致就不顯示（避免拿別檔的批次）。
// 模擬環境 SDK 對台股明細直接回空陣列、不送出請求（券商後台才有明細）。

import {
    fetchPositionDetail,
    fetchProfitLossDetailOf,
    type FutureProfitLoss,
    type ProfitLoss,
    type StockProfitLoss,
} from './shioaji';
import { canonicalBrokerCode } from './realized-name';
import type { Account } from './types/portfolio';

export type TwMarket = 'S' | 'F';
type Dir = 'Buy' | 'Sell';

export interface TwStockPositionDetail {
    market: 'S';
    date: string;
    code: string;
    /** 張（券商以張回傳；零股截成 0） */
    quantity: number;
    price: number;
    last_price: number;
    dseq: string;
    direction: Dir;
    pnl: number;
    fee: number;
    cond: string;
    ex_dividends: number;
    interest: number;
    margintrading_amt: number;
    collateral: number;
}

export interface TwFuturePositionDetail {
    market: 'F';
    date: string;
    code: string;
    /** 未平倉口數 */
    quantity: number;
    /** 原始成交口數 */
    entry_quantity: number;
    price: number;
    last_price: number;
    dseq: string;
    direction: Dir;
    pnl: number;
    fee: number;
}

export type TwPositionDetail = TwStockPositionDetail | TwFuturePositionDetail;

export interface TwStockProfitDetail {
    market: 'S';
    /** 被沖銷那筆的原成交日 */
    date: string;
    code: string;
    /** 股數（unit=Share） */
    quantity: number;
    price: number;
    cost: number;
    fee: number;
    tax: number;
    interest: number;
    ex_dividend_amt: number;
    shortselling_fee: number;
    rep_margintrading_amt: number;
    rep_collateral: number;
    rep_margin: number;
    cond: string;
    trade_type: string;
    dseq: string;
}

export interface TwFutureProfitDetail {
    market: 'F';
    /** 平倉日 */
    date: string;
    code: string;
    quantity: number;
    direction: Dir;
    entry_date: string;
    entry_quantity: number;
    entry_seqno: string;
    entry_price: number;
    cover_price: number;
    pnl: number;
    fee: number;
    tax: number;
    dseq: string;
}

export type TwProfitDetail = TwStockProfitDetail | TwFutureProfitDetail;

// ---- 正規化 ----

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const dir = (v: unknown): Dir => (v === 'Sell' ? 'Sell' : 'Buy');
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []);

/** 券商日期 YYYYMMDD 或 YYYY-MM-DD → YYYY-MM-DD；其他格式原樣 */
export function twIsoDate(raw: string): string {
    const s = raw.trim();
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

export function normalizePositionDetail(market: TwMarket, raw: unknown): TwPositionDetail[] {
    return rows(raw).map(r => market === 'S'
        ? {
            market: 'S' as const, date: twIsoDate(str(r.date)), code: str(r.code), quantity: num(r.quantity),
            price: num(r.price), last_price: num(r.last_price), dseq: str(r.dseq), direction: dir(r.direction),
            pnl: num(r.pnl), fee: num(r.fee), cond: str(r.cond) || 'Cash', ex_dividends: num(r.ex_dividends),
            interest: num(r.interest), margintrading_amt: num(r.margintrading_amt), collateral: num(r.collateral),
        }
        : {
            market: 'F' as const, date: twIsoDate(str(r.date)), code: str(r.code), quantity: num(r.quantity),
            entry_quantity: num(r.entry_quantity ?? r.quantity), price: num(r.price), last_price: num(r.last_price),
            dseq: str(r.dseq), direction: dir(r.direction), pnl: num(r.pnl), fee: num(r.fee),
        });
}

export function normalizeProfitDetail(market: TwMarket, raw: unknown): TwProfitDetail[] {
    return rows(raw).map(r => market === 'S'
        ? {
            market: 'S' as const, date: twIsoDate(str(r.date)), code: str(r.code), quantity: num(r.quantity),
            price: num(r.price), cost: num(r.cost), fee: num(r.fee), tax: num(r.tax), interest: num(r.interest),
            ex_dividend_amt: num(r.ex_dividend_amt), shortselling_fee: num(r.shortselling_fee),
            rep_margintrading_amt: num(r.rep_margintrading_amt), rep_collateral: num(r.rep_collateral),
            rep_margin: num(r.rep_margin), cond: str(r.cond) || 'Cash', trade_type: str(r.trade_type) || 'Common',
            dseq: str(r.dseq),
        }
        : {
            market: 'F' as const, date: twIsoDate(str(r.date)), code: str(r.code), quantity: num(r.quantity),
            direction: dir(r.direction), entry_date: twIsoDate(str(r.entry_date)), entry_quantity: num(r.entry_quantity),
            entry_seqno: str(r.entry_seqno), entry_price: num(r.entry_price), cover_price: num(r.cover_price),
            pnl: num(r.pnl), fee: num(r.fee), tax: num(r.tax), dseq: str(r.dseq),
        });
}

// ---- 庫存明細 ----

export const TW_POSITION_DETAIL_MISMATCH = '庫存已變動，明細與這一列不符；請更新持倉後再展開';

/** 庫存列的身分：同帳戶內 代碼＋方向＋（股票）交易條件 唯一 */
export interface TwPositionKey {
    id: number;
    code: string;
    direction: Dir;
    /** 股票交易條件（Cash／MarginTrading／ShortSelling）；期貨不給 */
    cond?: string;
}

export async function fetchTwPositionDetail(account: Account, market: TwMarket, row: TwPositionKey): Promise<TwPositionDetail[]> {
    const lots = normalizePositionDetail(market, await fetchPositionDetail(market, account, row.id));
    const code = canonicalBrokerCode(row.code);
    const cond = row.cond || 'Cash';
    // sidecar 快取被較新的 position_unit 換掉時，同一個 id 可能指向別檔：不符就整批不顯示
    if (lots.some(l => canonicalBrokerCode(l.code) !== code || l.direction !== row.direction || (l.market === 'S' && l.cond !== cond))) {
        throw new Error(TW_POSITION_DETAIL_MISMATCH);
    }
    return lots;
}

// ---- 沖銷明細 ----

export const TW_PNL_DETAIL_MISMATCH = '損益資料已變動，找不到這一筆；請更新損益後再展開';

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** profit_loss 列在重查結果裡的同一筆（不靠 id：id 是快取索引，會變） */
export function sameRealizedRow(a: ProfitLoss, b: ProfitLoss): boolean {
    if (canonicalBrokerCode(a.code) !== canonicalBrokerCode(b.code) || twIsoDate(a.date) !== twIsoDate(b.date) || !same(a.pnl, b.pnl)) return false;
    if ('dseq' in a || 'dseq' in b) {
        const s = a as StockProfitLoss;
        const t = b as StockProfitLoss;
        return s.dseq === t.dseq && (s.seqno ?? '') === (t.seqno ?? '') && (s.cond || 'Cash') === (t.cond || 'Cash') && same(s.price, t.price);
    }
    const f = a as FutureProfitLoss;
    const g = b as FutureProfitLoss;
    return f.direction === g.direction && same(f.quantity, g.quantity) && same(f.entry_price, g.entry_price) && same(f.cover_price, g.cover_price);
}

/**
 * 一筆已實現損益的沖銷明細。先以該列日期重查 profit_loss（同一個 unit），
 * 把 sidecar 快取換成這一天、找回這一列現在的 id，再查明細；回來的代碼也要一致。
 * 期貨明細以「代碼＋平倉日＋方向」查，同組多列會回同一份明細。
 */
export async function fetchTwProfitDetail(account: Account, market: TwMarket, row: ProfitLoss): Promise<TwProfitDetail[]> {
    const hit = await fetchProfitLossDetailOf(market, account, twIsoDate(row.date), list => list.find(r => sameRealizedRow(r, row)));
    if (!hit) throw new Error(TW_PNL_DETAIL_MISMATCH);
    const detail = normalizeProfitDetail(market, hit.detail);
    const code = canonicalBrokerCode(row.code);
    if (detail.some(d => canonicalBrokerCode(d.code) !== code)) throw new Error(TW_PNL_DETAIL_MISMATCH);
    return detail;
}

/** 股票交易條件顯示 */
export function twCondLabel(cond: string): string {
    switch (cond) {
        case 'Netting': return '現股當沖';
        case 'MarginTrading': return '融資';
        case 'ShortSelling': return '融券';
        case 'SBLShort': return '借券';
        case 'SBLShortPriceExempt': return '借券豁免';
        case 'Emerging': return '興櫃';
        case 'Cash': case '': return '現股';
        default: return cond;
    }
}
