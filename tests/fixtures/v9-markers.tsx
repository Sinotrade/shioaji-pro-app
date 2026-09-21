// Development-only visual fixture. No bootstrap, SSE, Shioaji or HTTP API imports.
// The production build's entrypoints exclude this page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CandlestickSeries, HistogramSeries, ColorType, createChart, createSeriesMarkers,
    type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { ResearchMarkerControls } from '../../src/components/research-marker-controls';
import { DEFAULT_MARKER_OPTIONS, EMPTY_FLOW, V9FlowTracker, v9KbarMarkers, selectResearchMarkers,
    researchMarkerGap, mergeResearchMarkerLabels } from '../../src/lib/utils/v9-chart-markers';
import { darkTwClass } from '../../src/theme.css';
import type { Candle } from '../../src/lib/types/market';
document.body.className = darkTwClass;
document.body.style.cssText = 'margin:0;background:#0e1116;color:#dde3ee;font:14px system-ui';
const start = Date.UTC(2026, 8, 18, 9) / 1000;
const bars: Candle[] = Array.from({ length: 270 }, (_, i) => {
    const center = 100 + i * 0.008 + Math.sin(i / 12) * 1.4;
    const attack = i % 19 === 0;
    return { time: start + (i + 1) * 60, open: center - .10, high: center + .25, low: center - .25,
        close: attack ? center + .22 : center + .04, volume: attack ? 650 : i % 7 === 0 ? 40 : 100 + i % 17 * 4 };
});
const tracker = new V9FlowTracker();
for (let i = 0; i < 20; i++) tracker.push({ time: start + i, volume: 1, tickType: 0 });
for (const [i, tickType] of [[25, 1], [60, 2], [110, 1], [150, 2], [200, 1], [250, 2]]) {
    for (let n = 0; n < 120; n++) tracker.push({ time: start + i! * 60 + n / 200, volume: 1, tickType: 0 });
    tracker.push({ time: start + i! * 60 + 1, volume: 40, tickType: tickType! });
}
const recorded = tracker.snapshot(1);
function Fixture() {
    const host = useRef<HTMLDivElement>(null);
    const priceMarkers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const volumeMarkers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const [options, setOptions] = useState(DEFAULT_MARKER_OPTIONS);
    const [tablet, setTablet] = useState(false);
    const [hasTicks, setHasTicks] = useState(true);
    const [gap, setGap] = useState(5);
    const flow = hasTicks ? recorded : EMPTY_FLOW;
    const markers = useMemo(() => selectResearchMarkers([...v9KbarMarkers(bars), ...flow.markers],
        bars.map(bar => bar.time), options, gap), [options, flow, gap]);
    useEffect(() => {
        const chart = createChart(host.current!, { autoSize: true,
            layout: { background: { type: ColorType.Solid, color: '#0b1018' }, textColor: '#a3afc2' },
            grid: { vertLines: { color: '#1a2533' }, horzLines: { color: '#1a2533' } },
            timeScale: { timeVisible: true },
        });
        const candles = chart.addSeries(CandlestickSeries, { upColor: '#f23645', downColor: '#16b389',
            wickUpColor: '#f23645', wickDownColor: '#16b389', borderVisible: false });
        const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
        chart.priceScale('right').applyOptions({ scaleMargins: { top: .12, bottom: .3 } });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: .83, bottom: 0 } });
        candles.setData(bars.map(bar => ({ ...bar, time: bar.time as UTCTimestamp })));
        volume.setData(bars.map(bar => ({ time: bar.time as UTCTimestamp, value: bar.volume,
            color: bar.close >= bar.open ? '#773443' : '#145544' })));
        priceMarkers.current = createSeriesMarkers(candles, [], { autoScale: false, zOrder: 'top' });
        volumeMarkers.current = createSeriesMarkers(volume, [], { autoScale: false, zOrder: 'top' });
        const updateGap = () => {
            const range = chart.timeScale().getVisibleLogicalRange();
            if (range) setGap(researchMarkerGap(range.to - range.from, chart.timeScale().width()));
        };
        chart.timeScale().subscribeVisibleLogicalRangeChange(updateGap);
        const resize = new ResizeObserver(() => { chart.timeScale().fitContent(); updateGap(); });
        resize.observe(host.current!);
        chart.timeScale().fitContent();
        return () => { resize.disconnect(); priceMarkers.current?.detach(); volumeMarkers.current?.detach(); chart.remove(); };
    }, []);
    useEffect(() => {
        priceMarkers.current?.setMarkers(mergeResearchMarkerLabels(markers.filter(marker => marker.group !== 'volume'))
            .map(marker => ({ ...marker, time: marker.time as UTCTimestamp, size: 1 })));
        volumeMarkers.current?.setMarkers(markers.filter(marker => marker.group === 'volume')
            .map(marker => ({ ...marker, time: marker.time as UTCTimestamp, position: 'aboveBar' as const, size: .8 })));
    }, [markers]);
    return <main style={{ padding: 16, maxWidth: tablet ? 650 : 1280, margin: 'auto' }}>
        <h2>V9 研究標記 · 離線驗證</h2>
        <p style={{ color: '#e0a43c' }}>測試資料／非市場行情。本頁不連券商、不查歷史、不下單。</p>
        <p><button onClick={() => setTablet(!tablet)}>{tablet ? '桌面寬度' : '平板窄面板'}</button>{' '}
            <button onClick={() => setHasTicks(!hasTicks)}>{hasTicks ? '測試無 Tick 狀態' : '顯示測試 Tick'}</button></p>
        <div style={{ border: '1px solid #253243', borderRadius: 8, overflow: 'hidden' }}>
            <ResearchMarkerControls options={options} onChange={setOptions} flow={flow} markers={markers} barCount={bars.length} />
            <div ref={host} style={{ height: 580 }} />
        </div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
