// src/components/combo-list.tsx — 交易所組合商品列表（issue #32）
//
// 枚舉一個期貨家族目前所有可交易的 managed 組合（跨月價差），批次快照
// 輪詢報價（一發 request，rate limit 友善；不佔訂閱額度），點一列即
// 帶入組合單面板的兩腳 — 自選清單支援組合商品前的替代動線。
//
// 家族選擇雙軌：下拉分「常用指數」與「全部家族（含個股期）」兩組；
// 自選/任何面板點到期貨或有個股期的股票時自動連動到該家族 —
// 個股期兩百多個 root 用滾的找不現實，連動才是主要動線。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { comboMonthsLabel } from '../lib/combo';
import { pickCombo } from '../lib/combo-pick';
import {
    fetchComboFutures,
    fetchComboSnapshots,
    fetchFutures,
    fetchFuturesRoots,
    type ContractRoot,
    type ManagedComboContract,
} from '../lib/shioaji';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './derivative-explorer.css';
import { Orb } from './orb';

const COMBO_LIST_ROOT = 'sj-pro-combo-list-root';

// 常用指數家族（自成一組排最前）
const PINNED_ROOTS = ['TXF', 'MXF', 'TMF', 'EXF', 'FXF'];

const sideOk = (price: number, volume: number | undefined) =>
    Number.isFinite(price) && (volume ?? 0) > 0;

const stripMonth = (name: string) => name.replace(/\s*\d{6}$/, '');

export function ComboListPanel({
    contract,
}: {
    contract?: ContractInfo | null;
}) {
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

    const applyRoot = useCallback((next: string) => {
        setRoot((prev) => {
            if (prev === next) return prev;
            localStorage.setItem(COMBO_LIST_ROOT, next);
            return next;
        });
    }, []);

    useEffect(() => {
        fetchFuturesRoots()
            .then((rows) => setRoots(rows))
            .catch(() => undefined); // 清單載不到仍可用預設 root
    }, []);

    // 連動全域選取：點到期貨 → 跟它的家族；點到股票 → 查它的個股期
    // 家族（沒有個股期就不動）。之後仍可手動下拉切換。
    const followSeq = useRef(0);
    useEffect(() => {
        const c = contract;
        if (!c) return;
        // 任何新選擇（含期貨/非股票）都作廢在途的個股期查詢 — 否則
        // 遲到的股票查詢會蓋掉更新的期貨選擇
        const seq = ++followSeq.current;
        if (c.security_type === 'FUT') {
            if (c.root) applyRoot(c.root);
            return;
        }
        if (c.security_type !== 'STK') return;
        fetchFutures({ underlyingCode: c.code })
            .then((rows) => {
                if (seq !== followSeq.current) return;
                const r = rows.find((x) => x.root)?.root;
                if (r) applyRoot(r);
            })
            .catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract?.code]);

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

    const pinned = PINNED_ROOTS.map((code) =>
        roots.find((r) => r.root === code),
    ).filter((r): r is ContractRoot => !!r);
    const rest = roots.filter((r) => !PINNED_ROOTS.includes(r.root));
    const rootName = roots.find((r) => r.root === root)?.name;
    const rootLabel = rootName ? stripMonth(rootName) : root;

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <select
                    className={styles.select}
                    value={root}
                    onChange={(e) => applyRoot(e.target.value)}
                >
                    {/* 清單未載入或存的 root 已下市 → 補現值選項不留空白 */}
                    {!roots.some((r) => r.root === root) && (
                        <option value={root}>{root}</option>
                    )}
                    <optgroup label='常用指數'>
                        {pinned.map((r) => (
                            <option key={r.root} value={r.root}>
                                {stripMonth(r.name)}（{r.root}）
                            </option>
                        ))}
                    </optgroup>
                    <optgroup label='全部家族（含個股期）'>
                        {rest.map((r) => (
                            <option key={r.root} value={r.root}>
                                {stripMonth(r.name)}（{r.root}）
                            </option>
                        ))}
                    </optgroup>
                </select>
            </div>
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>
                    {rootLabel} 跨月價差
                </span>
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
                <div className={styles.empty}>
                    {rootLabel} 目前沒有可交易的組合
                </div>
            ) : (
                <div className={styles.scroll}>
                    <table className={styles.table}>
                        <colgroup>
                            <col style={{ width: '30%' }} />
                            <col style={{ width: '21%' }} />
                            <col style={{ width: '21%' }} />
                            <col style={{ width: '15%' }} />
                            <col style={{ width: '13%' }} />
                        </colgroup>
                        <thead>
                            <tr>
                                <th className={styles.thLeft}>組合（近/遠）</th>
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
                                const months = comboMonthsLabel(combo.code);
                                return (
                                    <tr
                                        key={combo.code}
                                        className={styles.row}
                                        title={`${rootLabel} ${months ?? combo.code}｜帶入組合單`}
                                        onClick={() => {
                                            pickCombo(combo);
                                            notify({
                                                kind: 'info',
                                                title: '🧩 已帶入組合單',
                                                body: `${rootLabel} ${months ?? ''}（${combo.code}）`,
                                            });
                                        }}
                                    >
                                        <td className={styles.tdLeft}>
                                            <strong>
                                                {months ?? combo.code}
                                            </strong>
                                            {months && (
                                                <span
                                                    className={
                                                        styles.contractName
                                                    }
                                                >
                                                    {combo.code}
                                                </span>
                                            )}
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
