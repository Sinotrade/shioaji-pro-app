// src/components/option-expiry-picker.tsx — T 字報價的到期契約選擇器（issue #152）
//
// 依到期日排序的橫向標籤列、依月份分組；每個標籤顯示 MM/DD、種類
// （月／週三／週五）與剩餘天數。太多時橫向捲動，窄面板與獨立視窗
// 都只佔一列；選取的標籤會自動捲入可見範圍。

import { useEffect, useRef } from 'react';
import {
    daysLeftLabel,
    expiryTitle,
    groupByMonth,
    KIND_LABEL,
    type OptionExpiry,
} from '../lib/option-expiry';
import * as styles from './option-expiry-picker.css';

export function OptionExpiryPicker({
    expiries,
    value,
    onChange,
}: {
    expiries: OptionExpiry[];
    value: string;
    onChange: (key: string) => void;
}) {
    const selectedRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        selectedRef.current?.scrollIntoView?.({
            block: 'nearest',
            inline: 'nearest',
        });
    }, [value]);

    return (
        <div className={styles.strip} role="radiogroup" aria-label="到期契約">
            {groupByMonth(expiries).map((g, i, all) => (
                <div
                    key={g.month}
                    className={styles.group}
                    role="group"
                    aria-label={`${g.month.slice(0, 4)}年${Number(g.month.slice(4))}月`}
                >
                    <span className={styles.monthLabel} aria-hidden>
                        {i > 0 && g.month.slice(0, 4) !== all[0]!.month.slice(0, 4)
                            ? `${g.month.slice(2, 4)}年`
                            : ''}
                        {Number(g.month.slice(4))}月
                    </span>
                    {g.items.map((e) => {
                        const on = e.key === value;
                        return (
                            <button
                                key={e.key}
                                ref={on ? selectedRef : undefined}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                data-expiry={e.key}
                                title={expiryTitle(e)}
                                className={styles.chip[on ? 'on' : 'off']}
                                onClick={() => onChange(e.key)}
                            >
                                <span className={styles.date}>
                                    {e.date.slice(5, 7)}/{e.date.slice(8, 10)}
                                </span>
                                <span className={styles.kind[e.kind === 'monthly' ? 'monthly' : 'weekly']}>
                                    {KIND_LABEL[e.kind]}
                                </span>
                                <span className={styles.days}>
                                    {daysLeftLabel(e.daysLeft)}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
