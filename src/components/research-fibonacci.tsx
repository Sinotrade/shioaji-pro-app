import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { IChartApi, ISeriesApi, MouseEventParams } from 'lightweight-charts';
import { fibLevels, pickFibAnchor, readFib, validFib, type FibAnchor, type FibDrawing } from '../lib/manual-fibonacci';
import { ManualFibonacciPrimitive } from '../lib/manual-fibonacci-primitive';
import type { Candle } from '../lib/types/market';
import * as styles from './research-fibonacci.css';

export function ResearchFibonacci({ chart, series, bars, storageKey, capture, open, onOpenChange }: {
    chart: IChartApi | null; series: ISeriesApi<'Candlestick'> | null; bars: Candle[];
    storageKey: string; capture: MutableRefObject<boolean>;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const [drawing, setDrawing] = useState<FibDrawing | null>(() => readFib(storageKey));
    const [shown, setShown] = useState(true);
    const [active, setActive] = useState(false);
    const [draft, setDraft] = useState<FibAnchor | null>(null);
    const [message, setMessage] = useState(drawing ? '已還原本商品、本週期的固定錨點；不隨行情自動改線。'
        : '先按手動畫線，再依時間順序點波段起點、終點（吸附原始 K 棒高／低）。');
    const state = useRef({ active, draft, bars });
    state.current = { active, draft, bars };
    const stop = () => { capture.current = false; setActive(false); setDraft(null); };
    const persist = (value: FibDrawing | null) => {
        try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); }
        catch { setMessage('瀏覽器無法儲存；本次畫線仍可使用，重新整理不保留。'); }
    };
    useEffect(() => () => { capture.current = false; }, [capture]);
    useEffect(() => {
        if (!chart || !series) return;
        const clicked = (param: MouseEventParams) => {
            const current = state.current;
            if (!current.active) return;
            if (!param.point || typeof param.time !== 'number' || (param.paneIndex !== undefined && param.paneIndex !== 0)) return;
            const price = series.coordinateToPrice(param.point.y);
            const point = price === null ? null : pickFibAnchor(current.bars, param.time, Number(price));
            if (!point) { setMessage('請點選主圖已收棒、有成交量的 K 棒；空白處及未收棒不能當錨點。'); return; }
            if (!current.draft) {
                state.current.draft = point;
                setDraft(point); setMessage(`起點 ${point.price} 已選，請點右方較晚的波段終點。`); return;
            }
            const next = { start: current.draft, end: point };
            if (!validFib(next)) { setMessage('終點需晚於起點，且兩點價格不能相同；請重新選終點。'); return; }
            setDrawing(next); setShown(true); stop();
            state.current.active = false; state.current.draft = null;
            setMessage('已固定錨點；新 K 棒不會自動改線。可隱藏、重畫或清除。'); persist(next);
        };
        chart.subscribeClick(clicked);
        return () => chart.unsubscribeClick(clicked);
    }, [chart, series, storageKey]);
    useEffect(() => {
        if (!series) return;
        const primitive = new ManualFibonacciPrimitive(shown && !active ? drawing : null, active ? draft : null);
        series.attachPrimitive(primitive);
        return () => { series.detachPrimitive(primitive); };
    }, [series, shown, active, drawing, draft]);
    return <details className={styles.root} open={open} onToggle={event => {
        onOpenChange?.(event.currentTarget.open);
        if (!event.currentTarget.open && state.current.active) {
            stop(); state.current.active = false; state.current.draft = null;
            setMessage('已收合工具並取消選點，保留原畫線。');
        }
    }}>
        <summary className={styles.summary}>斐波那契畫線
            <span className={styles.summaryHint}>{drawing
                ? fibLevels(drawing).map(level => `${(level.ratio * 100).toFixed(1).replace('.0', '')}% ${level.price.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`).join('  ·  ')
                : '38.2% · 50% · 61.8%'}</span>
        </summary>
        <section aria-label="斐波那契手動畫線">
        <div className={styles.row}>
            <strong>斐波那契</strong>
            <button className={styles.button} aria-pressed={active} disabled={!chart || !series || !bars.length}
                onClick={() => { capture.current = true; state.current.active = true; state.current.draft = null;
                    setActive(true); setDraft(null); setMessage('請點波段起點，再點較晚的終點；上漲低→高、下跌高→低。'); }}>
                {drawing ? '重新畫線' : '手動畫線'}</button>
            {active && <button className={styles.button} onClick={() => { stop(); state.current.active = false;
                setMessage('已取消，保留原畫線。'); }}>取消</button>}
            <button className={styles.button} disabled={!drawing || active} aria-pressed={shown && Boolean(drawing)}
                onClick={() => setShown(!shown)}>{shown ? '隱藏回撤線' : '顯示回撤線'}</button>
            <button className={styles.button} disabled={!drawing && !active} onClick={() => {
                stop(); state.current.active = false; setDrawing(null); setMessage('已清除本商品、本週期的手動畫線。'); persist(null);
            }}>清除</button>
            {drawing && <span>{drawing.end.price > drawing.start.price ? '上漲波段回檔' : '下跌波段反彈'}：
                {drawing.start.price} → {drawing.end.price}</span>}
            {drawing && fibLevels(drawing).map(level => <span key={level.ratio} style={{ color: level.color }}>
                {(level.ratio * 100).toFixed(1).replace('.0', '')}%　{level.price.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</span>)}
        </div>
        <small className={styles.message} role="status" title={`${message} 僅研究參考，不是進場訊號。`}>
            {message} 僅研究參考，不是進場訊號。
        </small>
        </section>
    </details>;
}
