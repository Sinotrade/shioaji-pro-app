// src/components/tick-tape.tsx — time & sales feed.
// Preloads today's recent history ticks, then streams live deals on top.
// Times show full microsecond precision (HH:MM:SS.ffffff).
// Big lots (≥3× the rolling average of visible rows) are highlighted.

import { memo, useEffect, useMemo, useState } from 'react';
import { fetchLastTicks } from '../lib/kgi';
import { onAnyTick } from '../lib/stream';
import type { ContractBase } from '../lib/types/contract';
import type { HistoryTicks } from '../lib/types/tick';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { dateStrOffset } from '../lib/utils/kbars';
import * as panel from './panel.css';
import * as styles from './tick-tape.css';
import { Orb } from './orb';

const MAX_ROWS = 120;
const BIG_LOT_FACTOR = 3;

interface TapeRow {
    id: number; // monotonic — stable React key
    time: string; // HH:MM:SS.ffffff
    close: number | string;
    volume: number;
    tick_type: number; // 1=buy 2=sell 0=unknown
}

let rowSeq = 0;

// normalize to HH:MM:SS.ffffff (6 fraction digits)
function fmtTickTime(t: string): string {
    const [hms = '', frac = ''] = t.split('.');
    return `${hms}.${frac.padEnd(6, '0').slice(0, 6)}`;
}

// futures night-session ticks are filed under the NEXT trading date —
// try tomorrow first for FUT/OPT, fall back to today.
async function loadHistory(
    contract: ContractBase,
    count: number,
): Promise<HistoryTicks> {
    const isFop =
        contract.security_type === 'FUT' || contract.security_type === 'OPT';
    if (isFop) {
        try {
            const next = await fetchLastTicks(
                contract,
                count,
                dateStrOffset(-1),
            );
            if (next.datetime.length > 0) return next;
        } catch {
            // fall back to today
        }
    }
    return fetchLastTicks(contract, count);
}

const TapeRowView = memo(function TapeRowView({
    time,
    close,
    volume,
    tickType,
    big,
}: {
    time: string;
    close: number | string;
    volume: number;
    tickType: number;
    big: boolean;
}) {
    const dir = tickType === 1 ? 'up' : tickType === 2 ? 'down' : 'flat';
    return (
        <div className={big ? styles.tapeRowBig : styles.tapeRow}>
            <span className={styles.time}>{time}</span>
            <span
                className={panel.dirText[dir]}
                style={{ textAlign: 'right' }}
            >
                {fmtPrice(close)}
            </span>
            <span className={big ? styles.volBig : styles.vol}>
                {fmtInt(volume)}
            </span>
        </div>
    );
});

export function TickTape({ contract }: { contract: ContractBase }) {
    const [rows, setRows] = useState<TapeRow[]>([]);
    const [loading, setLoading] = useState(true);

    // history preload, then live stream on top
    useEffect(() => {
        let cancelled = false;
        setRows([]);
        setLoading(true);

        loadHistory(contract, MAX_ROWS)
            .then((h) => {
                if (cancelled) return;
                const hist: TapeRow[] = [];
                for (let i = h.datetime.length - 1; i >= 0; i--) {
                    const dt = h.datetime[i];
                    if (!dt) continue;
                    hist.push({
                        id: rowSeq++,
                        time: fmtTickTime(dt.slice(11)),
                        close: h.close[i] ?? 0,
                        volume: h.volume[i] ?? 0,
                        tick_type: h.tick_type[i] ?? 0,
                    });
                }
                // live rows may already have arrived — keep them on top
                setRows((live) => [...live, ...hist].slice(0, MAX_ROWS));
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        const off = onAnyTick((tick) => {
            if (tick.code !== contract.code) return;
            setRows((prev) =>
                [
                    {
                        id: rowSeq++,
                        time: fmtTickTime(tick.time),
                        close: tick.close,
                        volume: tick.volume,
                        tick_type: tick.tick_type,
                    },
                    ...prev,
                ].slice(0, MAX_ROWS),
            );
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [contract]);

    // big-lot threshold from the rolling average of visible rows
    const bigThreshold = useMemo(() => {
        if (rows.length < 10) return Infinity;
        const sum = rows.reduce((s, r) => s + r.volume, 0);
        return Math.max(5, (sum / rows.length) * BIG_LOT_FACTOR);
    }, [rows]);

    return (
        <div className={panel.panelBody}>
            <div className={styles.tape}>
                {rows.length === 0 && (
                    <span
                        className={styles.tapeRow}
                        style={{ justifyItems: 'center' }}
                    >
                        <span />
                        <span className={styles.time}>
                            {loading ? (
                                <>
                                    <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                                    載入歷史成交…
                                </>
                            ) : (
                                '今日尚無成交'
                            )}
                        </span>
                        <span />
                    </span>
                )}
                {rows.map((t) => (
                    <TapeRowView
                        key={t.id}
                        time={t.time}
                        close={t.close}
                        volume={t.volume}
                        tickType={t.tick_type}
                        big={t.volume >= bigThreshold}
                    />
                ))}
            </div>
        </div>
    );
}

