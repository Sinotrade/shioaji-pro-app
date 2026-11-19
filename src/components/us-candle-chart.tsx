// src/components/us-candle-chart.tsx — 美股 K 線（SDK 1.8.0b1 美股 1 分 K 歷史＋即時逐筆）
//
// 只看盤：沒有圖上下單、畫圖、指標（美股下單走下單／閃電面板）。時間軸是紐約
// 牆鐘（與台股 K 線的台北牆鐘同一套編碼），只有一般盤；5／15／60 分與日 K
// 由 1 分 K 聚合（與台股相同）。即時逐筆只併入一般盤的成交。
// SDK 沒有美股歷史（舊版）時只畫開啟後收到的一般盤逐筆。

import {
    CandlestickSeries,
    ColorType,
    createChart,
    HistogramSeries,
    type IChartApi,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { contractLinkKey } from '../lib/contract-key';
import { getChartColors, themeKey as themeKeyOf, useThemeSettings, type ChartColors } from '../lib/theme-store';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { fetchUsKbars, isUsHistoryUnavailable, mergeUsTickIntoBars } from '../lib/us/us-history';
import { getUsTickMeta } from '../lib/us/us-quotes';
import { aggregate, dateStrOffset, wallClockToUtc } from '../lib/utils/kbars';
import { DEFAULT_CHART_INTERVAL, isChartInterval, type ChartInterval } from '../lib/workspace';
import { AsyncStatus } from './async-status';
import * as styles from './candle-chart.css';

const US_TIMEFRAMES: readonly { label: ChartInterval; minutes: number; days: number }[] = [
    { label: '1m', minutes: 1, days: 4 },
    { label: '5m', minutes: 5, days: 10 },
    { label: '15m', minutes: 15, days: 20 },
    { label: '60m', minutes: 60, days: 60 },
    // 美股 kbars 一次最多 30 天：日 K 由 1 分 K 聚合，抓 4 段約半年
    { label: '1D', minutes: 1440, days: 119 },
];

function tfOf(interval: unknown) {
    const label = isChartInterval(interval) ? interval : DEFAULT_CHART_INTERVAL;
    return US_TIMEFRAMES.find(t => t.label === label) ?? US_TIMEFRAMES[1]!;
}

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'unavailable';

function toSeries(bars: Candle[], c: ChartColors) {
    return {
        candles: bars.map(b => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })),
        volume: bars.map(b => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? c.upVol : c.downVol })),
    };
}

export function UsCandleChart({ contract, interval, onIntervalChange }: {
    contract: ContractInfo;
    interval?: ChartInterval;
    onIntervalChange?: (interval: ChartInterval) => void;
}) {
    const key = contractLinkKey(contract);
    const quote = useQuote(key);
    const [localInterval, setLocalInterval] = useState<ChartInterval | undefined>(interval);
    useEffect(() => setLocalInterval(interval), [interval]);
    const tf = tfOf(localInterval);
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = themeKeyOf(themeSettings);
    const colorsRef = useRef(colors);
    colorsRef.current = colors;

    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const barsRef = useRef<Candle[]>([]);
    /** 目前圖上那組（商品|週期）的歷史已就位，逐筆才可更新 */
    const loadedKeyRef = useRef('');
    const [state, setState] = useState<LoadState>('loading');
    const [retry, setRetry] = useState(0);

    // chart lifecycle
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = colorsRef.current;
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                attributionLogo: false,
            },
            grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
            crosshair: {
                vertLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
                horzLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false },
            autoSize: true,
        });
        candleRef.current = chart.addSeries(CandlestickSeries, {
            upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down,
        });
        volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        chartRef.current = chart;
        return () => {
            chart.remove();
            chartRef.current = null;
            candleRef.current = null;
            volRef.current = null;
        };
    }, []);

    // 主題變更
    useEffect(() => {
        const c = colors;
        chartRef.current?.applyOptions({
            layout: { textColor: c.text },
            grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
            rightPriceScale: { borderColor: c.border },
            timeScale: { borderColor: c.border },
        });
        candleRef.current?.applyOptions({
            upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down,
        });
        const { volume } = toSeries(barsRef.current, c);
        volRef.current?.setData(volume);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    // 歷史載入（換商品／週期／重試）
    useEffect(() => {
        let cancelled = false;
        const loadKey = `${key}|${tf.minutes}`;
        loadedKeyRef.current = '';
        barsRef.current = [];
        candleRef.current?.setData([]);
        volRef.current?.setData([]);
        setState('loading');
        const apply = (bars: Candle[]) => {
            barsRef.current = bars;
            const { candles, volume } = toSeries(bars, colorsRef.current);
            candleRef.current?.setData(candles);
            volRef.current?.setData(volume);
            loadedKeyRef.current = loadKey;
            chartRef.current?.timeScale().scrollToRealTime();
            candleRef.current?.priceScale().applyOptions({ autoScale: true });
        };
        fetchUsKbars(contract, dateStrOffset(tf.days), dateStrOffset(0), { timeoutMs: 30_000 })
            .then((raw) => {
                if (cancelled) return;
                const bars = aggregate(raw, tf.minutes);
                apply(bars);
                setState(bars.length ? 'ready' : 'empty');
            })
            .catch((e) => {
                if (cancelled) return;
                // 舊 SDK：只畫即時一般盤逐筆；其他錯誤可重試
                apply([]);
                setState(isUsHistoryUnavailable(e) ? 'unavailable' : 'error');
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, contract.exchange, tf.minutes, tf.days, retry]);

    // 即時逐筆 → 最後一根（只收一般盤）
    const tick = quote?.tick;
    useEffect(() => {
        if (!tick || tick.code !== key) return;
        if (loadedKeyRef.current !== `${key}|${tf.minutes}`) return;
        const session = getUsTickMeta(key)?.session;
        if (session && session !== 'Regular') return;
        const price = Number(tick.close);
        if (!tick.date || !tick.time) return;
        const wall = wallClockToUtc(`${tick.date}T${tick.time}`);
        const bar = mergeUsTickIntoBars(barsRef.current, wall, price, Number(tick.volume) || 0, tf.minutes);
        if (!bar) return;
        try {
            candleRef.current?.update({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
            volRef.current?.update({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? colorsRef.current.upVol : colorsRef.current.downVol });
        } catch {
            // 圖表拒收（時間比尾端舊）— 忽略這筆
        }
        if (state !== 'ready' && barsRef.current.length > 0 && state !== 'loading') setState('ready');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    const pick = (label: ChartInterval) => {
        setLocalInterval(label);
        onIntervalChange?.(label);
    };

    const overlay = state === 'loading' ? <AsyncStatus phase='loading' text='載入美股 K 線…' />
        : state === 'error' ? <AsyncStatus phase='error' text='美股 K 線無法取得' action={<button type='button' onClick={() => setRetry(n => n + 1)}>重試</button>} />
        : state === 'unavailable' ? <AsyncStatus phase='empty' text='這個 SDK 版本沒有美股歷史 K 線，只畫開啟後的一般盤成交' />
        : state === 'empty' ? <AsyncStatus phase='empty' text='沒有美股 K 線（美股歷史行情只有正式環境）' />
        : null;

    return (
        <div className={styles.wrap} data-testid='us-candle-chart'>
            <div className={styles.toolbar}>
                {US_TIMEFRAMES.map(t => (
                    <button key={t.label} type='button' className={styles.tfBtn[t.label === tf.label ? 'active' : 'normal']} onClick={() => pick(t.label)}>
                        {t.label}
                    </button>
                ))}
                <span className={styles.tfBtn.normal} style={{ cursor: 'default' }} title='美股只有一般盤 09:30–16:00（美東時間）'>美東・一般盤</span>
            </div>
            <div className={styles.chartRow}>
                <div ref={hostRef} className={styles.chartHost}>
                    {overlay && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: state === 'error' ? 'auto' : 'none', zIndex: 2 }}>
                            {overlay}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
