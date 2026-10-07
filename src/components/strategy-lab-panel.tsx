import { Component, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useStrategyJournal } from '../hooks/use-strategy-journal';
import { compareStrategyFrames } from '../lib/strategy-replay';
import {
    DEFAULT_STRATEGY_SETTINGS,
    type ReplayPortfolio, type StrategyDecision, type StrategyFrame, type StrategySettings,
} from '../lib/strategy-lab-types';
import type { DaytradeInput, DaytradeResult } from '../lib/daytrade-picker';
import * as s from './strategy-lab-panel.css';

export interface StrategyLabPanelProps {
    onPick?: (code: string) => void;
    recording: boolean;
    recordingError: string | null;
    onRecordNow: () => void;
}

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const COST_FIELDS = [
    ['feeBps', '單邊手續費（基點）', 1000],
    ['taxBps', '賣出交易稅（基點）', 1000],
    ['slippageBps', '單邊滑價（基點）', 1000],
    ['minFeeTwd', '每筆最低手續費（元）', 10000],
] as const;
type CostField = typeof COST_FIELDS[number][0];
type CostDraft = Record<CostField, string>;
const initialDraft = (): CostDraft => Object.fromEntries(COST_FIELDS.map(([key]) => [key, String(DEFAULT_STRATEGY_SETTINGS[key])])) as CostDraft;
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const number = (value: number, digits = 2) => Number.isFinite(value) ? value.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
function clock(value: number | string | undefined): string {
    if (value === undefined) return '未記錄';
    const normalized = typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
        ? `${value.replace(' ', 'T')}+08:00` : value;
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) return '時間無效';
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
}

function settingsFromDraft(candidateRvol: StrategySettings['candidateRvol'], draft: CostDraft): { value: StrategySettings | null; error: string | null } {
    const values = {} as Record<CostField, number>;
    for (const [key, label, max] of COST_FIELDS) {
        const value = draft[key].trim() === '' ? NaN : Number(draft[key]);
        if (!Number.isFinite(value) || value < 0 || value > max) {
            return { value: null, error: `${label}須為 0～${max} 的有限數值；設定無效時停止比較。` };
        }
        values[key] = value;
    }
    return { value: { candidateRvol, ...values }, error: null };
}

function decisionFor(result: DaytradeResult, code: string): StrategyDecision {
    const confirmed = [...result.long, ...result.short].find(row => row.contract.code === code);
    if (confirmed) return { code, kind: 'confirmed', side: confirmed.side, reasons: confirmed.reasons };
    const observation = [...result.observationsLong, ...result.observationsShort].find(row => row.contract.code === code);
    const excluded = result.excluded.find(row => row.code === code);
    if (observation) return { code, kind: 'observation', side: observation.side,
        reasons: [...new Set([...observation.reasons, ...(excluded?.reasons ?? [])])] };
    return { code, kind: 'excluded', reasons: excluded?.reasons ?? ['未出現在確認或觀察名單，請核對完整輸入。'] };
}
function decisionLabel(decision: StrategyDecision | undefined) {
    if (!decision) return '原始判斷未記錄';
    const kind = { confirmed: '盤中條件已確認', observation: '前日觀察', excluded: '排除／等待' }[decision.kind];
    return `${kind}${decision.side ? ` · ${decision.side === 'long' ? '多方' : '空方'}` : ''}`;
}
function DecisionDetail({ label, decision }: { label: string; decision: StrategyDecision | undefined }) {
    return <div className={s.status}>
        <span>{label}：{decisionLabel(decision)}</span>
        <ul className={s.reasons}>{(decision?.reasons.length ? decision.reasons : ['尚無記錄原因']).map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    </div>;
}

function StockDecision({ input, frame, baseline, candidate, onPick }: {
    input: DaytradeInput; frame: StrategyFrame; baseline: DaytradeResult; candidate: DaytradeResult;
    onPick?: (code: string) => void;
}) {
    const code = input.contract.code;
    const original = frame.decisions.find(decision => decision.code === code);
    const before = decisionFor(baseline, code);
    const after = decisionFor(candidate, code);
    const changed = before.kind !== after.kind || before.side !== after.side
        || before.reasons.join('\n') !== after.reasons.join('\n');
    return <div className={s.row} data-strategy-code={code}>
        <button className={s.stockButton} onClick={() => onPick?.(code)} aria-label={`研究 ${code} ${input.contract.name}`}>
            {code} {input.contract.name}
        </button>
        <div className={s.tiny}>資格資料日 {input.contract.update_date || '未記錄'} · 行情 {clock(input.snapshot?.datetime)}</div>
        <div className={s.tiny}>當時日K {input.daily.length} 根 · 分鐘K {input.minutes.length} 根 · 券源時間 {clock(input.shortSource?.datetime)}</div>
        <div className={changed ? s.difference : s.status}>基準：{decisionLabel(before)} → 候選：{decisionLabel(after)}{changed ? '（判斷或原因有差異）' : '（一致）'}</div>
        <details className={s.details}>
            <summary className={s.summary}>原始與重算原因</summary>
            <DecisionDetail label='原始掃描' decision={original} />
            <DecisionDetail label='基準 RVOL 1.5' decision={before} />
            <DecisionDetail label='候選' decision={after} />
        </details>
    </div>;
}

function PortfolioCard({ title, portfolio }: { title: string; portfolio: ReplayPortfolio }) {
    return <section className={s.card} aria-label={title}>
        <h4 className={s.heading}>{title}</h4>
        <dl className={s.metrics}>
            <dt className={s.term}>已平倉模擬交易</dt><dd className={s.value}>{portfolio.trades.length} 筆</dd>
            <dt className={s.term}>已實現淨損益</dt><dd className={s.value}>{number(portfolio.netPnl)} 元</dd>
            <dt className={s.term}>已平倉總成本</dt><dd className={s.value}>{number(portfolio.totalCosts)} 元</dd>
            <dt className={s.term}>已平倉勝率</dt><dd className={s.value}>{portfolio.winRate === null ? '無已平倉樣本' : `${number(portfolio.winRate)}%`}</dd>
            <dt className={s.term}>最大已實現回撤</dt><dd className={s.value}>{number(portfolio.maxRealizedDrawdown)} 元</dd>
            <dt className={s.term}>未平倉／待成交</dt><dd className={s.value}>{portfolio.openPositions.length}／{portfolio.pendingCount}</dd>
            <dt className={s.term}>跳過不可成交報價</dt><dd className={s.value}>{portfolio.skippedFills}</dd>
        </dl>
        <p className={s.tiny}>總成本含已平倉交易的費用、稅與滑價折算；滑價已反映在成交價，不重複扣除。回撤僅按已平倉累積損益，不含未實現風險。</p>
        <details className={s.details}>
            <summary className={s.summary}>逐筆模擬交易與未平倉</summary>
            {portfolio.trades.length === 0 && <p className={s.note}>尚無完成的模擬交易。</p>}
            {portfolio.trades.map((trade, index) => <div className={s.row} key={`${trade.code}-${trade.entryAt}-${index}`}>
                <strong>{trade.code} {trade.name} · {trade.side === 'long' ? '多' : '空'} · {trade.quantity} 股</strong>
                <div className={s.tiny}>研究確認 {clock(trade.signalAt)}</div>
                <div className={s.tiny}>進 {clock(trade.entryAt)}／{number(trade.entryPrice)} → 出 {clock(trade.exitAt)}／{number(trade.exitPrice)}</div>
                <div className={s.tiny}>手續費 {number(trade.fees)} · 交易稅 {number(trade.tax)} · 淨損益 {number(trade.netPnl)} 元（{number(trade.returnPct)}%）</div>
                <div className={s.tiny}>出場原因：{trade.exitReason}</div>
            </div>)}
            {portfolio.openPositions.map((position, index) => <div className={s.row} key={`${position.code}-${position.entryAt}-${index}`}>
                <strong>未平倉：{position.code} {position.name} · {position.side === 'long' ? '多' : '空'} · {position.quantity} 股</strong>
                <div className={s.tiny}>進 {clock(position.entryAt)}／{number(position.entryPrice)}；不以區間結尾假造平倉。</div>
            </div>)}
            {portfolio.pendingCount > 0 && <p className={s.note}>{portfolio.pendingCount} 筆研究確認仍在等待下一筆可用新報價，不視為已成交。</p>}
        </details>
    </section>;
}

function StrategyLabBody({ onPick, recording, recordingError, onRecordNow }: StrategyLabPanelProps) {
    const journal = useStrategyJournal();
    const [sourceKey, setSourceKey] = useState('');
    const [selection, setSelection] = useState<{ source: string; ids: string[] } | null>(null);
    const [frames, setFrames] = useState<StrategyFrame[]>([]);
    const [cursor, setCursor] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [fullInterval, setFullInterval] = useState(false);
    const [candidateRvol, setCandidateRvol] = useState<StrategySettings['candidateRvol']>(DEFAULT_STRATEGY_SETTINGS.candidateRvol);
    const [draft, setDraft] = useState<CostDraft>(initialDraft);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const loadGeneration = useRef(0);
    useEffect(() => () => { loadGeneration.current++; }, []);
    const sources = useMemo(() => [...new Set(journal.summaries.map(row => row.sourceKey))], [journal.summaries]);
    const source = sourceKey || sources[0] || '';
    const sourceRows = useMemo(() => journal.summaries.filter(row => row.sourceKey === source), [journal.summaries, source]);
    const ids = useMemo(() => selection?.source === source ? selection.ids : sourceRows.map(row => row.id), [selection, sourceRows, source]);
    const selected = useMemo(() => new Set(ids), [ids]);
    const settings = useMemo(() => settingsFromDraft(candidateRvol, draft), [candidateRvol, draft]);
    const safeCursor = Math.min(Math.max(0, cursor), Math.max(0, frames.length - 1));
    const current = frames[safeCursor];
    const comparison = useMemo(() => {
        if (!frames.length || !settings.value) return { value: null, error: null };
        try {
            return { value: compareStrategyFrames(fullInterval ? frames : frames.slice(0, safeCursor + 1), settings.value), error: null };
        } catch (reason) { return { value: null, error: message(reason) }; }
    }, [frames, settings, fullInterval, safeCursor]);
    const currentComparison = comparison.value?.frames[safeCursor];
    useEffect(() => {
        if (!playing || !frames.length || comparison.error || !settings.value) return;
        if (safeCursor >= frames.length - 1) { setPlaying(false); return; }
        const timer = globalThis.setTimeout(() => setCursor(value => value + 1), 1000);
        return () => globalThis.clearTimeout(timer);
    }, [playing, frames.length, safeCursor, comparison.error, settings.value]);
    const move = (value: number) => {
        if (!Number.isFinite(value)) { setActionError('回放位置無效，請重新選擇。'); return; }
        setPlaying(false); setFullInterval(false);
        setCursor(Math.min(Math.max(0, Math.floor(value)), Math.max(0, frames.length - 1)));
    };
    const changeSource = (value: string) => {
        loadGeneration.current++;
        setSourceKey(value); setSelection(null); setFrames([]); setCursor(0);
        setPlaying(false); setFullInterval(false); setBusy(false); setActionError(null); setStatus(null);
    };
    const loadSelected = async () => {
        const generation = ++loadGeneration.current;
        setBusy(true); setPlaying(false); setActionError(null); setStatus(null);
        try {
            const next = await journal.load(ids);
            if (loadGeneration.current !== generation) return;
            if (next.some(frame => frame.sourceKey !== source)) throw new Error('載入的日誌來源不符，已停止回放。');
            setFrames(next); setCursor(0); setFullInterval(false); setSelection({ source, ids: [...ids] });
            setStatus(`已依時間先後載入 ${next.length} 筆；從第一筆開始，不預先使用後續結果。`);
        } catch (reason) {
            if (loadGeneration.current === generation) { setFrames([]); setActionError(`回放載入失敗：${message(reason)}`); }
        } finally { if (loadGeneration.current === generation) setBusy(false); }
    };
    const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const target = event.currentTarget;
        const file = target.files?.[0];
        if (!file) return;
        setBusy(true); setActionError(null); setStatus(null);
        try {
            if (file.size > MAX_IMPORT_BYTES) throw new Error('檔案超過 50 MiB，未讀取或寫入日誌。');
            const count = await journal.importJson(await file.text());
            setStatus(`匯入完成：新增 ${count} 筆，已存在且相同的紀錄不重複寫入。`);
        } catch (reason) { setActionError(`匯入失敗：${message(reason)}`); }
        finally { setBusy(false); target.value = ''; }
    };
    const exportSelected = async () => {
        setBusy(true); setActionError(null); setStatus(null);
        try {
            const text = await journal.exportJson(ids);
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url; link.download = `v9-strategy-journal-${new Date().toISOString().slice(0, 10)}.json`;
            try { document.body.appendChild(link); link.click(); }
            finally { link.remove(); globalThis.setTimeout(() => URL.revokeObjectURL(url), 0); }
            setStatus(`已建立 ${ids.length} 筆日誌的 JSON 下載；請保留備份。`);
        } catch (reason) { setActionError(`匯出失敗：${message(reason)}`); }
        finally { setBusy(false); }
    };
    const recordNow = () => {
        try { onRecordNow(); } catch (reason) { setActionError(`記錄請求失敗：${message(reason)}`); }
    };

    return <div className={s.root}>
        <div className={s.toolbar}>
            <h3 className={s.title}>策略實驗室</h3>
            <span className={s.badge}>僅研究，不下單</span>
            <button className={s.recordButton} disabled={recording} onClick={recordNow}>{recording ? '掃描記錄中…' : '記錄一次'}</button>
        </div>
        <div className={s.body}>
            <p className={s.note}>將真正完成的掃描保存在此瀏覽器；回放的是當時已知資料，不是用今日資格或券源回填歷史。沒有自動升級策略或下單功能。</p>
            <p className={s.tiny}>開啟當沖多空10或本頁時，共用同一個掃描流程；「記錄一次」不另開一套資料下載。關閉後不在背景新增掃描。</p>
            {recordingError && <p className={s.warning} role='alert'>日誌記錄失敗：{recordingError}。本次資料未確認持久保存。</p>}
            {journal.error && <div className={s.warning} role='alert'>本機日誌讀取失敗：{journal.error}<button className={s.button} onClick={() => { void journal.refresh(); }}>重試讀取</button></div>}
            {actionError && <p className={s.warning} role='alert'>{actionError}</p>}
            {status && <p className={s.notice} role='status'>{status}</p>}
            {journal.loading && <p className={s.note} role='status'>讀取本機持久化日誌中…</p>}
            {!journal.loading && !journal.summaries.length && <p className={s.notice}>請開啟當沖多空10或按記錄一次以累積真正掃描日誌；回放限已記錄掃描。</p>}

            <section className={s.section} aria-label='掃描日誌'>
                <h4 className={s.heading}>1. 選擇來源與掃描日誌</h4>
                <label className={s.field}>資料來源（不可混合）
                    <select className={s.input} aria-label='日誌資料來源' value={source} disabled={!sources.length || busy} onChange={event => changeSource(event.target.value)}>
                        {!sources.length && <option value=''>尚無日誌</option>}
                        {sources.map(key => <option key={key} value={key}>{key} · {journal.summaries.filter(row => row.sourceKey === key).length} 筆</option>)}
                    </select>
                </label>
                <p className={s.note}>來源 {source || '未記錄'} · 本來源 {sourceRows.length} 筆，已選 {ids.length} 筆。新日誌不會改寫正在回放的已載入區間。</p>
                <div className={s.actions}>
                    <button className={s.button} disabled={!sourceRows.length || busy} onClick={() => setSelection({ source, ids: sourceRows.map(row => row.id) })}>選取本來源全部</button>
                    <button className={s.button} disabled={!ids.length || busy} onClick={() => setSelection({ source, ids: [] })}>取消全選</button>
                </div>
                {sourceRows.length > 0 && <div className={s.journal}>
                    {sourceRows.map(row => <label className={s.journalRow} key={row.id}>
                        <input type='checkbox' aria-label={`選取日誌 ${row.id}`} checked={selected.has(row.id)} disabled={busy}
                            onChange={event => setSelection({ source, ids: event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id) })} />
                        <span className={s.journalText}><span>{clock(row.capturedAt)} · {row.poolSize} 檔</span>
                            <span className={s.tiny}>{row.id}</span>
                            {row.warnings.length > 0 && <span className={s.difference}>{row.warnings.join('；')}</span>}
                        </span>
                    </label>)}
                </div>}
                <div className={s.actions}>
                    <button className={s.button} disabled={!ids.length || busy} onClick={() => { void loadSelected(); }}>載入所選回放</button>
                    <button className={s.button} disabled={!ids.length || busy} onClick={() => { void exportSelected(); }}>匯出所選 JSON</button>
                </div>
                <details className={s.details}>
                    <summary className={s.summary}>匯入日誌 JSON</summary>
                    <p className={s.note}>只接收本功能的資料格式，最多 50 MiB；驗證通過後才保存，不執行檔案內程式碼。日誌含選股池與研究行情，分享前請自行核對。</p>
                    <label className={s.field}>選擇日誌檔案<input className={s.file} type='file' accept='.json,application/json' aria-label='匯入日誌 JSON' disabled={busy} onChange={event => { void importFile(event); }} /></label>
                </details>
            </section>

            <section className={s.section} aria-label='比較設定'>
                <h4 className={s.heading}>2. 比較設定</h4>
                <div className={s.fields}>
                    <label className={s.field}>候選同時段 RVOL 門檻<select className={s.input} aria-label='候選 RVOL' value={candidateRvol} onChange={event => {
                        const next = Number(event.target.value);
                        if (next === 1.5 || next === 2 || next === 2.5) { setCandidateRvol(next); setPlaying(false); }
                        else setActionError('不支援的 RVOL 門檻，已保留原設定。');
                    }}>{[1.5, 2, 2.5].map(value => <option value={value} key={value}>{value} 倍</option>)}</select></label>
                    {COST_FIELDS.map(([key, label, max]) => <label className={s.field} key={key}>{label}<input className={s.input} type='number'
                        aria-label={label} min={0} max={max} step='any' value={draft[key]} onChange={event => { setDraft(old => ({ ...old, [key]: event.target.value })); setPlaying(false); }} /></label>)}
                </div>
                <p className={s.note}>基準固定 RVOL 1.5，其餘研究條件相同。成本兩組一致；1 基點＝0.01%，預設僅是假設，非券商報價或稅率確認。最低費按每次成交計；滑價反映在模擬成交價。</p>
                {settings.error && <p className={s.warning} role='alert'>{settings.error}</p>}
            </section>

            <section className={s.section} aria-label='歷史掃描回放'>
                <h4 className={s.heading}>3. 逐筆回放與比較</h4>
                {!current && <p className={s.note}>請選擇同一來源的日誌並載入回放。這裡不會自動下載或重建未曾記錄的歷史。</p>}
                {current && <>
                    <p className={s.note}>載入區間 {clock(frames[0]!.capturedAt)} ～ {clock(frames.at(-1)!.capturedAt)} · {frames.length} 筆（台北時間）</p>
                    <div className={s.actions}>
                        <button className={s.button} disabled={safeCursor === 0} onClick={() => move(safeCursor - 1)}>上一筆</button>
                        <button className={s.button} disabled={frames.length < 2 || !settings.value || !!comparison.error} onClick={() => {
                            setFullInterval(false);
                            if (!playing && safeCursor >= frames.length - 1) setCursor(0);
                            setPlaying(value => !value);
                        }}>{playing ? '暫停' : '播放'}</button>
                        <button className={s.button} disabled={safeCursor >= frames.length - 1} onClick={() => move(safeCursor + 1)}>下一筆</button>
                    </div>
                    <input className={s.slider} type='range' aria-label='回放位置' aria-valuetext={`第 ${safeCursor + 1} 筆 ${clock(current.capturedAt)}`}
                        min={0} max={Math.max(0, frames.length - 1)} step={1} value={safeCursor} onChange={event => move(Number(event.target.value))} />
                    <p className={s.notice} data-time={current.capturedAt} data-replay-time={current.capturedAt}>目前第 {safeCursor + 1}／{frames.length} 筆 · {clock(current.capturedAt)} · 池內 {current.poolCodes.length} 檔</p>
                    <p className={s.tiny}>來源 {current.sourceKey} · 版本 {current.engineVersion} · 日誌 {current.id}</p>
                    {current.warnings.length > 0 && <p className={s.warning}>當時資料警示：{current.warnings.join('；')}</p>}
                    <div className={s.actions}>
                        <button className={s.button} disabled={!settings.value || fullInterval} onClick={() => { setPlaying(false); setFullInterval(true); }}>全區間比較</button>
                        {fullInterval && <button className={s.button} onClick={() => setFullInterval(false)}>回到游標以前</button>}
                    </div>
                    <p className={fullInterval ? s.warning : s.note} data-comparison-scope={fullInterval ? 'full' : 'cursor'}>
                        {fullInterval ? '全區間結果（包含目前游標之後的日誌）' : '僅計算第一筆到目前游標，未使用後續日誌'}：
                        {clock(frames[0]!.capturedAt)} ～ {clock((fullInterval ? frames.at(-1)! : current).capturedAt)}
                    </p>
                    {comparison.error && <p className={s.warning} role='alert'>比較已停止：{comparison.error}。請檢查日誌或設定，不沿用舊結果。</p>}
                    {comparison.value && <>
                        <div className={s.cards}><PortfolioCard title='基準 · RVOL 1.5' portfolio={comparison.value.baseline} /><PortfolioCard title={`候選 · RVOL ${candidateRvol}`} portfolio={comparison.value.candidate} /></div>
                        {comparison.value.warnings.map((warning, index) => <p className={s.warning} key={index}>{warning}</p>)}
                    </>}
                    {currentComparison && <div className={s.section}>
                        <h4 className={s.heading}>目前這筆：候選相對基準的確認名單差異</h4>
                        <p className={s.difference}>新增多方 {currentComparison.addedLong.join('、') || '無'} · 移除多方 {currentComparison.removedLong.join('、') || '無'}<br />新增空方 {currentComparison.addedShort.join('、') || '無'} · 移除空方 {currentComparison.removedShort.join('、') || '無'}</p>
                        <p className={s.note}>逐檔列出原始判斷、基準與候選的確認／觀察／排除原因；沒有資料的股票不補成合格候選。</p>
                        {current.inputs.map(input => <StockDecision key={`${input.contract.exchange}:${input.contract.code}`} input={input} frame={current}
                            baseline={currentComparison.baseline} candidate={currentComparison.candidate} onPick={onPick} />)}
                    </div>}
                </>}
                <p className={s.note}>模擬結果僅反映已記錄的掃描頻率、選股池和成交假設；不代表逐筆市場成交或實證績效。未平倉、漏行情、券源與流動性限制，仍須獨立核對。</p>
            </section>
        </div>
    </div>;
}

class LabErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
    state: { error: string | null } = { error: null };
    static getDerivedStateFromError(error: unknown) { return { error: message(error) }; }
    render() {
        if (this.state.error) return <div className={s.warning} role='alert'>策略實驗室顯示已停止：{this.state.error}。已保存日誌不受影響。
            <button className={s.button} onClick={() => this.setState({ error: null })}>重新開啟實驗室</button>
        </div>;
        return this.props.children;
    }
}

export function StrategyLabPanel(props: StrategyLabPanelProps) {
    return <LabErrorBoundary><StrategyLabBody {...props} /></LabErrorBoundary>;
}
