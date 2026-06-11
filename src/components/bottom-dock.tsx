// src/components/bottom-dock.tsx — positions / orders / account tabs

import { useCallback, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { ensureContract } from '../lib/contracts-cache';
import {
    cancelOrder,
    fetchSettlements,
    updateOrderQty,
    type Settlement,
} from '../lib/shioaji';
import { notify, placeQuickOrder } from '../lib/trade';
import type { Trade } from '../lib/types/order';
import type {
    AccountBalance,
    Margin,
    Position,
} from '../lib/types/portfolio';
import {
    fmtInt,
    fmtMoney,
    fmtPrice,
    fmtSigned,
} from '../lib/utils/format';
import { vars } from '../theme.css';
import * as panel from './panel.css';
import * as styles from './bottom-dock.css';

type TabKey = 'positions' | 'orders' | 'account';

const ACTIVE_STATUSES = new Set([
    'PendingSubmit',
    'PreSubmitted',
    'Submitted',
    'PartFilled',
]);

function statusKind(status: string): 'ok' | 'pending' | 'bad' {
    if (status === 'Filled') return 'ok';
    if (ACTIVE_STATUSES.has(status)) return 'pending';
    return 'bad';
}

function PositionsTable({
    positions,
    onChanged,
}: {
    positions: Position[];
    onChanged: () => void;
}) {
    const [busyCode, setBusyCode] = useState<string | null>(null);
    const act = async (p: Position, mode: 'close' | 'reverse') => {
        if (busyCode) return;
        setBusyCode(p.code);
        try {
            const contract = await ensureContract(p.code);
            const exit = p.direction === 'Buy' ? 'Sell' : 'Buy';
            const qty =
                mode === 'close' ? p.quantity : p.quantity * 2;
            const trade = await placeQuickOrder(contract, exit, null, qty);
            notify({
                kind: 'ok',
                title: mode === 'close' ? '⏹ 平倉單已送出' : '🔄 反手單已送出',
                body: `${p.code} 市價${exit === 'Buy' ? '買' : '賣'} ${qty} (${trade.status.status})`,
            });
            onChanged();
        } catch (e) {
            notify({
                kind: 'err',
                title: mode === 'close' ? '平倉失敗' : '反手失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        } finally {
            setBusyCode(null);
        }
    };
    if (positions.length === 0) {
        return <div className={styles.emptyState}>NO OPEN POSITIONS · 無持倉</div>;
    }
    const maxAbsPnl = Math.max(1, ...positions.map((p) => Math.abs(p.pnl)));
    return (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th className={styles.th}>代碼</th>
                    <th className={styles.th}>方向</th>
                    <th className={styles.th}>數量</th>
                    <th className={styles.th}>成本</th>
                    <th className={styles.th}>現價</th>
                    <th className={styles.th}>損益</th>
                    <th className={styles.th} style={{ width: '18%' }}>
                        損益分布
                    </th>
                    <th className={styles.th} />
                </tr>
            </thead>
            <tbody>
                {positions.map((p) => {
                    const dir = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat';
                    return (
                        <tr key={`${p.code}-${p.id}`}>
                            <td className={styles.td}>{p.code}</td>
                            <td
                                className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}
                            >
                                {p.direction === 'Buy' ? '多 LONG' : '空 SHORT'}
                            </td>
                            <td className={styles.td}>{fmtInt(p.quantity)}</td>
                            <td className={styles.td}>{fmtPrice(p.price)}</td>
                            <td className={styles.td}>
                                {fmtPrice(p.last_price)}
                            </td>
                            <td
                                className={`${styles.td} ${panel.dirText[dir]}`}
                            >
                                {fmtSigned(p.pnl, 0)}
                            </td>
                            <td className={styles.td}>
                                <div className={styles.pnlBar}>
                                    <div
                                        className={styles.pnlFill}
                                        style={{
                                            left: p.pnl >= 0 ? '50%' : undefined,
                                            right:
                                                p.pnl < 0 ? '50%' : undefined,
                                            width: `${(Math.abs(p.pnl) / maxAbsPnl) * 50}%`,
                                            background:
                                                p.pnl >= 0
                                                    ? vars.color.up
                                                    : vars.color.down,
                                        }}
                                    />
                                </div>
                            </td>
                            <td className={styles.td}>
                                <button
                                    className={styles.cancelBtn}
                                    disabled={busyCode === p.code}
                                    title='市價沖銷此倉位'
                                    onClick={() => act(p, 'close')}
                                >
                                    平
                                </button>{' '}
                                <button
                                    className={styles.cancelBtn}
                                    disabled={busyCode === p.code}
                                    title='市價反向兩倍（翻倉）'
                                    onClick={() => act(p, 'reverse')}
                                >
                                    反
                                </button>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function QtyEditor({
    trade,
    onChanged,
}: {
    trade: Trade;
    onChanged: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState('');
    if (!editing) {
        return (
            <button
                className={styles.cancelBtn}
                title='減量（輸入新數量）'
                onClick={() => {
                    setVal(
                        String(
                            trade.order.quantity -
                                trade.status.deal_quantity,
                        ),
                    );
                    setEditing(true);
                }}
            >
                改量
            </button>
        );
    }
    return (
        <input
            autoFocus
            className={styles.qtyInline}
            value={val}
            inputMode='numeric'
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter') {
                    const q = Number(val);
                    if (Number.isInteger(q) && q >= 1) {
                        updateOrderQty(trade.order.id, q)
                            .then(() => {
                                notify({
                                    kind: 'ok',
                                    title: '✏️ 改量已送出',
                                    body: `${trade.contract.code} → ${q}（僅能減量）`,
                                });
                                onChanged();
                            })
                            .catch((err) =>
                                notify({
                                    kind: 'err',
                                    title: '改量失敗',
                                    body:
                                        err instanceof Error
                                            ? err.message
                                            : String(err),
                                }),
                            );
                    }
                    setEditing(false);
                }
            }}
        />
    );
}

function OrdersTable({
    trades,
    onChanged,
}: {
    trades: Trade[];
    onChanged: () => void;
}) {
    const [cancelling, setCancelling] = useState<string | null>(null);
    if (trades.length === 0) {
        return <div className={styles.emptyState}>NO ORDERS · 無委託</div>;
    }
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
    return (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th className={styles.th}>代碼</th>
                    <th className={styles.th}>買賣</th>
                    <th className={styles.th}>價格</th>
                    <th className={styles.th}>委託量</th>
                    <th className={styles.th}>成交量</th>
                    <th className={styles.th}>狀態</th>
                    <th className={styles.th}>訊息</th>
                    <th className={styles.th} />
                </tr>
            </thead>
            <tbody>
                {[...trades].reverse().map((t) => {
                    const st = t.status.status;
                    return (
                        <tr key={t.order.id}>
                            <td className={styles.td}>{t.contract.code}</td>
                            <td
                                className={`${styles.td} ${panel.dirText[t.order.action === 'Buy' ? 'up' : 'down']}`}
                            >
                                {t.order.action === 'Buy' ? '買' : '賣'}
                            </td>
                            <td className={styles.td}>
                                {fmtPrice(
                                    t.status.modified_price || t.order.price,
                                )}
                            </td>
                            <td className={styles.td}>
                                {fmtInt(t.order.quantity)}
                            </td>
                            <td className={styles.td}>
                                {fmtInt(t.status.deal_quantity)}
                            </td>
                            <td className={styles.td}>
                                <span
                                    className={
                                        styles.statusChip[statusKind(st)]
                                    }
                                >
                                    {st}
                                </span>
                            </td>
                            <td
                                className={styles.td}
                                style={{
                                    maxWidth: '16rem',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {t.status.msg || '—'}
                            </td>
                            <td className={styles.td}>
                                {ACTIVE_STATUSES.has(st) && (
                                    <>
                                        <QtyEditor
                                            trade={t}
                                            onChanged={onChanged}
                                        />{' '}
                                        <button
                                            className={styles.cancelBtn}
                                            disabled={
                                                cancelling === t.order.id
                                            }
                                            onClick={() =>
                                                doCancel(t.order.id)
                                            }
                                        >
                                            {cancelling === t.order.id
                                                ? '…'
                                                : 'CANCEL'}
                                        </button>
                                    </>
                                )}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function AccountView({
    balance,
    margin,
}: {
    balance?: AccountBalance;
    margin?: Margin;
}) {
    const { data: settlements } = usePoll<Settlement[]>(
        useCallback(() => fetchSettlements().catch(() => []), []),
        60000,
    );
    const items: { label: string; value: string; dir?: 'up' | 'down' | 'flat' }[] =
        [];
    if (balance) {
        items.push({
            label: '證券交割帳戶 Balance',
            value: fmtMoney(balance.acc_balance),
        });
    }
    if (margin) {
        items.push(
            { label: '權益數 Equity', value: fmtMoney(margin.equity) },
            {
                label: '可用保證金 Available',
                value: fmtMoney(margin.available_margin),
            },
            {
                label: '原始保證金 Initial',
                value: fmtMoney(margin.initial_margin),
            },
            {
                label: '維持保證金 Maint.',
                value: fmtMoney(margin.maintenance_margin),
            },
            {
                label: '風險指標 Risk',
                value: `${margin.risk_indicator.toFixed(0)}%`,
                dir:
                    margin.risk_indicator >= 100
                        ? 'flat'
                        : margin.risk_indicator >= 50
                          ? 'up'
                          : 'up',
            },
            {
                label: '期貨平倉損益 Settle P&L',
                value: fmtSigned(margin.future_settle_profitloss, 0),
                dir:
                    margin.future_settle_profitloss > 0
                        ? 'up'
                        : margin.future_settle_profitloss < 0
                          ? 'down'
                          : 'flat',
            },
        );
    }
    for (const st of settlements ?? []) {
        if (!st.amount) continue;
        items.push({
            label: `交割款 ${st.date}`,
            value: fmtSigned(st.amount, 0),
            dir: st.amount > 0 ? 'up' : 'down',
        });
    }
    if (items.length === 0) {
        return <div className={styles.emptyState}>NO ACCOUNT DATA · 無帳務資料</div>;
    }
    return (
        <div className={styles.accountGrid}>
            {items.map((it) => (
                <div key={it.label} className={styles.statCard}>
                    <span className={styles.statCardLabel}>{it.label}</span>
                    <span
                        className={`${styles.statCardValue} ${it.dir ? panel.dirText[it.dir] : ''}`}
                    >
                        {it.value}
                    </span>
                </div>
            ))}
        </div>
    );
}

export function BottomDock({
    positions,
    trades,
    balance,
    margin,
    onTradesChanged,
}: {
    positions: Position[];
    trades: Trade[];
    balance?: AccountBalance;
    margin?: Margin;
    onTradesChanged: () => void;
}) {
    const [tab, setTab] = useState<TabKey>('positions');
    const activeOrders = trades.filter((t) =>
        ACTIVE_STATUSES.has(t.status.status),
    ).length;

    const tabs: { key: TabKey; label: string }[] = [
        { key: 'positions', label: `持倉 Positions [${positions.length}]` },
        { key: 'orders', label: `委託 Orders [${activeOrders}/${trades.length}]` },
        { key: 'account', label: '帳務 Account' },
    ];

    return (
        <div className={styles.dock}>
            <div className={styles.tabBar}>
                {tabs.map((t) => (
                    <button
                        key={t.key}
                        className={styles.tab[tab === t.key ? 'on' : 'off']}
                        onClick={() => setTab(t.key)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            <div className={panel.panelBody}>
                {tab === 'positions' && (
                    <PositionsTable
                        positions={positions}
                        onChanged={onTradesChanged}
                    />
                )}
                {tab === 'orders' && (
                    <OrdersTable trades={trades} onChanged={onTradesChanged} />
                )}
                {tab === 'account' && (
                    <AccountView balance={balance} margin={margin} />
                )}
            </div>
        </div>
    );
}
