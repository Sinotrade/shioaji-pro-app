// src/lib/combo.ts — managed 組合單的 canonical 規則（issue #32）
//
// 1.7.3 managed 語意：腳不帶 action；ComboOrder.action 是交易所層級的
// BS_Code，兩腳實際買賣方向由「組合型別 × 整體 action」展開（TAIFEX
// canonical 表，見 shioaji skill COMBO_ORDERS.md）。舊 directed 模式的
// order-level action 會被忽略、腳 action 才算數 — 面板同時顯示兩套是
// 誤操作根源，故全面改走 managed。
//
// canonical 腳序與淨價定義（與整體買賣方向無關）：
//   TimeSpread/WeeklyTimeSpread  [近月, 遠月]        淨價 = 遠 − 近
//   PriceSpread Call             [高履約, 低履約]     淨價 = 低C − 高C
//   PriceSpread Put              [低履約, 高履約]     淨價 = 高P − 低P
//   Straddle/Strangle            [Call, Put]          淨價 = C + P
//   ConversionReversal           [Call, Put]（同履約） 淨價 = P − C
// 差額型（非 Straddle/Strangle）係數 = [−1, +1]：整體買進 ＝ 買正係數腳、
// 賣負係數腳；和額型 ＝ 兩腳同向。

import type { ComboType } from './shioaji';
import type { ContractInfo } from './types/contract';

export const COMBO_TYPE_LABEL: Record<ComboType, string> = {
    PriceSpread: '價格價差',
    TimeSpread: '跨月價差',
    Straddle: '跨式',
    Strangle: '勒式',
    ConversionReversal: '轉換／逆轉',
    WeeklyTimeSpread: '週選跨月價差',
};

/** canonical 腳係數：淨價 = Σ coef×腳價。 */
export function comboCoefs(type: ComboType): [number, number] {
    return type === 'Straddle' || type === 'Strangle' ? [1, 1] : [-1, 1];
}

/** 整體 action 展開成兩腳實際方向（canonical 腳序）。 */
export function legActionsFor(
    type: ComboType,
    action: 'Buy' | 'Sell',
): ['Buy' | 'Sell', 'Buy' | 'Sell'] {
    return comboCoefs(type).map((c) =>
        (c > 0) === (action === 'Buy') ? 'Buy' : 'Sell',
    ) as ['Buy' | 'Sell', 'Buy' | 'Sell'];
}

export interface OptionComboShape {
    /** canonical 順序的兩腳（可能與輸入相反 → swapped）。 */
    legs: [ContractInfo, ContractInfo];
    swapped: boolean;
    comboType: ComboType | null;
    /** 同履約價 Call+Put：Straddle 與 ConversionReversal 曖昧，需使用者選。 */
    ambiguous: ComboType[] | null;
    error: string | null;
}

const shapeError = (
    a: ContractInfo,
    b: ContractInfo,
    error: string,
): OptionComboShape => ({
    legs: [a, b],
    swapped: false,
    comboType: null,
    ambiguous: null,
    error,
});

/**
 * 選擇權兩腳 → canonical 腳序＋型別。行情端點不收選擇權組合
 * （1.7.3 未實作行情編碼），所以排序/推導在 client 做；下單時
 * server 會以 Contract V2 Info 再驗一次（家族/週月/順序），這裡
 * 只求先擋掉明顯不合法與把腳排對。
 */
export function deriveOptionShape(
    a: ContractInfo,
    b: ContractInfo,
): OptionComboShape {
    if (a.code === b.code) return shapeError(a, b, '兩腳不可為同一合約');
    const sa = a.strike_price;
    const sb = b.strike_price;
    const ra = a.option_right ?? '';
    const rb = b.option_right ?? '';
    const da = a.delivery_month ?? '';
    const db = b.delivery_month ?? '';
    if (!sa || !sb || !ra || !rb || !da || !db) {
        return shapeError(a, b, '合約資訊不完整，無法判定組合型別');
    }
    const isCall = (r: string) => r === 'C' || /call/i.test(r);
    const ca = isCall(ra);
    const cb = isCall(rb);

    const ordered = (
        first: ContractInfo,
        type: ComboType | null,
        ambiguous: ComboType[] | null = null,
    ): OptionComboShape => {
        const swapped = first !== a;
        return {
            legs: swapped ? [b, a] : [a, b],
            swapped,
            comboType: type,
            ambiguous,
            error: null,
        };
    };

    if (da !== db) {
        // 跨月：僅同履約價同 Call/Put 是時間價差；近月在前。
        // 週選/月選是否同家族由 server 驗（Weekly 變體也由 server 推導）。
        if (sa === sb && ca === cb) {
            return ordered(da < db ? a : b, 'TimeSpread');
        }
        return shapeError(a, b, '跨月組合僅支援同履約價、同 Call/Put（時間價差）');
    }
    if (ca !== cb) {
        // Call 在前
        const call = ca ? a : b;
        if (sa === sb) {
            return ordered(call, null, ['Straddle', 'ConversionReversal']);
        }
        return ordered(call, 'Strangle');
    }
    if (sa !== sb) {
        // 垂直價差：Call 高履約在前；Put 低履約在前
        const first = ca ? (sa > sb ? a : b) : (sa < sb ? a : b);
        return ordered(first, 'PriceSpread');
    }
    return shapeError(a, b, '兩腳完全相同，無法組成組合');
}

/** 期貨兩腳的 canonical 預排序（近月在前）；家族合法性交給 server 驗。 */
export function orderFuturesLegs(
    a: ContractInfo,
    b: ContractInfo,
): { legs: [ContractInfo, ContractInfo]; swapped: boolean } {
    const da = a.delivery_month ?? '';
    const db = b.delivery_month ?? '';
    if (da && db && da > db) return { legs: [b, a], swapped: true };
    return { legs: [a, b], swapped: false };
}

export interface LegQuoteL1 {
    bid: number;
    ask: number;
}

/**
 * 合成報價（canonical 淨價軸，僅供參考）：
 * bid = 正係數腳收 bid、負係數腳付 ask；ask 反之。
 * 買組合吃 ask、賣組合打 bid — 與原生組合簿的方向定義一致。
 */
export function syntheticComboQuote(
    type: ComboType,
    quotes: [LegQuoteL1 | null, LegQuoteL1 | null],
): LegQuoteL1 | null {
    const coefs = comboCoefs(type);
    let bid = 0;
    let ask = 0;
    for (let i = 0; i < 2; i++) {
        const q = quotes[i];
        if (!q || !Number.isFinite(q.bid) || !Number.isFinite(q.ask)) {
            return null;
        }
        if (coefs[i]! > 0) {
            bid += q.bid;
            ask += q.ask;
        } else {
            bid -= q.ask;
            ask -= q.bid;
        }
    }
    return { bid: Number(bid.toFixed(2)), ask: Number(ask.toFixed(2)) };
}
