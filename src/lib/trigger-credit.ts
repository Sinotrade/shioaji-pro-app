// src/lib/trigger-credit.ts — 觸價單的股票信用條件（#263）。
// A stock trigger entry keeps the credit condition it was created with
// (融資、融券、現股當沖先賣) and goes out with it when it fires — in the
// window engine (placeQuickOrder) and in the background engine (#226 step 5:
// OrderSpec stockCond / daytradeShort, `stock-trigger-common-and-credit`).
// Switching the panel afterwards never changes a trigger already placed.
// What neither engine takes is refused when created, with the reason.

import { CREDIT_TEXT, isOddLot, ODD_LOT_TEXT } from './odd-lot';
import type { TriggerOrder } from './trigger-engine';
import type { Action, StockOrderCond } from './types/order';

export const TRIGGER_CREDIT_TEXT = {
    sbl: '觸價單不支援借券賣出（借券、借券豁免）；請改用現股、融資、融券或現股當沖先賣',
    futures: '信用條件（融資、融券、當沖先賣）只適用股票',
    protect: '停損停利（括號單）以現股出場，不能帶信用條件',
    exit: '停損停利觸價只以現股出場，不能帶信用條件',
    time: '時間條件只支援現股',
    alert: '到價警示不下單，不帶信用條件',
} as const;

type CreditShape = Pick<TriggerOrder, 'kind' | 'action' | 'account' | 'orderLot' | 'bracketId' | 'bracketPlan' | 'role' | 'time'
    | 'orderCond' | 'daytradeShort'>;

/** Why a trigger cannot go out with its credit condition (null: it can, or it
 * has none). The same rules as the order ticket (`stockOrderProblem`) and the
 * background engine's `order_fits` / `closing_cond`: 整股 only; 融券 sells
 * only; 當沖先賣 only sells in cash; only an entry (an opening order —
 * protective stops / takes and bracket exits close in cash); no 借券. Whether
 * the stock may be day-traded or is open for 融資券 today is checked by the
 * panel when created and by the broker when it fires. */
export function triggerCreditProblem(t: CreditShape): string | null {
    const cond = t.orderCond && t.orderCond !== 'Cash' ? t.orderCond : undefined;
    const daytrade = t.daytradeShort === true;
    if (!cond && !daytrade) return null;
    if (t.kind === 'alert') return TRIGGER_CREDIT_TEXT.alert;
    if (t.account?.account_type !== 'S') return TRIGGER_CREDIT_TEXT.futures;
    if (cond && cond !== 'MarginTrading' && cond !== 'ShortSelling') return TRIGGER_CREDIT_TEXT.sbl;
    if (isOddLot(t.orderLot)) return cond ? ODD_LOT_TEXT.cond : ODD_LOT_TEXT.daytrade;
    if (t.bracketId || t.bracketPlan) return TRIGGER_CREDIT_TEXT.protect;
    if (t.role !== 'entry') return TRIGGER_CREDIT_TEXT.exit;
    if (t.time) return TRIGGER_CREDIT_TEXT.time;
    if (cond === 'ShortSelling' && t.action === 'Buy') return CREDIT_TEXT.shortBuy;
    if (daytrade && cond) return CREDIT_TEXT.daytradeCond;
    if (daytrade && t.action !== 'Sell') return CREDIT_TEXT.daytradeSide;
    return null;
}

/** The fields a new trigger of `action` stores for the panel's credit
 * setting: 當沖先賣 only on a sell (a buy is a plain cash buy, as on the
 * ticket); 現股 stores nothing. */
export function triggerCreditFields(credit: { cond: StockOrderCond; daytradeShort: boolean }, action: Action): { orderCond?: StockOrderCond; daytradeShort?: true } {
    if (credit.cond !== 'Cash') return { orderCond: credit.cond };
    return credit.daytradeShort && action === 'Sell' ? { daytradeShort: true } : {};
}

/** 「融資」「融券」「現股當沖先賣」 for a trigger that goes out with it; '' in cash. */
export function triggerCreditText(t: { orderCond?: string; daytradeShort?: boolean }): string {
    if (t.orderCond === 'MarginTrading') return '融資';
    if (t.orderCond === 'ShortSelling') return '融券';
    if (t.orderCond === 'SBLShort') return '借券';
    if (t.orderCond === 'SBLShortPriceExempt') return '借券豁免';
    return t.daytradeShort ? '現股當沖先賣' : '';
}
