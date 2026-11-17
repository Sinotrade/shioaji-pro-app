// src/components/us-intraday.tsx — 美股走勢（只畫訂閱後收到的逐筆）
//
// SDK 1.8.0b1 沒有美股歷史 ticks／K 線：線圖只有這個 App 開著、訂閱之後
// 收到的本時段（盤前／盤中／盤後）成交；換時段重新開始。虛線是前一日參考價。

import { useEffect, useState } from 'react';
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

export function UsIntraday({ contract }: { contract: ContractInfo }) {
    const key = contractLinkKey(contract);
    useQuote(key); // 確保已訂閱
    const ticks = useSessionTicks(key);
    const ref = contract.us_reference ? Number(contract.us_reference) : null;
    const path = usIntradayPath(ticks, ref);
    const last = ticks[ticks.length - 1];
    const up = last && ref ? Number(last.price) >= ref : true;

    return (
        <div className={styles.wrap} data-testid='us-intraday'>
            <div className={styles.head}>
                <span>{contract.code} 走勢{last ? `・${US_SESSION_LABEL[last.session] || ''}` : ''}</span>
                <span className={styles.note}>只含開啟後收到的逐筆，沒有歷史資料</span>
            </div>
            {path ? (
                <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' role='img' aria-label={`${contract.code} 美股走勢`}>
                    {path.refY !== null && <line x1={0} x2={W} y1={path.refY} y2={path.refY} className={styles.refLine} />}
                    <polyline points={path.points} className={up ? styles.lineUp : styles.lineDown} />
                </svg>
            ) : (
                <div className={styles.empty}>
                    {ref ? `參考 ${fmtUsPrice(contract.us_reference)}${contract.reference_date ? `（${contract.reference_date}）` : ''}・` : ''}尚無即時成交
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
