// src/components/option-expiry-picker.tsx — T 字報價的到期契約選擇器（issue #152）
//
// 依到期日排序的橫向標籤列、依月份分組；每個標籤顯示 MM/DD、種類
// （月／週三／週五）與剩餘天數。太多時橫向捲動，窄面板與獨立視窗
// 都只佔一列；選取的標籤會自動捲入可見範圍。還有標籤在可視範圍外時，
// 該側邊緣淡出，提示可橫向捲動。

import { useEffect, useRef, useState } from 'react';
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
    const stripRef = useRef<HTMLDivElement | null>(null);
    const [fade, setFade] = useState<'none' | 'start' | 'end' | 'both'>('none');

    useEffect(() => {
        const el = stripRef.current;
        if (!el) return;
        const update = () => {
            const before = el.scrollLeft > 1;
            const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
            setFade(before && after ? 'both' : before ? 'start' : after ? 'end' : 'none');
        };
        update();
        el.addEventListener('scroll', update, { passive: true });
        const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
        ro?.observe(el);
        return () => {
            el.removeEventListener('scroll', update);
            ro?.disconnect();
        };
    }, [expiries]);

    useEffect(() => {
        selectedRef.current?.scrollIntoView?.({
            block: 'nearest',
            inline: 'nearest',
        });
    }, [value]);

    return (
        <div
            ref={stripRef}
            className={styles.strip}
            data-fade={fade}
            role="radiogroup"
            aria-label="到期契約"
        >
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
                                <span
                                    className={styles.date[e.shiftedFrom === null ? 'normal' : 'shifted']}
                                    data-shifted={e.shiftedFrom !== null || undefined}
                                >
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
