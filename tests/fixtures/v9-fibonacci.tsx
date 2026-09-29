// No API/bootstrap/broker imports. The exact production control and primitive.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createChart, CandlestickSeries, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { ResearchFibonacci } from '../../src/components/research-fibonacci';
import { darkTwClass } from '../../src/theme.css';
const bars = Array.from({ length: 100 }, (_, i) => {
    const close = 100 + (i < 60 ? i : 120 - i) * .5;
    return { time: Date.UTC(2026, 8, 24, 9, i + 1) / 1000, open: close - .5, close, high: close + 1, low: close - 1, volume: 20 };
});
document.body.className = darkTwClass;
document.body.style.cssText = 'margin:0;background:#101820;color:#dce5ee;font:14px system-ui';
function Fixture() {
    const host = useRef<HTMLDivElement>(null), capture = useRef(false);
    const [apis, setApis] = useState<{ chart: IChartApi; series: ISeriesApi<'Candlestick'> } | null>(null);
    useEffect(() => {
        const chart = createChart(host.current!, { autoSize: true,
            layout: { background: { type: ColorType.Solid, color: '#101820' }, textColor: '#bdc8d6' },
            grid: { vertLines: { color: '#21313e' }, horzLines: { color: '#21313e' } },
            timeScale: { timeVisible: true, rightOffset: 12 }, rightPriceScale: { minimumWidth: 135 } });
        const series = chart.addSeries(CandlestickSeries, { upColor: '#fb7185', downColor: '#4ade80', borderVisible: false });
        series.setData(bars.map(b => ({ ...b, time: b.time as UTCTimestamp })));
        setApis({ chart, series });
        const resize = new ResizeObserver(() => chart.timeScale().fitContent()); resize.observe(host.current!);
        chart.timeScale().fitContent();
        return () => { resize.disconnect(); chart.remove(); };
    }, []);
    return <main style={{ padding: 12 }}><h2>V9 手動斐波那契 · 離線測試</h2>
        <p>合成資料／不連券商／不下單。按手動畫線，先點左方低點，再點較右方高點。</p>
        <ResearchFibonacci storageKey="v9-fib-fixture-only" chart={apis?.chart ?? null} series={apis?.series ?? null} bars={bars} capture={capture} />
        <div ref={host} style={{ height: 480 }} />
    </main>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
