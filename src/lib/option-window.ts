// src/lib/option-window.ts — T 字報價的即時訂閱窗（issue #371）.
// 設計與數量上限見 docs/design/option-chain-range.md。表格列出全部履約價，
// 只有這個窗內的檔位訂閱 Tick／BidAsk；這裡只放純計算，方便測試。

import { fetchSnapshots } from './shioaji';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';

/** 表格列的索引範圍，含頭尾。 */
export interface StrikeRange {
    first: number;
    last: number;
}

/** 還量不到畫面時，以價平為中心上下各幾檔（等於舊版固定顯示的 8 檔）。 */
export const INITIAL_SPAN = 8;
/** 畫面上下各多訂閱幾檔，小幅捲動不必換訂閱。 */
export const LIVE_BUFFER = 3;
/** 一張 T 字表最多同時訂閱幾檔履約價。 */
export const LIVE_STRIKE_CAP = 24;
/** 每檔履約價占幾個訂閱：買權＋賣權 × Tick＋BidAsk。 */
export const QUOTES_PER_STRIKE = 4;
/** 捲動停下多久才換窗；持續捲動時完全不動訂閱。 */
export const WINDOW_SETTLE_MS = 300;
/** /data/snapshots 單次上限。 */
export const SNAPSHOT_BATCH = 500;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** 以 center 為中心上下各 span 檔，超出表格時截掉。 */
export function centeredRange(center: number, total: number, span = INITIAL_SPAN): StrikeRange {
    if (total <= 0) return { first: 0, last: -1 };
    const c = clamp(center, 0, total - 1);
    return { first: Math.max(0, c - span), last: Math.min(total - 1, c + span) };
}

/** 由捲動位置算出畫面上看得到的列（表頭 sticky，蓋住內容最上方 headerHeight）。 */
export function visibleRange(
    scrollTop: number,
    viewportHeight: number,
    headerHeight: number,
    rowHeight: number,
    total: number,
): StrikeRange | null {
    if (total <= 0 || rowHeight <= 0 || viewportHeight <= 0) return null;
    const first = clamp(Math.floor(scrollTop / rowHeight), 0, total - 1);
    const end = Math.ceil((scrollTop + viewportHeight - headerHeight) / rowHeight) - 1;
    return { first, last: clamp(end, first, total - 1) };
}

/** 讓第 index 列置中的 scrollTop（未夾到可捲範圍，瀏覽器會自己夾）。 */
export function scrollTopFor(index: number, viewportHeight: number, headerHeight: number, rowHeight: number): number {
    return Math.max(0, index * rowHeight - (viewportHeight - headerHeight - rowHeight) / 2);
}

/** 畫面加緩衝，總數不超過 LIVE_STRIKE_CAP；超過時以畫面中心為準。 */
export function liveRangeFor(visible: StrikeRange, total: number): StrikeRange {
    if (total <= 0) return { first: 0, last: -1 };
    const first = Math.max(0, visible.first - LIVE_BUFFER);
    const last = Math.min(total - 1, visible.last + LIVE_BUFFER);
    if (last - first + 1 <= LIVE_STRIKE_CAP) return { first, last };
    const mid = Math.floor((visible.first + visible.last) / 2);
    const start = clamp(mid - Math.floor(LIVE_STRIKE_CAP / 2), 0, total - LIVE_STRIKE_CAP);
    return { first: start, last: start + LIVE_STRIKE_CAP - 1 };
}

/**
 * 換窗的遲滯：畫面還在目前的窗內就不動，回傳同一個物件。
 * 面板高到看得到的列超過上限時，窗永遠蓋不滿畫面，此時位移小於緩衝也不換。
 */
export function nextLiveRange(current: StrikeRange, visible: StrikeRange, total: number): StrikeRange {
    const want = liveRangeFor(visible, total);
    const overflow = visible.last - visible.first + 1 >= LIVE_STRIKE_CAP;
    const stay = overflow
        ? current.last - current.first + 1 >= LIVE_STRIKE_CAP && Math.abs(want.first - current.first) < LIVE_BUFFER
        : current.first <= visible.first && current.last >= visible.last;
    if (stay) return current;
    return want.first === current.first && want.last === current.last ? current : want;
}

export const inRange = (range: StrikeRange, index: number) => index >= range.first && index <= range.last;

/** 全部履約價的基準快照：依單次上限分批，一批失敗整次失敗，由呼叫端保留舊值。 */
export async function fetchChainSnapshots(contracts: ContractBase[]): Promise<Snapshot[]> {
    const rows: Snapshot[] = [];
    for (let i = 0; i < contracts.length; i += SNAPSHOT_BATCH) {
        rows.push(...(await fetchSnapshots(contracts.slice(i, i + SNAPSHOT_BATCH))));
    }
    return rows;
}
