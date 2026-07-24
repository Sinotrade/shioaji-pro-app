// src/components/bottom-dock.tsx — positions / orders / account tabs

import { Lock, Unlock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { useTradingLive } from '../hooks/use-stream';
import {
    ensureAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import { ensureContract } from '../lib/contracts-cache';
import {
    maskAccountId,
    maskMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import {
    cancelOrder,
    fetchSettlements,
    updateOrderPrice,
    updateOrderQty,
    type Settlement,
} from '../lib/shioaji';
import {
    notify,
    placeQuickOrder,
    placeStockExitByShares,
    watchTradesToTerminal,
} from '../lib/trade';
import type { Trade } from '../lib/types/order';
import type {
    AccountBalance,
    Margin,
    Position,
    StockPosition,
} from '../lib/types/portfolio';
import {
    fmtInt,
    fmtMoney,
    fmtPrice,
    fmtSigned,
    fmtStockLots,
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
    onSelectCode,
}: {
    positions: Position[];
    onChanged: () => void;
    onSelectCode: (code: string) => void;
}) {
    const [busyCode, setBusyCode] = useState<string | null>(null);
    // 平/反 are one-click market orders on the whole position — keep them
    // locked by default like 閃電下單 (issue #1: 存股族一秒反向很可怕)
    const [actArmed, setActArmed] = useState(false);
    const privMoney = usePrivacyMoney();
    const live = useTradingLive();
    // 股名 joined from the contract cache (issue #1: 只看 code 不友善)
    const [names, setNames] = useState<Record<string, string>>({});
    const codesKey = positions.map((p) => p.code).join(',');
    useEffect(() => {
        let alive = true;
        void Promise.allSettled(
            positions.map((p) => ensureContract(p.code)),
        ).then((rs) => {
            if (!alive) return;
            const next: Record<string, string> = {};
            for (const r of rs) {
                if (r.status === 'fulfilled' && r.value.name) {
                    next[r.value.code] = r.value.name;
                }
            }
            setNames(next);
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);
    const act = async (p: Position, mode: 'close' | 'reverse') => {
        if (busyCode) return;
        setBusyCode(p.code);
        try {
            const contract = await ensureContract(p.code);
            const exit = p.direction === 'Buy' ? 'Sell' : 'Buy';
            // 反手＝平掉舊倉 + 再開同量反向倉。兩者分開傳，拆腿的錯誤訊息才
            // 講得出零股是卡在「今日買進」還是「新開的反向倉」
            const closeShares = p.quantity;
            const openShares = mode === 'reverse' ? p.quantity : 0;
            const qty = closeShares + openShares;
            const actLabel = `${p.code} ${mode === 'close' ? '平倉' : '反手'}`;
            if (isStockPosition(p)) {
                // shares → Common lots + daytrade 今日買進 + IntradayOdd 零股；
                // 不 throw — 已送出的腿一定進 watcher，失敗的腿記名回報
                const { placed, errors } = await placeStockExitByShares(
                    contract,
                    exit,
                    {
                        closeShares,
                        openShares,
                        ydShares: p.yd_quantity,
                        cond: p.cond,
                    },
                );
                if (placed.length > 0) {
                    // errors 必須一起傳 — 否則已送出的腿全成交時，終態通知會
                    // 報綠色「全部成交」，但部位其實只處理了一部分
                    void watchTradesToTerminal('S', placed, actLabel, errors);
                }
                if (errors.length > 0) {
                    // 「我們決定不送」與「送出時炸了、不知道券商收到沒」給
                    // 使用者的指示完全相反，不可以混成同一句話
                    const anyUnknown = errors.some(
                        (er) => er.sent === 'unknown',
                    );
                    notify({
                        kind: 'err',
                        title: `❌ ${actLabel} 有委託未送出`,
                        body:
                            errors
                                .map((er) => `${er.leg}：${er.error}`)
                                .join('；') +
                            (placed.length > 0
                                ? '；其餘已送出的腿追蹤中'
                                : '') +
                            (anyUnknown
                                ? ' — 無法確認這些委託是否已送達券商，請先到「委託」分頁確認再決定是否重送，勿直接重按'
                                : placed.length > 0
                                  ? ' — 這些腿未送出，券商不會有對應委託；勿直接重按（會重複送出已成功的腿）'
                                  : ' — 這些腿未送出，券商不會有對應委託'),
                    });
                    onChanged();
                    return;
                }
            } else {
                const placed = await placeQuickOrder(contract, exit, null, qty);
                void watchTradesToTerminal('F', [placed], actLabel);
            }
            // 送出成功只代表「傳送中」— place_order 初始可能只是
            // PendingSubmit，成交/退件/部分成交由 watcher 的終態通知定案
            notify({
                kind: 'info',
                title:
                    mode === 'close' ? '⏳ 平倉單傳送中' : '⏳ 反手單傳送中',
                body: `${p.code} 市價${exit === 'Buy' ? '買' : '賣'} ${
                    isStockPosition(p) ? fmtStockLots(qty) : `${qty} 口`
                } — 等待回報確認（成交／退件以結果通知為準）`,
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
                    <th className={styles.th}>名稱</th>
                    <th className={styles.th}>方向</th>
                    <th className={styles.th}>數量</th>
                    <th className={styles.th}>成本</th>
                    <th className={styles.th}>現價</th>
                    <th className={styles.th}>損益</th>
                    <th className={styles.th}>報酬率</th>
                    <th className={styles.th} style={{ width: '18%' }}>
                        損益分布
                    </th>
                    <th className={styles.th}>
                        <button
                            className={styles.cancelBtn}
                            title={
                                actArmed
                                    ? '鎖定平/反按鍵（防誤觸）'
                                    : '平/反為整倉市價單，預設鎖定 — 點此解鎖'
                            }
                            style={
                                actArmed
                                    ? {
                                          color: vars.color.danger,
                                          borderColor: vars.color.danger,
                                      }
                                    : undefined
                            }
                            onClick={() => setActArmed((v) => !v)}
                        >
                            {actArmed ? <Unlock size={10} /> : <Lock size={10} />}
                        </button>
                    </th>
                </tr>
            </thead>
            <tbody>
                {positions.map((p) => {
                    const dir = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat';
                    // 報酬率 = signed price move vs entry (works for both
                    // stocks and futures without knowing the multiplier)
                    const sign = p.direction === 'Buy' ? 1 : -1;
                    const retPct =
                        p.price > 0
                            ? ((p.last_price - p.price) / p.price) * 100 * sign
                            : 0;
                    return (
                        <tr
                            key={`${p.code}-${p.id}`}
                            className={styles.clickableRow}
                            onClick={() => onSelectCode(p.code)}
                            title='點擊連動圖表與下單面板'
                        >
                            <td className={styles.td}>{p.code}</td>
                            <td className={styles.td}>
                                {names[p.code] ?? ''}
                            </td>
                            <td
                                className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}
                            >
                                {p.direction === 'Buy' ? '多 LONG' : '空 SHORT'}
                            </td>
                            <td className={`${styles.td} ${styles.qtyCell}`}>
                                {maskMoney(
                                    isStockPosition(p)
                                        ? fmtStockLots(p.quantity)
                                        : fmtInt(p.quantity),
                                    privMoney,
                                )}
                            </td>
                            <td className={styles.td}>{fmtPrice(p.price)}</td>
                            <td className={styles.td}>
                                {fmtPrice(p.last_price)}
                            </td>
                            <td
                                className={`${styles.td} ${panel.dirText[dir]}`}
                            >
                                {maskMoney(fmtSigned(p.pnl, 0), privMoney)}
                            </td>
                            <td
                                className={`${styles.td} ${panel.dirText[dir]}`}
                            >
                                {retPct > 0 ? '+' : ''}
                                {retPct.toFixed(2)}%
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
                                    disabled={
                                        busyCode === p.code || !live || !actArmed
                                    }
                                    title={
                                        !live
                                            ? '行情未連線，暫停下單'
                                            : !actArmed
                                              ? '已鎖定 — 點表頭鎖頭解鎖平/反'
                                              : '市價沖銷此倉位'
                                    }
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void act(p, 'close');
                                    }}
                                >
                                    平
                                </button>{' '}
                                <button
                                    className={styles.cancelBtn}
                                    disabled={
                                        busyCode === p.code || !live || !actArmed
                                    }
                                    title={
                                        !live
                                            ? '行情未連線，暫停下單'
                                            : !actArmed
                                              ? '已鎖定 — 點表頭鎖頭解鎖平/反'
                                              : '市價反向兩倍（翻倉）'
                                    }
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void act(p, 'reverse');
                                    }}
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

function OrdersTable({
    trades,
    onChanged,
    onSelectCode,
}: {
    trades: Trade[];
    onChanged: () => void;
    onSelectCode: (code: string) => void;
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
                    <th className={styles.th}>類別</th>
                    <th className={styles.th}>價格</th>
                    <th className={styles.th}>委託量</th>
                    <th className={styles.th}>成交</th>
                    <th className={styles.th}>狀態</th>
                    <th className={styles.th}>訊息</th>
                    <th className={styles.th} />
                </tr>
            </thead>
            <tbody>
                {[...trades].reverse().map((t) => {
                    const st = t.status.status;
                    const fillPct =
                        t.order.quantity > 0
                            ? (t.status.deal_quantity / t.order.quantity) * 100
                            : 0;
                    return (
                        <tr
                            key={t.order.id}
                            className={styles.clickableRow}
                            onClick={() => onSelectCode(t.contract.code)}
                            title='點擊連動圖表與下單面板'
                        >
                            <td className={styles.td}>{t.contract.code}</td>
                            <td
                                className={`${styles.td} ${panel.dirText[t.order.action === 'Buy' ? 'up' : 'down']}`}
                            >
                                {t.order.action === 'Buy' ? '買' : '賣'}
                            </td>
                            <td className={`${styles.td} ${styles.detailCell}`}>
                                {orderDetail(t) || '—'}
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
                                <span className={styles.fillCell}>
                                    {fmtInt(t.status.deal_quantity)}
                                    {st === 'PartFilled' && (
                                        <span className={styles.fillTrack}>
                                            <span
                                                className={styles.fillBar}
                                                style={{
                                                    width: `${fillPct}%`,
                                                }}
                                            />
                                        </span>
                                    )}
                                </span>
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
                                        <span
                                            onClick={(e) =>
                                                e.stopPropagation()
                                            }
                                        >
                                            {(t.order.price_type ?? 'LMT') ===
                                                'LMT' && (
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
                                        <button
                                            className={styles.cancelBtn}
                                            disabled={
                                                cancelling === t.order.id
                                            }
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                doCancel(t.order.id);
                                            }}
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

// stock positions carry yd_quantity; futures ones don't
function isStockPosition(p: Position): p is StockPosition {
    return 'yd_quantity' in p;
}

// 1,234,567 → 123萬；2.3億 — readable at a glance
function fmtCompact(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}億`;
    if (abs >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}萬`;
    return Math.round(n).toLocaleString();
}

// resolve a vanilla-extract var(--x) reference to a concrete color
function cssColor(el: HTMLElement, varRef: string): string {
    if (!varRef.startsWith('var(')) return varRef;
    return (
        getComputedStyle(el).getPropertyValue(varRef.slice(4, -1)).trim() ||
        '#888'
    );
}

// asset-allocation donut: gapped arcs, center shows the total
function AssetDonut({
    segs,
    total,
    mask = false,
}: {
    segs: { label: string; value: number; color: string }[];
    total: number;
    mask?: boolean;
}) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current;
        if (!cv) return;
        const size = 148;
        const dpr = window.devicePixelRatio || 1;
        cv.width = size * dpr;
        cv.height = size * dpr;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        const cx = size / 2;
        const cy = size / 2;
        const r = size / 2 - 8;
        const thick = 15;
        // background ring
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = cssColor(cv, vars.color.muted);
        ctx.lineWidth = thick;
        ctx.stroke();
        // segments with small gaps
        const gap = segs.length > 1 ? 0.06 : 0;
        let angle = -Math.PI / 2;
        for (const s of segs) {
            const sweep = (s.value / total) * Math.PI * 2;
            if (sweep <= gap * 2) {
                angle += sweep;
                continue;
            }
            ctx.beginPath();
            ctx.arc(cx, cy, r, angle + gap, angle + sweep - gap);
            ctx.strokeStyle = cssColor(cv, s.color);
            ctx.lineWidth = thick;
            ctx.lineCap = 'round';
            ctx.stroke();
            angle += sweep;
        }
        // center: total assets
        ctx.textAlign = 'center';
        ctx.fillStyle = cssColor(cv, vars.color.mutedForeground);
        ctx.font = "600 9px 'Inter', sans-serif";
        ctx.fillText('資產市值', cx, cy - 8);
        ctx.fillStyle = cssColor(cv, vars.color.foreground);
        ctx.font = "700 16px 'JetBrains Mono', monospace";
        ctx.fillText(mask ? '••••' : fmtCompact(total), cx, cy + 10);
    }, [segs, total, mask]);
    return (
        <canvas
            ref={ref}
            style={{ width: 148, height: 148, flexShrink: 0 }}
        />
    );
}

function AccountView({
    balance,
    margin,
    positions,
}: {
    balance?: AccountBalance;
    margin?: Margin;
    positions: Position[];
}) {
    const privMoney = usePrivacyMoney();
    const { data: settlements } = usePoll<Settlement[]>(
        useCallback(() => fetchSettlements().catch(() => []), []),
        60000,
    );

    // 資產市值 (issue #1): stock market value net of estimated sell-side
    // fees/taxes, plus futures equity and the settlement account balance
    const stockRows = positions.filter(isStockPosition).map((p) => {
        const sign = p.direction === 'Sell' ? -1 : 1;
        // quantity is in shares (unit=Share)
        const gross = p.last_price * p.quantity;
        const isEtf = p.code.startsWith('00');
        const taxRate = isEtf ? 0.001 : 0.003;
        const net = gross * (1 - 0.001425 - taxRate);
        return { code: p.code, value: sign * net };
    });
    const stockValue = stockRows.reduce((s, r) => s + r.value, 0);
    const futEquity = margin?.equity ?? 0;
    const cash = balance?.acc_balance ?? 0;
    const totalAssets = stockValue + futEquity + cash;
    const items: {
        label: string;
        value: string;
        dir?: 'up' | 'down' | 'flat';
        tone?: 'danger' | 'warn';
    }[] = [];
    if (balance) {
        items.push({
            label: '證券交割帳戶 Balance',
            value: fmtMoney(balance.acc_balance),
        });
    }
    if (stockRows.length > 0) {
        items.push({
            label: '股票市值（扣稅費估）Stock Value',
            value: fmtMoney(Math.round(stockValue)),
        });
    }
    if (totalAssets > 0 && (stockRows.length > 0 || margin || balance)) {
        items.push({
            label: '資產市值 Total Assets',
            value: fmtMoney(Math.round(totalAssets)),
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
                // TAIFEX 風險指標：低於 100% 有追繳風險、過低會被代沖銷
                label: '風險指標 Risk',
                value: `${margin.risk_indicator.toFixed(0)}%`,
                tone:
                    margin.risk_indicator < 100
                        ? 'danger'
                        : margin.risk_indicator < 200
                          ? 'warn'
                          : undefined,
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
    const distSegs = [
        { label: '證券', value: Math.max(0, stockValue), color: vars.color.accent },
        { label: '期貨權益', value: Math.max(0, futEquity), color: vars.color.amber },
        { label: '交割帳戶', value: Math.max(0, cash), color: vars.color.flat },
    ].filter((s) => s.value > 0);
    const distTotal = distSegs.reduce((s, d) => s + d.value, 0);
    const topHoldings = [...stockRows]
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 5);
    const maxHolding = Math.max(1, ...topHoldings.map((h) => Math.abs(h.value)));
    return (
        <div>
            <div className={styles.accountGrid}>
                {items.map((it) => (
                    <div key={it.label} className={styles.statCard}>
                        <span className={styles.statCardLabel}>{it.label}</span>
                        <span
                            className={`${styles.statCardValue} ${it.dir ? panel.dirText[it.dir] : ''}`}
                            style={
                                it.tone
                                    ? {
                                          color:
                                              it.tone === 'danger'
                                                  ? vars.color.danger
                                                  : vars.color.amber,
                                      }
                                    : undefined
                            }
                        >
                            {it.label.includes('風險')
                                ? it.value
                                : maskMoney(it.value, privMoney)}
                        </span>
                    </div>
                ))}
            </div>
            {distTotal > 0 && (
                <div className={styles.distBlock}>
                    <span className={styles.distTitle}>資產分布</span>
                    <div className={styles.distWrap}>
                        <AssetDonut
                            segs={distSegs}
                            total={distTotal}
                            mask={privMoney}
                        />
                        <div className={styles.distDetail}>
                            {distSegs.map((s) => (
                                <div key={s.label} className={styles.distRow}>
                                    <span
                                        className={styles.distSwatch}
                                        style={{ background: s.color }}
                                    />
                                    <span className={styles.distLabel}>
                                        {s.label}
                                    </span>
                                    <span className={styles.distValue}>
                                        {maskMoney(
                                            fmtMoney(Math.round(s.value)),
                                            privMoney,
                                        )}
                                    </span>
                                    <span className={styles.distPct}>
                                        {((s.value / distTotal) * 100).toFixed(
                                            1,
                                        )}
                                        %
                                    </span>
                                </div>
                            ))}
                            {topHoldings.length > 0 && (
                                <>
                                    <span className={styles.holdingHead}>
                                        前五大持股
                                    </span>
                                    {topHoldings.map((h) => (
                                        <div
                                            key={h.code}
                                            className={styles.holdingRow}
                                        >
                                            <span
                                                className={styles.holdingCode}
                                            >
                                                {h.code}
                                            </span>
                                            <div
                                                className={styles.holdingTrack}
                                            >
                                                <div
                                                    className={
                                                        styles.holdingFill
                                                    }
                                                    style={{
                                                        width: `${(Math.abs(h.value) / maxHolding) * 100}%`,
                                                    }}
                                                />
                                            </div>
                                            <span
                                                className={styles.holdingValue}
                                            >
                                                {maskMoney(
                                                    fmtCompact(h.value),
                                                    privMoney,
                                                )}
                                            </span>
                                            <span className={styles.distPct}>
                                                {(
                                                    (Math.abs(h.value) /
                                                        Math.max(
                                                            1,
                                                            Math.abs(
                                                                stockValue,
                                                            ),
                                                        )) *
                                                    100
                                                ).toFixed(1)}
                                                %
                                            </span>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function AccountPicker({
    type,
    onChanged,
}: {
    type: 'S' | 'F';
    onChanged: () => void;
}) {
    const { accounts, selectedStock, selectedFutures } = useAccounts();
    const priv = usePrivacyMode();
    useEffect(ensureAccounts, []);
    const list = accounts.filter((a) => a.account_type === type);
    if (list.length === 0) return null;
    const selected = type === 'S' ? selectedStock : selectedFutures;
    const key = selected ? `${selected.broker_id}-${selected.account_id}` : '';
    return (
        <select
            className={styles.accountSelect}
            title={type === 'S' ? '證券帳號' : '期貨帳號'}
            value={key}
            onChange={(e) => {
                const acc = list.find(
                    (a) => `${a.broker_id}-${a.account_id}` === e.target.value,
                );
                if (acc) {
                    selectAccount(acc);
                    onChanged();
                }
            }}
        >
            {list.map((a) => (
                <option
                    key={`${a.broker_id}-${a.account_id}`}
                    value={`${a.broker_id}-${a.account_id}`}
                >
                    {type === 'S' ? '證' : '期'} {a.broker_id}-
                    {maskAccountId(a.account_id, priv)}
                </option>
            ))}
        </select>
    );
}

export function BottomDock({
    positions,
    trades,
    balance,
    margin,
    onTradesChanged,
    onSelectCode,
}: {
    positions: Position[];
    trades: Trade[];
    balance?: AccountBalance;
    margin?: Margin;
    onTradesChanged: () => void;
    onSelectCode: (code: string) => void;
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
                <span className={styles.tabSpacer} />
                <AccountPicker type='S' onChanged={onTradesChanged} />
                <AccountPicker type='F' onChanged={onTradesChanged} />
            </div>
            <div className={panel.panelBody}>
                {tab === 'positions' && (
                    <PositionsTable
                        positions={positions}
                        onChanged={onTradesChanged}
                        onSelectCode={onSelectCode}
                    />
                )}
                {tab === 'orders' && (
                    <OrdersTable
                        trades={trades}
                        onChanged={onTradesChanged}
                        onSelectCode={onSelectCode}
                    />
                )}
                {tab === 'account' && (
                    <AccountView
                        balance={balance}
                        margin={margin}
                        positions={positions}
                    />
                )}
            </div>
        </div>
    );
}
