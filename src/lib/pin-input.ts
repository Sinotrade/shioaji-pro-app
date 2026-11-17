// src/lib/pin-input.ts — 面板鎖定／群組手打代碼的解析
//
// 先當台股查；查不到又像美股代碼（英文字母）時改查美股（存 US:CODE）。
// 鎖定是非同步的：較晚回來的查詢結果不可蓋掉之後的鎖定或解除鎖定。

import { contractLinkKey, isUsKey, usLinkKey } from './contract-key';
import type { ContractInfo } from './types/contract';

export const US_TYPED_CODE = /^[A-Za-z][A-Za-z.]{0,9}$/;

export async function resolveInputContract(
    code: string,
    ensure: (key: string) => Promise<ContractInfo>,
): Promise<ContractInfo> {
    if (isUsKey(code)) return ensure(code);
    try {
        return await ensure(code);
    } catch (error) {
        if (!US_TYPED_CODE.test(code)) throw error;
        return ensure(usLinkKey(code));
    }
}

/** 每個面板的鎖定設定器：只套用該面板最新一次設定的結果 */
export function createPinSetter(deps: {
    ensure: (key: string) => Promise<ContractInfo>;
    cached: (code: string) => unknown;
    store: (id: string, pin: string | null) => void;
}) {
    const seq = new Map<string, number>();
    return (id: string, pin: string | null) => {
        const mine = (seq.get(id) ?? 0) + 1;
        seq.set(id, mine);
        if (pin && !isUsKey(pin) && !deps.cached(pin) && US_TYPED_CODE.test(pin)) {
            const settle = (value: string) => { if (seq.get(id) === mine) deps.store(id, value); };
            return resolveInputContract(pin, deps.ensure).then((c) => settle(contractLinkKey(c)), () => settle(pin));
        }
        deps.store(id, pin);
        return Promise.resolve();
    };
}
