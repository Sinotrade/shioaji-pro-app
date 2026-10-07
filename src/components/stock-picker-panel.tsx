// src/components/stock-picker-panel.tsx — 短線選股 TOP N（多方／空方切換）。
// 多方：排名/標的/現價/漲跌%/量比/分數/狀態/型態，過熱檔排除置底；
// 空方：鏡像邏輯，過冷檔（極端超賣）排除置底。唯讀、點列選取該股。

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
    useStockPicker,
    type PickerRow,
    type PickerSide,
} from '../hooks/use-stock-picker';
import { fmtPrice } from '../lib/utils/format';
import { V9_RESEARCH_MODE } from '../lib/workspace';
import { ResearchDailyBreakoutPanel } from './research-daily-breakout-panel';
import { DaytradePickerPanel } from './daytrade-picker-panel';
import { useDaytradePicker } from '../hooks/use-daytrade-picker';
import { StrategyLabPanel } from './strategy-lab-panel';
import * as s from './stock-picker-panel.css';

function fmtClock(ts: number) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function StockPickerPanel({ onPick }: { onPick: (code: string) => void }) {
    const [side, setSide] = useState<PickerSide>('long');
    const [view, setView] = useState<'classic' | 'daily' | 'daytrade' | 'lab'>('classic');
    const daytradeActive = V9_RESEARCH_MODE && view === 'daytrade';
    const labActive = V9_RESEARCH_MODE && view === 'lab';
    const researchScanActive = daytradeActive || labActive;
    const { rows, dailyRows, regime, loading, error, lastUpdated, refresh } =
        useStockPicker(side, !researchScanActive);
    const daytrade = useDaytradePicker(researchScanActive);

    const regimeCls = regime
        ? regime.side === 'bull'
            ? s.regimeBull
            : regime.side === 'bear'
              ? s.regimeBear
              : s.regimeNeutral
        : s.regimeNeutral;

    let rankCounter = 0;

    return (
        <div className={s.wrap}>
            <div className={s.toolbar} style={V9_RESEARCH_MODE ? { flexWrap: 'wrap' } : undefined}>
                <span className={s.title}>短線選股</span>
                <span className={s.poolCount}>{researchScanActive ? daytrade.poolSize : view === 'daily' ? dailyRows.length : rows.length} 檔</span>
                {V9_RESEARCH_MODE && <span className={s.segWrap}>
                    <button className={`${s.seg} ${view === 'classic' ? s.segActiveLong : ''}`}
                        onClick={() => setView('classic')}>原選股</button>
                    <button className={`${s.seg} ${view === 'daily' ? s.segActiveLong : ''}`}
                        onClick={() => { setSide('long'); setView('daily'); }}>日K波段</button>
                    <button className={`${s.seg} ${view === 'daytrade' ? s.segActiveLong : ''}`}
                        onClick={() => setView('daytrade')}>當沖多空10</button>
                    <button className={`${s.seg} ${view === 'lab' ? s.segActiveLong : ''}`}
                        onClick={() => setView('lab')}>策略實驗室</button>
                </span>}
                {view === 'classic' && <>
                <span className={s.segWrap}>
                    <button
                        className={`${s.seg} ${side === 'long' ? s.segActiveLong : ''}`}
                        onClick={() => setSide('long')}
                    >
                        多方
                    </button>
                    <button
                        className={`${s.seg} ${side === 'short' ? s.segActiveShort : ''}`}
                        onClick={() => setSide('short')}
                    >
                        空方
                    </button>
                </span>
                <span className={`${s.regimeBadge} ${regimeCls}`}>
                    {regime ? regime.label : '盤勢 —'}
                </span>
                </>}
                <button
                    className={s.iconBtn}
                    style={V9_RESEARCH_MODE ? { flexShrink: 0 } : undefined}
                    title="重新整理"
                    onClick={researchScanActive ? daytrade.refresh : refresh}
                    disabled={researchScanActive && daytrade.loading}
                >
                    <RefreshCw size={13} className={(researchScanActive ? daytrade.loading : loading) ? s.spinning : ''} />
                </button>
            </div>

            {researchScanActive && <div className={s.updatedAt} role={daytrade.recordingError ? 'alert' : 'status'}>
                {daytrade.recordingError ?? (daytrade.recording ? '策略日誌保存中…' : daytrade.lastRecordedAt
                    ? `策略日誌已保存 ${fmtClock(daytrade.lastRecordedAt)} · 本頁開啟期間每次完成掃描均記錄`
                    : '策略日誌等待首次掃描完成 · 儲存在本機瀏覽器，請定期匯出備份')}
            </div>}
            {labActive ? <StrategyLabPanel recording={daytrade.loading || daytrade.recording}
                recordingError={daytrade.recordingError} onRecordNow={daytrade.refresh} onPick={onPick} />
                : daytradeActive ? <DaytradePickerPanel {...daytrade} onRefresh={daytrade.refresh} onPick={onPick} /> : view === 'daily' && V9_RESEARCH_MODE ? <ResearchDailyBreakoutPanel
                rows={dailyRows} loading={loading} error={error} onPick={onPick} /> : <>
            {lastUpdated && (
                <div className={s.updatedAt}>
                    最後更新 {fmtClock(lastUpdated)}
                    {regime ? `　大盤 RSI ${regime.rsi.toFixed(0)}` : ''}
                </div>
            )}

            {loading && rows.length === 0 ? (
                <div className={s.stateBox}>
                    <RefreshCw size={18} className={s.spinning} />
                    掃描自選＋{side === 'long' ? '漲量' : '跌量'}前 40、評估中…
                </div>
            ) : error && rows.length === 0 ? (
                <div className={s.stateBox}>選股載入失敗：{error}</div>
            ) : (
                <div className={s.scroll}>
                    <div className={s.head}>
                        <span>TOP</span>
                        <span>標的</span>
                        <span style={{ textAlign: 'right' }}>現價</span>
                        <span style={{ textAlign: 'right' }}>漲跌%</span>
                        <span style={{ textAlign: 'right' }}>量比</span>
                        <span style={{ textAlign: 'right' }}>分數</span>
                        <span style={{ textAlign: 'center' }}>狀態</span>
                        <span>型態</span>
                    </div>

                    {rows.map((r: PickerRow) => {
                        const excluded = r.score.excluded;
                        if (!excluded) rankCounter++;
                        const rankNum = excluded ? null : rankCounter;
                        const rankCls =
                            rankNum === 1
                                ? s.rank1
                                : rankNum !== null && rankNum <= 5
                                  ? side === 'long'
                                      ? s.rankTop
                                      : s.rankTopShort
                                  : s.rank;
                        const scoreCls = excluded
                            ? s.scoreCell
                            : r.score.score >= 75
                              ? side === 'long'
                                  ? s.scoreHot
                                  : s.scoreHotShort
                              : r.score.score >= 60
                                ? s.scoreWarm
                                : s.scoreCell;
                        const chgCls = r.changeRate >= 0 ? s.upTxt : s.downTxt;
                        const statusCls = excluded
                            ? s.statusExcl
                            : r.score.status === '強轉'
                              ? s.statusStrong
                              : r.score.status === '弱轉'
                                ? s.statusStrongShort
                                : r.score.status === '蓄勢'
                                  ? s.statusBuild
                                  : s.statusWait;
                        return (
                            <div
                                key={r.contract.code}
                                className={`${s.row} ${excluded ? s.rowExcluded : ''}`}
                                onClick={() => onPick(r.contract.code)}
                                title={
                                    excluded
                                        ? (side === 'long' ? '過熱' : '過冷') +
                                          '排除：' +
                                          r.score.excludeReasons.join('、')
                                        : r.score.pattern
                                }
                            >
                                <span className={`${s.rank} ${rankCls}`}>
                                    {rankNum ?? '—'}
                                </span>
                                <span className={s.nameCell}>
                                    <span className={s.codeTxt}>
                                        {r.contract.code}
                                    </span>
                                    <span className={s.nameTxt}>
                                        {r.contract.name}
                                    </span>
                                </span>
                                <span className={s.num}>{fmtPrice(r.price)}</span>
                                <span className={`${s.num} ${chgCls}`}>
                                    {r.changeRate >= 0 ? '+' : ''}
                                    {r.changeRate.toFixed(2)}
                                </span>
                                <span
                                    className={`${s.num} ${r.volumeRatio >= 1.5 ? s.volHot : ''}`}
                                >
                                    {r.volumeRatio.toFixed(2)}
                                </span>
                                <span className={`${s.scoreCell} ${scoreCls}`}>
                                    {excluded
                                        ? side === 'long'
                                            ? '過熱'
                                            : '過冷'
                                        : r.score.score}
                                </span>
                                <span className={`${s.statusCell} ${statusCls}`}>
                                    {excluded ? '排除' : r.score.status}
                                </span>
                                <span className={s.patternCell}>
                                    {r.score.pattern}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
            </>}
        </div>
    );
}
