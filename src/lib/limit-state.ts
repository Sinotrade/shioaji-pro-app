// src/lib/limit-state.ts — 成交價是否位於漲停／跌停（各面板共用一份）
//
// 規則：
// - 指數（IND）與興櫃（OES）沒有漲跌停 → 永遠 null
// - 漲跌停價缺席或不合理（limit_up <= limit_down、limit_down <= 0）→ null
// - 以跳動價位的精度（小數位數，至少 2 位）四捨五入後再比較，消掉 0.1
//   級距累加的浮點誤差。不用「半檔容差」：期權級距表尚未載入時
//   tickSizeFor 會退回參考價所在級距，半檔可能大於停板附近的真實級距，
//   把停板前一檔誤判成停板

import type { ContractInfo } from './types/contract';
import { tickDecimals, tickSizeFor } from './utils/ticksize';

export type LimitState = 'up' | 'down' | null;

type LimitContract = Pick<
    ContractInfo,
    'code' | 'exchange' | 'security_type' | 'target_code' | 'limit_up' | 'limit_down'
> &
    Partial<Pick<ContractInfo, 'tick_rule' | 'tick' | 'underlying_kind'>>;

export function limitStateOf(
    contract: LimitContract,
    price: number | undefined | null,
): LimitState {
    if (contract.security_type === 'IND' || contract.exchange === 'OES') {
        return null;
    }
    if (price === undefined || price === null || !Number.isFinite(price) || price <= 0) {
        return null;
    }
    const lu = Number(contract.limit_up);
    const ld = Number(contract.limit_down);
    if (!Number.isFinite(lu) || !Number.isFinite(ld) || ld <= 0 || lu <= ld) {
        return null;
    }
    const decimals = Math.max(
        2,
        tickDecimals(tickSizeFor(contract, lu)),
        tickDecimals(tickSizeFor(contract, ld)),
    );
    const round = (v: number) => Number(v.toFixed(decimals));
    const px = round(price);
    if (px >= round(lu)) return 'up';
    if (px <= round(ld)) return 'down';
    return null;
}
