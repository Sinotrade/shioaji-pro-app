import { RefreshCw } from 'lucide-react';
import type { DaytradeResult, DaytradeRow } from '../lib/daytrade-picker';
import * as styles from './daytrade-picker-panel.css';

export interface DaytradePickerPanelProps {
    result: DaytradeResult | null;
    loading: boolean;
    error: string | null;
    lastUpdated: number | null;
    poolSize: number;
    onRefresh: () => void;
    onPick?: (code: string) => void;
}

function number(value: number | null, digits = 2): string {
    return value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function ratio(value: number | null): string {
    return value !== null && Number.isFinite(value) ? `${number(value)}倍` : '待補';
}

/** Broker timestamps without an explicit zone are Taiwan local wall-clock time. */
function clock(value: string | number | null): string {
    if (value === null) return '待補';
    const normalized = typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
        ? `${value.replace(' ', 'T')}+08:00`
        : value;
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) return '時間待核對';
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
}

function StockRow({ row, rank, observation, onPick }: {
    row: DaytradeRow;
    rank: number;
    observation: boolean;
    onPick?: (code: string) => void;
}) {
    const tone = row.side === 'long' ? styles.long : styles.short;
    return <div className={styles.stock}>
        <button className={styles.row} data-stock-code={row.contract.code}
            data-daytrade-kind={observation ? 'observation' : 'confirmed'} data-side={row.side}
            aria-label={`研究 ${row.contract.code} ${row.contract.name}`}
            title={row.reasons.join('；')} onClick={() => onPick?.(row.contract.code)}>
            <span className={`${styles.rank} ${tone}`}>{rank}</span>
            <span className={styles.identity}>
                <span className={styles.name}>{row.contract.code} {row.contract.name}</span>
                <span className={styles.info}>{row.signal}</span>
            </span>
            <span className={styles.numbers}>
                <span>{number(row.price)}</span>
                <span className={row.changeRate >= 0 ? styles.long : styles.short}>
                    {row.changeRate >= 0 ? '+' : ''}{number(row.changeRate)}%
                </span>
            </span>
            <span className={styles.metrics}>
                <span className={tone}>研究分數 {number(row.score, 0)}</span>
                <span>前日量比 {ratio(row.volumeRatio)}</span>
                <span title='與過往相同盤中時段的累積成交量比較，不等於前日全日量比'>同時段 RVOL {ratio(row.rvol)}</span>
            </span>
            <span className={styles.source}>
                {observation ? '日K收盤' : '行情'} {clock(row.asOf)} · 契約日 {row.qualificationDate || '待核對'}
            </span>
        </button>
        <details className={styles.rowDetails}>
            <summary className={styles.detailsSummary}>條件與資料</summary>
            <div className={styles.detailMetrics}>
                <span>VWAP（分鐘近似） {number(row.vwap)}</span>
                <span>價差 {number(row.spreadPct)}%</span>
                <span>ATR {number(row.atrPct)}%</span>
            </div>
            {row.reasons.length ? <ul className={styles.reasons}>
                {row.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
            </ul> : <p className={styles.info}>尚無條件說明；請核對資料。</p>}
        </details>
    </div>;
}

function SideList({ rows, side, observation, onPick }: {
    rows: DaytradeRow[];
    side: 'long' | 'short';
    observation: boolean;
    onPick?: (code: string) => void;
}) {
    const top = rows.filter(row => row.side === side).slice(0, 10);
    return <section className={styles.sidePanel} aria-label={`${observation ? '前一交易日觀察' : '盤中條件已確認'}${side === 'long' ? '多方' : '空方'}`}>
        <h4 className={styles.sideHeading}>
            <span className={side === 'long' ? styles.long : styles.short}>{side === 'long' ? '多方' : '空方'}</span>
            <span className={styles.info}>{top.length} / 10 檔</span>
        </h4>
        {top.length ? top.map((row, index) => <StockRow key={row.contract.code} row={row} rank={index + 1}
            observation={observation} onPick={onPick} />)
            : <div className={styles.empty}>{observation ? '尚無符合條件的前日觀察股。' : '尚無盤中條件完整且方向符合的候選。'}不補滿10檔。</div>}
    </section>;
}

/** Read-only view: all data and selection behavior are supplied by the parent. */
export function DaytradePickerPanel({ result, loading, error, lastUpdated, poolSize, onRefresh, onPick }: DaytradePickerPanelProps) {
    // Never present a carried/stale live list as currently confirmed outside the core's live window.
    const live = result?.phase === 'live';
    const long = live ? result.long : [];
    const short = live ? result.short : [];
    const excluded = result?.excluded ?? [];
    return <div className={styles.root}>
        <div className={styles.toolbar}>
            <span className={styles.title}>當沖多空10</span>
            <span className={styles.badge}>僅研究，不下單</span>
            <button className={styles.refresh} aria-label='重新整理當沖研究' title='重新整理當沖研究'
                disabled={loading} onClick={onRefresh}>
                <RefreshCw size={13} className={loading ? styles.spinning : undefined} />
            </button>
        </div>
        <div className={styles.body}>
            <p className={styles.note}>自選＋排行榜最多40檔，池內排序；目前 {poolSize} 檔。多空各最多10檔，條件不足不湊滿；研究分數不是勝率。</p>
            <p className={styles.sourceNote}>評估日 {result?.tradeDate || '待補'} · 最後更新 {clock(lastUpdated)}（台北時間）</p>
            {!result && !loading && !error && <p className={styles.notice}>尚無已提供的當沖研究資料，請重新整理。</p>}
            {loading && <p className={styles.notice} role='status'>當沖資料評估中；現有結果只代表各檔所示的行情時間。</p>}
            {error && <p className={styles.warning} role='alert'>資料載入狀況：{error}。保留的研究結果不代表最新行情。</p>}
            {result?.phase === 'preopen' && <p className={styles.notice}>尚未進入09:15～13:25盤中確認時段，先看前日觀察；不提供目前可當沖的確認名單。</p>}
            {result?.phase === 'closed' && <p className={styles.notice}>已離開09:15～13:25盤中確認時段，不提供目前可當沖的確認名單。前日觀察不是即時訊號，隔日須重新核對資格與行情。</p>}
            <h3 className={styles.heading}>盤中條件已確認 <span className={styles.info}>多 {long.length} · 空 {short.length}</span></h3>
            <p className={styles.note}>只列資格、流動性、價差、同時段量能與完成5分K條件通過者；空方仍須自行確認帳戶與券源，非成交保證。</p>
            <div className={styles.sides}>
                <SideList rows={long} side='long' observation={false} onPick={onPick} />
                <SideList rows={short} side='short' observation={false} onPick={onPick} />
            </div>
            <h3 className={styles.heading}>前一交易日觀察 <span className={styles.info}>非今日盤中確認</span></h3>
            <p className={styles.note}>完成日K的趨勢、量能與波動篩選；前日量比不等於同時段RVOL。缺分鐘歷史、資格待核對或盤中條件不足，不會因此補進確認名單。</p>
            <div className={styles.sides}>
                <SideList rows={result?.observationsLong ?? []} side='long' observation onPick={onPick} />
                <SideList rows={result?.observationsShort ?? []} side='short' observation onPick={onPick} />
            </div>
            <details className={styles.excluded}>
                <summary className={styles.heading}>排除／等待原因 · {excluded.length} 檔 <span className={styles.info}>展開核對</span></summary>
                {excluded.length ? excluded.map(row => <div className={styles.excludedRow} key={row.code}>
                    <span className={styles.name}>{row.code} {row.name}</span>
                    <span className={styles.info}>{row.reasons.join('；') || '等待完整資料'}</span>
                </div>) : <p className={styles.empty}>目前尚無排除／等待明細。</p>}
            </details>
            <p className={styles.note}>分數是研究排序，不是推薦下單或報酬承諾。VWAP為分鐘量價近似；日K由分鐘聚合，未完成權息校正。資格與報價須按各檔資料日期核對。</p>
        </div>
    </div>;
}
