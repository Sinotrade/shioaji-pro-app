// src/components/bottom-dock.tsx — positions / orders / account tabs.
// 標題列常駐：帳戶範圍選單、合併｜分帳戶切換、市場篩選 chips、摘要列；
// 持倉/委託表本體在 bottom-dock-positions.tsx / bottom-dock-orders.tsx

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import {
    ensureAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import {
    maskAccountId,
    maskMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import { fetchSettlements, type Settlement } from '../lib/shioaji';
import type { Trade } from '../lib/types/order';
import type {
    AccountBalance,
    AccountedPosition,
    Margin,
    Position,
} from '../lib/types/portfolio';
import { fmtMoney, fmtSigned } from '../lib/utils/format';
import { vars } from '../theme.css';
import * as panel from './panel.css';
import * as styles from './bottom-dock.css';
import { OrdersPane } from './bottom-dock-orders';
import { PositionsPane } from './bottom-dock-positions';
import {
    ACTIVE_STATUSES,
    accountToRef,
    isStockPosition,
    positionAccountRef,
    positionMarket,
    refKey,
    useDockPref,
    type MarketFilter,
    type ViewMode,
} from './bottom-dock-shared';

type TabKey = 'positions' | 'orders' | 'account';

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
        // margin 全 0（模擬帳戶/沒押保證金）時 risk_indicator=0 沒有意義 —
        // 顯示 — 且不上色，避免「風險 0% 全紅」的假警報
        const riskMeaningful =
            margin.initial_margin > 0 && margin.risk_indicator > 0;
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
                value: riskMeaningful
                    ? `${margin.risk_indicator.toFixed(0)}%`
                    : '—',
                tone: !riskMeaningful
                    ? undefined
                    : margin.risk_indicator < 100
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

export function BottomDock({
    positions,
    trades,
    balance,
    margin,
    onTradesChanged,
    onSelectCode,
}: {
    positions: AccountedPosition[];
    trades: Trade[];
    balance?: AccountBalance;
    margin?: Margin;
    onTradesChanged: () => void;
    onSelectCode: (code: string) => void;
}) {
    const [tab, setTab] = useState<TabKey>('positions');
    const { accounts, selectedStock, selectedFutures } = useAccounts();
    useEffect(ensureAccounts, []);
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const [mode, setMode] = useDockPref<ViewMode>(
        'mode',
        ['merged', 'grouped'],
        'merged',
    );
    const [market, setMarket] = useDockPref<MarketFilter>(
        'market',
        ['all', 'S', 'F'],
        'all',
    );
    // 帳戶範圍：'' = 全部帳戶，其餘為 broker_id-account_id
    const [scope, setScope] = useState('');
    const tradable = accounts.filter(
        (a) => a.account_type === 'S' || a.account_type === 'F',
    );
    useEffect(() => {
        if (
            scope &&
            !tradable.some((a) => refKey(accountToRef(a)) === scope)
        ) {
            setScope('');
        }
    }, [scope, tradable]);
    const scopeAccount =
        tradable.find((a) => refKey(accountToRef(a)) === scope) ?? null;
    const fallback = { stock: selectedStock, futures: selectedFutures };

    const activeOrders = trades.filter((t) =>
        ACTIVE_STATUSES.has(t.status.status),
    ).length;

    const tabs: { key: TabKey; label: string }[] = [
        { key: 'positions', label: `持倉 Positions [${positions.length}]` },
        { key: 'orders', label: `委託 Orders [${activeOrders}/${trades.length}]` },
        { key: 'account', label: '帳務 Account' },
    ];

    // ---- 摘要列：scope＋市場篩選後的彙總 ----
    const sumRows = positions.filter((p) => {
        if (market !== 'all' && positionMarket(p) !== market) return false;
        if (scope) return refKey(positionAccountRef(p, fallback)) === scope;
        return true;
    });
    const totalPnl = sumRows.reduce((s, p) => s + p.pnl, 0);
    const stockRows = sumRows.filter(isStockPosition);
    const hasFutRows = sumRows.length !== stockRows.length;
    const stockValue = stockRows.reduce(
        (s, p) =>
            s + (p.direction === 'Sell' ? -1 : 1) * p.last_price * p.quantity,
        0,
    );
    const stockCost = stockRows.reduce(
        (s, p) => s + p.price * p.quantity,
        0,
    );
    // 期貨是保證金交易、無成本基礎 — 只有純股票視圖才給報酬率%
    const pnlPct =
        !hasFutRows && stockCost > 0 ? (totalPnl / stockCost) * 100 : null;
    const pnlDir = totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : 'flat';
    // 期貨帳戶指標只在範圍含期貨帳戶時顯示
    const showFut =
        market !== 'S' &&
        (scope === '' || scopeAccount?.account_type === 'F') &&
        !!margin;
    // margin 全 0（模擬帳戶）或沒押保證金時 risk_indicator=0 不代表「快被
    // 斷頭」— 顯示 — 且不上色；真的有部位才照 <100% 紅 / <200% 琥珀
    const riskMeaningful =
        !!margin && margin.initial_margin > 0 && margin.risk_indicator > 0;
    const riskColor =
        margin && riskMeaningful
            ? margin.risk_indicator < 100
                ? vars.color.danger
                : margin.risk_indicator < 200
                  ? vars.color.amber
                  : undefined
            : undefined;

    const marketChips: { key: MarketFilter; label: string }[] = [
        { key: 'all', label: '全部' },
        { key: 'S', label: '證券' },
        { key: 'F', label: '期貨' },
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
                <select
                    className={styles.accountSelect}
                    title='帳戶範圍（選個別帳戶會同步下單面板）'
                    value={scope}
                    onChange={(e) => {
                        const v = e.target.value;
                        setScope(v);
                        const acc = tradable.find(
                            (a) => refKey(accountToRef(a)) === v,
                        );
                        if (acc) {
                            // 個別帳戶：同步 account-store，下單面板跟著切
                            selectAccount(acc);
                            onTradesChanged();
                        }
                    }}
                >
                    <option value=''>全部帳戶</option>
                    {tradable.map((a) => {
                        const key = refKey(accountToRef(a));
                        return (
                            <option key={key} value={key}>
                                {a.account_type === 'S' ? '[證]' : '[期]'}{' '}
                                {a.broker_id}-
                                {maskAccountId(a.account_id, priv)}
                            </option>
                        );
                    })}
                </select>
                <span className={styles.ctrlGroup}>
                    <button
                        className={
                            styles.ctrlOpt[mode === 'merged' ? 'on' : 'off']
                        }
                        onClick={() => setMode('merged')}
                    >
                        合併
                    </button>
                    <button
                        className={
                            styles.ctrlOpt[mode === 'grouped' ? 'on' : 'off']
                        }
                        onClick={() => setMode('grouped')}
                    >
                        分帳戶
                    </button>
                </span>
                <span className={styles.ctrlGroup}>
                    {marketChips.map((c) => (
                        <button
                            key={c.key}
                            className={
                                styles.ctrlOpt[market === c.key ? 'on' : 'off']
                            }
                            onClick={() => setMarket(c.key)}
                        >
                            {c.label}
                        </button>
                    ))}
                </span>
            </div>
            <div className={styles.summaryRow}>
                <span className={styles.sumItem}>
                    <span className={styles.sumLabel}>總損益</span>
                    <span
                        className={`${styles.sumValue} ${panel.dirText[pnlDir]}`}
                    >
                        {maskMoney(fmtSigned(totalPnl, 0), privMoney)}
                        {pnlPct !== null && (
                            <span className={styles.sumSub}>
                                {' '}
                                ({pnlPct > 0 ? '+' : ''}
                                {pnlPct.toFixed(2)}%)
                            </span>
                        )}
                    </span>
                </span>
                {market !== 'F' && stockRows.length > 0 && (
                    <span className={styles.sumItem}>
                        <span className={styles.sumLabel}>總市值</span>
                        <span className={styles.sumValue}>
                            {maskMoney(
                                fmtMoney(Math.round(stockValue)),
                                privMoney,
                            )}
                        </span>
                    </span>
                )}
                {showFut && margin && (
                    <span className={styles.sumItem}>
                        <span className={styles.sumLabel}>期貨權益</span>
                        <span className={styles.sumValue}>
                            {maskMoney(fmtMoney(margin.equity), privMoney)}
                        </span>
                    </span>
                )}
                {showFut && margin && (
                    <span className={styles.sumItem}>
                        <span className={styles.sumLabel}>風險指標</span>
                        <span
                            className={styles.sumValue}
                            style={riskColor ? { color: riskColor } : undefined}
                        >
                            {riskMeaningful
                                ? `${margin.risk_indicator.toFixed(0)}%`
                                : '—'}
                        </span>
                    </span>
                )}
            </div>
            {tab === 'positions' && (
                <PositionsPane
                    positions={positions}
                    mode={mode}
                    market={market}
                    scopeKey={scope}
                    fallback={fallback}
                    onChanged={onTradesChanged}
                    onSelectCode={onSelectCode}
                />
            )}
            {tab === 'orders' && (
                <OrdersPane
                    trades={trades}
                    mode={mode}
                    market={market}
                    scopeKey={scope}
                    fallback={fallback}
                    onChanged={onTradesChanged}
                    onSelectCode={onSelectCode}
                />
            )}
            {tab === 'account' && (
                <div className={panel.panelBody}>
                    <AccountView
                        balance={balance}
                        margin={margin}
                        positions={positions}
                    />
                </div>
            )}
        </div>
    );
}
