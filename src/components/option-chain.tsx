// src/components/option-chain.tsx — TXO option chain (T 字報價表).
// Loads the OPT contract list once (cached), shows strikes around ATM for
// a selectable expiry, refreshes quotes via batched snapshots.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { apiPost } from '../lib/api';
import { pickOptionLeg } from '../lib/option-pick';
import { fetchSnapshots } from '../lib/shioaji';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice, fmtSigned } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';
import * as styles from './option-chain.css';

interface OptContract {
    code: string;
    exchange: string;
    security_type: string;
    category: string;
    delivery_month: string;
    delivery_date: string;
    strike_price: number;
    option_right: string;
    reference: number;
}

let optCache: OptContract[] | null = null;
let optLoading: Promise<OptContract[]> | null = null;

async function loadTxo(): Promise<OptContract[]> {
    if (optCache) return optCache;
    if (optLoading) return optLoading;
    optLoading = (async () => {
        const res = await apiPost<{ contracts: OptContract[] }>(
            '/api/v1/data/contracts',
            { security_type: 'OPT', page: -1 },
        );
        optCache = res.contracts.filter((c) => c.category === 'TXO');
        return optCache;
    })();
    return optLoading;
}

const STRIKE_SPAN = 8; // strikes above/below ATM

function isCall(c: OptContract): boolean {
    return c.option_right.toUpperCase().startsWith('C');
}

const MONTH_KEY = 'sj-pro-optchain-month';

export function OptionChain({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [contracts, setContracts] = useState<OptContract[]>([]);
    const [month, setMonth] = useState(
        () => localStorage.getItem(MONTH_KEY) ?? '',
    );
    const [snaps, setSnaps] = useState<Map<string, Snapshot>>(new Map());
    const [loading, setLoading] = useState(true);
    const txf = useQuote('TXFR1');

    useEffect(() => {
        loadTxo()
            .then((cs) => {
                setContracts(cs);
                const months = [...new Set(cs.map((c) => c.delivery_month))]
                    .filter(Boolean)
                    .sort();
                // restore saved month if still listed, else front month
                setMonth((m) =>
                    m && months.includes(m) ? m : (months[0] ?? ''),
                );
            })
            .finally(() => setLoading(false));
    }, []);

    const months = useMemo(
        () =>
            [...new Set(contracts.map((c) => c.delivery_month))]
                .filter(Boolean)
                .sort()
                .slice(0, 6),
        [contracts],
    );

    const atm = txf?.tick ? Number(txf.tick.close) : null;

    // strikes around ATM for selected month
    const rows = useMemo(() => {
        const inMonth = contracts.filter((c) => c.delivery_month === month);
        const strikes = [
            ...new Set(inMonth.map((c) => c.strike_price)),
        ].sort((a, b) => a - b);
        if (strikes.length === 0) return [];
        const center = atm ?? strikes[Math.floor(strikes.length / 2)]!;
        let idx = 0;
        let best = Infinity;
        strikes.forEach((s, i) => {
            const d = Math.abs(s - center);
            if (d < best) {
                best = d;
                idx = i;
            }
        });
        const lo = Math.max(0, idx - STRIKE_SPAN);
        const sel = strikes.slice(lo, idx + STRIKE_SPAN + 1);
        return sel.map((strike) => ({
            strike,
            call: inMonth.find(
                (c) => c.strike_price === strike && isCall(c),
            ),
            put: inMonth.find(
                (c) => c.strike_price === strike && !isCall(c),
            ),
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contracts, month, atm === null ? 0 : Math.round(atm / 100)]);

    // snapshot polling for visible contracts
    const codesKey = rows
        .flatMap((r) => [r.call?.code, r.put?.code])
        .filter(Boolean)
        .join(',');
    const refreshSnaps = useCallback(async () => {
        if (!codesKey) return;
        const targets = rows
            .flatMap((r) => [r.call, r.put])
            .filter((c): c is OptContract => !!c)
            .map((c) => ({
                security_type: 'OPT' as const,
                exchange: 'TAIFEX' as const,
                code: c.code,
                target_code: null,
            }));
        try {
            const result = await fetchSnapshots(targets);
            setSnaps(new Map(result.map((s) => [s.code, s])));
        } catch {
            // keep last snapshot set
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    useEffect(() => {
        refreshSnaps();
        const t = setInterval(refreshSnaps, 5000);
        return () => clearInterval(t);
    }, [refreshSnaps]);

    // the strike closest to ATM — exact, not a fixed point distance
    const nearestStrike = useMemo(() => {
        if (atm === null || rows.length === 0) return null;
        let best: number | null = null;
        let bestDist = Infinity;
        for (const r of rows) {
            const d = Math.abs(r.strike - atm);
            if (d < bestDist) {
                bestDist = d;
                best = r.strike;
            }
        }
        return best;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, atm === null ? 0 : Math.round(atm / 10)]);

    if (loading) {
        return <div className={dock.emptyState}>載入 TXO 合約…</div>;
    }
    if (rows.length === 0) {
        return <div className={dock.emptyState}>無可用合約</div>;
    }

    const Cell = ({ code }: { code?: string }) => {
        const s = code ? snaps.get(code) : undefined;
        if (!s) {
            return (
                <>
                    <td className={styles.td}>—</td>
                    <td className={styles.td}>—</td>
                    <td className={styles.td}>—</td>
                </>
            );
        }
        const dir =
            s.change_price > 0 ? 'up' : s.change_price < 0 ? 'down' : 'flat';
        return (
            <>
                <td className={`${styles.td} ${panel.dirText[dir]}`}>
                    {s.close ? fmtPrice(s.close, 0) : '—'}
                </td>
                <td className={styles.td}>
                    {s.buy_price ? fmtPrice(s.buy_price, 0) : '—'}
                </td>
                <td className={styles.td}>
                    {s.sell_price ? fmtPrice(s.sell_price, 0) : '—'}
                </td>
            </>
        );
    };

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {months.map((m) => (
                    <button
                        key={m}
                        className={styles.month[m === month ? 'on' : 'off']}
                        onClick={() => {
                            setMonth(m);
                            localStorage.setItem(MONTH_KEY, m);
                        }}
                    >
                        {m.slice(0, 4)}/{m.slice(4)}
                    </button>
                ))}
                {atm !== null && (
                    <span className={styles.atm}>
                        TXF {fmtPrice(atm, 0)}{' '}
                        {txf?.tick?.price_chg &&
                            fmtSigned(Number(txf.tick.price_chg), 0)}
                    </span>
                )}
            </div>
            <div className={panel.panelBody}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th className={styles.th} colSpan={3}>
                                CALL 買權
                            </th>
                            <th className={`${styles.th} ${styles.strikeTh}`}>
                                履約價
                            </th>
                            <th className={styles.th} colSpan={3}>
                                PUT 賣權
                            </th>
                        </tr>
                        <tr>
                            <th className={styles.th}>成交</th>
                            <th className={styles.th}>買</th>
                            <th className={styles.th}>賣</th>
                            <th className={`${styles.th} ${styles.strikeTh}`} />
                            <th className={styles.th}>成交</th>
                            <th className={styles.th}>買</th>
                            <th className={styles.th}>賣</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr
                                key={r.strike}
                                className={onPick ? styles.pickableRow : ''}
                                title={
                                    onPick
                                        ? '點 CALL 側連動買權、PUT 側連動賣權'
                                        : undefined
                                }
                                onClick={(e) => {
                                    if (!onPick) return;
                                    // left half of the row → call, right → put
                                    const rect = (
                                        e.currentTarget as HTMLElement
                                    ).getBoundingClientRect();
                                    const left =
                                        e.clientX - rect.left <
                                        rect.width / 2;
                                    const code = left
                                        ? r.call?.code
                                        : r.put?.code;
                                    if (code) {
                                        onPick(code);
                                        // also offer it to a combo panel in
                                        // 連動 mode (issue #1)
                                        pickOptionLeg(code);
                                    }
                                }}
                            >
                                <Cell code={r.call?.code} />
                                <td
                                    className={`${styles.strike} ${
                                        r.strike === nearestStrike
                                            ? styles.atmStrike
                                            : ''
                                    }`}
                                >
                                    {fmtPrice(r.strike, 0)}
                                </td>
                                <Cell code={r.put?.code} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
