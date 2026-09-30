// src/lib/pending-trigger-view.ts — plain-language wording for a 待確認
// trigger (#144): what it would do, when it fires, and where the price is
// now, so the panel and its notification read as sentences, not codes.

import type { ContractInfo } from './types/contract';
import type { TriggerOrder } from './trigger-engine';
import { isOddLot, stockQtyUnit } from './odd-lot';
import { fmtPrice } from './utils/format';

/** 中文商品名（含月份）; the code when the contract is not loaded yet. */
export function contractLabel(code: string, contract: Pick<ContractInfo, 'name' | 'delivery_month'> | undefined): string {
    if (!contract?.name) return code;
    const month = contract.delivery_month;
    return month && !contract.name.includes(month) ? `${contract.name} ${month}` : contract.name;
}

export function kindLabel(t: Pick<TriggerOrder, 'kind' | 'bracketId'>): string {
    const base = t.kind === 'take' ? '停利' : '停損';
    return t.bracketId ? `括號單${base}` : base;
}

/** 股票以「張」（零股以「股」）、期貨選擇權以「口」計 */
export function actionLabel(t: Pick<TriggerOrder, 'action' | 'quantity' | 'account' | 'orderLot'>): string {
    const unit = t.account?.account_type === 'S' ? stockQtyUnit(t.orderLot) : '口';
    return `${t.action === 'Buy' ? '買進' : '賣出'} ${t.quantity} ${unit}`;
}

/** 送單方式：整股／期貨市價；零股沒有市價，以漲跌停價限價送出（#204） */
export function exitStyleLabel(t: Pick<TriggerOrder, 'orderLot'>): string {
    return isOddLot(t.orderLot) ? '零股漲跌停限價' : '市價';
}

/** 「價格漲到 48,151 以上時觸發」 */
export function conditionLabel(t: Pick<TriggerOrder, 'condition' | 'price'>): string {
    return t.condition === 'above' ? `漲到 ${fmtPrice(t.price)} 以上` : `跌到 ${fmtPrice(t.price)} 以下`;
}

export function fmtPoints(v: number): string {
    return Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Where the current price stands against the trigger price. */
export function distanceLabel(t: Pick<TriggerOrder, 'condition' | 'price'>, price: number): { text: string; past: boolean } {
    const d = price - t.price;
    const past = t.condition === 'above' ? d >= 0 : d <= 0;
    if (d === 0) return { text: '正好在觸發價', past };
    if (past) return { text: `已${t.condition === 'above' ? '超過' : '跌破'} ${fmtPoints(d)} 點`, past };
    return { text: `已回到觸發價${t.condition === 'above' ? '下方' : '上方'} ${fmtPoints(d)} 點`, past };
}
