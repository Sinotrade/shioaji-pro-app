// src/lib/us-block-route.ts — 美股商品在各面板的走向（主視窗 BlockBody 與彈出視窗共用）
//
// 美股（SDK 1.8.0b1）有最佳一檔、逐筆，以及一般盤的歷史 1 分 K／逐筆／快照
// （只有正式環境 BC 有資料）。自選、dock、下單、閃電、報價板已整合；K 線、
// 走勢、成交明細改用美股元件（先載歷史再接即時，SDK 沒有歷史時退回只用即時）；
// 五檔改顯示最佳一檔。其他跟著商品走的面板（五檔圖、分價量、回放、籌碼、
// 選擇權、組合、條件單、回測等）沒有美股資料或規則，顯示「美股暫不支援」。

import type { ContractBase } from './types/contract';
import type { BlockType } from './workspace';

export const US_UNSUPPORTED: ReadonlySet<BlockType> = new Set<BlockType>([
    'depthmap', 'volprofile', 'replay', 'chips', 'company',
    'oddspread', 'stockfutures', 'warrants', 'optchain', 'combo', 'combolist',
    'grid', 'conditional', 'backtest', 'chainmap', 'optpnl',
]);

export type UsBlockRoute =
    /** 面板不支援美股 */
    | { kind: 'unsupported'; detail?: string }
    /** K 線面板：報價板＋美股 K 線（一般盤 1 分 K 歷史＋即時逐筆） */
    | { kind: 'chart' }
    /** 走勢：一般盤歷史＋即時逐筆（沒有歷史時只畫訂閱後的逐筆） */
    | { kind: 'intraday' }
    /** 成交明細：最近交易日的歷史成交＋即時逐筆 */
    | { kind: 'tape' }
    /** 五檔：美股只有最佳一檔 */
    | { kind: 'depth' };

/** 非美股商品、或面板照常處理（下單／閃電的 wrapper 自己分流）時回 null */
export function usBlockRoute(type: BlockType, contract: Pick<ContractBase, 'region'> | null | undefined): UsBlockRoute | null {
    if (contract?.region !== 'US') return null;
    if (US_UNSUPPORTED.has(type)) return { kind: 'unsupported' };
    if (type === 'chart') return { kind: 'chart' };
    if (type === 'intraday') return { kind: 'intraday' };
    if (type === 'tape') return { kind: 'tape' };
    if (type === 'depth') return { kind: 'depth' };
    return null;
}
