// src/lib/us-block-route.ts — 美股商品在各面板的走向（主視窗 BlockBody 與彈出視窗共用）
//
// 美股（SDK 1.8.0b1）有最佳一檔、逐筆，以及一般盤的歷史 1 分 K／逐筆／快照
// （只有正式環境 BC 有資料）。報價板、K 線、走勢、成交明細、五檔都直接用
// 台股元件畫（資料轉接見 lib/chart-history、lib/us/us-adapter、lib/us/us-tape，
// 時段見 lib/intraday-session 的 'US'）；自選、dock、下單、閃電的 wrapper 自己
// 分流。其他跟著商品走的面板（五檔圖、分價量、回放、籌碼、選擇權、組合、
// 條件單、回測等）沒有美股資料或規則，顯示「美股暫不支援」。

import type { ContractBase } from './types/contract';
import type { BlockType } from './workspace';

export const US_UNSUPPORTED: ReadonlySet<BlockType> = new Set<BlockType>([
    'depthmap', 'volprofile', 'replay', 'chips', 'company',
    'oddspread', 'stockfutures', 'warrants', 'optchain', 'combo', 'combolist',
    'grid', 'conditional', 'backtest', 'chainmap', 'optpnl',
]);

export type UsBlockRoute =
    /** 面板不支援美股 */
    { kind: 'unsupported'; detail?: string };

/** 非美股商品、或面板照常處理（台股元件已支援美股，或 wrapper 自己分流）時回 null */
export function usBlockRoute(type: BlockType, contract: Pick<ContractBase, 'region'> | null | undefined): UsBlockRoute | null {
    if (contract?.region !== 'US') return null;
    if (US_UNSUPPORTED.has(type)) return { kind: 'unsupported' };
    return null;
}
