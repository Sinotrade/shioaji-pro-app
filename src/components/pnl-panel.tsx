// src/components/pnl-panel.tsx — realized P&L analytics (30 days)

import { useCallback } from 'react';
import { usePoll } from '../hooks/use-poll';
import { fetchProfitLoss } from '../lib/kgi';
import { fmtMoney, fmtSigned } from '../lib/utils/format';
import { dateStrOffset } from '../lib/utils/kbars';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';
import * as styles from './pnl-panel.css';

interface PnlRow {
    date: string;
    pnl: number;
}

async function fetchPnl(): Promise<PnlRow[]> {
    const body = {
        begin_date: dateStrOffset(30),
        end_date: dateStrOffset(0),
    };
    const [st, fu] = await Promise.allSettled([
        fetchProfitLoss('S', undefined, body.begin_date, body.end_date),
        fetchProfitLoss('F', undefined, body.begin_date, body.end_date),
    ]);
    const rows = [
        ...(st.status === 'fulfilled' ? st.value : []),
        ...(fu.status === 'fulfilled' ? fu.value : []),
    ];
    return rows
        .map((r) => ({ date: r.date, pnl: Number(r.pnl) || 0 }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

function EquityCurve({ rows }: { rows: PnlRow[] }) {
    if (rows.length < 2) return null;
    // cumulative by trade order
    const cum: number[] = [];
    let acc = 0;
    for (const r of rows) {
        acc += r.pnl;
        cum.push(acc);
    }
    const w = 100;
    const h = 36;
    const min = Math.min(0, ...cum);
    const max = Math.max(0, ...cum);
    const span = max - min || 1;
    const pts = cum
        .map(
            (v, i) =>
                `${((i / (cum.length - 1)) * w).toFixed(2)},${(h - ((v - min) / span) * h).toFixed(2)}`,
        )
        .join(' ');
    const zeroY = h - ((0 - min) / span) * h;
    const last = cum[cum.length - 1] ?? 0;
    return (
        <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio='none'
            className={styles.curve}
        >
            <line
                x1='0'
                y1={zeroY}
                x2={w}
                y2={zeroY}
                className={styles.zeroLine}
            />
            <polyline
                points={pts}
                fill='none'
                strokeWidth='1.5'
                className={last >= 0 ? styles.curveUp : styles.curveDown}
            />
        </svg>
    );
}

export function PnlPanel() {
    const { data, error } = usePoll<PnlRow[]>(
        useCallback(() => fetchPnl(), []),
        60000,
    );
    const rows = data ?? [];
    const total = rows.reduce((s, r) => s + r.pnl, 0);
    const wins = rows.filter((r) => r.pnl > 0);
    const losses = rows.filter((r) => r.pnl < 0);
    const winRate = rows.length
        ? (wins.length / rows.length) * 100
        : 0;
    const avgWin = wins.length
        ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length
        : 0;
    const avgLoss = losses.length
        ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length
        : 0;

    if (rows.length === 0) {
        return (
            <div className={dock.emptyState}>
                {error ? '損益資料無法取得' : '近 30 日無已實現損益'}
            </div>
        );
    }

    const dir = total > 0 ? 'up' : total < 0 ? 'down' : 'flat';
    return (
        <div className={panel.panelBody}>
            <div className={styles.summary}>
                <div className={styles.bigStat}>
                    <span className={styles.bigLabel}>30 日已實現損益</span>
                    <span
                        className={`${styles.bigValue} ${panel.dirText[dir]}`}
                    >
                        {fmtSigned(total, 0)}
                    </span>
                </div>
                <EquityCurve rows={rows} />
            </div>
            <div className={dock.accountGrid}>
                <div className={dock.statCard}>
                    <span className={dock.statCardLabel}>筆數 / 勝率</span>
                    <span className={dock.statCardValue}>
                        {rows.length} 筆 · {winRate.toFixed(0)}%
                    </span>
                </div>
                <div className={dock.statCard}>
                    <span className={dock.statCardLabel}>平均獲利</span>
                    <span
                        className={`${dock.statCardValue} ${panel.dirText.up}`}
                    >
                        {fmtMoney(Math.round(avgWin))}
                    </span>
                </div>
                <div className={dock.statCard}>
                    <span className={dock.statCardLabel}>平均虧損</span>
                    <span
                        className={`${dock.statCardValue} ${panel.dirText.down}`}
                    >
                        {fmtMoney(Math.round(avgLoss))}
                    </span>
                </div>
                <div className={dock.statCard}>
                    <span className={dock.statCardLabel}>賺賠比</span>
                    <span className={dock.statCardValue}>
                        {avgLoss !== 0
                            ? Math.abs(avgWin / avgLoss).toFixed(2)
                            : '—'}
                    </span>
                </div>
            </div>
        </div>
    );
}
