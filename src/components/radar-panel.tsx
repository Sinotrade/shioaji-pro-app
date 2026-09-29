// src/components/radar-panel.tsx — multi-symbol V9 radar.
// Watches the active watchlist: live price from snapshots, four-timeframe
// V9 resonance (1/5/60/D) per symbol, and a streaming feed of flip /
// aligned events. Read-only; clicking a row selects that symbol.

import { Bell, BellOff, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useRadar, type RadarRow } from '../hooks/use-radar';
import { useWatchlist } from '../hooks/use-watchlist';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './radar-panel.css';

const FRAMES = [1, 5, 60, 1440] as const;

function fmtClock(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function sideOf(row: RadarRow, minutes: number) {
    return (
        row.resonance?.frames.find((f) => f.minutes === minutes)?.side ??
        'insufficient'
    );
}

export function RadarPanel({ onPick }: { onPick: (code: string) => void }) {
    const watchlist = useWatchlist();
    const contracts = watchlist.items.map((item) => item.contract);
    const radar = useRadar(contracts);
    const [feedOpen, setFeedOpen] = useState(false);

    return (
        <>
            <div className={styles.toolbar}>
                <span className={styles.title}>
                    多檔雷達 · {radar.rows.length} 檔
                </span>
                <button
                    className={`${styles.iconBtn} ${radar.notifyOn ? styles.iconBtnOn : ''}`}
                    title={radar.notifyOn ? '通知 開' : '通知 關'}
                    onClick={() => radar.setNotifyOn(!radar.notifyOn)}
                >
                    {radar.notifyOn ? <Bell size={13} /> : <BellOff size={13} />}
                </button>
                <button
                    className={styles.iconBtn}
                    title="重新整理"
                    onClick={radar.refresh}
                >
                    <RefreshCw size={13} />
                </button>
            </div>

            <div className={styles.head}>
                <span>標的</span>
                <span className={styles.headNum}>價</span>
                <span className={styles.headNum}>1</span>
                <span className={styles.headNum}>5</span>
                <span className={styles.headNum}>60</span>
                <span className={styles.headNum}>日</span>
            </div>

            <div className={styles.body}>
                {radar.rows.length === 0 && (
                    <div className={styles.stateMsg}>
                        自選清單無標的，請先加入自選
                    </div>
                )}
                {radar.rows.map((row) => {
                    const snap = row.snapshot;
                    const chg = snap?.change_price ?? 0;
                    const priceCls =
                        chg > 0
                            ? styles.priceUp
                            : chg < 0
                              ? styles.priceDown
                              : styles.priceFlat;
                    const ref = snap ? snap.close - chg : 0;
                    const pct =
                        snap && chg && ref > 0 ? (chg / ref) * 100 : 0;
                    const flashAt = radar.flashCodes[row.code];
                    return (
                        <div
                            key={row.code}
                            className={styles.row}
                            onClick={() => onPick(row.code)}
                            title={row.resonance?.summary}
                        >
                            <span className={styles.idBlock}>
                                <span className={styles.codeTxt}>
                                    {row.code}
                                </span>
                                <span className={styles.nameTxt}>
                                    {row.name}
                                </span>
                            </span>
                            <span className={styles.priceBlock}>
                                <span className={priceCls}>
                                    {snap
                                        ? fmtPrice(snap.close)
                                        : row.barsState === 'loading'
                                          ? '…'
                                          : '—'}
                                </span>
                                <span className={styles.pctTxt}>
                                    {snap
                                        ? `${chg > 0 ? '+' : ''}${pct.toFixed(2)}%`
                                        : ''}
                                </span>
                            </span>
                            {FRAMES.map((minutes) => {
                                const side = sideOf(row, minutes);
                                return (
                                    <span
                                        key={minutes}
                                        className={styles.cell[side]}
                                    >
                                        {side === 'long'
                                            ? '多'
                                            : side === 'short'
                                              ? '空'
                                              : side === 'neutral'
                                                ? '中'
                                                : ''}
                                    </span>
                                );
                            })}
                            {flashAt ? (
                                <span
                                    key={flashAt}
                                    className={styles.flashOverlay}
                                />
                            ) : null}
                        </div>
                    );
                })}
            </div>

            <button
                className={styles.feedToggle}
                onClick={() => setFeedOpen((open) => !open)}
            >
                {feedOpen ? (
                    <ChevronUp size={12} />
                ) : (
                    <ChevronDown size={12} />
                )}
                事件
                <span className={styles.feedCount}>{radar.events.length}</span>
            </button>

            {feedOpen && (
                <div className={styles.feed}>
                    {radar.events.length === 0 && (
                        <div className={styles.stateMsg}>尚無轉折事件</div>
                    )}
                    {radar.events.map((event) => {
                        const textCls =
                            event.kind === 'flip'
                                ? event.to === 'short'
                                    ? styles.eventTagShort
                                    : event.to === 'long'
                                      ? styles.eventTagLong
                                      : styles.eventText
                                : styles.eventText;
                        return (
                            <div key={event.id} className={styles.eventRow}>
                                <span className={styles.eventTime}>
                                    {fmtClock(event.time)}
                                </span>
                                <span className={textCls}>
                                    {event.kind === 'aligned' ? '🎯' : '🔔'}{' '}
                                    {event.text}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
