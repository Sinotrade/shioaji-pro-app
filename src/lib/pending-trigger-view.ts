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

export function kindLabel(t: Pick<TriggerOrder, 'kind' | 'bracketId' | 'role'>): string {
    if (t.role === 'entry') return '觸價單';
    const base = t.kind === 'take' ? '停利' : '停損';
    return t.bracketId ? `括號單${base}` : base;
}

/** 股票以「張」（零股以「股」）、期貨選擇權以「口」計 */
export function actionLabel(t: Pick<TriggerOrder, 'action' | 'quantity' | 'account' | 'orderLot'>): string {
    const unit = t.account?.account_type === 'S' ? stockQtyUnit(t.orderLot) : '口';
    return `${t.action === 'Buy' ? '買進' : '賣出'} ${t.quantity} ${unit}`;
}

/** 送單方式：整股／期貨市價；零股沒有市價，以漲跌停價限價送出（#204）；
 * #226 範圍市價、觸價後限價（觸發價 ± N 檔） */
export function exitStyleLabel(t: Pick<TriggerOrder, 'orderLot'> & { send?: TriggerOrder['send'] }): string {
    if (isOddLot(t.orderLot)) return '零股漲跌停限價';
    if (t.send?.type === 'MKP') return '範圍市價';
    if (t.send?.type === 'LMT') return t.send.ticks === 0 ? '觸發價限價' : `觸發價${t.send.ticks > 0 ? '+' : '−'}${Math.abs(t.send.ticks)}檔限價`;
    return '市價';
}

/** 送出後會怎樣：整股／期貨是市價單會立即成交；零股是漲跌停價限價 ROD，
 * 要等下一次零股撮合（約每 5 秒），不保證立即成交（#204） */
export function sendOutcomeText(t: Pick<TriggerOrder, 'orderLot'> & Partial<Pick<TriggerOrder, 'send' | 'group' | 'ocoMode'>>): string {
    if (!isOddLot(t.orderLot) && t.send?.type === 'LMT') {
        return t.group && t.ocoMode === 'fill' ? '會以限價 IOC 送出，未成交的部分會取消' : '會以限價送出，未成交的部分會留在委託中';
    }
    if (!isOddLot(t.orderLot) && t.send?.type === 'MKP') return '會以範圍市價送出，可能只成交一部分';
    return isOddLot(t.orderLot)
        ? '會以漲跌停價送出零股限價 ROD，等下一次零股撮合（約每 5 秒）成交，不保證立即成交'
        : '會立刻以市價成交';
}

/** 送出按鈕的提示 */
export function sendButtonTitle(t: Pick<TriggerOrder, 'orderLot'> & { send?: TriggerOrder['send'] }): string {
    if (!isOddLot(t.orderLot) && t.send && t.send.type !== 'MKT') return `重新檢查行情連線、環境與帳戶後，以原設定（${exitStyleLabel(t)}）立即送出`;
    return isOddLot(t.orderLot)
        ? '重新檢查行情連線、環境與帳戶後，以原設定立即送出零股限價單（漲跌停價、ROD，等零股撮合）'
        : '重新檢查行情連線、環境與帳戶後，以原設定立即送出市價單';
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
