// src/components/ticks-table.tsx

import type { Tick } from '../lib/types/tick';
import * as styles from './ticks-table.css';

interface Props {
    ticks: Tick[];
    totalCount?: number;
}

function tickTypeClass(tickType: number): string | undefined {
    if (tickType === 1) return styles.tickTypeBuy;
    if (tickType === 2) return styles.tickTypeSell;
    return undefined;
}

function tickTypeLabel(tickType: number): string {
    if (tickType === 1) return 'Buy';
    if (tickType === 2) return 'Sell';
    return '–';
}

export function TicksTable({ ticks, totalCount }: Props) {
    if (ticks.length === 0) {
        return (
            <div className={styles.emptyCard}>
                <span className={styles.meta}>No ticks yet.</span>
            </div>
        );
    }
    const meta =
        totalCount != null
            ? `Latest ${ticks.length} of ${totalCount.toLocaleString()} ticks`
            : `${ticks.length} ticks`;
    return (
        <div className={styles.wrapper}>
            <div className={styles.meta}>{meta}</div>
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th className={styles.thLeft}>Time</th>
                        <th className={styles.th}>Price</th>
                        <th className={styles.th}>Volume</th>
                        <th className={styles.th}>Type</th>
                    </tr>
                </thead>
                <tbody>
                    {ticks.map((tick, idx) => {
                        const toneClass = tickTypeClass(tick.tick_type) ?? '';
                        return (
                            <tr key={`${tick.time}-${idx}`}>
                                <td className={styles.tdLeft}>
                                    {tick.time.slice(0, 8)}
                                </td>
                                <td className={`${styles.td} ${toneClass}`}>
                                    {tick.close}
                                </td>
                                <td className={styles.td}>{tick.volume}</td>
                                <td className={`${styles.td} ${toneClass}`}>
                                    {tickTypeLabel(tick.tick_type)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
