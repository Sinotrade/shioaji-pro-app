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
import { comboContractInfo, comboMonthsLabel } from '../lib/combo';
import { pickCombo } from '../lib/combo-pick';
import { primeContract } from '../lib/contracts-cache';
import {
    fetchComboFutures,
    fetchComboSnapshots,
    fetchFutures,
    fetchFuturesRoots,
    type ContractRoot,
    type ManagedComboContract,
} from '../lib/shioaji';
import type { StockMeta } from '../lib/stock-index';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './derivative-explorer.css';
import { Orb } from './orb';
import { UnderlyingPicker } from './underlying-picker';

const COMBO_LIST_ROOT = 'sj-pro-combo-list-root';

// 常用指數家族（自成一組排最前）
const PINNED_ROOTS = ['TXF', 'MXF', 'TMF', 'EXF', 'FXF'];

const sideOk = (price: number, volume: number | undefined) =>
    Number.isFinite(price) && (volume ?? 0) > 0;

const stripMonth = (name: string) => name.replace(/\s*\d{6}$/, '');

export function ComboListPanel({
    contract,
    onPick,
}: {
    contract?: ContractInfo | null;
    // 點列時把組合推上全域選取 — K 線/五檔/分時等連動面板跟著切
    onPick?: (code: string) => void;
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
    // 個股期搜尋器目前顯示的標的
    const [underlying, setUnderlying] = useState<StockMeta | null>(null);

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

    // 個股期查詢共用 seq — 新動作（連動/搜尋/手動切換）作廢在途查詢
    const followSeq = useRef(0);
    const rootFromUnderlying = useCallback(
        (stock: StockMeta, notFoundNote: boolean) => {
            const seq = ++followSeq.current;
            fetchFutures({ underlyingCode: stock.code })
                .then((rows) => {
                    if (seq !== followSeq.current) return;
                    const r = rows.find((x) => x.root)?.root;
                    if (r) {
                        setUnderlying(stock);
                        applyRoot(r);
                    } else if (notFoundNote) {
                        notify({
                            kind: 'info',
                            title: '沒有個股期',
                            body: `${stock.code} ${stock.name} 目前沒有掛牌的個股期貨`,
                        });
                    }
                })
                .catch(() => undefined);
        },
        [applyRoot],
    );

    // 連動選取（標準 chrome 連動/釘選：不釘時 contract 跟隨自選選擇、
    // 釘住時固定）：點到期貨 → 跟它的家族；點到股票 → 查它的個股期
    // 家族（沒有就不動）。搜尋器與下拉是手動入口。
    useEffect(() => {
        const c = contract;
        if (!c) return;
        if (c.security_type === 'FUT') {
            followSeq.current++; // 作廢在途個股期查詢
            if (c.root) {
                setUnderlying(null);
                applyRoot(c.root);
            }
            return;
        }
        if (c.security_type !== 'STK') return;
        rootFromUnderlying(
            {
                code: c.code,
                name: c.name,
                category: c.category ?? '',
                exchange: c.exchange ?? '',
            },
            false, // 連動撞到沒個股期的股票不彈通知，安靜不動
        );
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
                    onChange={(e) => {
                        followSeq.current++; // 作廢在途個股期查詢
                        setUnderlying(null);
                        applyRoot(e.target.value);
                    }}
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
            <div className={styles.toolbar}>
                {/* 個股期主要入口：搜尋股票代碼/名稱 → 切到其個股期家族
                   （兩百多個 root 靠下拉滾不現實）；手動動作不受連動開關
                   影響 */}
                <UnderlyingPicker
                    value={underlying}
                    onChange={(stock) => rootFromUnderlying(stock, true)}
                />
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
                                            // 帶入組合單＋推上全域選取
                                            // （K線/五檔/分時連動）。
                                            // pickCombo 內建 prime，這裡
                                            // 再以較完整名稱覆蓋
                                            pickCombo(combo);
                                            primeContract(
                                                comboContractInfo(
                                                    combo,
                                                    `${rootLabel} ${months ?? ''}`.trim(),
                                                ),
                                            );
                                            onPick?.(combo.code);
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
