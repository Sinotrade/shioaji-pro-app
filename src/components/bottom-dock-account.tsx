import { canTrade } from '../lib/account-tradable';
// src/components/bottom-dock-account.tsx — 帳務/交割 tab。
// 報表風卡片牆＋donut 改成交易工具：資金狀態緊湊數字列（含風險指標色條）、
// 交割行事曆（T+0/T+1/T+2）、今日已實現損益（可展開明細）、交易額度、
// 預收券款/圈存（查詢類 only — reserve 申請屬下單動作，刻意不做）。
// 寬版兩欄（左=資金＋交割＋額度、右=損益＋預收）、窄版單欄堆疊。

import { accountMatches } from '../lib/flash-account';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { useAccounts } from '../lib/account-store';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '../hooks/use-query';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import {
    fetchEarmarkingDetail,
    fetchInfo,
    fetchProfitLoss,
    fetchProfitLossSummary,
    fetchSettlements,
    fetchStockReserveDetail,
    fetchStockReserveSummary,
    fetchTradingLimits,
    type EarmarkStocksDetail,
    type ProfitLoss,
    type ReserveStocksDetail,
    type ReserveStocksSummary,
    type Settlement,
    type TradingLimits,
} from '../lib/shioaji';
import type {
    Account,
    AccountFunds,
    AccountBalance,
    AccountedPosition,
    Margin,
} from '../lib/types/portfolio';
import { canonicalBrokerCode, resolveRealizedName } from '../lib/realized-name';
import { bizDateLabel, settleDateLabel } from '../lib/settle-date';
import { classifyAccountQueryError, classifyBrokerQueryError, settleAccountQueries, TRADING_LIMITS_NOT_SENT } from '../lib/trading-limits-error';
import { knownServerInfo, useServerInfo } from '../lib/server-info-store';
import { getApiBase } from '../lib/runtime';
import { TRADING_LIMITS_WINDOW, twQueryWindowState, windowLabel, type TwQueryWindow } from '../lib/tw-query-window';
import { useTwQueryWindow } from '../hooks/use-tw-query-window';
import { fmtMoney, fmtSigned } from '../lib/utils/format';
import { vars } from '../theme.css';
import {
    isStockPosition,
    sizeClassOf,
    useMeasuredWidth,
    type MarketFilter,
} from './bottom-dock-shared';
import * as styles from './bottom-dock.css';
import { AsyncStatus } from './async-status';
import { AccountQueryFailure, QueryError } from './account-query-failure';
import type { QueryFailure } from '../lib/trading-state';
import * as panel from './panel.css';
import { TwPnlDetail, twRealizedQty } from './tw-account-detail';

// ---- helpers ----

function dirOfAmount(n: number): 'up' | 'down' | 'flat' {
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

function Loading({ text }: { text: string }) {
    return <AsyncStatus phase='loading' text={text} className={styles.loadingRow} />;
}

// 券商查詢「不在服務中」的灰字提示：時段外（不送查詢）或券商回時段／AS400 未連線。
// 原始錯誤只放 title 給客服回報用，畫面不顯示，避免看起來像查詢壞掉
function ClosedHint({ what, window: w }: { what: string; window: TwQueryWindow }) {
    return <span className={styles.acctHint}>{`非交易時段無${what}資料（${windowLabel(w)} 提供）`}</span>;
}

function UnavailableHint({ what, raw }: { what: string; raw: string | null }) {
    return <span className={styles.acctHint} title={raw ?? undefined}>{`券商${what}服務目前未開放`}</span>;
}

function Row({
    label,
    value,
    dir,
}: {
    label: string;
    value: string;
    dir?: 'up' | 'down' | 'flat';
}) {
    return (
        <div className={styles.fundRow}>
            <span className={styles.fundLabel}>{label}</span>
            <span
                className={`${styles.fundValue} ${dir ? panel.dirText[dir] : ''}`}
            >
                {value}
            </span>
        </div>
    );
}

// ---- 資金狀態 ----

function FundsSection({
    incomplete = false,
    balance,
    margin,
    positions,
    showStock,
    showFut,
    sim,
    privMoney,
    futuresFailure = null,
    onRetryFutures,
}: {
    futuresFailure?: { kind: QueryFailure['kind'] | null; raw: string } | null;
    onRetryFutures?: () => void;
    balance?: AccountBalance;
    margin?: Margin;
    positions: AccountedPosition[];
    showStock: boolean;
    showFut: boolean;
    sim: boolean;
    privMoney: boolean;
    incomplete?: boolean;
}) {
    const money = (n: number) => maskMoney(fmtMoney(Math.round(n)), privMoney);
    const signed = (n: number) => maskMoney(fmtSigned(n, 0), privMoney);

    // 股票市值（扣賣出方稅費估）— 沿用原帳務 tab 的估算
    const stockValue = positions
        .filter(isStockPosition)
        .reduce((s, p) => {
            const sign = p.direction === 'Sell' ? -1 : 1;
            const gross = p.last_price * p.quantity;
            const taxRate = p.code.startsWith('00') ? 0.001 : 0.003;
            return s + sign * gross * (1 - 0.001425 - taxRate);
        }, 0);

    const cash = balance?.acc_balance ?? 0;
    const futEquity = margin?.equity ?? 0;
    // 模擬環境 balance/margin 全 0 屬上游行為（server 不打真 API）—
    // 顯示「模擬模式無法查詢」小字而不是一排 $0
    const simBalanceBlank = sim && !!balance && cash === 0;
    const marginAllZero =
        !!margin &&
        margin.equity === 0 &&
        margin.initial_margin === 0 &&
        margin.available_margin === 0 &&
        margin.today_balance === 0;
    const simMarginBlank = sim && marginAllZero;

    const riskMeaningful =
        !!margin && margin.initial_margin > 0 && margin.risk_indicator > 0;
    const risk = margin?.risk_indicator ?? 0;
    const riskTone = !riskMeaningful
        ? undefined
        : risk < 100
          ? vars.color.danger
          : risk < 200
            ? vars.color.amber
            : vars.color.success; // 綠 = 安全（狀態色固定，不隨漲跌配色翻轉）

    const totalAssets =
        (showStock ? stockValue + cash : 0) + (showFut ? futEquity : 0);
    const showTotal =
        !incomplete && totalAssets > 0 &&
        ((showStock && stockValue > 0) || cash > 0 || futEquity > 0);

    const hasAny = showStock || showFut;
    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>資金狀態 Funds</div>
            {!hasAny && <span className={styles.acctHint}>無符合範圍的帳戶</span>}
            {showStock && (
                <>
                    {simBalanceBlank ? (
                        <div className={styles.fundRow}>
                            <span className={styles.fundLabel}>
                                證券交割帳戶 Balance
                            </span>
                            <span className={styles.acctHint}>
                                模擬模式無法查詢
                            </span>
                        </div>
                    ) : (
                        <Row
                            label='證券交割帳戶 Balance'
                            value={balance ? money(cash) : '—'}
                        />
                    )}
                    {stockValue !== 0 && (
                        <Row
                            label='股票市值（扣稅費估）'
                            value={money(stockValue)}
                        />
                    )}
                </>
            )}
            {showStock && showFut && !!margin && (
                <div className={styles.fundRule} />
            )}
            {showFut && !margin && (futuresFailure
                // 保證金查詢失敗且沒有上一份：不能一直顯示載入中
                ? <AccountQueryFailure what='期貨帳務' error={futuresFailure.raw} kind={futuresFailure.kind}
                    onRetry={() => onRetryFutures?.()} />
                : <Loading text='載入期貨帳務' />)}
            {showFut &&
                !!margin &&
                (simMarginBlank ? (
                    <div className={styles.fundRow}>
                        <span className={styles.fundLabel}>期貨帳務 Margin</span>
                        <span className={styles.acctHint}>模擬模式無法查詢</span>
                    </div>
                ) : (
                    <>
                        <Row label='權益數 Equity' value={money(margin.equity)} />
                        <Row
                            label='可用保證金 Available'
                            value={money(margin.available_margin)}
                        />
                        <Row
                            label='原始保證金 Initial'
                            value={money(margin.initial_margin)}
                        />
                        <Row
                            label='維持保證金 Maint.'
                            value={money(margin.maintenance_margin)}
                        />
                        {/* TAIFEX 風險指標色條：<100% 追繳風險紅、<200% 琥珀 */}
                        <div className={styles.riskRow}>
                            <span className={styles.fundLabel}>
                                風險指標 Risk
                            </span>
                            <span className={styles.riskTrack}>
                                {riskMeaningful && (
                                    <span
                                        className={styles.riskFill}
                                        style={{
                                            display: 'block',
                                            width: `${Math.min(100, (risk / 300) * 100)}%`,
                                            background: riskTone,
                                        }}
                                    />
                                )}
                            </span>
                            <span
                                className={styles.fundValue}
                                style={
                                    riskMeaningful && risk < 200
                                        ? { color: riskTone }
                                        : undefined
                                }
                            >
                                {riskMeaningful ? `${risk.toFixed(0)}%` : '—'}
                            </span>
                        </div>
                        <Row
                            label='期貨平倉損益 Settle P&L'
                            value={signed(margin.future_settle_profitloss)}
                            dir={dirOfAmount(margin.future_settle_profitloss)}
                        />
                        {/* 保留上一份保證金時的暫時性刷新失敗：灰字標示這份不是剛更新的 */}
                        {futuresFailure?.kind && (
                            <AccountQueryFailure what='期貨帳務' error={futuresFailure.raw} kind={futuresFailure.kind}
                                onRetry={() => onRetryFutures?.()} />
                        )}
                    </>
                ))}
            {showTotal && (
                <>
                    <div className={styles.fundRule} />
                    <Row label='資產市值 Total Assets' value={money(totalAssets)} />
                </>
            )}
        </section>
    );
}

// ---- 交割行事曆 ----

function SettleSection({
    settlements,
    error,
    privMoney,
    onRetry,
}: {
    settlements: Settlement[] | undefined;
    error: string | null;
    privMoney: boolean;
    onRetry: () => void;
}) {
    // 失敗時 data 維持 undefined，不能當成載入中（同 #381）；已有資料的刷新失敗保留上一份
    const failed = settlements === undefined && !!error;
    const byT = new Map((settlements ?? []).map((s) => [s.T, s]));
    // 全 0 也顯示三列（手機版預收頁日曆概念）
    const rows = [0, 1, 2].map((t) => {
        const hit = byT.get(t);
        return {
            t,
            date: hit ? settleDateLabel(hit.date) : bizDateLabel(t),
            amount: hit?.amount ?? 0,
        };
    });
    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>
                交割行事曆 Settlements
                <span className={styles.acctTitleNote}>正=應收 負=應付</span>
            </div>
            {failed ? (
                <AccountQueryFailure what='交割' error={error!} onRetry={onRetry} />
            ) : settlements === undefined ? (
                <Loading text='載入交割資訊' />
            ) : (
                rows.map((r) => (
                    <div key={r.t} className={styles.settleRow}>
                        <span className={styles.settleTag}>T+{r.t}</span>
                        <span className={styles.settleDate}>{r.date}</span>
                        <span
                            className={`${styles.settleAmount} ${panel.dirText[dirOfAmount(r.amount)]}`}
                        >
                            {maskMoney(fmtSigned(r.amount, 0), privMoney)}
                        </span>
                    </div>
                ))
            )}
            {/* 保留上一份資料時的暫時性刷新失敗：灰字標示這份不是剛更新的 */}
            {!failed && error && classifyAccountQueryError(error) && (
                <AccountQueryFailure what='交割' error={error} onRetry={onRetry} />
            )}
        </section>
    );
}

// ---- 今日已實現損益 ----

type AccountedPnl = ProfitLoss & { market: 'S' | 'F'; accountKey: string; account: Account };

const nameKey = (r: AccountedPnl) => `${r.market}:${r.code}`;

interface PnlData {
    rows: AccountedPnl[];
    total: number;
}

function PnlSection({
    pnl,
    version,
    error,
    errorKind,
    privMoney,
    onRetry,
}: {
    pnl: PnlData | undefined;
    /** 今日損益查詢時間：更新後重新展開會重查沖銷明細 */
    version: number;
    error: string | null;
    /** 已分類的錯誤種類（模擬環境不分類，一律 null） */
    errorKind: ReturnType<typeof classifyAccountQueryError>;
    privMoney: boolean;
    onRetry: () => void;
}) {
    // 失敗時 data 維持 undefined，不能當成載入中；已有資料的刷新失敗保留上一份
    const failed = pnl === undefined && !!error;
    const [open, setOpen] = useState(false);
    // 每筆展開沖銷明細（list_profit_loss_detail），同 30 日損益面板與美股
    const [detailOpen, setDetailOpen] = useState<ReadonlySet<string>>(new Set());
    const toggleDetail = (key: string) => setDetailOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    // 股名 lazy 解析：展開時才查、component 內快取，不訂閱行情。
    // 以「市場:列上代號」為 key（#240 #286）：正式環境券商損益的期貨代號不保證
    // 與合約代號一字不差，resolveRealizedName 會正規化並逐一嘗試替代格式；
    // 只查還沒有名稱的列，查不到的下次更新（重新整理／重新展開）再試。
    const [names, setNames] = useState<Record<string, string>>({});
    const wanted = useMemo(() => {
        if (!open) return [];
        const seen = new Map<string, { code: string; market: 'S' | 'F' }>();
        for (const r of pnl?.rows ?? []) {
            seen.set(nameKey(r), { code: r.code, market: r.market });
        }
        return [...seen.entries()];
    }, [open, pnl]);
    useEffect(() => {
        const missing = wanted.filter(([key]) => !names[key]);
        if (missing.length === 0) return;
        let alive = true;
        void Promise.allSettled(
            missing.map(([, r]) => resolveRealizedName(r.code, r.market)),
        ).then((rs) => {
            if (!alive) return;
            const found: Record<string, string> = {};
            rs.forEach((r, index) => {
                if (r.status === 'fulfilled' && r.value) {
                    found[missing[index]![0]] = r.value;
                }
            });
            if (Object.keys(found).length > 0) {
                setNames((prev) => ({ ...prev, ...found }));
            }
        });
        return () => {
            alive = false;
        };
        // names 只用來略過已解析的列，不能當 deps（否則每解析到一筆就重查其餘）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wanted]);

    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>今日已實現損益 Realized P&L</div>
            {failed ? (
                <AccountQueryFailure what='損益' error={error!} kind={errorKind} onRetry={onRetry} />
            ) : pnl === undefined ? (
                <Loading text='載入已實現損益' />
            ) : pnl.rows.length === 0 ? (
                <span className={styles.acctHint}>今日無已實現損益</span>
            ) : (
                <>
                    <button
                        className={styles.pnlToggle}
                        title={open ? '收合明細' : '展開明細'}
                        onClick={() => setOpen((v) => !v)}
                    >
                        {open ? (
                            <ChevronDown size={12} />
                        ) : (
                            <ChevronRight size={12} />
                        )}
                        <span
                            className={`${styles.pnlTotal} ${panel.dirText[dirOfAmount(pnl.total)]}`}
                        >
                            {maskMoney(fmtSigned(pnl.total, 0), privMoney)}
                        </span>
                        <span className={styles.pnlCount}>
                            {pnl.rows.length} 筆
                        </span>
                    </button>
                    {open &&
                        pnl.rows.map((r) => {
                            const key = `${r.accountKey}-${r.market}-${r.id}-${'dseq' in r ? r.dseq : r.date}`;
                            const rowOpen = detailOpen.has(key);
                            return (
                                <Fragment key={key}>
                                    <div
                                        className={`${styles.pnlDetailRow} ${styles.pnlDetailRowClickable}`}
                                        role='button'
                                        tabIndex={0}
                                        aria-expanded={rowOpen}
                                        title='展開沖銷明細'
                                        onClick={() => toggleDetail(key)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDetail(key); } }}
                                    >
                                        <span
                                            className={styles.pnlDetailCode}
                                            // 查不到名稱時滑過顯示券商回傳的原始代號（含看不到的字元），方便回報
                                            title={names[nameKey(r)] ? undefined : `原始代號 ${JSON.stringify(r.code)}`}
                                        >
                                            {rowOpen ? <ChevronDown size={10} aria-hidden /> : <ChevronRight size={10} aria-hidden />}
                                            {canonicalBrokerCode(r.code) || r.code}
                                        </span>
                                        <span className={styles.pnlDetailName}>
                                            {names[nameKey(r)] ?? ''}
                                        </span>
                                        <span className={styles.pnlDetailQty}>
                                            {/* 平倉筆的數量帶方向正負 — 顯示絕對值；遮金額時一併遮（#268） */}
                                            {maskMoney(twRealizedQty(r.market, r.quantity), privMoney)}
                                        </span>
                                        <span
                                            className={`${styles.pnlDetailVal} ${panel.dirText[dirOfAmount(r.pnl)]}`}
                                        >
                                            {maskMoney(fmtSigned(r.pnl, 0), privMoney)}
                                        </span>
                                    </div>
                                    {rowOpen && (
                                        <div className={styles.pnlCloseDetail}>
                                            <TwPnlDetail account={r.account} market={r.market} row={r} version={version} />
                                        </div>
                                    )}
                                </Fragment>
                            );
                        })}
                </>
            )}
            {/* 保留上一份損益時的暫時性刷新失敗：灰字標示這份不是剛更新的 */}
            {!failed && error && errorKind && (
                <AccountQueryFailure what='損益' error={error} kind={errorKind} onRetry={onRetry} />
            )}
        </section>
    );
}

// ---- 交易額度 ----

function LimitsSection({
    limits,
    error,
    closed,
    sim,
    privMoney,
    onRetry,
}: {
    limits: TradingLimits | null | undefined;
    error: string | null;
    /** 正式環境 QCredit 時段外：沒有送查詢 */
    closed: boolean;
    sim: boolean;
    privMoney: boolean;
    onRetry: () => void;
}) {
    const money = (n: number) => maskMoney(fmtMoney(n), privMoney);
    const allZero =
        !!limits &&
        Object.values(limits).every((v) => v === 0);
    // 失敗時 data 維持 undefined：不能再當成「載入中」，否則永遠卡在 Spinner（#381）。
    // 已有資料時的刷新失敗沿用 useQuery 的約定，保留上一份。
    const failed = limits === undefined && !!error;
    // 券商回時段錯誤或 AS400 未連線（夜間）都不是真的失敗
    const kind = failed ? classifyBrokerQueryError(error) : null;
    const offHours = closed || kind === 'window';
    const empty = offHours || kind === 'unavailable' || !limits || allZero;
    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>
                交易額度 Trading Limits
                <span className={styles.acctTitleNote}>
                    {windowLabel(TRADING_LIMITS_WINDOW)}
                </span>
            </div>
            {failed && !kind ? (
                <QueryError text={`交易額度查詢失敗：${error}`} onRetry={onRetry} />
            ) : limits === undefined && !kind && !offHours ? (
                <Loading text='載入交易額度' />
            ) : sim && empty ? (
                <span className={styles.acctHint}>模擬模式無法查詢</span>
            ) : kind === 'unavailable' ? (
                <UnavailableHint what='額度' raw={error} />
            ) : empty || !limits ? (
                <ClosedHint what='額度' window={TRADING_LIMITS_WINDOW} />
            ) : (
                <>
                    <Row
                        label='現股 可用/上限'
                        value={`${money(limits.trading_available)} / ${money(limits.trading_limit)}`}
                    />
                    <Row
                        label='融資 可用/上限'
                        value={`${money(limits.margin_available)} / ${money(limits.margin_limit)}`}
                    />
                    <Row
                        label='融券 可用/上限'
                        value={`${money(limits.short_available)} / ${money(limits.short_limit)}`}
                    />
                    {/* 保留上一份額度時券商 AS400 斷線：灰字標示，不進狀態列 */}
                    {error && classifyBrokerQueryError(error) === 'unavailable' && (
                        <UnavailableHint what='額度' raw={error} />
                    )}
                </>
            )}
        </section>
    );
}

// ---- 預收券款/圈存 ----

interface ReserveData {
    summary: Pick<ReserveStocksSummary, 'stocks'> | null;
    detail: Pick<ReserveStocksDetail, 'stocks'> | null;
    earmark: Pick<EarmarkStocksDetail, 'stocks'> | null;
}

function ReserveSection({
    reserve,
    error,
    sim,
    privMoney,
    onRetry,
}: {
    reserve: ReserveData | undefined;
    error: string | null;
    sim: boolean;
    privMoney: boolean;
    onRetry: () => void;
}) {
    let body;
    // 失敗時 data 維持 undefined，不能當成載入中（同 #381）；已有資料的刷新失敗保留上一份
    if (reserve === undefined && error && !sim) {
        body = <AccountQueryFailure what='預收' error={error} onRetry={onRetry} />;
    } else if (reserve === undefined && !(error && sim)) {
        body = <Loading text='載入預收資訊' />;
    } else if (sim || !reserve) {
        // 模擬環境不支援預收（API 回空或錯誤都歸到這個提示）
        body = (
            <span className={styles.acctHint}>模擬模式不支援預收券款</span>
        );
    } else if (!reserve.summary && !reserve.detail && !reserve.earmark) {
        // 三個查詢全失敗 — graceful 灰字，不紅字報錯
        body = (
            <span className={styles.acctHint}>暫時無法查詢預收資訊</span>
        );
    } else {
        const sumRows = reserve.summary?.stocks ?? [];
        const detRows = reserve.detail?.stocks ?? [];
        const earRows = reserve.earmark?.stocks ?? [];
        if (
            sumRows.length === 0 &&
            detRows.length === 0 &&
            earRows.length === 0
        ) {
            body = (
                <span className={styles.acctHint}>
                    目前無可預收股票與預收紀錄
                </span>
            );
        } else {
            body = (
                <>
                    {sumRows.length > 0 && (
                        <>
                            <span className={styles.rsvHead}>
                                可預收股票（可預收/已預收）
                            </span>
                            {sumRows.map((s, i) => (
                                <div
                                    key={`${s.contract.code}-${i}`}
                                    className={styles.rsvRow}
                                >
                                    <span>{s.contract.code}</span>
                                    <span className={styles.rsvInfo} />
                                    <span className={styles.rsvVal}>
                                        {maskMoney(`${s.available_share.toLocaleString()} / ${s.reserved_share.toLocaleString()} 股`, privMoney)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                    {detRows.length > 0 && (
                        <>
                            <span className={styles.rsvHead}>預收券款明細</span>
                            {detRows.map((s, i) => (
                                <div
                                    key={`${s.contract.code}-${i}`}
                                    className={styles.rsvRow}
                                >
                                    <span>{s.contract.code}</span>
                                    <span
                                        className={styles.rsvInfo}
                                        title={s.info}
                                    >
                                        {s.status ? '成功' : '失敗'}
                                        {s.info ? `・${s.info}` : ''}
                                    </span>
                                    <span className={styles.rsvVal}>
                                        {maskMoney(`${s.share.toLocaleString()} 股`, privMoney)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                    {earRows.length > 0 && (
                        <>
                            <span className={styles.rsvHead}>
                                圈存（預收款項）明細
                            </span>
                            {earRows.map((s, i) => (
                                <div
                                    key={`${s.contract.code}-${i}`}
                                    className={styles.rsvRow}
                                >
                                    <span>{s.contract.code}</span>
                                    <span
                                        className={styles.rsvInfo}
                                        title={s.info}
                                    >
                                        {s.status ? '成功' : '失敗'}
                                        {s.info ? `・${s.info}` : ''}
                                    </span>
                                    <span className={styles.rsvVal}>
                                        {maskMoney(`${s.share.toLocaleString()} 股`, privMoney)}・
                                        {maskMoney(
                                            fmtMoney(s.amount),
                                            privMoney,
                                        )}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}
                </>
            );
        }
    }
    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>
                預收券款/圈存 Reserve
                <span className={styles.acctTitleNote}>查詢</span>
            </div>
            {body}
            {/* 保留上一份資料時的暫時性刷新失敗：灰字標示這份不是剛更新的 */}
            {reserve !== undefined && !sim && error && classifyAccountQueryError(error) && (
                <AccountQueryFailure what='預收' error={error} onRetry={onRetry} />
            )}
        </section>
    );
}

// ---- pane 本體 ----

export interface AccountRefreshControls {
    refresh: () => Promise<void>;
    loading: boolean;
    error: string | null;
}

interface AccountPaneProps {
    positions: AccountedPosition[];
    balance?: AccountBalance;
    margin?: Margin;
    funds?: AccountFunds[];
    market: MarketFilter;
    scopeAccount: Account | null;
    mode?: 'merged' | 'grouped';
    onRefreshControls?: (controls: AccountRefreshControls | null) => void;
    /** 重查資金（餘額／保證金）；期貨保證金查詢失敗的重試按鈕用 */
    onRetryFunds?: () => void;
}
export function AccountPane(props: AccountPaneProps) {
    const { accounts } = useAccounts();
    const privacy = usePrivacyMode();
    const visible = accounts.filter(a => canTrade(a) && (a.account_type === 'S' || a.account_type === 'F')
        && (props.market === 'all' || a.account_type === props.market)
        && (!props.scopeAccount || accountMatches(a, props.scopeAccount)));
    const key = visible.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}`).sort().join('|');
    const [controls, setControls] = useState<Record<string, AccountRefreshControls>>({});
    const callbacks = useMemo(() => Object.fromEntries(visible.map(a => {
        const id = `${a.account_type}:${a.broker_id}:${a.account_id}`;
        return [id, (control: AccountRefreshControls | null) => setControls(previous => {
            const next = { ...previous };
            if (control) next[id] = control; else delete next[id];
            return next;
        })];
    })), [key]);
    const grouped = props.mode === 'grouped' && !props.scopeAccount;
    useEffect(() => {
        if (!grouped) return;
        const current = Object.entries(controls).filter(([id]) => id in callbacks).map(([, c]) => c);
        props.onRefreshControls?.({ refresh: async () => { await Promise.all(current.map(c => c.refresh())); },
            loading: current.some(c => c.loading), error: current.map(c => c.error).filter(Boolean).join('；') || null });
        return () => props.onRefreshControls?.(null);
    }, [grouped, controls, callbacks, props.onRefreshControls]);
    if (!visible.length) return <div role="status">無符合範圍的帳戶</div>;
    if (!grouped) return <AccountPaneContent {...props} />;
    return <>{visible.map(account => {
        const id = `${account.account_type}:${account.broker_id}:${account.account_id}`;
        return <section key={id}>
            <h3>{account.account_type === 'F' ? '期貨' : '證券'} {account.broker_id}-{maskAccountId(account.account_id, privacy)}</h3>
            <AccountPaneContent {...props} scopeAccount={account}
                positions={props.positions.filter(p => accountMatches(p.account, account))}
                onRefreshControls={callbacks[id]} />
        </section>;
    })}{!visible.length && <div role="status">無符合範圍的帳戶</div>}</>;
}

function AccountPaneContent({ positions, balance, margin, funds, market, scopeAccount, onRefreshControls, onRetryFunds }: AccountPaneProps) {
    const privMoney = usePrivacyMoney();
    const { ref, width } = useMeasuredWidth();
    const wide = sizeClassOf(width) === 'wide';

    // 模擬環境判斷：空狀態文案（無法查詢 vs 非交易時段）與額度時段閘門靠這個分流。
    // 以共用的 server-info store 為準（sidecar 換模式重啟時會被清掉，這裡跟著重問）；
    // store 沒資料時用自己問到的結果。undefined＝還沒問到；問不到（null）當正式環境處理
    const storeInfo = useServerInfo();
    const apiBase = getApiBase();
    // 自己問到的結果綁定 API 位址：換伺服器後，前一台晚到的回應不能拿來當這台的模式
    const [fetched, setFetched] = useState<{ base: string; simulation: boolean | null } | undefined>(undefined);
    const storeKnown = !!storeInfo;
    // store 被清掉（同位址 sidecar 換模式重啟等）時，先前自己問到的模式立刻作廢 —
    // 在 render 期間處理，避免同一次 commit 的查詢 effect 拿舊的「模擬」放行
    const [prevStoreKnown, setPrevStoreKnown] = useState(storeKnown);
    if (prevStoreKnown !== storeKnown) {
        setPrevStoreKnown(storeKnown);
        setFetched(undefined);
    }
    useEffect(() => {
        if (storeKnown) return;
        let alive = true;
        fetchInfo()
            .then((i) => {
                if (alive) setFetched({ base: apiBase, simulation: i.simulation });
            })
            .catch(() => {
                if (alive) setFetched({ base: apiBase, simulation: null });
            });
        return () => {
            alive = false;
        };
    }, [storeKnown, apiBase]);
    const simulation = storeInfo ? storeInfo.simulation : fetched?.base === apiBase ? fetched.simulation : undefined;
    const sim = simulation === true;
    const infoKnown = simulation !== undefined;

    // 交易額度（QCredit）只在交易日 08:30–15:00 有服務：正式環境時段外不送查詢，
    // 計時器到邊界時自動開查（不輪詢）。模擬環境隨時可查。cache key 帶交易日，
    // 每個交易日時段開始時重查一次，不沿用前一天的快照
    const limitsWindow = useTwQueryWindow(TRADING_LIMITS_WINDOW);
    const limitsEnabled = infoKnown && (sim || limitsWindow.open);
    const limitsClosed = infoKnown && !sim && !limitsWindow.open;
    const limitsSession = sim ? 'sim' : limitsWindow.sessionDate ?? 'closed';

    // 全域帳戶範圍：scope 選 [期] 只顯示期貨區塊、[證] 只顯示證券區塊；
    // 市場篩選 chips 同樣生效
    const showStock =
        market !== 'F' && (!scopeAccount || scopeAccount.account_type === 'S');
    const showFut =
        market !== 'S' && (!scopeAccount || scopeAccount.account_type === 'F');

    const { accounts } = useAccounts();
    const queryAccounts = accounts.filter(a => canTrade(a) && (a.account_type === 'S' || a.account_type === 'F')
        && (!scopeAccount || (a.account_type === scopeAccount.account_type && a.broker_id === scopeAccount.broker_id && a.account_id === scopeAccount.account_id))
        && (a.account_type === 'S' ? showStock : showFut));
    const stockAccounts = queryAccounts.filter(a => a.account_type === 'S');
    const selKey = queryAccounts.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}`).sort().join('|');

    const selectedFunds = funds?.filter(row => queryAccounts.some(a => accountMatches(a, row.account)));
    const fundsIncomplete = !!funds && (selectedFunds!.length !== queryAccounts.length
        || selectedFunds!.some(row => row.error || (row.account.account_type === 'S' ? !row.balance || !!row.balance.errmsg?.trim() : !row.margin)));
    if (funds) {
        const stockFunds = selectedFunds!.filter(row => row.account.account_type === 'S');
        const futureFunds = selectedFunds!.filter(row => row.account.account_type === 'F');
        balance = stockFunds.length === stockAccounts.length && stockFunds.length > 0 && stockFunds.every(row => row.balance && !row.balance.errmsg?.trim() && !row.error)
            ? { acc_balance: stockFunds.reduce((sum, row) => sum + row.balance!.acc_balance, 0), date: stockFunds[0]!.balance!.date, errmsg: '' } : undefined;
        const expectedFutures = queryAccounts.filter(a => a.account_type === 'F').length;
        // 保證金暫時性失敗（errorKind）保留該帳戶上一份，區塊內有灰字；真錯誤仍不合計
        if (futureFunds.length === expectedFutures && expectedFutures > 0 && futureFunds.every(row => row.margin && (!row.error || row.errorKind))) {
            margin = { ...futureFunds[0]!.margin! };
            for (const field of Object.keys(margin) as (keyof Margin)[]) {
                margin[field] = futureFunds.reduce((sum, row) => sum + row.margin![field], 0);
            }
            if (futureFunds.length > 1) { margin.risk_indicator = 0; margin.plus_margin_indicator = 0; }
        } else margin = undefined;
    }

    // 期貨保證金查詢失敗：全是暫時性／未開放才給分類，夾一筆真錯誤就是紅字
    const failedFutures = (selectedFunds ?? []).filter(row => row.account.account_type === 'F' && row.error);
    const futuresFailure = failedFutures.length === 0 ? null : {
        kind: failedFutures.every(row => row.errorKind)
            ? (failedFutures.every(row => row.errorKind === 'unavailable') ? 'unavailable' as const : 'temporary' as const)
            : null,
        raw: [...new Set(failedFutures.map(row => row.rawError ?? row.error!))].join('；'),
    };

    // 只篩掉不在範圍內市場的持倉（股票市值估算用）
    const scopedPositions = useMemo(
        () =>
            positions.filter((p) =>
                isStockPosition(p) ? showStock : showFut,
            ),
        [positions, showStock, showFut],
    );

    // 交割行事曆（證券）
    const { data: settlements, refresh: refreshSettle, loading: loadingSettle, error: errorSettle } = useQuery<
        Settlement[]
    >(
        useCallback(
            () =>
                settleAccountQueries(stockAccounts.map(a => fetchSettlements(a))).then(results => {
                    const sums = new Map<string, Settlement>();
                    for (const row of results.flat()) {
                        const key = `${row.T}`;
                        const previous = sums.get(key);
                        if (previous && previous.date !== row.date) throw new Error('帳戶交割日期不一致，合計待確認');
                        sums.set(key, { ...row, amount: (previous?.amount ?? 0) + row.amount });
                    }
                    return [...sums.values()];
                }),
            [showStock, selKey],
        ),
        `settlements:${selKey}:${showStock}`,
        true, stockAccounts,
    );

    // 今日已實現損益：profit_loss 給列表/筆數；profitloss_sum 給權威總額。
    // 模擬環境 sum 回全 0 但 profit_loss 有 paper 資料 — 以列表加總 fallback。
    // fallback 逐市場判斷：證/期各自「sum 有料就用 sum、沒料就加總列表」，
    // 避免一個市場 sum 有效、另一個只有列表時總額漏掉後者的筆數
    const pnlFetcher = useCallback(async (): Promise<PnlData> => {
        const rows: AccountedPnl[] = [];
        let total = 0;
        // 全部帳戶、列表與總額都等完：先到的暫時性錯誤不能蓋掉同批裡的真錯誤
        await settleAccountQueries(
            queryAccounts.map(async (account) => {
                const m = account.account_type as 'S' | 'F';
                const sel = account;
                const [list, sum] = await settleAccountQueries([
                    // 股票用股數（Share）：Common 會把零股截成 0 張
                    fetchProfitLoss(m, sel, undefined, undefined, m === 'S' ? 'Share' : undefined),
                    fetchProfitLossSummary(m, sel),
                ]);
                for (const r of list) rows.push({ ...r, market: m, accountKey: `${account.broker_id}:${account.account_id}`, account });
                const haveSum =
                    sum &&
                    (sum.total.pnl !== 0 || sum.profitloss_sum.length > 0);
                total += haveSum
                    ? sum.total.pnl
                    : list.reduce((s, r) => s + r.pnl, 0);
            }),
        );
        rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
        return { rows, total };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showStock, showFut, selKey]);
    const { data: pnl, refresh: refreshPnl, loading: loadingPnl, error: errorPnl, updatedAt: pnlUpdatedAt } = useQuery<PnlData>(
        pnlFetcher,
        `realized-pnl:${selKey}:${showStock}:${showFut}`,
        true, queryAccounts,
    );

    // 交易額度（證券）
    const { data: limits, refresh: refreshLimits, loading: loadingLimits, error: errorLimits } = useQuery<TradingLimits | null>(
        useCallback(
            () => {
                // 送出當下再確認一次時段：React 狀態可能比牆鐘晚（計時器延後、睡眠喚醒），
                // 傳輸層準備（啟動讀取閘門、Tauri 載入）也可能把實際送出拖過 15:00
                const guard = () => {
                    // 送出當下的模式以共用 store 為準（若已知）
                    const simNow = knownServerInfo()?.simulation ?? sim;
                    if (simNow !== true && !twQueryWindowState(Date.now(), TRADING_LIMITS_WINDOW).open) {
                        throw new Error(TRADING_LIMITS_NOT_SENT);
                    }
                };
                try { guard(); } catch (e) { return Promise.reject(e); }
                return Promise.all(stockAccounts.map(a => fetchTradingLimits(a, guard))).then(results => {
                    if (!results.length) return null;
                    const total: TradingLimits = { ...results[0]! };
                    for (const key of Object.keys(total) as (keyof TradingLimits)[]) total[key] = results.reduce((sum, row) => sum + row[key], 0);
                    return total;
                });
            },
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [showStock, selKey, sim],
        ),
        `trading-limits:${selKey}:${showStock}:${limitsSession}`,
        limitsEnabled, stockAccounts,
    );

    // 預收券款/圈存（證券、查詢類）— 個別 catch，任一失敗不拖垮整區
    const { data: reserve, refresh: refreshReserve, loading: loadingReserve, error: errorReserve } = useQuery<ReserveData>(
        useCallback(async () => {
            if (!showStock) {
                return { summary: null, detail: null, earmark: null };
            }
            const batches = await settleAccountQueries(stockAccounts.map(async account => {
                const [summary, detail, earmark] = await settleAccountQueries([
                    fetchStockReserveSummary(account), fetchStockReserveDetail(account), fetchEarmarkingDetail(account),
                ]);
                return { summary, detail, earmark };
            }));
            const first = batches[0];
            if (!first) return { summary: null, detail: null, earmark: null };
            return {
                summary: { stocks: batches.flatMap(b => b.summary.stocks) },
                detail: { stocks: batches.flatMap(b => b.detail.stocks) },
                earmark: { stocks: batches.flatMap(b => b.earmark.stocks) },
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [showStock, selKey]),
        `reserves:${selKey}:${showStock}`,
        true, stockAccounts,
    );

    const refreshReports = useCallback(async () => {
        await Promise.all([refreshSettle(), refreshPnl(), refreshLimits(), refreshReserve()]);
    }, [refreshSettle, refreshPnl, refreshLimits, refreshReserve]);
    const reportsLoading = loadingSettle || loadingPnl || loadingLimits || loadingReserve;
    // 額度時段外是預期狀態，區塊內已有提示，不算報表錯誤（#381）。保留上一份額度時
    // 畫面沒有提示，刷新失敗仍要留在狀態列，否則舊資料看起來像剛更新
    // 額度時段外／AS400 未連線，交割、預收的暫時性失敗都是預期狀態，區塊內已有灰字提示，
    // 不算報表錯誤（#381）。保留上一份資料時畫面沒有提示，刷新失敗仍要留在狀態列，
    // 否則舊資料看起來像剛更新
    // 額度保留舊資料時只有 AS400 斷線在區塊內有灰字；時段錯誤仍留狀態列（#381）
    const limitsKind = classifyBrokerQueryError(errorLimits);
    const limitsExpected = limits === undefined ? !!limitsKind : limitsKind === 'unavailable';
    // 交割、預收、損益的暫時性失敗不論有無舊資料，區塊內都有灰字提示
    const settleExpected = !!classifyAccountQueryError(errorSettle);
    const reserveExpected = !!classifyAccountQueryError(errorReserve);
    // 今日已實現損益（TKAP01 損益後台／r6）同交割：暫時性失敗區塊內有灰字。
    // 模擬環境不走券商後台，錯誤照舊（不分類）
    const pnlKind = sim ? null : classifyAccountQueryError(errorPnl);
    const pnlExpected = !!pnlKind;
    const reportsError = [
        settleExpected ? null : errorSettle,
        pnlExpected ? null : errorPnl,
        limitsExpected ? null : errorLimits,
        reserveExpected ? null : errorReserve,
    ].filter(Boolean).join('；') || null;
    useEffect(() => {
        onRefreshControls?.({ refresh: refreshReports, loading: reportsLoading, error: reportsError });
        return () => onRefreshControls?.(null);
    }, [onRefreshControls, refreshReports, reportsLoading, reportsError]);

    const left = (
        <div className={styles.acctCol}>
            {fundsIncomplete && <div role="status">部分帳戶資金尚未取得或查詢失敗；合計待確認</div>}
            {!scopeAccount && queryAccounts.filter(a => a.account_type === 'F').length > 1 && <div role="status">多帳戶風險比例不合計，請切換分帳戶檢視</div>}
            <FundsSection
                incomplete={fundsIncomplete}
                balance={balance}
                margin={margin}
                positions={scopedPositions}
                showStock={showStock}
                showFut={showFut}
                sim={sim}
                privMoney={privMoney}
                futuresFailure={futuresFailure}
                onRetryFutures={onRetryFunds}
            />
            {showStock && (
                <SettleSection
                    settlements={settlements}
                    error={errorSettle}
                    privMoney={privMoney}
                    onRetry={() => void refreshSettle()}
                />
            )}
            {showStock && (
                <LimitsSection
                    limits={limits}
                    error={errorLimits}
                    closed={limitsClosed}
                    sim={sim}
                    privMoney={privMoney}
                    onRetry={() => void refreshLimits()}
                />
            )}
        </div>
    );
    const right = (
        <div className={styles.acctCol}>
            <PnlSection pnl={pnl} version={pnlUpdatedAt ?? 0} error={errorPnl} errorKind={pnlKind} privMoney={privMoney} onRetry={() => void refreshPnl()} />
            {showStock && (
                <ReserveSection
                    reserve={reserve}
                    error={errorReserve}
                    sim={sim}
                    privMoney={privMoney}
                    onRetry={() => void refreshReserve()}
                />
            )}
        </div>
    );

    return (
        <div ref={ref}>
            {reportsError && <span role="status">{reportsError}</span>}
            <div
                className={`${styles.acctWrap} ${wide ? styles.acctWrapWide : ''}`}
            >
                {left}
                {right}
            </div>
        </div>
    );
}

// 美股帳務在 us-account-panels.tsx（UsAccountSection）
export { UsAccountSection } from './us-account-panels';
