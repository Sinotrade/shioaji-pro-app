// src/components/us-intraday.tsx — 美股走勢
//
// 有美股歷史（SDK 1.8.0b1）時：x 軸固定一般盤 09:30–16:00（美東時間），先畫
// 最近一個交易日的 1 分 K 收盤，再接上即時一般盤逐筆。沒有歷史（舊 SDK、
// 非正式環境、盤前／盤後）時退回只畫訂閱後收到的本時段逐筆。虛線是參考價。

import { useEffect, useState } from 'react';
import { isUsHistoryUnavailable, latestUsSessionBars } from '../lib/us/us-history';
import { US_INTRADAY_H, US_INTRADAY_W, usIntradaySeries, usIntradaySessionPath, usSessionReference } from '../lib/us/us-intraday';
import type { Candle } from '../lib/types/market';
import { useQuote } from '../hooks/use-stream';
import { contractLinkKey } from '../lib/contract-key';
import type { ContractInfo } from '../lib/types/contract';
import { fmtUsPrice } from '../lib/us/decimal';
import { getUsSessionTicks, subscribeUsSessionTicks, US_SESSION_LABEL, type UsTickMeta } from '../lib/us/us-quotes';
import * as styles from './us-intraday.css';

const W = 600;
const H = 240;
const REDRAW_MS = 250;

function useSessionTicks(key: string): readonly UsTickMeta[] {
    const [ticks, setTicks] = useState(() => [...getUsSessionTicks(key)]);
    useEffect(() => {
        setTicks([...getUsSessionTicks(key)]);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = subscribeUsSessionTicks(key, () => {
            if (timer) return;
            timer = setTimeout(() => { timer = null; setTicks([...getUsSessionTicks(key)]); }, REDRAW_MS);
        });
        return () => { off(); if (timer) clearTimeout(timer); };
    }, [key]);
    return ticks;
}

export function usIntradayPath(ticks: readonly UsTickMeta[], ref: number | null) {
    const prices = ticks.map(t => Number(t.price)).filter(Number.isFinite);
    if (!prices.length) return null;
    let lo = Math.min(...prices, ...(ref ? [ref] : []));
    let hi = Math.max(...prices, ...(ref ? [ref] : []));
    if (hi === lo) { hi += 0.01; lo -= 0.01; }
    const t0 = ticks[0]!.ts;
    const span = Math.max(1, ticks[ticks.length - 1]!.ts - t0);
    const y = (p: number) => H - ((p - lo) / (hi - lo)) * (H - 12) - 6;
    const points = ticks.map(t => `${(((t.ts - t0) / span) * W).toFixed(1)},${y(Number(t.price)).toFixed(1)}`).join(' ');
    return { points, refY: ref ? y(ref) : null, lo, hi };
}

type HistoryState =
    | { kind: 'loading' }
    | { kind: 'ready'; date: string; bars: Candle[] }
    | { kind: 'none'; reason: 'empty' | 'unavailable' | 'error' };

function useUsSessionHistory(contract: ContractInfo): HistoryState {
    const [state, setState] = useState<HistoryState>({ kind: 'loading' });
    useEffect(() => {
        let cancelled = false;
        setState({ kind: 'loading' });
        latestUsSessionBars(contract)
            .then(r => { if (!cancelled) setState(r ? { kind: 'ready', ...r } : { kind: 'none', reason: 'empty' }); })
            .catch(e => { if (!cancelled) setState({ kind: 'none', reason: isUsHistoryUnavailable(e) ? 'unavailable' : 'error' }); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract.code, contract.exchange]);
    return state;
}

// 兩端與正中間（一般盤 390 分鐘的中點是 12:45），用 space-between 排
const AXIS_LABELS = ['09:30', '12:45', '16:00'];

export function UsIntraday({ contract }: { contract: ContractInfo }) {
    const key = contractLinkKey(contract);
    useQuote(key); // 確保已訂閱
    const ticks = useSessionTicks(key);
    const history = useUsSessionHistory(contract);
    const ref = contract.us_reference ? Number(contract.us_reference) : null;
    const series = usIntradaySeries(history.kind === 'ready' ? history : null, ticks);
    const sessionRef = series ? usSessionReference(ref, contract.reference_date, series.date) : ref;

    if (series) {
        const path = usIntradaySessionPath(series, sessionRef);
        const up = sessionRef ? path.last >= sessionRef : true;
        return (
            <div className={styles.wrap} data-testid='us-intraday'>
                <div className={styles.head}>
                    <span>{contract.code} 走勢・一般盤 {series.date}</span>
                    <span className={styles.note}>美東時間{series.fromHistory ? '' : '・只含開啟後收到的逐筆'}</span>
                </div>
                <svg className={styles.chart} viewBox={`0 0 ${US_INTRADAY_W} ${US_INTRADAY_H}`} preserveAspectRatio='none' role='img' aria-label={`${contract.code} 美股走勢`}>
                    {path.refY !== null && <line x1={0} x2={US_INTRADAY_W} y1={path.refY} y2={path.refY} className={styles.refLine} />}
                    <polyline points={path.points} className={up ? styles.lineUp : styles.lineDown} />
                </svg>
                <div className={styles.foot}>
                    {AXIS_LABELS.map(a => <span key={a}>{a}</span>)}
                </div>
                <div className={styles.foot}>
                    <span>低 {fmtUsPrice(String(path.lo))}</span>
                    <span>最新 {fmtUsPrice(String(path.last))}</span>
                    <span>高 {fmtUsPrice(String(path.hi))}</span>
                </div>
            </div>
        );
    }

    const path = usIntradayPath(ticks, ref);
    const last = ticks[ticks.length - 1];
    const up = last && ref ? Number(last.price) >= ref : true;
    const note = history.kind === 'loading' ? '載入歷史走勢…'
        : history.kind === 'none' && history.reason === 'unavailable' ? '這個 SDK 版本沒有美股歷史，只含開啟後收到的逐筆'
        : '只含開啟後收到的逐筆';

    return (
        <div className={styles.wrap} data-testid='us-intraday'>
            <div className={styles.head}>
                <span>{contract.code} 走勢{last ? `・${US_SESSION_LABEL[last.session] || ''}` : ''}</span>
                <span className={styles.note}>{note}</span>
            </div>
            {path ? (
                <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' role='img' aria-label={`${contract.code} 美股走勢`}>
                    {path.refY !== null && <line x1={0} x2={W} y1={path.refY} y2={path.refY} className={styles.refLine} />}
                    <polyline points={path.points} className={up ? styles.lineUp : styles.lineDown} />
                </svg>
            ) : (
                <div className={styles.empty}>
                    {ref ? `參考 ${fmtUsPrice(contract.us_reference)}${contract.reference_date ? `（${contract.reference_date}）` : ''}・` : ''}{history.kind === 'loading' ? '載入中…' : '尚無成交'}
                </div>
            )}
            {path && (
                <div className={styles.foot}>
                    <span>低 {fmtUsPrice(String(path.lo))}</span>
                    <span>最新 {fmtUsPrice(last!.price)}</span>
                    <span>高 {fmtUsPrice(String(path.hi))}</span>
                </div>
            )}
        </div>
    );
}
