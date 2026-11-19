// src/lib/us/us-order-rules.ts — 美股（closed beta）下單規則
//
// 規格（美股 PM，11/18）：
// - 只用 H 帳戶、只能整股；price_type LMT／MKT。
// - 市價只能賣出：買進只能限價（美股 PM，11/18）。
// - time_in_force：DAY、ATC（ATC 只能限價；ATC＋MKT 上游 V016 會拒）。
//   OPG 這版不開放；要開時把 'OPG' 加進 US_TIME_IN_FORCE_ENABLED 即可。
// - 不帶 order_lot／order_cond／daytrade_short／custom_field（SDK 本地就拒）。
// - 價格最多 4 位小數；MKT 送 "0"（SDK intl.rs：MKT 可為 0）。

import { decFractionDigits, decIsPositive, decNormalize } from './decimal';
import type { Action } from '../types/order';
import type { UsOrderReq, UsPriceType, UsTimeInForce } from '../types/us';

/** 這版開放的時效；開放 OPG 只要改這裡 */
export const US_TIME_IN_FORCE_ENABLED: readonly UsTimeInForce[] = ['DAY', 'ATC'];

export const US_TIME_IN_FORCE_LABEL: Record<UsTimeInForce, string> = {
    DAY: 'DAY 當日有效',
    OPG: 'OPG 開盤',
    ATC: 'ATC 收盤',
};

export const US_PRICE_TYPES: readonly UsPriceType[] = ['LMT', 'MKT'];
export const US_PRICE_TYPE_LABEL: Record<UsPriceType, string> = { LMT: '限價', MKT: '市價' };

export const US_PRICE_MAX_DECIMALS = 4;

/** 這個方向＋時效不能用這個價別的原因；可以用回 null */
export function usPriceTypeBlockReason(action: Action, tif: UsTimeInForce, priceType: UsPriceType): string | null {
    if (priceType !== 'MKT') return null;
    if (action === 'Buy') return '買進只能限價，市價只能賣出';
    if (tif === 'ATC') return 'ATC 只能限價，不能用市價';
    return null;
}

/** 這個方向＋時效能不能配這個價別（買進只能限價；ATC 只能限價） */
export function usPriceTypeAllowed(action: Action, tif: UsTimeInForce, priceType: UsPriceType): boolean {
    return usPriceTypeBlockReason(action, tif, priceType) === null;
}

/** 美股下單面板的 Beta 提示 */
export const US_BETA_NOTICE = '美股 Beta：只能整股；買進只能限價，市價只能賣出；ATC 只能限價；改價會先刪單再重下。';

export interface UsOrderDraft {
    action: Action;
    quantity: string;
    priceType: UsPriceType;
    timeInForce: UsTimeInForce;
    price: string;
}

/** 檢查草稿；有問題回中文訊息，合法回 null */
export function usOrderProblem(d: UsOrderDraft): string | null {
    if (d.action !== 'Buy' && d.action !== 'Sell') return '請選擇買賣方向';
    if (!US_TIME_IN_FORCE_ENABLED.includes(d.timeInForce)) return `這個版本不開放 ${d.timeInForce} 時效`;
    if (!US_PRICE_TYPES.includes(d.priceType)) return '美股只能用限價或市價';
    const blocked = usPriceTypeBlockReason(d.action, d.timeInForce, d.priceType);
    if (blocked) return blocked;
    const qty = d.quantity.trim();
    if (!/^\d+$/.test(qty) || Number(qty) < 1) return '美股只能整股，數量至少 1 股';
    if (!Number.isSafeInteger(Number(qty))) return '數量過大';
    if (d.priceType === 'LMT') {
        const price = d.price.trim();
        if (!decIsPositive(price)) return '限價單需要大於 0 的價格';
        if (decFractionDigits(price) > US_PRICE_MAX_DECIMALS) return `價格最多 ${US_PRICE_MAX_DECIMALS} 位小數`;
    }
    return null;
}

/** 草稿 → place_order 的 stock_order（呼叫前先過 usOrderProblem） */
export function buildUsOrderReq(d: UsOrderDraft): UsOrderReq {
    return {
        action: d.action,
        price: d.priceType === 'MKT' ? '0' : decNormalize(d.price.trim()) ?? d.price.trim(),
        quantity: Number(d.quantity.trim()),
        price_type: d.priceType,
        time_in_force: d.timeInForce,
    };
}

/** 美股委託被拒或刪單過早（-2054）時的提示 */
export const US_CANCEL_TOO_EARLY_CODE = '-2054';
export const US_CANCEL_TOO_EARLY_MESSAGE = '剛送出的委託稍後再刪：券商還在建立這筆委託，請約 1 秒後再按一次刪單';

/** 錯誤訊息是否是「此委託不存在」（剛送出 1 秒內刪單） */
export function isUsCancelTooEarly(message: string | undefined | null): boolean {
    if (!message) return false;
    return message.includes(US_CANCEL_TOO_EARLY_CODE) || message.includes('此委託不存在');
}
