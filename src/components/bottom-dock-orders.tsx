// src/components/bottom-dock-orders.tsx — 委託 tab：成交進度圈、狀態篩選、
// 分帳戶區段、批次刪單（arm-lock 防誤觸）；inline 改價/減量沿用

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
    cancelOrder,
    updateOrderPrice,
    updateOrderQty,
} from '../lib/shioaji';
import { usePrivacyMode } from '../lib/privacy';
import { notify } from '../lib/trade';
import type { Trade } from '../lib/types/order';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { vars } from '../theme.css';
import { Orb } from './orb';
import * as panel from './panel.css';
import * as styles from './bottom-dock.css';
import {
    accountRefLabel,
    ACTIVE_STATUSES,
    ArmLockButton,
    ConfirmButton,
    refKey,
    sizeClassOf,
    statusKind,
    tradeAccountRef,
    tradeMarket,
    useDockPref,
    useMeasuredWidth,
    type AccountFallback,
    type MarketFilter,
    type ViewMode,
} from './bottom-dock-shared';

type StatusFilter = 'active' | 'filled' | 'dead' | 'all';
const STATUS_FILTERS = ['active', 'filled', 'dead', 'all'] as const;

function statusBucket(t: Trade): Exclude<StatusFilter, 'all'> {
    const st = t.status.status;
    if (ACTIVE_STATUSES.has(st)) return 'active';
    if (st === 'Filled') return 'filled';
    return 'dead';
}

// 成交均價：OrderStatusInfo 無 avg_price 欄位，由 deals 加權平均回推；
// 沒有成交明細時回 null（呼叫端退回單行委託價）
function avgFillPrice(t: Trade): number | null {
    const deals = t.status.deals ?? [];
    const qty = deals.reduce((s, d) => s + d.quantity, 0);
    if (qty <= 0) return null;
    return deals.reduce((s, d) => s + d.price * d.quantity, 0) / qty;
}

// 成交進度圈：PartFilled 部分填色、Filled 全填、其餘空圈
function FillRing({ t }: { t: Trade }) {
    const st = t.status.status;
    const total = t.order.quantity;
    const pct = total > 0 ? Math.min(1, t.status.deal_quantity / total) : 0;
    const r = 5;
    const c = 2 * Math.PI * r;
    const color =
        st === 'Filled'
            ? vars.color.down // ok 語彙同 statusChip.ok
            : vars.color.amber;
    return (
        <svg width={14} height={14} viewBox='0 0 14 14' aria-hidden>
            <circle
                cx={7}
                cy={7}
                r={r}
                fill='none'
                strokeWidth={2.2}
                style={{ stroke: vars.color.muted }}
            />
            {pct > 0 && (
                <circle
                    cx={7}
                    cy={7}
                    r={r}
                    fill='none'
                    strokeWidth={2.2}
                    strokeLinecap='round'
                    strokeDasharray={`${c * pct} ${c}`}
                    transform='rotate(-90 7 7)'
                    style={{ stroke: color }}
                />
            )}
        </svg>
    );
}

// inline editor for a working order's qty (減量) or price (改價)
function OrderEditor({
    trade,
    field,
    onChanged,
}: {
    trade: Trade;
    field: 'qty' | 'price';
    onChanged: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState('');
    if (!editing) {
        return (
            <button
                className={styles.cancelBtn}
                title={field === 'qty' ? '減量（輸入新數量）' : '改價（輸入新價格）'}
                onClick={() => {
                    setVal(
                        field === 'qty'
                            ? String(
                                  trade.order.quantity -
                                      trade.status.deal_quantity,
                              )
                            : String(
                                  trade.status.modified_price ||
                                      trade.order.price,
                              ),
                    );
                    setEditing(true);
                }}
            >
                {field === 'qty' ? '改量' : '改價'}
            </button>
        );
    }
    const submit = () => {
        const n = Number(val);
        const valid =
            field === 'qty' ? Number.isInteger(n) && n >= 1 : n > 0;
        if (valid) {
            const req =
                field === 'qty'
                    ? updateOrderQty(trade.order.id, n)
                    : updateOrderPrice(trade.order.id, n);
            req.then(() => {
                notify({
                    kind: 'ok',
                    title: field === 'qty' ? '✏️ 改量已送出' : '✏️ 改價已送出',
                    body: `${trade.contract.code} → ${n}${field === 'qty' ? '（僅能減量）' : ''}`,
                });
                onChanged();
            }).catch((err) =>
                notify({
                    kind: 'err',
                    title: field === 'qty' ? '改量失敗' : '改價失敗',
                    body: err instanceof Error ? err.message : String(err),
                }),
            );
        }
        setEditing(false);
    };
    return (
        <input
            autoFocus
            className={styles.qtyInline}
            value={val}
            inputMode={field === 'qty' ? 'numeric' : 'decimal'}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter') submit();
            }}
        />
    );
}

// compact order-detail chip: 價別/效期 + 倉別(futures) / 單位(stocks)
function orderDetail(t: Trade): string {
    const parts: string[] = [];
    if (t.order.price_type) parts.push(t.order.price_type);
    if (t.order.order_type) parts.push(t.order.order_type);
    if (t.order.octype && t.order.octype !== 'Auto') {
        parts.push(
            { New: '新倉', Cover: '平倉', DayTrade: '當沖' }[
                t.order.octype
            ] ?? t.order.octype,
        );
    }
    if (t.order.order_lot && t.order.order_lot !== 'Common') {
        parts.push(
            { IntradayOdd: '零股', Odd: '零股', Fixing: '定盤', BlockTrade: '鉅額' }[
                t.order.order_lot
            ] ?? t.order.order_lot,
        );
    }
    return parts.join(' ');
}

interface OrderGroup {
    key: string;
    label: string;
    rows: Trade[];
}

export function OrdersPane({
    trades,
    mode,
    market,
    scopeKey,
    fallback,
    onChanged,
    onSelectCode,
}: {
    trades: Trade[];
    mode: ViewMode;
    market: MarketFilter;
    scopeKey: string; // '' = 全部帳戶
    fallback: AccountFallback;
    onChanged: () => void;
    onSelectCode: (code: string) => void;
}) {
    const { ref: measureRef, width } = useMeasuredWidth();
    const size = sizeClassOf(width);
    const priv = usePrivacyMode();
    const [statusFilter, setStatusFilter] = useDockPref<StatusFilter>(
        'order-status',
        STATUS_FILTERS,
        'active',
    );
    const [armed, setArmed] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [busy, setBusy] = useState<{ done: number; total: number } | null>(
        null,
    );
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

    // scope（帳戶範圍）＋市場篩選
    const scoped = useMemo(() => {
        return trades.filter((t) => {
            if (market !== 'all' && tradeMarket(t) !== market) return false;
            if (scopeKey) {
                return refKey(tradeAccountRef(t, fallback)) === scopeKey;
            }
            return true;
        });
    }, [trades, market, scopeKey, fallback]);

    const bucketCounts = useMemo(() => {
        const counts = { active: 0, filled: 0, dead: 0 };
        for (const t of scoped) counts[statusBucket(t)]++;
        return counts;
    }, [scoped]);

    // 最新在前；全部檢視時有效單置頂
    const rows = useMemo(() => {
        const newest = [...scoped].reverse();
        const filtered =
            statusFilter === 'all'
                ? newest
                : newest.filter((t) => statusBucket(t) === statusFilter);
        if (statusFilter === 'all') {
            return [
                ...filtered.filter((t) => statusBucket(t) === 'active'),
                ...filtered.filter((t) => statusBucket(t) !== 'active'),
            ];
        }
        return filtered;
    }, [scoped, statusFilter]);

    const groups = useMemo<OrderGroup[]>(() => {
        if (mode !== 'grouped') return [{ key: '', label: '', rows }];
        const map = new Map<string, OrderGroup>();
        for (const t of rows) {
            const ref = tradeAccountRef(t, fallback);
            const key = refKey(ref) || `type-${tradeMarket(t)}`;
            let g = map.get(key);
            if (!g) {
                g = { key, label: accountRefLabel(ref, priv), rows: [] };
                map.set(key, g);
            }
            g.rows.push(t);
        }
        return [...map.values()];
    }, [rows, mode, fallback, priv]);

    const activeIds = useMemo(
        () =>
            new Set(
                rows
                    .filter((t) => ACTIVE_STATUSES.has(t.status.status))
                    .map((t) => t.order.id),
            ),
        [rows],
    );
    const selCount = [...selected].filter((id) => activeIds.has(id)).length;
    const allSelected = activeIds.size > 0 && selCount === activeIds.size;
    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(activeIds));
    };

    const doCancel = async (id: string) => {
        setCancelling(id);
        try {
            await cancelOrder(id);
            onChanged();
        } catch {
            // status refresh will surface reality
        } finally {
            setCancelling(null);
        }
    };

    // 批次刪單：逐筆呼叫 cancelOrder，完成回報筆數
    const runBatchCancel = async (ids: string[]) => {
        if (ids.length === 0 || busy) return;
        setBusy({ done: 0, total: ids.length });
        let ok = 0;
        for (const id of ids) {
            try {
                await cancelOrder(id);
                ok++;
            } catch {
                // 留給狀態刷新反映實情
            }
            setBusy((b) => (b ? { done: b.done + 1, total: b.total } : b));
        }
        setBusy(null);
        setSelected(new Set());
        notify({
            kind: ok === ids.length ? 'ok' : 'err',
            title: '批次刪單完成',
            body: `已送出 ${ok}/${ids.length} 筆刪單`,
        });
        onChanged();
    };

    const priceCell = (t: Trade) => {
        const isMkt = (t.order.price_type ?? 'LMT') !== 'LMT';
        const ordPrice = t.status.modified_price || t.order.price;
        const avg = avgFillPrice(t);
        return (
            <span className={styles.priceDual}>
                <span>{isMkt && !ordPrice ? '市價' : fmtPrice(ordPrice)}</span>
                {avg !== null && (
                    <span className={styles.priceDualSub}>
                        成 {fmtPrice(avg)}
                    </span>
                )}
            </span>
        );
    };

    const fillCell = (t: Trade) => (
        <span className={styles.ringWrap}>
            <FillRing t={t} />
            <span>
                {fmtInt(t.status.deal_quantity)}/{fmtInt(t.order.quantity)}
            </span>
        </span>
    );

    const selectionCell = (t: Trade) => {
        const active = ACTIVE_STATUSES.has(t.status.status);
        return (
            <input
                type='checkbox'
                className={styles.chk}
                disabled={!armed || !active || busy !== null}
                checked={active && selected.has(t.order.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() =>
                    setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(t.order.id)) next.delete(t.order.id);
                        else next.add(t.order.id);
                        return next;
                    })
                }
                title={
                    !active
                        ? '非有效單，不可刪'
                        : armed
                          ? '選取加入批次刪單'
                          : '批次刪單已鎖定 — 先解鎖'
                }
            />
        );
    };

    const actionsCell = (t: Trade, withEditors: boolean) => {
        const st = t.status.status;
        if (!ACTIVE_STATUSES.has(st)) return null;
        return (
            <>
                {withEditors && (
                    <>
                        <span onClick={(e) => e.stopPropagation()}>
                            {(t.order.price_type ?? 'LMT') === 'LMT' && (
                                <>
                                    <OrderEditor
                                        trade={t}
                                        field='price'
                                        onChanged={onChanged}
                                    />{' '}
                                </>
                            )}
                            <OrderEditor
                                trade={t}
                                field='qty'
                                onChanged={onChanged}
                            />
                        </span>{' '}
                    </>
                )}
                <button
                    className={styles.cancelBtn}
                    disabled={cancelling === t.order.id || busy !== null}
                    onClick={(e) => {
                        e.stopPropagation();
                        void doCancel(t.order.id);
                    }}
                >
                    {cancelling === t.order.id ? '…' : 'CANCEL'}
                </button>
            </>
        );
    };

    const renderTable = (list: Trade[]) => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th className={styles.th} style={{ width: '1.4rem' }}>
                        <input
                            type='checkbox'
                            className={styles.chk}
                            disabled={
                                !armed || activeIds.size === 0 || busy !== null
                            }
                            checked={allSelected}
                            onChange={toggleAll}
                            title='全選有效單（批次刪單）'
                        />
                    </th>
                    <th className={styles.th}>代碼</th>
                    <th className={styles.th}>買賣</th>
                    {size === 'wide' && <th className={styles.th}>類別</th>}
                    <th className={styles.th}>價格</th>
                    <th className={styles.th}>成交/委託</th>
                    <th className={styles.th}>狀態</th>
                    {size === 'wide' && <th className={styles.th}>訊息</th>}
                    <th className={styles.th} />
                </tr>
            </thead>
            <tbody>
                {list.map((t) => {
                    const st = t.status.status;
                    return (
                        <tr
                            key={t.order.id}
                            className={styles.clickableRow}
                            onClick={() => onSelectCode(t.contract.code)}
                            title='點擊連動圖表與下單面板'
                        >
                            <td
                                className={styles.td}
                                onClick={(e) => e.stopPropagation()}
                            >
                                {selectionCell(t)}
                            </td>
                            <td className={styles.td}>{t.contract.code}</td>
                            <td
                                className={`${styles.td} ${panel.dirText[t.order.action === 'Buy' ? 'up' : 'down']}`}
                            >
                                {t.order.action === 'Buy' ? '買' : '賣'}
                            </td>
                            {size === 'wide' && (
                                <td
                                    className={`${styles.td} ${styles.detailCell}`}
                                >
                                    {orderDetail(t) || '—'}
                                </td>
                            )}
                            <td className={styles.td}>{priceCell(t)}</td>
                            <td className={styles.td}>{fillCell(t)}</td>
                            <td className={styles.td}>
                                <span
                                    className={
                                        styles.statusChip[statusKind(st)]
                                    }
                                >
                                    {st}
                                </span>
                            </td>
                            {size === 'wide' && (
                                <td
                                    className={styles.td}
                                    style={{
                                        maxWidth: '14rem',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {t.status.msg || '—'}
                                </td>
                            )}
                            <td className={styles.td}>
                                {actionsCell(t, true)}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );

    // 窄版：兩行卡片式 row（代碼＋買賣＋狀態 / 價格＋進度圈＋刪單）
    const renderCards = (list: Trade[]) => (
        <div>
            {list.map((t) => {
                const st = t.status.status;
                return (
                    <div
                        key={t.order.id}
                        className={styles.cardRow}
                        onClick={() => onSelectCode(t.contract.code)}
                        title='點擊連動圖表與下單面板'
                    >
                        <div className={styles.cardLine}>
                            <span onClick={(e) => e.stopPropagation()}>
                                {selectionCell(t)}
                            </span>
                            <span className={styles.cardCode}>
                                {t.contract.code}
                            </span>
                            <span
                                className={
                                    styles.dirBadge[
                                        t.order.action === 'Buy'
                                            ? 'up'
                                            : 'down'
                                    ]
                                }
                            >
                                {t.order.action === 'Buy' ? '買' : '賣'}
                            </span>
                            <span className={styles.cardSpacer} />
                            <span
                                className={styles.statusChip[statusKind(st)]}
                            >
                                {st}
                            </span>
                        </div>
                        <div className={styles.cardLine}>
                            {priceCell(t)}
                            {fillCell(t)}
                            <span className={styles.cardSpacer} />
                            <span onClick={(e) => e.stopPropagation()}>
                                {actionsCell(t, false)}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    const renderRows = (list: Trade[]) =>
        size === 'narrow' ? renderCards(list) : renderTable(list);

    const filterChips: { key: StatusFilter; label: string; n?: number }[] = [
        { key: 'active', label: '有效', n: bucketCounts.active },
        { key: 'filled', label: '已成交', n: bucketCounts.filled },
        { key: 'dead', label: '已取消/失敗', n: bucketCounts.dead },
    ];

    return (
        <div className={styles.dockBody} ref={measureRef}>
            <div className={styles.filterRow}>
                {filterChips.map((c) => (
                    <button
                        key={c.key}
                        className={
                            styles.ctrlOpt[
                                statusFilter === c.key ? 'on' : 'off'
                            ]
                        }
                        title='再點一次顯示全部'
                        onClick={() =>
                            setStatusFilter(
                                statusFilter === c.key ? 'all' : c.key,
                            )
                        }
                    >
                        {c.label} {c.n ?? 0}
                    </button>
                ))}
            </div>
            <div className={styles.paneScroll}>
                {rows.length === 0 ? (
                    <div className={styles.emptyState}>
                        NO ORDERS · 無委託
                    </div>
                ) : mode === 'grouped' ? (
                    groups.map((g) => {
                        const gActive = g.rows.filter((t) =>
                            ACTIVE_STATUSES.has(t.status.status),
                        );
                        const isCollapsed = collapsed.has(g.key);
                        return (
                            <div key={g.key}>
                                <div className={styles.groupHeader}>
                                    <button
                                        className={styles.groupHeader}
                                        style={{
                                            border: 'none',
                                            background: 'transparent',
                                            padding: 0,
                                            width: 'auto',
                                            flex: '0 1 auto',
                                            minWidth: 0,
                                        }}
                                        onClick={() =>
                                            setCollapsed((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(g.key)) {
                                                    next.delete(g.key);
                                                } else next.add(g.key);
                                                return next;
                                            })
                                        }
                                    >
                                        {isCollapsed ? (
                                            <ChevronRight size={11} />
                                        ) : (
                                            <ChevronDown size={11} />
                                        )}
                                        <span className={styles.groupTitle}>
                                            {g.label}
                                        </span>
                                        <span className={styles.groupStat}>
                                            {g.rows.length} 筆
                                        </span>
                                        <span className={styles.groupStat}>
                                            有效 {gActive.length}
                                        </span>
                                    </button>
                                    <span className={styles.groupSpacer} />
                                    {gActive.length > 0 && (
                                        <span
                                            onClick={(e) =>
                                                e.stopPropagation()
                                            }
                                        >
                                            <ConfirmButton
                                                label={`全刪 ${gActive.length}`}
                                                confirmLabel={`確認刪 ${gActive.length} 筆？`}
                                                disabled={
                                                    !armed || busy !== null
                                                }
                                                title={
                                                    armed
                                                        ? '刪除此帳戶所有有效單'
                                                        : '已鎖定 — 點下方鎖頭解鎖批次刪單'
                                                }
                                                onConfirm={() =>
                                                    void runBatchCancel(
                                                        gActive.map(
                                                            (t) => t.order.id,
                                                        ),
                                                    )
                                                }
                                            />
                                        </span>
                                    )}
                                </div>
                                {!isCollapsed && renderRows(g.rows)}
                            </div>
                        );
                    })
                ) : (
                    renderRows(rows)
                )}
            </div>
            <div className={styles.batchBar}>
                <ArmLockButton
                    armed={armed}
                    onToggle={() => setArmed((v) => !v)}
                    hint='批次刪單'
                />
                {size === 'narrow' && (
                    <input
                        type='checkbox'
                        className={styles.chk}
                        disabled={
                            !armed || activeIds.size === 0 || busy !== null
                        }
                        checked={allSelected}
                        onChange={toggleAll}
                        title='全選有效單（批次刪單）'
                    />
                )}
                <span>
                    已選{' '}
                    <span className={styles.batchCount}>{selCount}</span> 筆
                </span>
                {busy ? (
                    <span className={styles.busyRow}>
                        <Orb size={12} variant='ring' />
                        刪單中 {busy.done}/{busy.total}
                    </span>
                ) : (
                    <ConfirmButton
                        label='刪除已選'
                        confirmLabel={`確認刪除 ${selCount} 筆？`}
                        disabled={!armed || selCount === 0}
                        title={
                            !armed
                                ? '已鎖定 — 點鎖頭解鎖批次刪單'
                                : `刪除已選 ${selCount} 筆有效委託`
                        }
                        onConfirm={() =>
                            void runBatchCancel(
                                [...selected].filter((id) =>
                                    activeIds.has(id),
                                ),
                            )
                        }
                    />
                )}
                <span className={styles.batchSpacer} />
            </div>
        </div>
    );
}
