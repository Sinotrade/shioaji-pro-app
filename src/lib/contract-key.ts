// src/lib/contract-key.ts — 連動用的商品識別字串
//
// 台股維持裸代碼（舊存檔的鎖定／群組／popout 都是裸代碼，照舊相容）；
// 美股一律加 `US:` 前綴（例：US:AAPL），避免和台股代碼撞名，也讓
// ensureContract／useContract 知道要走美股商品資訊而不是 region=TW 查詢。

import type { ContractBase } from './types/contract';

export const US_KEY_PREFIX = 'US:';

export function isUsKey(key: string | null | undefined): boolean {
    return typeof key === 'string' && key.startsWith(US_KEY_PREFIX);
}

/** 美股代碼 → 連動 key（大寫） */
export function usLinkKey(code: string): string {
    return `${US_KEY_PREFIX}${code.trim().toUpperCase()}`;
}

/** 合約的連動 key：美股 `US:CODE`，台股裸代碼 */
export function contractLinkKey(c: Pick<ContractBase, 'code' | 'region'>): string {
    return c.region === 'US' ? usLinkKey(c.code) : c.code;
}

export function parseContractLinkKey(key: string): { region: 'TW' | 'US'; code: string } {
    return isUsKey(key)
        ? { region: 'US', code: key.slice(US_KEY_PREFIX.length).trim().toUpperCase() }
        : { region: 'TW', code: key };
}

/** 兩個合約是否同一檔（含 region） */
export function sameContract(
    a: Pick<ContractBase, 'code' | 'region'> | null | undefined,
    b: Pick<ContractBase, 'code' | 'region'> | null | undefined,
): boolean {
    return !!a && !!b && contractLinkKey(a) === contractLinkKey(b);
}
