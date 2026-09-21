import type { FlowSnapshot, ResearchMarkerOptions, V9ChartMarker } from '../lib/utils/v9-chart-markers';
import * as styles from './research-marker-controls.css';

export function researchFlowStatus(flow: FlowSnapshot): string {
    if (!flow.sampleCount) return '等待真實 Tick（不由 K 棒補造）';
    if (flow.sampleCount < 20) return `Tick 暖機 ${flow.sampleCount}/20`;
    const threshold = flow.threshold === null ? '—' : flow.threshold.toFixed(1);
    return `樣本 ${flow.sampleCount}/120 · 下筆門檻約 ${threshold} · 已識別 ${flow.qualifiedCount} 筆`;
}

export function ResearchMarkerControls({ options, onChange, flow, markers, barCount, loading = false }: {
    options: ResearchMarkerOptions;
    onChange: (options: ResearchMarkerOptions) => void;
    flow: FlowSnapshot;
    markers: V9ChartMarker[];
    barCount: number;
    loading?: boolean;
}) {
    const toggles = [
        ['volume', '攻／洗／量背'],
        ['divergence', '頂／底背'],
        ['trend', '多空線買賣點'],
        ['trendShort', '放空買賣點'],
        ['flow', '大單推估'],
    ] as const;
    const lastTick = flow.lastTime === null ? '' : new Date(flow.lastTime * 1000).toISOString().slice(5, 19).replace('T', ' ');
    return <section className={styles.root} aria-label="V9 研究標記">
        <div className={styles.row}>
            <span className={styles.label}>研究標記</span>
            {toggles.map(([key, label]) => <button key={key}
                className={styles.toggle[options[key] ? 'on' : 'off']}
                aria-pressed={options[key]}
                onClick={() => onChange({ ...options, [key]: !options[key] })}>
                {label} <span>{markers.filter(marker => marker.group === key).length}</span>
            </button>)}
            <button className={styles.toggle[options.tint ? 'on' : 'off']} aria-pressed={options.tint}
                title="多空底色：與 ATR 防守線同源，多方段淡綠、空方段淡紅、中性／暖機留白"
                onClick={() => onChange({ ...options, tint: !options.tint })}>
                多空底色
            </button>
            <button className={styles.toggle[options.compact ? 'on' : 'off']} aria-pressed={options.compact}
                title="精簡：依圖寬自動間隔，至少 5 根；全部：顯示所有符合條件的標記"
                onClick={() => onChange({ ...options, compact: !options.compact })}>
                {options.compact ? '精簡顯示' : '全部標記'}
            </button>
            <details className={styles.help}>
                <summary>判讀說明</summary>
                <div className={styles.explanation}>
                    <p>攻／洗／量背在成交量區；頂背／底背與大單推估在主圖。數字為目前載入資料的顯示標記數，非視窗內數量。精簡依圖寬減量，量能標記優先保留「攻」、其次「洗」；放大或切「全部標記」可看完整條件。</p>
                    <p>K 棒型態只使用已收棒的原始 OHLC，切換平均 K 不改計算。背離固定採 20 根比較窗、KDJ(45,9,9) 與加權 MACD(45,117,17)，至少需 153 根有效 K 棒；與可自訂參數的副圖分開計算。</p>
                    <p>大單：前 20～120 筆真實整股／期貨成交量均值 ×3，最低 5 單位；未知方向只入基準、不投買賣票。以同根 K 的合格買賣量差判斷，未收棒仍會變。換股票或交易時段重新暖機，重新整理不保留 Tick。</p>
                    <p>多空線買賣點：依 SuperTrend（ATR 週期 10、倍數 3，與 V9 預設多空趨勢線相同）翻轉，綠「買」為收盤站上軌道、由空翻多，紅「平」為收盤跌破軌道、由多翻空，代表只做多的進出場研究位置；標記落在已收棒，盤中未收棒會變，若你自訂多空線參數，標記尚未連動。</p>
                    <p>放空買賣點：同一組 SuperTrend 翻轉的做空側，紅「賣」為由多翻空（開空），綠「補」為由空翻多（回補空單）。與做多側同時開啟時，同一翻轉點會合併顯示「平·賣」（翻空：平多並開空）與「買·補」（翻多：回補空單並做多）。台股現股放空有券與平盤以下不得放空等限制，期貨方可雙向；此為研究位置、非自動訊號。</p>
                    <p>多空底色：與主圖「ATR 防守線」同源（V8 多空線綜合 RSI／KDJ／MACD、連續兩根確認，45～55 為中性），多方段鋪淡綠、空方段鋪淡紅，中性與暖機段留白；只標示目前站在多／空哪一側，不是進出場訊號，盤中未收棒仍可能變換。ATR 防守線為 V9 預設主圖指標（綠線多方防守、紅線空方防守），可於指標設定檢視或增刪。</p>
                    <p>這是量價型態與成交方向推估，不是官方主力／法人、大戶身分或已驗證交易訊號；「洗」也不代表能辨識洗盤意圖。開關與精簡顯示不下載歷史、不觸發下單。</p>
                </div>
            </details>
        </div>
        <div className={styles.status}>
            <span>{loading ? 'K 棒載入中' : `已收棒 ${barCount} 根`}</span>
            {!loading && barCount < 153 && <span>背離暖機 {barCount}/153</span>}
            {!loading && barCount >= 153 && !markers.some(marker => marker.group === 'divergence')
                && options.divergence && <span>背離：目前無顯示標記</span>}
            <span>{researchFlowStatus(flow)}</span>
            {lastTick && <span>末筆 {lastTick}</span>}
            <span>僅研究 · 不下單</span>
        </div>
    </section>;
}
