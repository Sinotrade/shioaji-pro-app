import { RefreshButton } from './refresh-button';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
// src/components/option-chain.tsx — 臺指選擇權 T 字報價表（月選＋週選）.
// Loads the TAIEX option contracts once per day (cached): the monthly TXO
// root plus every weekly root discovered from options/roots (issue #152).
// Expiries are keyed by (root, delivery_date); shows strikes around ATM for
// the selected expiry and refreshes quotes via batched snapshots.

import { useEffect, useMemo, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import {
    buildExpiries,
    contractsForExpiry,
    isChainContract,
    MONTHLY_ROOT,
    pickChainRoots,
    resolveExpiry,
    taipeiToday,
    type ChainContract,
} from '../lib/option-expiry';
import { pickOptionLeg } from '../lib/option-pick';
import { fetchOptionRoots, fetchOptions } from '../lib/shioaji';
import { fmtPrice, fmtSigned } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as styles from './option-chain.css';
import { OptionExpiryPicker } from './option-expiry-picker';
import { Orb } from './orb';
import * as panel from './panel.css';

type OptContract = ChainContract;

// 合約清單一天載一次：週選每週掛牌／到期，跨日要重新發現
let optCache: { day: string; rows: OptContract[] } | null = null;
let optLoading: { day: string; p: Promise<OptContract[]> } | null = null;

export async function loadChainContracts(
    day: string = taipeiToday(),
): Promise<OptContract[]> {
    if (optCache?.day === day) return optCache.rows;
    if (optLoading?.day === day) return optLoading.p;
    const p = (async () => {
        // roots 查不到時退回只載月選
        const roots = await fetchOptionRoots().catch(() => []);
        const wanted = roots.length ? pickChainRoots(roots) : [MONTHLY_ROOT];
        const settled = await Promise.allSettled(
            wanted.map(async (root) =>
                (await fetchOptions(root)).map((c) =>
                    c.root ? c : { ...c, root },
                ),
            ),
        );
        const loaded = settled.flatMap((r) =>
            r.status === 'fulfilled' ? [r.value] : [],
        );
        // 全部失敗才算失敗；個別週選代碼（如占位 root）讀不到就略過
        const failed = settled.find((r) => r.status === 'rejected');
        if (loaded.length === 0 && failed) throw failed.reason;
        const rows = loaded.flat().filter(isChainContract);
        optCache = { day, rows };
        return rows;
    })();
    optLoading = { day, p };
    return p.finally(() => {
        if (optLoading?.p === p) optLoading = null;
    });
}

const STRIKE_SPAN = 8; // strikes above/below ATM

function isCall(c: OptContract): boolean {
    return c.option_right.toUpperCase().startsWith('C');
}

// 記住 `${root}:${delivery_date}`；舊版只記月份（sj-pro-optchain-month）
export const EXPIRY_KEY = 'sj-pro-optchain-expiry';

function readSavedExpiry(): string | null {
    try {
        return localStorage.getItem(EXPIRY_KEY);
    } catch {
        return null;
    }
}

function saveExpiry(key: string) {
    try {
        localStorage.setItem(EXPIRY_KEY, key);
    } catch {
        // 無法寫入（隱私模式等）時只是不記住
    }
}

export function OptionChain({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [contracts, setContracts] = useState<OptContract[]>([]);
    const [choice, setChoice] = useState<string | null>(readSavedExpiry);
    const [loading, setLoading] = useState(true);
    const txf = useQuote('TXFR1');

    useEffect(() => {
        let stale = false;
        loadChainContracts()
            .then((cs) => {
                if (!stale) setContracts(cs);
            })
            .catch(() => undefined)
            .finally(() => {
                if (!stale) setLoading(false);
            });
        return () => {
            stale = true;
        };
    }, []);

    const today = taipeiToday();
    const expiries = useMemo(
        () => buildExpiries(contracts, today),
        [contracts, today],
    );
    // 記住的到期若已到期或不再列出，改選最近到期的
    const expiry = resolveExpiry(expiries, choice);

    const atm = txf?.tick ? Number(txf.tick.close) : null;

    // strikes around ATM for the selected expiry
    const rows = useMemo(() => {
        const inMonth = contractsForExpiry(contracts, expiry);
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
    }, [contracts, expiry, atm === null ? 0 : Math.round(atm / 100)]);

    const { snapshots: snaps, refresh: refreshQuotes, loading: quotesLoading, error: quotesError } = useLiveSnapshots(rows.flatMap(r => [r.call, r.put]).filter((c): c is OptContract => !!c));

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
        return <div className={dock.emptyState}>
                <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                載入臺指選擇權合約…
            </div>;
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
                {quotesError && <span role="status">{quotesError}；保留上次報價</span>}
            <div className={styles.toolbar}>
                <OptionExpiryPicker
                    expiries={expiries}
                    value={expiry}
                    onChange={(key) => {
                        setChoice(key);
                        saveExpiry(key);
                    }}
                />
                {atm !== null && (
                    <span className={styles.atm}>
                        TXF {fmtPrice(atm, 0)}{' '}
                        {txf?.tick?.price_chg &&
                            fmtSigned(Number(txf.tick.price_chg), 0)}
                    </span>
                )}
                <RefreshButton label="更新報價" loading={quotesLoading} onClick={() => void refreshQuotes()} />
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
