// src/lib/limit-state.ts — 成交價是否位於漲停／跌停（各面板共用一份）
//
// 規則：
// - 指數（IND）與興櫃（OES）沒有漲跌停 → 永遠 null
// - 漲跌停價缺席或不合理（limit_up <= limit_down、limit_down <= 0）→ null
// - 以跳動價位的半檔為容差比較，避免 0.1 級距累加的浮點誤差；漲停用
//   「漲停價下方那一檔」的級距（如漲停 10 元時下方級距 0.01），避免把
//   漲停前一檔誤判為漲停

import type { ContractInfo } from './types/contract';
import { tickSizeFor } from './utils/ticksize';

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
    const upTick = tickSizeFor(contract, lu * (1 - 1e-9));
    const downTick = tickSizeFor(contract, ld);
    if (price >= lu - upTick / 2) return 'up';
    if (price <= ld + downTick / 2) return 'down';
    return null;
}
