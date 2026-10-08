// src/lib/ohlc-legend.ts — K 棒讀值（開高低收，issue #240）
//
// 圖表左上角一列：游標所在那根 K 棒的開高低收、與前一根收盤比的漲跌與
// 漲跌幅、量；游標離開（或不在任何 K 棒上）時讀最新一根。純函式＋一個
// 極小的 store：游標移動與 tick 只重繪讀值列，不重繪整張圖表元件。

import type { Candle } from './types/market';

export interface OhlcReadout {
    time: number;
    /** true = 游標停在這根；false = 顯示的是最新一根 */
    hovering: boolean;
    open: string;
    high: string;
    low: string;
    close: string;
    /** 這根 K 棒本身漲跌（收 vs 開）— 開高低收用 K 棒顏色 */
    barDir: 1 | -1 | 0;
    /** 與前一根收盤比；第一根沒有前一根 → null */
    change: string | null;
    changePct: string | null;
    changeDir: 1 | -1 | 0;
    volume: string;
}

/** 依 K 棒時間二分搜尋；找不到回 -1（bars 依時間遞增） */
export function findBarIndex(bars: readonly Candle[], time: number): number {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = bars[mid]!.time;
        if (t === time) return mid;
        if (t < time) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

const fmtNum = (v: number, decimals: number) =>
    v.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });

const sign = (v: number): 1 | -1 | 0 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * @param hoverTime 游標所在 K 棒時間；null = 游標不在圖上
 * @param decimalsFor 依價位回傳跳動價位的小數位（以該根最低價判斷 —
 *   跨級距的 K 棒取較細的那一檔，四個價小數位一致）
 */
export function ohlcReadout(
    bars: readonly Candle[],
    hoverTime: number | null,
    decimalsFor: (price: number) => number,
): OhlcReadout | null {
    if (bars.length === 0) return null;
    const hit = hoverTime === null ? -1 : findBarIndex(bars, hoverTime);
    const i = hit >= 0 ? hit : bars.length - 1;
    const b = bars[i]!;
    const prev = i > 0 ? bars[i - 1] : undefined;
    const d = Math.max(0, Math.min(8, decimalsFor(b.low)));
    let change: string | null = null;
    let changePct: string | null = null;
    let changeDir: 1 | -1 | 0 = 0;
    if (prev && Number.isFinite(prev.close)) {
        // 前一根可能在較細的級距（49.95 → 50.0）— 漲跌取兩者較多的小數位；
        // 先依小數位捨入再判斷方向，避免浮點誤差（1.4 - 1.3）
        const cd = Math.max(d, Math.max(0, Math.min(8, decimalsFor(prev.close))));
        const diff = Number((b.close - prev.close).toFixed(cd)) || 0;
        changeDir = sign(diff);
        change = `${changeDir > 0 ? '+' : ''}${fmtNum(diff, cd)}`;
        if (prev.close !== 0) {
            // 符號跟漲跌走：+1 點但幅度不到 0.005% 時顯示 +0.00%，不會變成無號
            const pct = Math.abs((diff / prev.close) * 100).toFixed(2);
            changePct = `${changeDir > 0 ? '+' : changeDir < 0 ? '-' : ''}${pct}%`;
        }
    }
    return {
        time: b.time,
        hovering: hit >= 0,
        open: fmtNum(b.open, d),
        high: fmtNum(b.high, d),
        low: fmtNum(b.low, d),
        close: fmtNum(b.close, d),
        barDir: sign(Number((b.close - b.open).toFixed(d))),
        change,
        changePct,
        changeDir,
        volume: Math.round(b.volume).toLocaleString('en-US'),
    };
}

export interface OhlcLayout {
    open: boolean;
    change: boolean;
    pct: boolean;
    volume: boolean;
}

// 依圖表寬度縮短：寬面板完整一列；中等寬度省略量與漲跌幅；很窄只留
// 高低收（客戶要的三個值）— 讀值列不換成好幾行去擋 K 棒
export const OHLC_FULL_MIN_WIDTH = 560;
export const OHLC_COMPACT_MIN_WIDTH = 400;

export function ohlcLayout(width: number): OhlcLayout {
    if (!(width > 0) || width >= OHLC_FULL_MIN_WIDTH) {
        return { open: true, change: true, pct: true, volume: true };
    }
    if (width >= OHLC_COMPACT_MIN_WIDTH) {
        return { open: true, change: true, pct: false, volume: false };
    }
    return { open: false, change: false, pct: false, volume: false };
}

export interface OhlcSnapshot {
    hoverTime: number | null;
    version: number;
}

export interface OhlcStore {
    subscribe(listener: () => void): () => void;
    snapshot(): OhlcSnapshot;
    /** 游標移到某根（K 棒時間）或離開（null） */
    hover(time: number | null): void;
    /** K 棒資料變了（tick／換商品／載入歷史）— 讀值重算 */
    bump(): void;
}

export function createOhlcStore(): OhlcStore {
    let snap: OhlcSnapshot = { hoverTime: null, version: 0 };
    const listeners = new Set<() => void>();
    const emit = () => listeners.forEach((l) => l());
    return {
        subscribe(l) {
            listeners.add(l);
            return () => {
                listeners.delete(l);
            };
        },
        snapshot: () => snap,
        hover(time) {
            if (snap.hoverTime === time) return;
            snap = { ...snap, hoverTime: time };
            emit();
        },
        bump() {
            snap = { ...snap, version: snap.version + 1 };
            emit();
        },
    };
}
