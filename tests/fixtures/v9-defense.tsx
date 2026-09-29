// Offline visual test only: no API, brokerage, bootstrap, or persistence.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType, LineType, type UTCTimestamp } from 'lightweight-charts';
import { ema, v9AtrDefense } from '../../src/lib/indicators';
import { DEF_BY_TYPE } from '../../src/lib/indicator-defs';
import { defenseEvents, defenseSegments, researchOpening, RESEARCH_COLORS } from '../../src/lib/research-visuals';
import { ResearchTransitionPrimitive } from '../../src/lib/research-transition-primitive';
import type { Candle } from '../../src/lib/types/market';

const start = Date.UTC(2026, 8, 24, 15) / 1000;
const bars: Candle[] = Array.from({ length: 780 }, (_, i) => {
    const center = 46800 + (i < 210 ? i * .85 : i < 390 ? 178 - (i - 210) * 2 : i < 650 ? -182 + (i - 390) * 1.8 : 286 - (i - 650) * 1.1);
    const close = center + Math.sin(i / 9) * 8;
    return { time: start + (i + 1) * 60, open: close - Math.cos(i / 7) * 4, high: close + 8, low: close - 8, close, volume: 10 + i % 23 };
});
const rails = v9AtrDefense(bars, 14, 2, 'FUT', 1);
const events = defenseEvents(bars, rails, 'FUT', 1);
const opening = researchOpening(bars, 'FUT')!;
document.body.style.cssText = 'margin:0;background:#0e1116;color:#dce5ee;font:14px system-ui';
function Fixture() {
    const host = useRef<HTMLDivElement>(null);
    const [narrow, setNarrow] = useState(false);
    const [open, setOpen] = useState(true);
    const [flips, setFlips] = useState(true);
    useEffect(() => {
        const chart = createChart(host.current!, { autoSize: true,
            layout: { background: { type: ColorType.Solid, color: '#101820' }, textColor: '#9bacbd' },
            grid: { vertLines: { color: '#1b2935' }, horzLines: { color: '#1b2935' } },
            timeScale: { timeVisible: true, rightOffset: 8 },
        });
        const candles = chart.addSeries(CandlestickSeries, { upColor: '#fb7185', downColor: '#4ade80',
            wickUpColor: '#fb7185', wickDownColor: '#4ade80', borderVisible: false, priceLineVisible: false });
        candles.setData(bars.map(b => ({ ...b, time: b.time as UTCTimestamp })));
        chart.priceScale('right').applyOptions({ scaleMargins: { top: .14, bottom: .24 } });
        const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: .85, bottom: 0 } });
        vol.setData(bars.map(b => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? '#723942' : '#225b44' })));
        for (const [period, color] of [[3, '#ff4d6d'], [8, '#f6c94c']] as const) {
            const s = chart.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
            s.setData(ema(bars, period).map(p => ({ ...p, time: p.time as UTCTimestamp })));
        }
        for (const [points, color] of [[rails.up, RESEARCH_COLORS.long], [rails.down, RESEARCH_COLORS.short]] as const) {
            for (const segment of defenseSegments(points)) {
                const line = chart.addSeries(LineSeries, { color, lineWidth: 3, lineType: LineType.WithSteps,
                    priceLineVisible: false, lastValueVisible: false });
                line.setData(segment.map(p => ({ time: p.time as UTCTimestamp, value: p.value! })));
            }
        }
        const verticals = flips ? events.filter(e => e.kind !== 'invalidated').map(e => ({ time: e.time, color: e.color, text: e.text })) : [];
        if (open) {
            const line = chart.addSeries(LineSeries, { color: RESEARCH_COLORS.open, lineStyle: 2, lineWidth: 2,
                title: '夜盤開盤', priceLineVisible: false });
            line.setData(bars.map(b => ({ time: b.time as UTCTimestamp, value: opening.price })));
        }
        candles.attachPrimitive(new ResearchTransitionPrimitive([
            ...(open ? [{ time: bars[0]!.time, color: RESEARCH_COLORS.open, text: '夜盤開盤', dashed: true }] : []), ...verticals,
        ].sort((a, b) => a.time - b.time)));
        const def = DEF_BY_TYPE.get('v8trend')!;
        const values = def.compute(bars, {}).line!;
        const score = chart.addSeries(LineSeries, { lineWidth: 2, lastValueVisible: false, priceLineVisible: false,
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, 1);
        score.setData(values.map(p => ({ ...p, time: p.time as UTCTimestamp })));
        score.createPriceLine({ price: 55, color: RESEARCH_COLORS.long, lineStyle: 2, title: '多55' });
        score.createPriceLine({ price: 45, color: RESEARCH_COLORS.short, lineStyle: 2, title: '空45' });
        chart.panes()[0]!.setStretchFactor(5); chart.panes()[1]!.setStretchFactor(1);
        chart.timeScale().fitContent();
        const resize = new ResizeObserver(() => chart.timeScale().fitContent());
        resize.observe(host.current!);
        return () => { resize.disconnect(); chart.remove(); };
    }, [open, flips]);
    return <main style={{ maxWidth: narrow ? 740 : 1600, margin: 'auto', padding: 12 }}>
        <h2>V9 多空變色・開盤線・ATR 防守</h2>
        <p>離線合成資料｜非真實行情、非成交紀錄｜不連券商、不下單</p>
        <button onClick={() => setNarrow(!narrow)}>{narrow ? '桌面寬度' : '平板寬度'}</button>{' '}
        <button aria-pressed={open} onClick={() => setOpen(!open)}>開盤線：{open ? '顯示' : '隱藏'}</button>{' '}
        <button aria-pressed={flips} onClick={() => setFlips(!flips)}>多空變換線：{flips ? '顯示' : '隱藏'}</button>
        <p style={{ color: RESEARCH_COLORS.open }}>夜盤開盤 {opening.price.toLocaleString('zh-TW')}｜09/24 15:00，跨午夜不重設</p>
        <p><span style={{ color: RESEARCH_COLORS.long }}>多方：紅色、ATR 在價下</span>　
            <span style={{ color: RESEARCH_COLORS.short }}>空方：綠色、ATR 在價上</span>　
            <span style={{ color: RESEARCH_COLORS.neutral }}>中性：黃色</span></p>
        <div ref={host} style={{ height: 610 }} />
        <p>V8 多空線：≥55 紅／≤45 綠／中間黃。防守失效後留白，重新確認才續畫。</p>
    </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
