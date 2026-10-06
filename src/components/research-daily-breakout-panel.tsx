import { useMemo, useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { buildDailyBreakoutStudy, DEFAULT_DAILY_BREAKOUT_SETTINGS, type DailyBreakoutSettings } from '../lib/research-daily-breakout';
import * as styles from './research-daily-breakout-panel.css';

export interface ResearchDailyBreakoutPanelProps {
    rows: { contract: ContractInfo; daily: Candle[] }[];
    loading: boolean;
    error: string | null;
    onPick: (code: string) => void;
}

type Study = ReturnType<typeof buildDailyBreakoutStudy>;
type StudyRow = { contract: ContractInfo; study: Study };
const STATUS_LABELS = { 'warming-up': '資料不足／暖機', waiting: '等待條件', excluded: '過熱排除', start: '放量突破研究啟動', tracking: '研究追蹤中', exit: '破線退出提醒' } as const;

function day(time: number | null | undefined): string {
    if (time === null || time === undefined || !Number.isFinite(time)) return '—';
    // The adapter encodes a Taiwan calendar-date label as UTC midnight.
    // It is not a real-time instant to be shifted by another eight hours.
    const date = new Date(time * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '—';
}
function number(value: number | null | undefined, digits = 2): string {
    return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : '—';
}
function ratio(value: number | null | undefined): string { return value === null || value === undefined ? '—' : `${number(value)}倍`; }
function statusOf(row: StudyRow) { return row.study.dataError ? 'error' : row.study.latest?.status ?? 'warming-up'; }
function dateOf(row: StudyRow): number | null { return row.study.latest?.asOf ?? row.study.candles.at(-1)?.time ?? null; }

/** Pure SVG view. It observes neither live prices nor broker state. */
function DailyStudyChart({ study, name }: { study: Study; name: string }) {
    const candles = study.candles.slice(-120);
    if (candles.length === 0) return <div className={styles.empty}>尚無可呈現的完成日K</div>;
    const trendByTime = new Map(study.trendLine.map(point => [point.time, point.value]));
    const eventsByTime = new Map(study.events.map(event => [event.time, event]));
    const values = candles.flatMap(candle => [candle.high, candle.low, ...(trendByTime.has(candle.time) ? [trendByTime.get(candle.time)!] : [])]);
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max((high - low) * 0.12, high * 0.005, 0.01);
    const yMin = low - padding, yMax = high + padding;
    const xLeft = 15, xRight = 640, yTop = 20, yBottom = 235, volumeTop = 275, volumeBottom = 325;
    const slot = (xRight - xLeft) / candles.length;
    const x = (index: number) => xLeft + slot * (index + 0.5);
    const y = (value: number) => yBottom - (value - yMin) / (yMax - yMin) * (yBottom - yTop);
    const maxVolume = Math.max(...candles.map(candle => candle.volume), 1);
    const lineSegments: string[] = [];
    let segment = '';
    candles.forEach((candle, index) => {
        const trend = trendByTime.get(candle.time);
        if (trend === undefined) { if (segment) lineSegments.push(segment); segment = ''; }
        else segment += `${segment ? ' L' : 'M'}${x(index).toFixed(2)},${y(trend).toFixed(2)}`;
    });
    if (segment) lineSegments.push(segment);
    const labelIndices = [...new Set([0, Math.floor((candles.length - 1) / 2), candles.length - 1])];
    return <div className={styles.chartScroll}>
        <svg className={styles.chart} viewBox='0 0 720 365' role='img' aria-label={`${name}完成日K、藍色研究趨勢線、成交量與研究事件`}>
            <title>{name}：最近 {candles.length} 根完成日K，箭頭不是可成交價</title>
            {[0, 1, 2, 3, 4].map(index => {
                const value = yMin + (yMax - yMin) * index / 4;
                return <g key={index}><line x1={xLeft} x2={xRight} y1={y(value)} y2={y(value)} stroke='currentColor' opacity={0.18} /><text x={650} y={y(value) + 4} fill='currentColor' fontSize={11}>{number(value)}</text></g>;
            })}
            {candles.map((candle, index) => {
                const color = candle.close >= candle.open ? styles.candleUp : styles.candleDown;
                const width = Math.max(1, Math.min(slot * 0.65, 10));
                const volumeHeight = candle.volume / maxVolume * (volumeBottom - volumeTop);
                return <g key={candle.time} data-daily-candle={candle.time}>
                    <title>{`${day(candle.time)} 開 ${number(candle.open)} 高 ${number(candle.high)} 低 ${number(candle.low)} 收 ${number(candle.close)} 量 ${candle.volume.toLocaleString('zh-TW')}`}</title>
                    <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} stroke={color} />
                    <rect x={x(index) - width / 2} y={Math.min(y(candle.open), y(candle.close))} width={width} height={Math.max(Math.abs(y(candle.open) - y(candle.close)), 1)} fill={color} />
                    <rect x={x(index) - width / 2} y={volumeBottom - volumeHeight} width={width} height={volumeHeight} fill={color} opacity={0.6} />
                </g>;
            })}
            {lineSegments.map((path, index) => <path key={index} d={path} fill='none' stroke='#60a5fa' strokeWidth={2} data-trend-line />)}
            {candles.map((candle, index) => {
                const event = eventsByTime.get(candle.time);
                if (!event) return null;
                const start = event.type === 'start';
                const anchor = start ? Math.min(yBottom - 3, y(candle.low) + 12) : Math.max(yTop + 3, y(candle.high) - 12);
                const points = start ? `${x(index)},${anchor - 5} ${x(index) - 5},${anchor + 4} ${x(index) + 5},${anchor + 4}` : `${x(index)},${anchor + 5} ${x(index) - 5},${anchor - 4} ${x(index) + 5},${anchor - 4}`;
                return <polygon key={event.time} points={points} fill={start ? '#fbbf24' : '#22d3ee'} data-research-event={event.type}><title>{`${day(event.time)} ${start ? '放量突破研究啟動' : '破線退出提醒'}；收盤 ${number(event.close)}，不是成交價`}</title></polygon>;
            })}
            <text x={xLeft} y={260} fill='currentColor' fontSize={11}>成交量（原始資料單位）</text>
            <text x={650} y={volumeTop + 4} fill='currentColor' fontSize={10}>{maxVolume.toLocaleString('zh-TW')}</text>
            {labelIndices.map(index => <text key={index} x={x(index)} y={348} textAnchor={index === 0 ? 'start' : index === candles.length - 1 ? 'end' : 'middle'} fill='currentColor' fontSize={11}>{day(candles[index]!.time)}</text>)}
        </svg>
    </div>;
}

export function ResearchDailyBreakoutPanel({ rows, loading, error, onPick }: ResearchDailyBreakoutPanelProps) {
    const [settings, setSettings] = useState<DailyBreakoutSettings>({ ...DEFAULT_DAILY_BREAKOUT_SETTINGS });
    const [selectedCode, setSelectedCode] = useState<string | null>(null);
    const studies = useMemo(() => rows.map(row => ({ contract: row.contract, study: buildDailyBreakoutStudy(row.daily, settings) })), [rows, settings]);
    const newestDate = studies.reduce<number | null>((latest, row) => {
        const date = dateOf(row);
        return date !== null && (latest === null || date > latest) ? date : latest;
    }, null);
    const candidates = useMemo(() => studies.filter(row => !row.study.dataError && row.study.latest?.status === 'start' && row.study.latest.exclusionReasons.length === 0 && row.study.latest.asOf === newestDate)
        .sort((a, b) => (b.study.latest?.volumeRatio ?? 0) - (a.study.latest?.volumeRatio ?? 0) || a.contract.code.localeCompare(b.contract.code)).slice(0, 5), [studies, newestDate]);
    const selected = studies.find(row => row.contract.code === selectedCode) ?? candidates[0] ?? studies[0];
    const pick = (code: string) => { setSelectedCode(code); onPick(code); };
    const stockRow = (row: StudyRow, candidate = false, rank?: number) => {
        const latest = row.study.latest;
        const status = statusOf(row);
        const older = newestDate !== null && dateOf(row) !== null && dateOf(row)! < newestDate;
        return <button key={row.contract.code} className={styles.row[selected?.contract.code === row.contract.code ? 'selected' : 'normal']} data-stock-code={row.contract.code} data-candidate={candidate} aria-label={`研究 ${row.contract.code} ${row.contract.name}`} aria-pressed={selected?.contract.code === row.contract.code} onClick={() => pick(row.contract.code)}>
            <span className={styles.identity}><span className={styles.name}>{rank ? `${rank}. ` : ''}{row.contract.code} {row.contract.name}</span>
                <span className={styles.info}>資料日 {day(dateOf(row))}{older ? ' · 較舊資料，不列TOP5' : ''}</span>
                {row.study.dataError && <span className={styles.info}>{row.study.dataError}</span>}
                {!!latest?.exclusionReasons.length && <span className={styles.info}>過熱條件：{latest.exclusionReasons.join('、')}</span>}
            </span>
            <span className={styles.numbers}><span className={styles.status[status]}>{status === 'error' ? '資料異常' : STATUS_LABELS[status]}</span><span>{number(latest?.close)}</span><span className={styles.info}>量比 {ratio(latest?.volumeRatio)}</span></span>
        </button>;
    };
    const snapshot = selected?.study.latest;
    return <div className={styles.root}>
        <div className={styles.toolbar}><span className={styles.title}>日K波段研究</span><span className={styles.badge}>僅研究，不下單</span><span className={styles.subtitle}>{rows.length} 檔已供資料</span></div>
        <div className={styles.body}>
            <div className={styles.controls}>
                <label className={styles.label}>研究趨勢線<select className={styles.control} aria-label='研究趨勢線' value={settings.trendType} onChange={event => setSettings(current => ({ ...current, trendType: event.target.value === 'ema' ? 'ema' : 'sma' }))}><option value='sma'>SMA20</option><option value='ema'>EMA20</option></select></label>
                <label className={styles.label}>放量標準<select className={styles.control} aria-label='放量標準' value={settings.volumeMultiple} onChange={event => setSettings(current => ({ ...current, volumeMultiple: event.target.value === '2' ? 2 : 1.5 }))}><option value='1.5'>前20日均量 × 1.5</option><option value='2'>前20日均量 × 2</option></select></label>
            </div>
            <p className={styles.note}>研究預設，不是截圖原公式。收盤突破前10日高點＋放量＋趨勢線上揚才啟動；研究追蹤中收盤破線即提醒退出，不要求退出日放量。前高、均量均排除當日。</p>
            <p className={styles.warning}>資料為分鐘聚合／權息未校正。僅使用有收盤來源證據的日K；全日缺口尚未核驗。切換參數會重算整段研究追蹤，屬參數比較，非真實持倉。</p>
            <p className={styles.note}>過熱排除：RSI &gt; 85、SMA20乖離 &gt; 15%、單日漲幅 ≥ 9%、跳空 ≥ 8%、3日漲幅 ≥ 22%。只阻擋新啟動，不阻擋破線退出。</p>
            {loading && <p className={styles.note} role='status'>資料載入中；現有結果只代表已提供的完成日K。</p>}
            {error && <p className={styles.warning} role='alert'>資料載入狀況：{error}。請核對各檔資料日期；保留資料不代表最新。</p>}
            <h3 className={styles.heading}><span>TOP5 放量突破研究候選</span><span className={styles.subtitle}>按量比排序，最多5檔</span></h3>
            <p className={styles.note}>資料日 {day(newestDate)} 的研究候選，非即時／非最新保證。只列這個資料日的新啟動；較舊日期、追蹤、退出、排除及暖機不補名額。</p>
            {candidates.length ? candidates.map((row, index) => stockRow(row, true, index + 1)) : <div className={styles.empty}>目前沒有符合條件的同資料日新啟動候選；不補滿TOP5。</div>}
            <details>
                <summary className={styles.heading}><span>逐檔研究狀態 · {studies.length} 檔</span><span className={styles.subtitle}>點此展開／收合</span></summary>
                {studies.map(row => stockRow(row))}
            </details>
            {!studies.length && <div className={styles.empty}>尚無已供資料的股票；本面板不自行查詢或訂閱行情。</div>}
            {selected && <section aria-label='選取股票日K研究'>
                <h3 className={styles.heading}><span>{selected.contract.code} {selected.contract.name}</span><span className={styles.subtitle}>完成日K截止 {day(dateOf(selected))}</span>
                    <label className={styles.label}>查看股票<select className={styles.control} aria-label='查看股票日K' value={selected.contract.code} onChange={event => pick(event.target.value)}>
                        {studies.map(row => { const status = statusOf(row); return <option key={row.contract.code} value={row.contract.code}>{row.contract.code} {row.contract.name} · {status === 'error' ? '資料異常' : STATUS_LABELS[status]}</option>; })}
                    </select></label>
                </h3>
                {selected.study.dataError && <p className={styles.warning}>{selected.study.dataError}</p>}
                <div className={styles.metrics}>
                    {[['資料日收盤', number(snapshot?.close)], ['研究趨勢線', number(snapshot?.trend)], ['前10日高點', number(snapshot?.prevHigh)], ['前20日均量比', ratio(snapshot?.volumeRatio)], ['RSI14', number(snapshot?.rsi14)], ['SMA20乖離', snapshot?.biasPct === null || snapshot?.biasPct === undefined ? '—' : `${number(snapshot.biasPct)}%`]].map(([label, value]) => <div className={styles.metric} key={label}><span className={styles.info}>{label}</span><span className={styles.metricValue}>{value}</span></div>)}
                </div>
                <div className={styles.legend}><span className={styles.trendLegend}>━ {settings.trendType === 'ema' ? 'EMA20' : 'SMA20'} 研究趨勢線</span><span className={styles.startLegend}>▲ 放量突破研究啟動</span><span className={styles.exitLegend}>▼ 破線退出提醒</span></div>
                <DailyStudyChart study={selected.study} name={`${selected.contract.code} ${selected.contract.name}`} />
                <p className={styles.note}>日K收盤後才確認。箭頭僅標示研究條件所在日，不是成交價、實際持倉或報酬；窄版可左右捲動圖表。</p>
                <h3 className={styles.heading}><span>研究事件明細</span><span className={styles.subtitle}>{selected.study.events.length} 次 · 新到舊</span></h3>
                {selected.study.events.length ? [...selected.study.events].reverse().map(event => <div className={styles.event} key={`${event.time}-${event.type}`} data-event-type={event.type}>
                    <div className={styles.eventTitle}><span className={event.type === 'start' ? styles.startLegend : styles.exitLegend}>{event.type === 'start' ? '放量突破研究啟動' : '破線退出提醒'}</span><span>{day(event.time)}</span></div>
                    <div>條件日收盤 {number(event.close)} · 趨勢線 {number(event.trend)} · {event.type === 'start' ? '前高' : '破線基準'} {number(event.level)} · 量比 {ratio(event.volumeRatio)}</div><div className={styles.info}>{event.reason}</div>
                </div>) : <div className={styles.empty}>這段已供日K尚無研究啟動／退出事件。</div>}
            </section>}
        </div>
    </div>;
}
