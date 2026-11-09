// src/lib/warrant-rules.ts — 台灣權證（認購／認售）的下單規則（單一判斷來源）
//
// 依據見 docs/qa/warrant-rules.md。這裡只放「交易所規則確定不收」的組合，
// 在確認前（下單面板、閃電、平倉）與送出前（placeStockOrder）都檢查一次，
// 任何路徑都不會把交易所必定退回的委託送出。

import { isForeignUnderlyingWarrant, isWarrantContract } from './contract-market';
import { isOddLot } from './odd-lot';
import type { SecurityType } from './types/contract';

/** 一交易單位 = 1,000 權證單位（TWSE 權證買賣辦法第 5 條）。 */
export const WARRANT_UNITS_PER_LOT = 1000;

export const WARRANT_TEXT = {
    oddLot: '權證不得零股交易（盤中零股、盤後零股都不收），請以整張下單（1 張 = 1,000 單位）',
    credit: '權證只能現股買賣，不適用融資、融券、借券賣出或現股當沖先賣',
    foreignMarket: '外國標的權證無漲跌幅限制，交易所不接受市價委託；請改用限價',
    offTick: '權證價格不在升降單位上（未滿 5 元 0.01、5–10 元 0.05、10–50 元 0.1、50–100 元 0.5、100–500 元 1、500 元以上 5）',
} as const;

/** 閃電面板與觸價／停損停利對權證的提示（觸價與自動停損停利照權證規則開放） */
export const WARRANT_FLASH_TEXT = {
    /** 外國標的權證：觸價後只能送限價（市價選項停用） */
    foreignTrigger: '外國標的權證觸價後不能送市價；請在設定選單把「觸價後」改成限價',
    /** 設定選單裡「觸價後」的市價選項停用原因 */
    foreignTriggerMenu: '外國標的權證無漲跌幅，觸價後不能送市價，只能限價',
    /** K 線圖的停損／停利觸發後一律市價，外國標的權證不能用 */
    chartForeign: '外國標的權證不能用 K 線圖停損停利（觸發後是市價單）；請到條件單面板設定觸價後限價',
    /** 外國標的權證：停損停利的出場是市價單，交易所不收，所以不能附加 */
    foreignProtect: '外國標的權證不能自動停損停利（出場是市價單，交易所不收）；請改用限價自行出場',
    /** 外國標的權證市價鈕旁的說明列 */
    foreignMarket: '外國標的權證不能下市價，請點價格下限價單',
} as const;

/** 下單面板價別列下的說明 */
export const WARRANT_TICKET_TEXT = {
    foreignMarket: '外國標的權證不能下市價，請用限價',
} as const;

type WarrantLike = { security_type?: SecurityType | string; code?: string } | null | undefined;

export interface WarrantOrderShape {
    price_type?: string;
    order_lot?: string;
    order_cond?: string;
    daytrade_short?: boolean;
}

/** 市價委託是否被交易所規則排除（營業細則第 58 條之 8：無升降幅度限制之有價證券不得市價）。 */
export function warrantMarketOrderBlock(contract: WarrantLike): string | null {
    if (!isWarrantContract(contract)) return null;
    return isForeignUnderlyingWarrant(contract?.code) ? WARRANT_TEXT.foreignMarket : null;
}

/** 權證不收的委託組合；非權證一律回 null（不影響股票規則）。 */
export function warrantOrderProblem(contract: WarrantLike, o: WarrantOrderShape): string | null {
    if (!isWarrantContract(contract)) return null;
    if (isOddLot(o.order_lot)) return WARRANT_TEXT.oddLot;
    if ((o.order_cond && o.order_cond !== 'Cash') || o.daytrade_short) return WARRANT_TEXT.credit;
    if (o.price_type !== undefined && o.price_type !== 'LMT') return warrantMarketOrderBlock(contract);
    return null;
}

/** 權證升降單位表（權證買賣辦法第 6 條；櫃買級距相同），給背景執行引擎計算限價用。 */
export function warrantTickTable(): { min: number; max: number | null; tick: number }[] {
    return [
        { min: 0, max: 5, tick: 0.01 }, { min: 5, max: 10, tick: 0.05 }, { min: 10, max: 50, tick: 0.1 },
        { min: 50, max: 100, tick: 0.5 }, { min: 100, max: 500, tick: 1 }, { min: 500, max: null, tick: 5 },
    ];
}

/** 價格是否落在權證升降單位上（以 1/10000 定點比較，與背景執行引擎相同）。 */
export function isWarrantPriceOnTick(price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    const fx = (v: number) => Math.round(v * 10_000);
    const p = fx(price);
    if (p <= 0) return false;
    const band = warrantTickTable().find(b => p >= fx(b.min) && (b.max === null || p < fx(b.max)));
    return !!band && (p - fx(band.min)) % fx(band.tick) === 0;
}

/**
 * 權證觸價單（觸價後送出）不收的組合；非權證回 null。
 * `send` 省略＝市價；外國標的只能觸價後限價，限價時觸發價必須在權證升降單位上
 * （觸價後限價＝觸發價往成交方向移 N 檔，起點不在升降單位上就送不出去）。
 */
export function warrantTriggerProblem(contract: WarrantLike, t: {
    orderLot?: string;
    send?: { type: string } | null;
    price?: number;
}): string | null {
    if (!isWarrantContract(contract)) return null;
    if (isOddLot(t.orderLot)) return WARRANT_TEXT.oddLot;
    const limit = t.send?.type === 'LMT';
    if (!limit && isForeignUnderlyingWarrant(contract?.code)) return WARRANT_FLASH_TEXT.foreignTrigger;
    if (limit && t.price !== undefined && !isWarrantPriceOnTick(t.price)) return WARRANT_TEXT.offTick;
    return null;
}

/** 權證能不能附自動停損停利（括號單）：出場一律市價，外國標的不收；非權證回 null。 */
export function warrantProtectProblem(contract: WarrantLike): string | null {
    if (!isWarrantContract(contract)) return null;
    return isForeignUnderlyingWarrant(contract?.code) ? WARRANT_FLASH_TEXT.foreignProtect : null;
}

/** 權證以股數市價平倉不收的情況（非權證回 null）：未滿一張的餘數（沒有零股），
 * 或外國標的（無漲跌幅、不收市價）。閃電平倉在取消停損停利之前先看這裡，
 * 不能平倉就不動保護。 */
export function warrantExitBySharesProblem(contract: WarrantLike, shares: number): string | null {
    if (!isWarrantContract(contract)) return null;
    if (shares % WARRANT_UNITS_PER_LOT) return '權證沒有零股，未滿一張的部分無法平倉';
    // 整張走市價：外國標的權證無漲跌幅、交易所不收市價，也沒有漲跌停價可當限價
    const market = shares >= WARRANT_UNITS_PER_LOT ? warrantMarketOrderBlock(contract) : null;
    return market ? `${market}（請在下單面板以限價平倉）` : null;
}
