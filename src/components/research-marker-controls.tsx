import { useId, useMemo, useState, type ReactNode } from 'react';
import type { FlowSnapshot, ResearchMarkerOptions, V9ChartMarker } from '../lib/utils/v9-chart-markers';
import type { ResearchLevel, V9Resonance } from '../lib/utils/research-chart';
import { PIVOT_ZONE_LABEL, pivotLevels, pivotSignal, pivotZone } from '../lib/pivot-levels';
import { researchDecision, type ResearchDataStatus } from '../lib/research-decision';
import type { ResearchEntryContext } from '../lib/research-entry';
import { researchSetupDisplay, type ResearchSetupEvaluation, type ResearchVwapEvaluation } from '../lib/research-setup-display';
import * as styles from './research-marker-controls.css';

type MarketTone = 'long' | 'short' | 'neutral' | 'insufficient';

interface MarketBias {
    tone: MarketTone;
    label: string;
    arrow: string;
}

export function v9MarketBias(resonance: V9Resonance): MarketBias {
    const ready = resonance.frames.filter(frame => frame.side !== 'insufficient');
    const missing = resonance.frames.length - ready.length;
    const long = ready.filter(frame => frame.side === 'long').length;
    const short = ready.filter(frame => frame.side === 'short').length;
    if (ready.length === 4 && long === 4) return { tone: 'long', label: '強勢多方', arrow: '↑' };
    if (ready.length === 4 && short === 4) return { tone: 'short', label: '強勢空方', arrow: '↓' };
    if (long > short) return { tone: 'long', label: missing ? '已載入週期偏多' : '盤勢偏多', arrow: '↗' };
    if (short > long) return { tone: 'short', label: missing ? '已載入週期偏空' : '盤勢偏空', arrow: '↘' };
    if (long + short === 0) return { tone: missing ? 'insufficient' : 'neutral', label: missing ? '等待高週期資料' : '盤整中性', arrow: missing ? '…' : '↔' };
    if (ready.length > 0) return { tone: 'neutral', label: '多空分歧', arrow: '↔' };
    return { tone: 'insufficient', label: '等待資料', arrow: '…' };
}

export function researchFlowStatus(flow: FlowSnapshot): string {
    if (!flow.sampleCount) return '等待真實 Tick（不由 K 棒補造）';
    if (flow.sampleCount < 20) return `Tick 暖機 ${flow.sampleCount}/20`;
    const threshold = flow.threshold === null ? '—' : flow.threshold.toFixed(1);
    return `樣本 ${flow.sampleCount}/120 · 下筆門檻約 ${threshold} · 已識別 ${flow.qualifiedCount} 筆`;
}

function levelText(level: ResearchLevel): string {
    return level.title + ' ' + level.price.toLocaleString('zh-TW', { maximumFractionDigits: 4 });
}

function priceText(price: number | undefined): string {
    return price === undefined || !Number.isFinite(price)
        ? '—'
        : price.toLocaleString('zh-TW', { maximumFractionDigits: 4 });
}

function distanceText(price: number | undefined, currentPrice: number | undefined): string {
    if (price === undefined || currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice === 0) return '';
    const distance = (price / currentPrice - 1) * 100;
    return (distance >= 0 ? '+' : '') + distance.toFixed(2) + '%';
}

function nearestLevels(levels: ResearchLevel[], currentPrice: number | undefined): {
    resistance?: ResearchLevel;
    support?: ResearchLevel;
} {
    if (currentPrice === undefined || !Number.isFinite(currentPrice)) return {};
    return {
        resistance: levels.filter(level => level.price > currentPrice).sort((a, b) => a.price - b.price)[0],
        support: levels.filter(level => level.price < currentPrice).sort((a, b) => b.price - a.price)[0],
    };
}

function frameSideText(side: V9Resonance['frames'][number]['side']): string {
    return side === 'long' ? '↑ 多'
        : side === 'short' ? '↓ 空'
          : side === 'neutral' ? '↔ 中性'
            : '… 待資料';
}

function frameRole(minutes: V9Resonance['frames'][number]['minutes']): string {
    return minutes === 1 ? '即時'
        : minutes === 5 ? '短線'
          : minutes === 60 ? '波段'
            : '背景';
}

export function ResearchMarkerControls({ options, onChange, flow, markers, barCount, resonance, levels, currentPrice, openingPrice,
    priceChange, pricePct, reference, toolbar, fibOpen = false, onToggleFib, loading = false, directionLoading = loading,
    dataStatus, entryContext, setupEvaluation, vwapEvaluation, macdParams = [45, 117, 17] }: {
    options: ResearchMarkerOptions;
    onChange: (options: ResearchMarkerOptions) => void;
    flow: FlowSnapshot;
    markers: V9ChartMarker[];
    barCount: number;
    resonance: V9Resonance | null;
    levels: ResearchLevel[];
    currentPrice?: number;
    openingPrice?: number;
    priceChange?: number;
    pricePct?: number;
    reference?: { key: string; label: string; color?: string }[];
    toolbar?: ReactNode;
    fibOpen?: boolean;
    onToggleFib?: () => void;
    loading?: boolean;
    directionLoading?: boolean;
    dataStatus?: ResearchDataStatus;
    entryContext?: ResearchEntryContext;
    setupEvaluation?: ResearchSetupEvaluation;
    vwapEvaluation?: ResearchVwapEvaluation;
    macdParams?: readonly [number, number, number];
}) {
    const [expanded, setExpanded] = useState(false);
    const detailId = useId();
    const toggles = [
        ['volume', '攻／洗／量價提醒'],
        ['divergence', '高低點動能提醒'],
        ['trend', '多空線買賣點'],
        ['trendShort', '放空買賣點'],
        ['flow', '大單推估'],
        ['entry', '強勢上車'],
        ['shortEntry', '弱勢放空'],
    ] as const;
    const lastTick = flow.lastTime === null ? '' : new Date(flow.lastTime * 1000).toISOString().slice(5, 19).replace('T', ' ');
    const lastClosedBar = resonance?.asOf === undefined
        ? '尚無已收一分K'
        : new Date(resonance.asOf * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const bias = resonance ? v9MarketBias(resonance) : null;
    // Callers may distinguish a view-only timeframe load from symbol/source
    // loading. Without that explicit override, loading remains fail-closed.
    const decision = useMemo(() => researchDecision(resonance, dataStatus, directionLoading, entryContext),
        [resonance, dataStatus, directionLoading, entryContext]);
    const directionAvailable = decision.dataStatus.state === 'fresh' || decision.dataStatus.state === 'closed';
    const displayFrames = resonance?.frames.map(frame => directionAvailable ? frame : { ...frame, side: 'insufficient' as const });
    const entryTone = decision.entrySide ?? (decision.entryLabel === '等待資料' ||
        (decision.dataStatus.state !== 'fresh' && decision.dataStatus.state !== 'closed') ? 'insufficient' : 'neutral');
    const entryDataLabel = { fresh: '僅研究', closed: '已休市', loading: '載入中', stale: '資料過期', unknown: '資料未確認' }[decision.dataStatus.state];
    const nearest = nearestLevels(levels, currentPrice);
    const setupDisplay = setupEvaluation && vwapEvaluation
        ? researchSetupDisplay(setupEvaluation, vwapEvaluation, dataStatus, directionLoading) : undefined;

    // 現價漲跌（由 CandleChart 傳入、口徑同 QuoteBoard）。
    const changeTone: 'up' | 'down' | 'flat' =
        priceChange === undefined || priceChange === 0 ? 'flat' : priceChange > 0 ? 'up' : 'down';
    const changeText = priceChange === undefined
        ? '—'
        : `${priceChange > 0 ? '+' : ''}${priceChange.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}${
            pricePct === undefined ? '' : ` (${pricePct > 0 ? '+' : ''}${pricePct.toFixed(2)}%)`}`;

    // 樞紐關卡：前一交易日 H/L/C → 強勢/中間/弱勢；開盤價落點分區與順勢訊號。
    const prevH = levels.find(level => level.id === 'prev-high')?.price;
    const prevL = levels.find(level => level.id === 'prev-low')?.price;
    const prevC = levels.find(level => level.id === 'prev-close')?.price;
    const pivot = prevH !== undefined && prevL !== undefined && prevC !== undefined
        ? pivotLevels(prevH, prevL, prevC) : null;
    const openZone = pivot && openingPrice !== undefined
        ? pivotZone(openingPrice, pivot, prevH!, prevL!) : null;
    const pivotSig = openZone ? pivotSignal(openZone) : null;

    return <section className={styles.root} aria-label="V9 研究標記">
        <div className={styles.headline}>
            <div className={styles.decisionSummary} aria-label="盤勢與進場分開判讀">
                <div className={styles.decisionBadge[decision.background.tone]} aria-label="高週期背景">
                    <span className={styles.decisionRole}>高週期 · 60分＋日K</span>
                    <strong>{decision.background.arrow} {decision.background.label}</strong>
                </div>
                <div className={styles.decisionBadge[decision.shortTerm.tone]} aria-label="短線方向">
                    <span className={styles.decisionRole}>短線 · 1分＋5分</span>
                    <strong>{decision.shortTerm.arrow} {decision.shortTerm.label}</strong>
                </div>
                <button type="button" className={`${styles.decisionBadge[entryTone]} ${styles.decisionEntry}`}
                    aria-label="進場狀態" aria-expanded={expanded} aria-controls={detailId}
                    onClick={() => setExpanded(value => !value)} title={decision.reasons.join('｜')}>
                    <span className={styles.decisionRole}>進場 · {entryDataLabel}</span>
                    <strong>{decision.entryLabel}</strong>
                </button>
                {setupDisplay && <button type="button" className={`${styles.decisionBadge[setupDisplay.tone]} ${styles.decisionEntry}`}
                    aria-label="獨立型態研究" aria-expanded={expanded} aria-controls={detailId}
                    onClick={() => setExpanded(value => !value)} title={setupDisplay.detail}>
                    <span className={styles.decisionRole}>型態 · 已收5分 · 獨立研究</span>
                    <strong>{setupDisplay.label}</strong>
                </button>}
            </div>
            <div className={styles.regimeQuote}>
                <strong className={styles.regimePrice}>{priceText(currentPrice)}</strong>
                <span className={styles.regimeChg[changeTone]}>{changeText}</span>
            </div>
            {reference && reference.length > 0 && <div className={styles.regimeReferenceItems}>
                {reference.map(item => <span key={item.key}
                    style={item.color ? { color: item.color } : undefined}>{item.label}</span>)}
            </div>}
            {toolbar && <div className={styles.toolbarSlot}>{toolbar}</div>}
            {onToggleFib && <button type="button" className={styles.fibBtn[fibOpen ? 'on' : 'off']}
                aria-pressed={fibOpen} onClick={onToggleFib}>斐波那契</button>}
            <button className={styles.expandButton} aria-expanded={expanded} aria-controls={detailId}
                onClick={() => setExpanded(value => !value)}>{expanded ? '收合詳情 ▴' : '圖層／詳情 ▾'}</button>
        </div>
        <div id={detailId} className={styles.detailsPanel} hidden={!expanded}>
        {setupDisplay && setupEvaluation && vwapEvaluation && <div className={styles.decisionReasons} aria-label="第一階段型態研究說明">
            <strong>{setupDisplay.label}</strong><span>{setupDisplay.detail}</span>
            <p>VWAP：固定已收一分K的 (高＋低＋收)/3 × 成交量累計近似；不是逐筆精確成交均價。股票每日09:00起算；期貨日夜盤分開，夜盤跨午夜不重設。</p>
            <p>資料：{vwapEvaluation.reason}。{vwapEvaluation.status === 'ready' && setupEvaluation.vwap !== undefined
                ? `已收棒VWAP ${priceText(setupEvaluation.vwap)}` : '資料不完整時不顯示完整時段均價、不確認型態。'}</p>
            <p>型態固定使用5分EMA3／8（沿用已載背景連續計算，不是1分圖的EMA讀值），候選只觀察本時段。順勢回踩：先有兩根同側且EMA3／8同向的已收5分K，再回踩EMA8但維持VWAP同側；之後最多三根收盤突破回踩棒高／低才研究確認。站回後失守／跌破後站回：原在一側、收盤穿越VWAP、三根內又收回原側才確認。失效或逾期取消，歷史確認不重複當新觸發。</p>
            {setupDisplay.label === setupEvaluation.label && setupEvaluation.confirmedAt !== undefined && <p>確認時間 {new Date(setupEvaluation.confirmedAt * 1000).toISOString().slice(5, 16).replace('T', ' ')}；不回填到回踩低／高點。</p>}
            <p>兩套型態獨立觀察，不合併原共振權重或進場門檻；不是買賣許可，未驗證獲利。缺分鐘可能是無成交或來源缺資料，本版不補造也不自動下載。</p>
        </div>}
        <div className={styles.decisionReasons} aria-label="等待或不可確認的原因">
            <strong>{decision.entryLabel}</strong>
            <span>{loading ? 'K 棒載入中' : `最後收棒 ${lastClosedBar}`} · 僅研究、不下單</span>
            {decision.entryChecks.length > 0 && <ul className={styles.entryChecklist} aria-label="研究進場缺項檢核">
                {decision.entryChecks.map(check => <li key={check.id} className={styles.entryCheck[check.state]}>
                    <strong>{check.state === 'pass' ? '✓ 已成立' : check.state === 'missing' ? '… 缺資料' : '○ 等待'}</strong>
                    <span>{check.label} · {check.detail}</span>
                </li>)}
            </ul>}
            <ul>{decision.reasons.filter(reason => !decision.entryChecks.some(check => check.detail === reason))
                .map(reason => <li key={reason}>{reason}</li>)}</ul>
        </div>
        {resonance && bias && <div className={styles.overview} aria-label="目前盤勢總覽">
            <div className={styles.directionCard[directionAvailable ? bias.tone : 'insufficient']}>
                <span className={styles.eyebrow}>四週期票數（不代表可進場）</span>
                <strong className={styles.directionValue}>{directionAvailable ? `${bias.arrow} ${bias.label}` : '… 判讀暫停'}</strong>
                <span className={styles.directionNote}>V9 共振 · {directionAvailable ? resonance.summary : decision.entryLabel}</span>
                <span className={styles.directionNote}>最後收棒 {lastClosedBar}</span>
            </div>
            <div className={styles.frameGrid} aria-label="V9 四週期方向">
                {displayFrames?.map(frame => <div key={frame.minutes}
                    className={styles.frameCard[frame.side]}
                    aria-label={`${frameRole(frame.minutes)} ${frame.label} ${frameSideText(frame.side)}`}>
                    <span className={styles.frameName}>{frameRole(frame.minutes)} · {frame.label}</span>
                    <strong className={styles.frameDirection}>{frameSideText(frame.side)}</strong>
                    <span className={styles.frameMeta}>{directionAvailable && frame.score !== undefined
                        ? `強度 ${frame.score.toFixed(0)}`
                        : `${frame.bars}/${frame.requiredBars} 根`}</span>
                </div>)}
            </div>
            <div className={styles.levelCard} title={levels.map(levelText).join('｜')}>
                <div className={styles.levelHeader}>
                    <span className={styles.eyebrow}>最近支撐壓力</span>
                    <span>{options.levels ? '圖線顯示中' : '圖線已隱藏'}</span>
                </div>
                <div className={styles.levelGrid}>
                    <div className={styles.levelPoint.resistance}>
                        <span className={styles.levelLabel}>上方壓力</span>
                        <strong className={styles.levelValue}>{priceText(nearest.resistance?.price)}</strong>
                        <small className={styles.levelDetail}>{nearest.resistance?.title ?? '無既有水平線'} {distanceText(nearest.resistance?.price, currentPrice)}</small>
                    </div>
                    <div className={styles.levelPoint.current}>
                        <span className={styles.levelLabel}>目前價格</span>
                        <strong className={styles.levelValue}>{priceText(currentPrice)}</strong>
                        <small className={styles.levelDetail}>判讀基準</small>
                    </div>
                    <div className={styles.levelPoint.support}>
                        <span className={styles.levelLabel}>下方支撐</span>
                        <strong className={styles.levelValue}>{priceText(nearest.support?.price)}</strong>
                        <small className={styles.levelDetail}>{nearest.support?.title ?? '無既有水平線'} {distanceText(nearest.support?.price, currentPrice)}</small>
                    </div>
                </div>
            </div>
        </div>}
        <details className={styles.formulaSources}>
            <summary>公式來源與參數</summary>
            <p>副圖：收盤價 MACD({macdParams.join(',')})；主圖 EMA3／EMA8、KDJ(45,9,9)、ATR(14,2) 預設不變。副圖可自訂參數，以指標設定為準。</p>
            <p>綜合方向：加權價 (高＋低＋2×收)/4 的 MACD(45,117,17) ＋ RSI／KDJ，權重為 MACD 30%、RSI 35%、KDJ 35%，再以 EMA3 平滑。即使 MACD 參數相同，價格來源與組合公式仍不同，副圖轉折與共振分數不一定同步。</p>
            <p>背景只讀 60分＋日K；短線只讀 1分＋5分。55 以上偏多、45 以下偏空，其間中性，沿用原門檻。方向同向後，固定檢核已收5分K的 EMA3／EMA8、ATR(14,2)有效防守與最新 SuperTrend(10,3)翻轉；切圖不改檢核週期。</p>
            <p>既有指標的研究檢核，非正式進場策略。研究觸發多／空不是可下單、不是已驗證勝率，不改動正式交易公式、成本或風控。</p>
        </details>
        {pivot && <div className={styles.pivotCard} aria-label="樞紐開盤落點盤前提示">
            <div className={styles.levelHeader}>
                <span className={styles.eyebrow}>樞紐開盤落點（盤前計畫／獨立預警）</span>
                <span>{openZone ? '已開盤' : '等待開盤'}</span>
            </div>
            <div className={styles.pivotLevels}>
                {([['強勢價', pivot.strong], ['中間價', pivot.mid], ['弱勢價', pivot.weak]] as const).map(([name, price]) =>
                    <div key={name} className={styles.pivotLevel}>
                        <span className={styles.pivotLevelName}>{name}</span>
                        <strong className={styles.pivotLevelPrice}>{priceText(price)}</strong>
                    </div>)}
            </div>
            {pivotSig && openZone
                ? <div className={styles.pivotSignal} title={`${pivotSig.text} 開盤價 ${priceText(openingPrice)} · 僅研究、不自動下單`}>
                    <span className={styles.eyebrow}>{PIVOT_ZONE_LABEL[openZone]}</span>
                    <strong className={styles.pivotSignalTitle}>{pivotSig.title}</strong>
                    <span className={styles.pivotSignalText}>{`開盤 ${priceText(openingPrice)} · ${pivotSig.text} · 僅研究`}</span>
                </div>
                : <div className={styles.pivotSignal} title={`開盤越過強勢價 ${priceText(pivot.strong)} 才做多；跌破弱勢價 ${priceText(pivot.weak)} 才做空；中間落點不操作。`}>
                    <span className={styles.eyebrow}>盤前計畫</span>
                    <strong className={styles.pivotSignalTitle}>等待開盤</strong>
                    <span className={styles.pivotSignalText}>越強勢價偏多；破弱勢價偏空；中間區不操作。</span>
                </div>}
        </div>}
        <div className={styles.row}>
            <span className={styles.label}>圖層與標記</span>
            {toggles.map(([key, label]) => <button key={key}
                className={styles.toggle[options[key] ? 'on' : 'off']}
                aria-pressed={options[key]}
                onClick={() => onChange({ ...options, [key]: !options[key] })}>
                {label} <span>{markers.filter(marker => marker.group === key).length}</span>
            </button>)}
            <button className={styles.toggle[options.tint ? 'on' : 'off']} aria-pressed={options.tint}
                title="多空底色：與 ATR 防守線同源，多方段淡紅、空頭段淡綠、暖機／失效留白"
                onClick={() => onChange({ ...options, tint: !options.tint })}>
                多空底色
            </button>
            <button className={styles.toggle[options.opening ? 'on' : 'off']} aria-pressed={options.opening}
                title="黃虛線標示本時段真實開盤價與開盤 K 棒；夜盤跨午夜沿用 15:00 開盤"
                onClick={() => onChange({ ...options, opening: !options.opening })}>開盤線</button>
            <button className={styles.toggle[options.transitions ? 'on' : 'off']} aria-pressed={options.transitions}
                title="依 ATR 已收棒確認方向，紅線翻多、綠線翻空；初次確認與翻轉分開標示"
                onClick={() => onChange({ ...options, transitions: !options.transitions })}>多空變換線</button>
            <button className={styles.toggle[options.pivot ? 'on' : 'off']} aria-pressed={options.pivot}
                title="主圖疊加樞紐強勢/中間/弱勢三關卡（前一日 H/L/C＋1.382/1.618）；開盤越強做多、破弱做空"
                onClick={() => onChange({ ...options, pivot: !options.pivot })}>樞紐關卡</button>
            <button className={styles.toggle[options.levels ? 'on' : 'off']} aria-pressed={options.levels}
                title="在主圖顯示開盤五分高低、昨高低與昨收；開盤線有獨立開關"
                onClick={() => onChange({ ...options, levels: !options.levels })}>
                支撐壓力
            </button>
            <button className={styles.toggle[options.compact ? 'on' : 'off']} aria-pressed={options.compact}
                title="精簡：依圖寬自動間隔，至少 5 根；全部：顯示所有符合條件的標記"
                onClick={() => onChange({ ...options, compact: !options.compact })}>
                {options.compact ? '精簡顯示' : '全部標記'}
            </button>
            <details className={styles.help}>
                <summary>判讀說明</summary>
                <div className={styles.explanation}>
                    <p>攻／洗／量價提醒在成交量區；高低點動能提醒與大單推估在主圖。數字為目前載入資料的顯示標記數，非視窗內數量。精簡依圖寬減量，量能標記優先保留「攻」、其次「洗」；放大或切「全部標記」可看完整條件。</p>
                    <p>高點力道不足：價格到近 20 根區間高點，但 KDJ 或 MACD 動能未達同窗最強。低點動能改善：價格到區間低點，但 KDJ 或 MACD 未跟著降到同窗最弱；「改善」是與區間最低動能比較，不保證逐根回升。</p>
                    <p>高點量未跟：價格到區間高點，但成交量未達同窗最大。低點量未縮：價格到區間低點，但成交量高於同窗最小；不是說比上一根放量，也不代表賣壓耗盡。量價比較窗為近 20 根，未滿時只讀已載入資料；「攻／洗」符合時優先顯示。</p>
                    <p>這四種文字都是價格與動能／成交量不同步的提醒，不代表已反轉，也不是直接買賣訊號。只使用已收棒的原始 OHLC，切換平均 K 不改計算。動能提醒固定採 20 根比較窗、KDJ(45,9,9) 與加權 MACD(45,117,17)，至少需 153 根有效 K 棒；與可自訂參數的副圖分開計算。</p>
                    <p>大單：前 20～120 筆真實整股／期貨成交量均值 ×3，最低 5 單位；未知方向只入基準、不投買賣票。以同根 K 的合格買賣量差判斷，未收棒仍會變。換股票或交易時段重新暖機，重新整理不保留 Tick。</p>
                    <p>多空線買賣點：依 SuperTrend（ATR 週期 10、倍數 3，與 V9 預設多空趨勢線相同）翻轉，綠「買」為收盤站上軌道、由空翻多，紅「平」為收盤跌破軌道、由多翻空，代表只做多的進出場研究位置；標記落在已收棒，盤中未收棒會變，若你自訂多空線參數，標記尚未連動。</p>
                    <p>放空買賣點：同一組 SuperTrend 翻轉的做空側，紅「賣」為由多翻空（開空），綠「補」為由空翻多（回補空單）。與做多側同時開啟時，同一翻轉點會合併顯示「平·賣」（翻空：平多並開空）與「買·補」（翻多：回補空單並做多）。台股現股放空有券與平盤以下不得放空等限制，期貨方可雙向；此為研究位置、非自動訊號。</p>
                    <p>V8 多空線：55 以上紅色偏多、45 以下綠色偏空、其間黃色中性。ATR 用連續兩根確認方向，多方紅線在收盤價下方只上移、空方綠線在收盤價上方只下移；收棒觸及／穿越上一根實際防守價即失效，停止舊軌，等重新確認。多空變換線與底色讀同一 ATR：多紅、空綠，暖機／失效留白；中性分數期間原防守軌可續存。只使用已收棒，與另可開啟的 SuperTrend 買賣點分開。</p>
                    <p>開盤線：只在已取得本時段第一分鐘資料時顯示黃虛線與開盤 K 位置；資料從半途開始則顯示資料不足。期貨日盤／夜盤分開，午夜不重置夜盤開盤價。翻轉文字在圖頂，避免蓋住 K 棒。</p>
                    <p>樞紐開盤落點：用前一日 H/L/C 算中間價 M=(H+L)/2，再以黃金比例 1.382／1.618 推出強勢價與弱勢價（收盤強弱會互換係數）。盤前只看計畫，開盤後只有「越過強勢價（做多）」或「跌破弱勢價（做空）」才是順勢訊號，進 1 單位、死抱 13:25；開在中間四區於回測為負期望、不操作。「樞紐關卡」開關只在主圖疊加水平參考線，不是觸價單，也不會自動下單。</p>
                    <p>V9 共振：1 分、5 分、60 分、日 K 都使用同一 V8 多空分數（55 以上多、45 以下空，其間中性）。為避免慢速 MACD(117)剛起算就被誤認，共振需要各時框至少 117 根已載入 K 棒；資料不足會直接顯示根數，不會額外下載歷史資料。四個時框同多或同空才稱「四週期同向」。</p>
                    <p>支撐壓力：主圖可切換開盤前 5 分鐘高／低、昨高／低／收；開盤線另有獨立開關。高點類為壓力參考、低點類為支撐參考，開盤與昨收是基準位。期貨夜盤跨午夜仍算同一時段。這些是可檢核價格水平，不是觸價單或交易建議。</p>
                    <p>這是量價型態與成交方向推估，不是官方主力／法人、大戶身分或已驗證交易訊號；「洗」也不代表能辨識洗盤意圖。開關與精簡顯示不下載歷史、不觸發下單。</p>
                </div>
            </details>
        </div>
        <div className={styles.status}>
            <span>{loading ? 'K 棒載入中' : `已收棒 ${barCount} 根`}</span>
            {!loading && barCount < 153 && <span>動能提醒資料準備中 {barCount}/153</span>}
            {!loading && barCount >= 153 && !markers.some(marker => marker.group === 'divergence')
                && options.divergence && <span>高低點動能：目前無顯示提醒</span>}
            <span>{researchFlowStatus(flow)}</span>
            {lastTick && <span>末筆 {lastTick}</span>}
            <span>僅研究 · 不下單</span>
        </div>
        </div>
    </section>;
}
