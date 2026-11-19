// src/components/us-tick-tape.tsx — 美股成交明細
//
// 先載入最近一個交易日的最後 N 筆歷史成交（SDK 1.8.0b1；只有一般盤，含收盤
// 競價），再把即時逐筆（盤前／盤中／盤後）疊在上面。時間是美東時間。
// SDK 沒有美股歷史時只顯示開啟後收到的逐筆。

import { memo, useEffect, useMemo, useState } from 'react';
import { contractLinkKey } from '../lib/contract-key';
import { retainQuote } from '../lib/quote-ownership';
import { onAnyTick } from '../lib/stream';
import type { ContractInfo } from '../lib/types/contract';
import { fmtUsPrice } from '../lib/us/decimal';
import { fetchUsTicks, isUsHistoryUnavailable, nyDateStr, type UsHistoryTick } from '../lib/us/us-history';
import { fmtInt } from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as styles from './tick-tape.css';

const MAX_ROWS = 120;
const BIG_LOT_FACTOR = 3;

interface UsTapeRow {
    id: number;
    time: string;
    price: string;
    volume: number;
    tickType: number;
}

let rowSeq = 0;

function fmtTime(t: string): string {
    const [hms = '', frac = ''] = t.split('.');
    return `${hms}.${frac.padEnd(6, '0').slice(0, 6)}`;
}

/** 歷史列（時間遞增）→ 明細列（新的在上） */
export function usTapeRowsFromHistory(ticks: readonly UsHistoryTick[], max = MAX_ROWS): UsTapeRow[] {
    const out: UsTapeRow[] = [];
    for (let i = ticks.length - 1; i >= 0 && out.length < max; i--) {
        const t = ticks[i]!;
        out.push({ id: rowSeq++, time: fmtTime(t.time), price: String(t.price), volume: t.volume, tickType: t.tickType });
    }
    return out;
}

/** 從美東今天往前找最近一個有成交的交易日（跳過週末，最多 6 天） */
async function loadUsHistory(contract: ContractInfo, count: number): Promise<UsHistoryTick[]> {
    const now = Date.now();
    for (let d = 0; d <= 6; d++) {
        const date = nyDateStr(now, d);
        const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const ticks = await fetchUsTicks(contract, date, { lastCnt: count });
        if (ticks.length > 0) return ticks;
    }
    return [];
}

const Row = memo(function Row({ row, big }: { row: UsTapeRow; big: boolean }) {
    const dir = row.tickType === 1 ? 'up' : row.tickType === 2 ? 'down' : 'flat';
    return (
        <div className={big ? styles.tapeRowBig : styles.tapeRow}>
            <span className={styles.time}>{row.time}</span>
            <span className={panel.dirText[dir]} style={{ textAlign: 'right' }}>{fmtUsPrice(row.price)}</span>
            <span className={big ? styles.volBig : styles.vol}>{fmtInt(row.volume)}</span>
        </div>
    );
});

export function UsTickTape({ contract }: { contract: ContractInfo }) {
    const key = contractLinkKey(contract);
    const [rows, setRows] = useState<UsTapeRow[]>([]);
    const [status, setStatus] = useState<'loading' | 'done' | 'error' | 'unavailable'>('loading');
    const [retrySeq, setRetrySeq] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setRows([]);
        setStatus('loading');
        loadUsHistory(contract, MAX_ROWS)
            .then((ticks) => {
                if (cancelled) return;
                const hist = usTapeRowsFromHistory(ticks);
                setRows(live => [...live, ...hist].slice(0, MAX_ROWS));
                setStatus('done');
            })
            .catch((e) => { if (!cancelled) setStatus(isUsHistoryUnavailable(e) ? 'unavailable' : 'error'); });

        const releaseQuote = retainQuote(contract, 'Tick');
        const off = onAnyTick((tick) => {
            if (tick.code !== key) return;
            setRows(prev => [
                { id: rowSeq++, time: fmtTime(tick.time), price: String(tick.close), volume: tick.volume, tickType: tick.tick_type },
                ...prev,
            ].slice(0, MAX_ROWS));
        });
        return () => {
            cancelled = true;
            off();
            releaseQuote();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, contract.exchange, retrySeq]);

    const bigThreshold = useMemo(() => {
        if (rows.length < 10) return Infinity;
        const sum = rows.reduce((s, r) => s + r.volume, 0);
        return Math.max(5, (sum / rows.length) * BIG_LOT_FACTOR);
    }, [rows]);

    return (
        <div className={panel.panelBody} data-testid='us-tick-tape'>
            <div className={styles.tape}>
                {rows.length === 0 && (
                    <span className={styles.tapeRow} style={{ justifyItems: 'center' }}>
                        <span />
                        <span className={styles.time}>
                            {status === 'loading' ? <AsyncStatus phase='loading' text='載入美股成交…' />
                                : status === 'error' ? <AsyncStatus phase='error' text='美股歷史成交無法取得'
                                    action={<button type='button' onClick={() => setRetrySeq(n => n + 1)}>重試</button>} />
                                : status === 'unavailable' ? <AsyncStatus phase='empty' text='這個 SDK 版本沒有美股歷史成交，只顯示開啟後的逐筆' />
                                : <AsyncStatus phase='empty' text='尚無美股成交（歷史行情只有正式環境）' />}
                        </span>
                        <span />
                    </span>
                )}
                {rows.map(r => <Row key={r.id} row={r} big={r.volume >= bigThreshold} />)}
            </div>
        </div>
    );
}
