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
import * as s from './stock-picker-panel.css';

function fmtClock(ts: number) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function StockPickerPanel({ onPick }: { onPick: (code: string) => void }) {
    const [side, setSide] = useState<PickerSide>('long');
    const { rows, regime, loading, error, lastUpdated, refresh } =
        useStockPicker(side);

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
            <div className={s.toolbar}>
                <span className={s.title}>短線選股</span>
                <span className={s.poolCount}>{rows.length} 檔</span>
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
                <button
                    className={s.iconBtn}
                    title="重新整理"
                    onClick={refresh}
                >
                    <RefreshCw size={13} className={loading ? s.spinning : ''} />
                </button>
            </div>

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
        </div>
    );
}
