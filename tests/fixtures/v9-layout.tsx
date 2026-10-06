// Offline visual acceptance: production controls, CSS and pane sizing; no broker hooks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { ResearchMarkerControls } from '../../src/components/research-marker-controls';
import { ResearchFibonacci } from '../../src/components/research-fibonacci';
import { ResearchIndustryWatchlistView } from '../../src/components/research-industry-watchlist';
import { researchSessionVwap, projectResearchVwap } from '../../src/lib/research-vwap';
import { researchSetups } from '../../src/lib/research-setups';
import { aggregate } from '../../src/lib/utils/kbars';
import { DEFAULT_MARKER_OPTIONS, EMPTY_FLOW } from '../../src/lib/utils/v9-chart-markers';
import { DEF_BY_TYPE } from '../../src/lib/indicator-defs';
import { applyResearchPaneLayout } from '../../src/lib/research-chart-layout';
import { ema } from '../../src/lib/indicators';
import type { ResearchDataStatus } from '../../src/lib/research-decision';
import type { V9Resonance } from '../../src/lib/utils/research-chart';
import type { Candle } from '../../src/lib/types/market';
import * as quoteCss from '../../src/components/quote-board.css';
import * as chartCss from '../../src/components/candle-chart.css';
import { darkTwClass } from '../../src/theme.css';
const bars = Array.from({ length: 840 }, (_, i) => {
    const close = 48120 - i * .48 + Math.sin(i / 12) * 28;
    return { time: Date.UTC(2026, 8, 24, 15, i + 1) / 1000, open: close + Math.sin(i * 2) * 8,
        high: close + 13, low: close - 12, close, volume: 20 + i % 31 };
});
const assignments = ['v9macd', 'v9kdj', 'v8trend'].map((type, i) => ({ type, paneIndex: i + 1 }));
const scenarios = ['分歧', '同向偏多', '資料過期', '載入中', '休市'] as const;
type Scenario = typeof scenarios[number];
document.body.className = darkTwClass;
document.body.style.cssText = 'margin:0;background:#0b1018;color:#dde5ef;font:13px system-ui';
function Fixture() {
    const host = useRef<HTMLDivElement>(null), capture = useRef(false);
    const [width, setWidth] = useState(1440), [quoteDetails, setQuoteDetails] = useState(false);
    const [options, setOptions] = useState(DEFAULT_MARKER_OPTIONS);
    const [scenario, setScenario] = useState<Scenario>('分歧');
    const [timeframe, setTimeframe] = useState(5);
    const [selectedCode, setSelectedCode] = useState<string>();
    const chartBars = useMemo(() => aggregate(bars, timeframe, 'FUT'), [timeframe]);
    const vwapEvaluation = useMemo(() => researchSessionVwap(bars, 'FUT', bars.at(-1)!.time), []);
    const setupEvaluation = useMemo(() => researchSetups(bars, 'FUT', bars.at(-1)!.time), []);
    const updateChart = useRef<((next: Candle[]) => void) | null>(null);
    const dataStatus: ResearchDataStatus = scenario === '資料過期'
        ? { state: 'stale', reason: '離線示例：已收 K 棒落後 6 分鐘' }
        : scenario === '載入中' ? { state: 'loading', reason: '離線示例：切換商品，等待新 K 棒' }
          : scenario === '休市' ? { state: 'closed', reason: '離線示例：夜盤正常收盤' }
            : { state: 'fresh', reason: '離線合成示例：假設本商品資料新鮮，不是即時行情' };
    const resonance: V9Resonance = {
        summary: scenario === '同向偏多' ? '四週期同多' : '多1／空2／中0／資料不足1',
        asOf: bars.at(-1)!.time,
        frames: scenario === '同向偏多' ? [
            { minutes: 1, label: '1分', side: 'long', score: 67, bars: 360, requiredBars: 117 },
            { minutes: 5, label: '5分', side: 'long', score: 65, bars: 200, requiredBars: 117 },
            { minutes: 60, label: '60分', side: 'long', score: 62, bars: 120, requiredBars: 117 },
            { minutes: 1440, label: '日K', side: 'long', score: 61, bars: 120, requiredBars: 117 },
        ] : [
            { minutes: 1, label: '1分', side: 'long', score: 67, bars: 360, requiredBars: 117 },
            { minutes: 5, label: '5分', side: 'short', score: 29, bars: 200, requiredBars: 117 },
            { minutes: 60, label: '60分', side: 'short', score: 38, bars: 120, requiredBars: 117 },
            { minutes: 1440, label: '日K', side: 'insufficient', bars: 9, requiredBars: 117 },
        ],
    };
    const [apis, setApis] = useState<{ chart: IChartApi; series: ISeriesApi<'Candlestick'> } | null>(null);
    useEffect(() => {
        const chart = createChart(host.current!, { autoSize: true,
            layout: { background: { type: ColorType.Solid, color: '#131b24' }, textColor: '#9faec0', fontSize: 11, attributionLogo: false },
            grid: { vertLines: { color: '#21303c' }, horzLines: { color: '#21303c' } },
            rightPriceScale: { minimumWidth: 86 }, timeScale: { timeVisible: true, rightOffset: 5 } });
        const series = chart.addSeries(CandlestickSeries, { upColor: '#fb7185', downColor: '#2ecc8a', wickUpColor: '#fb7185', wickDownColor: '#2ecc8a', borderVisible: false });
        const updaters: Array<(next: Candle[]) => void> = [next => series.setData(next.map(b => ({ ...b, time: b.time as UTCTimestamp })))];
        series.priceScale().applyOptions({ scaleMargins: { top: .1, bottom: .2 } });
        const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceLineVisible: false, lastValueVisible: false });
        volume.priceScale().applyOptions({ scaleMargins: { top: .86, bottom: 0 } });
        updaters.push(next => volume.setData(next.map(b => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? '#753e50' : '#205a47' }))));
        for (const [period, color] of [[3, '#fb7185'], [8, '#facc15']] as const) {
            const line = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: `EMA${period}` });
            updaters.push(next => line.setData(ema(next, period).map(p => ({ ...p, time: p.time as UTCTimestamp }))));
        }
        const vwap = chart.addSeries(LineSeries, { color: '#cbd5e1', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: '1分基準VWAP' });
        updaters.push(next => vwap.setData(projectResearchVwap(vwapEvaluation.points, next, 'FUT').map(p => ({ ...p, time: p.time as UTCTimestamp }))));
        for (const { type, paneIndex } of assignments) {
            const def = DEF_BY_TYPE.get(type)!;
            for (const item of def.outputs) {
                const s = item.kind === 'histogram'
                    ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
                    : chart.addSeries(LineSeries, { color: item.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, paneIndex);
                updaters.push(next => {
                    const out = def.compute(next, Object.fromEntries(def.params.map(p => [p.key, p.def])));
                    s.setData(out[item.key]!.map(p => ({ ...p, time: p.time as UTCTimestamp,
                        ...(item.kind === 'histogram' && p.value !== undefined ? { color: p.value >= 0 ? '#b85567' : '#21865e' } : {}) })));
                });
            }
        }
        const labelFrame = requestAnimationFrame(() => {
            for (const { type, paneIndex } of assignments) {
                const paneElement = chart.panes()[paneIndex]?.getHTMLElement();
                if (paneElement) {
                    const label = document.createElement('span');
                    label.textContent = type === 'v9macd' ? 'MACD (45,117,17)' : type === 'v9kdj' ? 'KDJ (45,9,9)' : 'V8 多空線';
                    label.style.cssText = 'position:absolute;top:4px;left:8px;z-index:3;font:11px system-ui;color:#b6c5d6;pointer-events:none;background:#131b24bb';
                    paneElement.style.position = 'relative'; paneElement.appendChild(label);
                }
            }
        });
        applyResearchPaneLayout(chart, assignments);
        let visibleLength = chartBars.length;
        const fitVisibleRange = () => chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, visibleLength - 145), to: visibleLength + 5 });
        chart.timeScale().subscribeSizeChange(fitVisibleRange);
        updateChart.current = next => {
            updaters.forEach(update => update(next));
            visibleLength = next.length;
            fitVisibleRange();
        };
        updateChart.current(chartBars);
        setApis({ chart, series });
        return () => {
            cancelAnimationFrame(labelFrame);
            chart.timeScale().unsubscribeSizeChange(fitVisibleRange);
            updateChart.current = null;
            // Child primitives detach in passive cleanup before the chart is disposed.
            queueMicrotask(() => chart.remove());
        };
    }, []);
    useEffect(() => { if (apis) updateChart.current?.(chartBars); }, [apis, chartBars]);
    return <main style={{ width, maxWidth: '100%', height: '100dvh', display: 'flex', flexDirection: 'column', margin: '0 auto', padding: '8px', boxSizing: 'border-box' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap', flexShrink: 0 }}>
            <b>V9 研究看盤 · 第一階段預覽</b><span style={{ color: '#facc15', fontSize: 11 }}>離線合成行情 · 不接行情 API</span>
            {[1440, 1024, 650].map(w => <button key={w} onClick={() => setWidth(w)}>{w === 1440 ? '桌面' : w === 1024 ? '平板' : '窄欄'}</button>)}
            {scenarios.map(value => <button key={value} aria-pressed={scenario === value}
                onClick={() => setScenario(value)}>{value}</button>)}
        </header>
        <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0, maxHeight: width === 1440 ? 800 : 720 }}>
        <aside style={{ width: width === 650 ? 190 : 260, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid #2c3b4b', borderRadius: 8, overflow: 'hidden', background: '#131b24' }}>
            <b style={{ padding: 8 }}>產業觀察 · 17類49檔</b>
            <ResearchIndustryWatchlistView selectedCode={selectedCode} onPick={setSelectedCode} />
        </aside>
        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid #2c3b4b', borderRadius: 8, overflow: 'hidden', background: '#131b24' }}>
            {selectedCode && <div style={{ fontSize: 11, padding: '4px 8px', color: '#facc15' }}>離線點選 {selectedCode} · 以下仍是合成期貨示例，不代表股票行情</div>}
            <div className={`${quoteCss.board} ${quoteCss.compactBoard}`}>
                <div className={quoteCss.symbolBlock}><b className={quoteCss.symbolCode}>TXFR1</b><span className={quoteCss.symbolName}>臺股期貨 近月 · 示例</span></div>
                <span className={quoteCss.bigPrice.down}>47,956</span><div className={quoteCss.changeBlock} style={{ color: '#2ecc8a' }}>-169.00<br />-0.35%</div>
                <div className={quoteCss.quickStats}><span>開 <b>47,915</b></span><span>高 <b>48,296</b></span><span>低 <b>47,769</b></span><span>量 <b>29,426</b></span></div>
                <button className={quoteCss.detailButton} aria-expanded={quoteDetails} onClick={() => setQuoteDetails(!quoteDetails)}>行情明細 {quoteDetails ? '▴' : '▾'}</button>
                {quoteDetails && <div className={`${quoteCss.statGrid} ${quoteCss.expandedStats}`}>參考<span>48,125</span>委買<span>47,950</span>委賣<span>47,974</span>時間<span>示例資料</span></div>}
            </div>
            <div className={chartCss.toolbar}>{[1, 5].map(minutes => <button key={minutes} onClick={() => setTimeframe(minutes)} aria-pressed={timeframe === minutes} className={chartCss.tfBtn[timeframe === minutes ? 'active' : 'normal']}>{minutes}m</button>)}
                <button className={chartCss.tfBtn.normal} onClick={() => apis && applyResearchPaneLayout(apis.chart, assignments)}>主圖放大</button></div>
            <ResearchMarkerControls options={options} onChange={setOptions} flow={EMPTY_FLOW} markers={[]} barCount={chartBars.length}
                resonance={resonance} dataStatus={dataStatus} loading={scenario === '載入中'} macdParams={[45, 117, 17]} levels={[
                    { id: 'prev-high', title: '昨高', price: 48150, kind: 'previous' },
                    { id: 'prev-low', title: '昨低', price: 47780, kind: 'previous' },
                    { id: 'prev-close', title: '昨收', price: 48030, kind: 'previous' },
                    { id: 'or-high', title: '開盤5分高', price: 47997, kind: 'opening-range' },
                    { id: 'open', title: '開盤', price: 47915, kind: 'open' },
                ]} currentPrice={47956} openingPrice={47915} setupEvaluation={setupEvaluation} vwapEvaluation={vwapEvaluation} />
            <ResearchFibonacci storageKey="v9-layout-fixture-only" chart={apis?.chart ?? null} series={apis?.series ?? null} bars={bars} capture={capture} />
            <div className={chartCss.researchReferenceStrip}><span style={{ color: '#facc15' }}>夜盤開盤 47,915</span><span style={{ color: '#4ade80' }}>ATR 空方價上防守 · 示例</span><span>EMA3／EMA8</span></div>
            <div ref={host} style={{ flex: 1, minHeight: 0, position: 'relative' }} />
        </section>
        </div>
    </main>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
