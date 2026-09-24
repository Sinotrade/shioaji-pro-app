import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
// src/components/bottom-dock.tsx — positions / orders / account tabs.
// 標題列常駐：帳戶範圍選單、合併｜分帳戶切換、市場篩選 chips、摘要列；
// 持倉/委託表本體在 bottom-dock-positions.tsx / bottom-dock-orders.tsx、
// 帳務/交割 tab 在 bottom-dock-account.tsx

import { useEffect, useState } from 'react';
import { RefreshButton } from './refresh-button';
import {
    ensureAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import { UNSIGNED_LABEL, UNSIGNED_TITLE } from '../lib/account-signing';
import {
    maskAccountId,
    maskMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import { RECONCILE_REASON_LABELS, refreshTradingState, useTradingState, type ReconcileReason } from '../lib/trading-state';

// 待對帳 names its distinct causes (#85); the tooltip keeps the full messages.
function reconcileLabel(reasons: readonly ReconcileReason[] | undefined) {
    const labels = (reasons ?? []).map(r => RECONCILE_REASON_LABELS[r]).filter(Boolean);
    if (!labels.length) return '待對帳';
    return `待對帳：${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` 等 ${labels.length} 項` : ''}`;
}
import type { Trade } from '../lib/types/order';
import type {
    AccountBalance,
    AccountedPosition,
    Margin,
} from '../lib/types/portfolio';
import { fmtMoney, fmtSigned } from '../lib/utils/format';
import { vars } from '../theme.css';
import { AccountPane, type AccountRefreshControls } from './bottom-dock-account';
import { OrdersPane } from './bottom-dock-orders';
import { PositionsPane } from './bottom-dock-positions';
import {
    accountToRef,
    isStockPosition,
    positionAccountRef,
    positionMarket,
    refKey,
    tradeAccountRef,
    tradeMarket,
    useDockPref,
    type MarketFilter,
    type ViewMode,
} from './bottom-dock-shared';
import * as styles from './bottom-dock.css';
import * as panel from './panel.css';

type TabKey = 'positions' | 'orders' | 'account';

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
    const portfolio = useTradingState();
    const [tab, setTab] = useState<TabKey>('positions');
    const [accountRefresh, setAccountRefresh] = useState<AccountRefreshControls | null>(null);
    const queryStatus = portfolio.queries[tab];
    // 操作通知已呈現改刪單結果；不在委託表重複常駐通用提示。
    const queryError = tab === 'orders'
        && queryStatus.error === '刪單／改單結果待確認；請手動更新委託，不要自動重送'
        ? null : queryStatus.error;
    const refreshing = portfolio.loading || (tab === 'account' && !!accountRefresh?.loading);
    const tabLabel = { positions: '持倉', orders: '委託', account: '帳務' }[tab];
    const refreshTab = () => {
        void refreshTradingState(tab);
        if (tab === 'account') void accountRefresh?.refresh();
    };
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
    // 帳戶範圍：'' = 全部帳戶，其餘為 broker_id-account_id。
    // scope 選項/持倉 fan-out 只用已簽署帳戶；未簽署帳戶（issue #16）另外
    // 灰字列出，讓使用者知道帳號有抓到、只是不能下單。
    const [scope, setScope] = useState('');
    const tradable = accounts.filter(
        (a) =>
            a.signed && (a.account_type === 'S' || a.account_type === 'F'),
    );
    const unsigned = accounts.filter(
        (a) =>
            !a.signed && (a.account_type === 'S' || a.account_type === 'F'),
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

    // 計數器必須跟委託清單看同一份（市場/帳戶範圍過濾後）— 否則
    // 「[0/4] 但清單顯示無委託」自相矛盾（issue #19）
    const scopedTrades = trades.filter((t) => {
        if (market !== 'all' && tradeMarket(t) !== market) return false;
        if (scope) return refKey(tradeAccountRef(t, fallback)) === scope;
        return true;
    });
    const activeOrders = scopedTrades.filter((t) =>
        remainingWorkingOrderQuantity(t) > 0,
    ).length;

    const tabs: { key: TabKey; label: string }[] = [
        { key: 'positions', label: `持倉 Positions [${positions.length}]` },
        {
            key: 'orders',
            label: `委託 Orders [${activeOrders}/${scopedTrades.length}]`,
        },
        { key: 'account', label: '帳務/交割 Account' },
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
                <span style={{ fontSize: 11, whiteSpace: 'nowrap' }} title={queryStatus.error ?? (tab === 'positions' ? '持倉依成交與行情在本機估算' : tab === 'orders' ? '委託依主動回報更新' : '帳務為上次查詢快照')}>
                    {queryStatus.needsReconcile || (tab === 'account' && accountRefresh?.error) ? reconcileLabel(queryStatus.reasons) : tab === 'positions' ? '即時估算' : tab === 'orders' ? '即時回報' : '帳務快照'}
                    {queryStatus.updatedAt ? ` · 查詢 ${new Date(queryStatus.updatedAt).toLocaleTimeString()}` : ' · 尚未查詢'}
                </span>
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
                    {unsigned.map((a) => {
                        const key = refKey(accountToRef(a));
                        return (
                            <option
                                key={key}
                                value={key}
                                disabled
                                title={UNSIGNED_TITLE}
                            >
                                {a.account_type === 'S' ? '[證]' : '[期]'}{' '}
                                {a.broker_id}-
                                {maskAccountId(a.account_id, priv)} · {UNSIGNED_LABEL}
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
                <RefreshButton label={`更新${tabLabel}`} loading={refreshing} onClick={refreshTab} />
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
            {queryError && <div role="status" style={{ padding: '4px 10px', fontSize: 12 }}>{queryError}</div>}
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
                    onShowAll={() => {
                        setMarket('all');
                        setScope('');
                    }}
                />
            )}
            {tab === 'account' && (
                <div className={panel.panelBody}>
                    <AccountPane
                        mode={mode}
                        funds={portfolio.funds}
                        // 股票市值估算要跟摘要列一樣尊重帳戶範圍 — 多帳戶時
                        // 選單一帳戶不能把別的帳戶持倉算進來
                        positions={
                            scope
                                ? positions.filter(
                                      (p) =>
                                          refKey(
                                              positionAccountRef(p, fallback),
                                          ) === scope,
                                  )
                                : positions
                        }
                        balance={balance}
                        margin={margin}
                        market={market}
                        scopeAccount={scopeAccount}
                        onRefreshControls={setAccountRefresh}
                    />
                </div>
            )}
        </div>
    );
}
