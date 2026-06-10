// src/components/contract-card.tsx

import type { ContractInfo } from '../lib/types/contract';
import * as styles from './contract-card.css';

export function ContractCard({ data }: { data: ContractInfo }) {
    return (
        <div className={styles.card}>
            <div className={styles.row}>
                <span className={styles.label}>Code</span>
                <span className={styles.value}>
                    {data.code} · {data.name}
                </span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>Security type</span>
                <span className={styles.value}>
                    {data.security_type ?? '–'}
                </span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>Exchange</span>
                <span className={styles.value}>{data.exchange ?? '–'}</span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>Reference</span>
                <span className={styles.value}>{data.reference}</span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>Limit up / down</span>
                <span className={styles.value}>
                    {data.limit_up} / {data.limit_down}
                </span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>Day trade</span>
                <span className={styles.value}>{data.day_trade || '–'}</span>
            </div>
        </div>
    );
}
