// src/components/combo-list.tsx — 交易所組合商品列表（issue #32）
//
// 枚舉一個期貨家族目前所有可交易的 managed 組合（跨月價差），批次快照
// 輪詢報價（一發 request，rate limit 友善；不佔訂閱額度），點一列即
// 帶入組合單面板的兩腳 — 自選清單支援組合商品前的替代動線。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { pickCombo } from '../lib/combo-pick';
import {
    fetchComboFutures,
    fetchComboSnapshots,
    fetchFuturesRoots,
    type ContractRoot,
    type ManagedComboContract,
} from '../lib/shioaji';
import { notify } from '../lib/trade';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './derivative-explorer.css';
import { Orb } from './orb';

const COMBO_LIST_ROOT = 'sj-pro-combo-list-root';

// 熱門指數家族排前面，其餘（股票期貨等）照 server 順序附後
const PINNED_ROOTS = ['TXF', 'MXF', 'TMF', 'EXF', 'FXF'];

const sideOk = (price: number, volume: number | undefined) =>
    Number.isFinite(price) && (volume ?? 0) > 0;

export function ComboListPanel() {
    const [roots, setRoots] = useState<ContractRoot[]>([]);
    const [root, setRoot] = useState(
        () => localStorage.getItem(COMBO_LIST_ROOT) || 'TXF',
    );
    const [combos, setCombos] = useState<ManagedComboContract[]>([]);
    const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(
        new Map(),
    );
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        fetchFuturesRoots()
            .then((rows) => {
                const byRoot = new Map(rows.map((r) => [r.root, r]));
                const pinned = PINNED_ROOTS.map((code) =>
                    byRoot.get(code),
                ).filter((r): r is ContractRoot => !!r);
                const rest = rows.filter(
                    (r) => !PINNED_ROOTS.includes(r.root),
                );
                setRoots([...pinned, ...rest]);
            })
            .catch(() => undefined); // 清單載不到仍可用預設 root
    }, []);

    useEffect(() => {
        let stale = false;
        setLoading(true);
        setError(false);
        fetchComboFutures(root)
            .then((rows) => {
                if (stale) return;
                setCombos(rows);
            })
            .catch(() => {
                if (stale) return;
                setCombos([]);
                setError(true);
            })
            .finally(() => {
                if (!stale) setLoading(false);
            });
        return () => {
            stale = true;
        };
    }, [root]);

    const comboKey = combos.map((c) => c.code).join(',');
    const refresh = useCallback(async () => {
        if (combos.length === 0) {
            setSnapshots(new Map());
            return;
        }
        try {
            const rows = await fetchComboSnapshots(combos);
            setSnapshots(new Map(rows.map((row) => [row.code, row])));
        } catch {
            // 保留上一輪成功的報價
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [comboKey]);

    useEffect(() => {
        void refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, [refresh]);

    // 有市場的排前面（總量降冪），零市場的沉底但仍可點（都可下單）
    const sorted = useMemo(() => {
        const activity = (c: ManagedComboContract) =>
            snapshots.get(c.code)?.total_volume ?? 0;
        return [...combos].sort((a, b) => activity(b) - activity(a));
    }, [combos, snapshots]);

    const activeCount = sorted.filter(
        (c) => (snapshots.get(c.code)?.total_volume ?? 0) > 0,
    ).length;

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <select
                    className={styles.select}
                    value={root}
                    onChange={(e) => {
                        setRoot(e.target.value);
                        localStorage.setItem(COMBO_LIST_ROOT, e.target.value);
                    }}
                >
                    {/* 清單未載入或存的 root 已下市 → 補一個現值選項，
                        select 才不會顯示空白 */}
                    {!roots.some((r) => r.root === root) && (
                        <option value={root}>{root}</option>
                    )}
                    {roots.map((r) => (
                        <option key={r.root} value={r.root}>
                            {r.root}｜{r.name.replace(/\s*\d{6}$/, '')}
                        </option>
                    ))}
                </select>
            </div>
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>{root} 跨月價差</span>
                <span>{combos.length} 組可交易</span>
                <span>{activeCount} 組有市場</span>
            </div>
            {loading ? (
                <div className={styles.empty}>
                    <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    載入組合商品…
                </div>
            ) : error ? (
                <div className={styles.error}>組合商品載入失敗</div>
            ) : sorted.length === 0 ? (
                <div className={styles.empty}>此家族目前沒有可交易的組合</div>
            ) : (
                <div className={styles.scroll}>
                    <table className={styles.table}>
                        <colgroup>
                            <col style={{ width: '26%' }} />
                            <col style={{ width: '22%' }} />
                            <col style={{ width: '22%' }} />
                            <col style={{ width: '16%' }} />
                            <col style={{ width: '14%' }} />
                        </colgroup>
                        <thead>
                            <tr>
                                <th className={styles.thLeft}>組合</th>
                                <th className={styles.th}>委買</th>
                                <th className={styles.th}>委賣</th>
                                <th className={styles.th}>成交</th>
                                <th className={styles.th}>總量</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map((combo) => {
                                const q = snapshots.get(combo.code);
                                const hasBid =
                                    !!q && sideOk(q.buy_price, q.buy_volume);
                                const hasAsk =
                                    !!q && sideOk(q.sell_price, q.sell_volume);
                                const traded = (q?.total_volume ?? 0) > 0;
                                return (
                                    <tr
                                        key={combo.code}
                                        className={styles.row}
                                        title='帶入組合單面板'
                                        onClick={() => {
                                            pickCombo(combo);
                                            notify({
                                                kind: 'info',
                                                title: '🧩 已帶入組合單',
                                                body: `${combo.code}（需開啟組合單面板）`,
                                            });
                                        }}
                                    >
                                        <td className={styles.tdLeft}>
                                            <strong>{combo.code}</strong>
                                        </td>
                                        <td className={`${styles.td} ${panel.dirText.up}`}>
                                            {hasBid
                                                ? `${fmtPrice(q!.buy_price)}×${q!.buy_volume}`
                                                : '—'}
                                        </td>
                                        <td className={`${styles.td} ${panel.dirText.down}`}>
                                            {hasAsk
                                                ? `${fmtPrice(q!.sell_price)}×${q!.sell_volume}`
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {traded ? fmtPrice(q!.close) : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {traded ? q!.total_volume : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
