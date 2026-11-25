import { retainQuote } from '../lib/quote-ownership';
// src/components/tick-tape.tsx — time & sales feed.
// Preloads today's recent history ticks, then streams live deals on top.
// Times show full microsecond precision (HH:MM:SS.ffffff).
// Big lots (≥3× the rolling average of visible rows) are highlighted.
//
// 美股（region US）走同一個元件：歷史是最近一個有成交的美東交易日（SDK
// 1.8.0 起含盤前／盤後／夜盤；舊 sidecar 只有一般盤），即時逐筆含盤前／盤後；
// 歷史與即時用同一個成交種類（漏斗鈕，切換時重抓歷史）。時間是美東時間，
// 跨日標日期分隔。資料轉接見 lib/us/us-tape.ts。

import { Funnel } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { contractLinkKey } from '../lib/contract-key';
import { fetchLastTicks } from '../lib/shioaji';
import { onAnyTick } from '../lib/stream';
import type { ContractBase } from '../lib/types/contract';
import type { HistoryTicks } from '../lib/types/tick';
import { fmtUsPrice } from '../lib/us/decimal';
import { isUsHistoryUnavailable, nyDateStr } from '../lib/us/us-history';
import { getUsTickMeta, subscribeUsSessionTicks } from '../lib/us/us-quotes';
import { setUsTickDetail, useUsTickDetail } from '../lib/us/us-tick-prefs';
import {
    loadUsTapeHistory,
    mergeUsTape,
    nextTapeRowId,
    usTapeDayBreaks,
    usTapeRowFromMeta,
    usTapeRowsFromHistory,
    type TapeRow,
} from '../lib/us/us-tape';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { dateStrOffset } from '../lib/utils/kbars';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as chrome from './panel-chrome.css';
import * as styles from './tick-tape.css';

const MAX_ROWS = 120;
const BIG_LOT_FACTOR = 3;

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
    us,
}: {
    time: string;
    close: number | string;
    volume: number;
    tickType: number;
    big: boolean;
    us: boolean;
}) {
    const dir = tickType === 1 ? 'up' : tickType === 2 ? 'down' : 'flat';
    return (
        <div className={big ? styles.tapeRowBig : styles.tapeRow}>
            <span className={styles.time}>{time}</span>
            <span
                className={panel.dirText[dir]}
                style={{ textAlign: 'right' }}
            >
                {us ? fmtUsPrice(close) : fmtPrice(close)}
            </span>
            <span className={big ? styles.volBig : styles.vol}>
                {fmtInt(volume)}
            </span>
        </div>
    );
});

/**
 * 美股成交明細標題列的過濾鈕（lucide Funnel）：與 設定 → 行情「美股成交資料」同一個設定。
 * 亮著（預設）＝一般成交（Tick，有過濾）；點掉＝完整成交（TickFull，含碎股與特殊條件成交）。
 */
export function UsTickDetailToggle() {
    const filtered = useUsTickDetail() !== 'TickFull';
    return (
        <button
            type='button'
            className={chrome.iconToggleBtn[filtered ? 'on' : 'off']}
            aria-label='只看一般成交'
            aria-pressed={filtered}
            title={filtered
                ? '一般成交：正規盤會更新最新價的成交，加上盤前、盤後、夜盤的整股成交（點擊取消過濾，看完整成交）'
                : '完整成交：含碎股與特殊條件成交的每一筆（點擊改回一般成交）'}
            onClick={() => setUsTickDetail(filtered ? 'TickFull' : 'Tick')}
        >
            <Funnel size={11} aria-hidden />
        </button>
    );
}

export function TickTape({ contract }: { contract: ContractBase }) {
    const isUs = contract.region === 'US';
    const [rows, setRows] = useState<TapeRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [historyError, setHistoryError] = useState(false);
    // 美股：這個 SDK 沒有美股歷史成交（舊版）— 只列開啟後的逐筆
    const [historyUnavailable, setHistoryUnavailable] = useState(false);
    const [retrySeq, setRetrySeq] = useState(0);

    // 美股：歷史與即時訂閱用同一個成交種類（漏斗鈕）；切換時重抓歷史（即時
    // 訂閱由 stream.ts 改訂），兩邊才一致。台股不看這個設定
    const usDetail = useUsTickDetail();
    const historyDetail = isUs ? usDetail : null;

    // history preload, then live stream on top
    useEffect(() => {
        let cancelled = false;
        setRows([]);
        setLoading(true);
        setHistoryError(false);
        setHistoryUnavailable(false);

        const history: Promise<(live: TapeRow[]) => TapeRow[]> = isUs
            ? loadUsTapeHistory(contract, MAX_ROWS, historyDetail ?? 'Tick').then((ticks) => {
                  const hist = usTapeRowsFromHistory(ticks, MAX_ROWS);
                  // 載入期間的即時列可能與歷史重疊 — 同價同量、時間差 ≤1 µs 去重
                  return (live: TapeRow[]) => mergeUsTape(live, hist, MAX_ROWS);
              })
            : loadHistory(contract, MAX_ROWS).then((h) => {
                  const hist: TapeRow[] = [];
                  for (let i = h.datetime.length - 1; i >= 0; i--) {
                      const dt = h.datetime[i];
                      if (!dt) continue;
                      hist.push({
                          id: nextTapeRowId(),
                          time: fmtTickTime(dt.slice(11)),
                          close: h.close[i] ?? 0,
                          volume: h.volume[i] ?? 0,
                          tick_type: h.tick_type[i] ?? 0,
                      });
                  }
                  // live rows may already have arrived — keep them on top
                  return (live: TapeRow[]) => [...live, ...hist].slice(0, MAX_ROWS);
              });
        history
            .then((merge) => {
                if (cancelled) return;
                setRows(merge);
            })
            .catch((e) => {
                if (cancelled) return;
                if (isUs && isUsHistoryUnavailable(e)) setHistoryUnavailable(true);
                else setHistoryError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [contract, isUs, historyDetail, retrySeq]);

    // 即時逐筆：與歷史分開，切換成交種類只重抓歷史，不重新訂閱
    useEffect(() => {
        const releaseQuote = retainQuote(contract, 'Tick');
        const push = (row: TapeRow) => {
            setHistoryError(false);
            setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
        };
        const key = contractLinkKey(contract);
        // 美股：每筆成交的通知（recordUsTick）帶微秒時間與內外盤；行情 store
        // 會合併相近的多筆，不能拿來列明細
        const off = isUs
            ? subscribeUsSessionTicks(key, () => {
                  const meta = getUsTickMeta(key);
                  if (!meta || !(meta.volume > 0)) return;
                  push(usTapeRowFromMeta(meta));
              })
            : onAnyTick((tick) => {
                  if (tick.code !== contract.code) return;
                  push({
                      id: nextTapeRowId(),
                      time: fmtTickTime(tick.time),
                      close: tick.close,
                      volume: tick.volume,
                      tick_type: tick.tick_type,
                  });
              });
        return () => {
            off();
            releaseQuote();
        };
    }, [contract, isUs]);

    // big-lot threshold from the rolling average of visible rows
    const bigThreshold = useMemo(() => {
        if (rows.length < 10) return Infinity;
        const sum = rows.reduce((s, r) => s + r.volume, 0);
        return Math.max(5, (sum / rows.length) * BIG_LOT_FACTOR);
    }, [rows]);

    // 美股：明細跨日（盤前的即時列接在前一交易日的歷史上）標日期
    const dayBreaks = isUs ? usTapeDayBreaks(rows, nyDateStr()) : null;

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
                                <AsyncStatus phase='loading' text='載入歷史成交…' />
                            ) : historyError ? (
                                <AsyncStatus phase='error' text='歷史成交無法取得'
                                    action={<button type='button' onClick={() => setRetrySeq(n => n + 1)}>重試</button>} />
                            ) : historyUnavailable ? (
                                <AsyncStatus phase='empty' text='這個 SDK 版本沒有美股歷史成交，只顯示開啟後的逐筆' />
                            ) : (
                                <AsyncStatus phase='empty' text={isUs ? '尚無成交資料' : '今日尚無成交'} />
                            )}
                        </span>
                        <span />
                    </span>
                )}
                {rows.map((t, i) => {
                    const row = (
                        <TapeRowView
                            key={t.id}
                            time={t.time}
                            close={t.close}
                            volume={t.volume}
                            tickType={t.tick_type}
                            big={t.volume >= bigThreshold}
                            us={isUs}
                        />
                    );
                    const day = dayBreaks?.get(i);
                    return day === undefined ? row : [
                        <div key={`d${t.id}`} className={styles.dayBreak} data-testid='us-tape-day'>
                            {`${day.slice(5).replace('-', '/')}（美東）`}
                        </div>,
                        row,
                    ];
                })}
            </div>
        </div>
    );
}
