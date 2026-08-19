// src/components/vol-profile.tsx — 分價量表 + 內外盤比.
// Aggregates today's history ticks once, then accumulates live ticks.

import { useEffect, useMemo, useState } from 'react';
import { fetchHistoryTicks } from '../lib/kgi';
import { onAnyTick } from '../lib/stream';
import type { ContractBase } from '../lib/types/contract';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { dateStrOffset } from '../lib/utils/kbars';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';
import * as styles from './vol-profile.css';

interface Level {
    buy: number; // 外盤 (成交在賣方掛單價, tick_type 1)
    sell: number; // 內盤 (tick_type 2)
}

type Profile = Map<number, Level>;

function addTo(profile: Profile, price: number, vol: number, tickType: number) {
    const lv = profile.get(price) ?? { buy: 0, sell: 0 };
    if (tickType === 1) lv.buy += vol;
    else if (tickType === 2) lv.sell += vol;
    else {
        lv.buy += vol / 2;
        lv.sell += vol / 2;
    }
    profile.set(price, lv);
}

export function VolProfile({ contract }: { contract: ContractBase }) {
    const [version, setVersion] = useState(0);
    const [profile, setProfile] = useState<Profile>(new Map());
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        const prof: Profile = new Map();
        setProfile(prof);
        setLoading(true);

        const isFop =
            contract.security_type === 'FUT' ||
            contract.security_type === 'OPT';
        const load = async () => {
            const dates = isFop
                ? [dateStrOffset(-1), dateStrOffset(0)]
                : [dateStrOffset(0)];
            for (const d of dates) {
                try {
                    const h = await fetchHistoryTicks(contract, d);
                    if (h.datetime.length > 0) {
                        for (let i = 0; i < h.close.length; i++) {
                            addTo(
                                prof,
                                h.close[i] ?? 0,
                                h.volume[i] ?? 0,
                                h.tick_type[i] ?? 0,
                            );
                        }
                        break;
                    }
                } catch {
                    // try next date
                }
            }
            if (!cancelled) {
                setVersion((v) => v + 1);
                setLoading(false);
            }
        };
        void load();

        const off = onAnyTick((tick) => {
            if (tick.code !== contract.code) return;
            addTo(prof, Number(tick.close), tick.volume, tick.tick_type);
            setVersion((v) => v + 1);
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [contract]);

    const { rows, maxTotal, buySum, sellSum } = useMemo(() => {
        const entries = [...profile.entries()]
            .filter(([p]) => p > 0)
            .sort((a, b) => b[0] - a[0]);
        let buySum = 0;
        let sellSum = 0;
        let maxTotal = 1;
        for (const [, lv] of entries) {
            buySum += lv.buy;
            sellSum += lv.sell;
            maxTotal = Math.max(maxTotal, lv.buy + lv.sell);
        }
        // cap rows for readability — keep the highest-volume levels
        let rows = entries;
        if (rows.length > 40) {
            const keep = new Set(
                [...entries]
                    .sort(
                        (a, b) =>
                            b[1].buy + b[1].sell - (a[1].buy + a[1].sell),
                    )
                    .slice(0, 40)
                    .map(([p]) => p),
            );
            rows = entries.filter(([p]) => keep.has(p));
        }
        return { rows, maxTotal, buySum, sellSum };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile, version]);

    const total = buySum + sellSum;
    const buyPct = total > 0 ? (buySum / total) * 100 : 50;

    if (loading && rows.length === 0) {
        return <div className={dock.emptyState}>統計分價量中…</div>;
    }
    if (rows.length === 0) {
        return <div className={dock.emptyState}>今日尚無成交資料</div>;
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.ratioRow}>
                <span className={panel.dirText.up}>
                    外盤 {buyPct.toFixed(1)}%
                </span>
                <div className={styles.ratioTrack}>
                    <div
                        className={styles.ratioBuy}
                        style={{ width: `${buyPct}%` }}
                    />
                </div>
                <span className={panel.dirText.down}>
                    內盤 {(100 - buyPct).toFixed(1)}%
                </span>
            </div>
            <div className={styles.list}>
                {rows.map(([price, lv]) => {
                    const t = lv.buy + lv.sell;
                    return (
                        <div key={price} className={styles.row}>
                            <span className={styles.price}>
                                {fmtPrice(price)}
                            </span>
                            <div className={styles.barTrack}>
                                <div
                                    className={styles.barBuy}
                                    style={{
                                        width: `${(lv.buy / maxTotal) * 100}%`,
                                    }}
                                />
                                <div
                                    className={styles.barSell}
                                    style={{
                                        width: `${(lv.sell / maxTotal) * 100}%`,
                                    }}
                                />
                            </div>
                            <span className={styles.vol}>{fmtInt(Math.round(t))}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

