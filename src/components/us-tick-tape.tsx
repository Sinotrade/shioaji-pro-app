// src/components/us-tick-tape.tsx — 美股成交明細
//
// 先載入最近一個交易日的最後 N 筆歷史成交（SDK 1.8.0b1；只有一般盤，含收盤
// 競價），再把即時逐筆（盤前／盤中／盤後）疊在上面。時間是美東時間。
// SDK 沒有美股歷史時只顯示開啟後收到的逐筆。

import { memo, useEffect, useMemo, useState } from 'react';
import { contractLinkKey } from '../lib/contract-key';
import { retainQuote } from '../lib/quote-ownership';
import type { ContractInfo } from '../lib/types/contract';
import { fmtUsPrice } from '../lib/us/decimal';
import { fetchUsTicks, isUsHistoryUnavailable, nyDateStr, type UsHistoryTick } from '../lib/us/us-history';
import { getUsTickMeta, nyDateTime, subscribeUsSessionTicks, type UsTickMeta } from '../lib/us/us-quotes';
import { fmtInt } from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as styles from './tick-tape.css';

const MAX_ROWS = 120;
const BIG_LOT_FACTOR = 3;

interface UsTapeRow {
    id: number;
    /** epoch µs（去重與排序用，保留原始精度） */
    ts: number;
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
        out.push({ id: rowSeq++, ts: t.tsUs, time: fmtTime(t.time), price: String(t.price), volume: t.volume, tickType: t.tickType });
    }
    return out;
}

/** 即時成交 → 明細列（美東時間到微秒） */
export function usTapeRowFromMeta(meta: UsTickMeta): UsTapeRow {
    const us = meta.tsUs ?? meta.ts * 1000;
    const { time } = nyDateTime(us);
    return { id: rowSeq++, ts: Math.floor(us), time: `${time}.${String(Math.floor(us) % 1_000_000).padStart(6, '0')}`, price: meta.price, volume: meta.volume, tickType: meta.tickType ?? 0 };
}

/** 歷史的 ns 時間經 JSON 數字傳遞後只準到 ±1 µs（見 us-history usTimeToUs） */
export const TAPE_DEDUPE_TOLERANCE_US = 1;

/**
 * 歷史回來時與載入期間收到的即時列合併：即時列若與某筆歷史同價、同量、時間
 * 相差不超過 1 µs，就視為同一筆丟掉（每筆歷史只抵銷一筆）；合併後依時間
 * 新到舊、取前 max 筆。
 */
export function mergeUsTape(live: readonly UsTapeRow[], hist: readonly UsTapeRow[], max = MAX_ROWS): UsTapeRow[] {
    const pool = new Map<string, number[]>();
    const keyOf = (r: UsTapeRow) => `${Number(r.price)}|${r.volume}`;
    for (const r of hist) {
        const list = pool.get(keyOf(r)) ?? [];
        list.push(r.ts);
        pool.set(keyOf(r), list);
    }
    const fresh = live.filter(r => {
        const list = pool.get(keyOf(r));
        const i = list ? list.findIndex(ts => Math.abs(ts - r.ts) <= TAPE_DEDUPE_TOLERANCE_US) : -1;
        if (i < 0) return true;
        list!.splice(i, 1);
        return false;
    });
    return [...fresh, ...hist].map((r, i) => [r, i] as const).sort((a, b) => b[0].ts - a[0].ts || a[1] - b[1]).map(([r]) => r).slice(0, max);
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
                setRows(live => mergeUsTape(live, hist));
                setStatus('done');
            })
            .catch((e) => { if (!cancelled) setStatus(isUsHistoryUnavailable(e) ? 'unavailable' : 'error'); });

        const releaseQuote = retainQuote(contract, 'Tick');
        // 每筆成交的通知（recordUsTick）帶微秒時間與內外盤
        const off = subscribeUsSessionTicks(key, () => {
            const meta = getUsTickMeta(key);
            if (!meta || !(meta.volume > 0)) return;
            const row = usTapeRowFromMeta(meta);
            setRows(prev => [row, ...prev].slice(0, MAX_ROWS));
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
