// src/lib/us-block-route.ts — 美股商品在各面板的走向（主視窗 BlockBody 與彈出視窗共用）
//
// 美股（SDK 1.8.0b1）只有最佳一檔與逐筆、沒有歷史資料。自選、dock、下單、閃電、
// 報價板、走勢（只畫訂閱後的逐筆）已整合；其他跟著商品走的面板顯示「美股暫不支援」。

import type { ContractBase } from './types/contract';
import type { BlockType } from './workspace';

export const US_UNSUPPORTED: ReadonlySet<BlockType> = new Set<BlockType>([
    'depth', 'depthmap', 'tape', 'volprofile', 'replay', 'chips', 'company',
    'oddspread', 'stockfutures', 'warrants', 'optchain', 'combo', 'combolist',
    'grid', 'conditional', 'backtest', 'chainmap', 'optpnl',
]);

export type UsBlockRoute =
    /** 面板不支援美股 */
    | { kind: 'unsupported'; detail?: string }
    /** K 線面板：只顯示報價板，下方標示沒有歷史 K 線 */
    | { kind: 'chart-quote' }
    /** 走勢：只畫訂閱後的逐筆 */
    | { kind: 'intraday' };

/** 非美股商品、或面板照常處理（下單／閃電的 wrapper 自己分流）時回 null */
export function usBlockRoute(type: BlockType, contract: Pick<ContractBase, 'region'> | null | undefined): UsBlockRoute | null {
    if (contract?.region !== 'US') return null;
    if (US_UNSUPPORTED.has(type)) return { kind: 'unsupported' };
    if (type === 'chart') return { kind: 'chart-quote' };
    if (type === 'intraday') return { kind: 'intraday' };
    return null;
}
