// src/components/ohlc-legend.tsx — K 棒讀值列（開高低收，issue #240）
//
// 圖表左上角一列，TradingView 式：游標所在 K 棒的開高低收、漲跌（幅）、
// 量；游標離開讀最新一根。自己訂閱 OhlcStore — 讀值變動不必重繪整張
// 圖表元件。整列 pointer-events: none，不擋畫圖工具、點價與拖曳。

import { useSyncExternalStore } from 'react';
import { ohlcLayout, ohlcReadout, type OhlcStore } from '../lib/ohlc-legend';
import { useTickBandsVersion } from '../lib/tick-bands';
import type { Candle } from '../lib/types/market';
import * as styles from './candle-chart.css';

// 讀值列右側讓開價格軸的寬度（px）
const OHLC_PRICE_AXIS_GUTTER = 80;

export function OhlcLegend({
    store,
    getBars,
    decimalsFor,
    width,
    colors,
}: {
    store: OhlcStore;
    getBars: () => readonly Candle[];
    decimalsFor: (price: number) => number;
    /** 圖表寬度 px（決定完整／省略量與漲跌幅／只留高低收） */
    width: number;
    colors: { up: string; down: string };
}) {
    const snap = useSyncExternalStore(store.subscribe, store.snapshot);
    // 期權級距表非同步到貨後重算小數位（不必等下一筆 tick 或游標移動）
    useTickBandsVersion();
    const r = ohlcReadout(getBars(), snap.hoverTime, decimalsFor);
    if (!r) return null;
    const layout = ohlcLayout(width);
    const dirColor = (d: 1 | -1 | 0) =>
        d > 0 ? colors.up : d < 0 ? colors.down : undefined;
    const valueColor = dirColor(r.barDir);
    const item = (key: 'open' | 'high' | 'low' | 'close', label: string) => (
        <span key={key} data-ohlc={key} className={styles.ohlcItem}>
            <span className={styles.ohlcLabel}>{label}</span>
            <span data-ohlc-value style={{ color: valueColor }}>{r[key]}</span>
        </span>
    );
    return (
        <div
            data-ohlc='row'
            data-hovering={r.hovering}
            className={styles.ohlcRow}
            style={width > OHLC_PRICE_AXIS_GUTTER ? { maxWidth: width - OHLC_PRICE_AXIS_GUTTER } : undefined}
        >
            {layout.open && item('open', '開')}
            {item('high', '高')}
            {item('low', '低')}
            {item('close', '收')}
            {layout.change && r.change !== null && (
                <span
                    data-ohlc='change'
                    className={styles.ohlcItem}
                    style={{ color: dirColor(r.changeDir) }}
                >
                    {layout.pct && r.changePct !== null
                        ? `${r.change} (${r.changePct})`
                        : r.change}
                </span>
            )}
            {layout.volume && (
                <span data-ohlc='volume' className={styles.ohlcItem}>
                    <span className={styles.ohlcLabel}>量</span>
                    <span>{r.volume}</span>
                </span>
            )}
        </div>
    );
}
