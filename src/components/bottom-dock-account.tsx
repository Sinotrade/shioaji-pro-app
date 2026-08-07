// src/components/bottom-dock-account.tsx — 帳務/交割 tab。
// 報表風卡片牆＋donut 改成交易工具：資金狀態緊湊數字列（含風險指標色條）、
// 交割行事曆（T+0/T+1/T+2）、今日已實現損益（可展開明細）、交易額度、
// 預收券款/圈存（查詢類 only — reserve 申請屬下單動作，刻意不做）。
// 寬版兩欄（左=資金＋交割＋額度、右=損益＋預收）、窄版單欄堆疊。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
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
    resolveContract,
    type AccountSelector,
    type EarmarkStocksDetail,
    type ProfitLoss,
    type ReserveStocksDetail,
    type ReserveStocksSummary,
    type Settlement,
    type TradingLimits,
} from '../lib/shioaji';
import type {
    Account,
    AccountBalance,
    AccountedPosition,
    Margin,
} from '../lib/types/portfolio';
import { fmtMoney, fmtSigned } from '../lib/utils/format';
import { vars } from '../theme.css';
import * as panel from './panel.css';
import * as styles from './bottom-dock.css';
import {
    isStockPosition,
    sizeClassOf,
    useMeasuredWidth,
    type MarketFilter,
} from './bottom-dock-shared';
import { Orb } from './orb';

// ---- helpers ----

function dirOfAmount(n: number): 'up' | 'down' | 'flat' {
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// T+n 的預估交割日（跳過週末；國定假日無法本地判斷，僅供全 0 佔位列）
function bizDateLabel(offset: number): string {
    const d = new Date();
    let left = offset;
    while (left > 0) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
        d.getDate(),
    ).padStart(2, '0')} (${WEEKDAYS[d.getDay()]})`;
}

// server 回的 date（YYYY-MM-DD）→ MM/DD (週X)；不可解析就原样顯示
function settleDateLabel(raw: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!m) return raw;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return `${m[2]}/${m[3]} (${WEEKDAYS[d.getDay()]})`;
}

function Loading({ text }: { text: string }) {
    return (
        <span className={styles.loadingRow}>
            <Orb size={12} />
            {text}
        </span>
    );
}

function Row({
    label,
    value,
    dir,
    tone,
}: {
    label: string;
    value: string;
    dir?: 'up' | 'down' | 'flat';
    tone?: 'danger' | 'warn';
}) {
    return (
        <div className={styles.fundRow}>
            <span className={styles.fundLabel}>{label}</span>
            <span
                className={`${styles.fundValue} ${dir ? panel.dirText[dir] : ''}`}
                style={
                    tone
                        ? {
                              color:
                                  tone === 'danger'
                                      ? vars.color.danger
                                      : vars.color.amber,
                          }
                        : undefined
                }
            >
                {value}
            </span>
        </div>
    );
}

// ---- 資金狀態 ----

function FundsSection({
    balance,
    margin,
    positions,
    showStock,
    showFut,
    sim,
    privMoney,
}: {
    balance?: AccountBalance;
    margin?: Margin;
    positions: AccountedPosition[];
    showStock: boolean;
    showFut: boolean;
    sim: boolean;
    privMoney: boolean;
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
            : vars.color.down; // 綠 = 安全（台股綠跌語彙外，安全狀態沿用綠）

    const totalAssets =
        (showStock ? stockValue + cash : 0) + (showFut ? futEquity : 0);
    const showTotal =
        totalAssets > 0 &&
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
            {showFut && !margin && <Loading text='載入期貨帳務' />}
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
    privMoney,
}: {
    settlements: Settlement[] | undefined;
    privMoney: boolean;
}) {
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
            {settlements === undefined ? (
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
        </section>
    );
}

// ---- 今日已實現損益 ----

type AccountedPnl = ProfitLoss & { market: 'S' | 'F' };

interface PnlData {
    rows: AccountedPnl[];
    total: number;
}

function PnlSection({
    pnl,
    privMoney,
}: {
    pnl: PnlData | undefined;
    privMoney: boolean;
}) {
    const [open, setOpen] = useState(false);
    // 股名 lazy 解析：展開時才查、component 內快取，不訂閱行情
    const [names, setNames] = useState<Record<string, string>>({});
    const codesKey = useMemo(
        () => (open ? [...new Set((pnl?.rows ?? []).map((r) => r.code))] : []),
        [open, pnl],
    );
    useEffect(() => {
        if (codesKey.length === 0) return;
        let alive = true;
        void Promise.allSettled(
            codesKey.map((code) => resolveContract(code)),
        ).then((rs) => {
            if (!alive) return;
            setNames((prev) => {
                const next = { ...prev };
                for (const r of rs) {
                    if (r.status === 'fulfilled' && r.value.name) {
                        next[r.value.code] = r.value.name;
                    }
                }
                return next;
            });
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey.join(',')]);

    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>今日已實現損益 Realized P&L</div>
            {pnl === undefined ? (
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
                        pnl.rows.map((r) => (
                            <div
                                key={`${r.market}-${r.id}-${'dseq' in r ? r.dseq : r.date}`}
                                className={styles.pnlDetailRow}
                            >
                                <span>{r.code}</span>
                                <span className={styles.pnlDetailName}>
                                    {names[r.code] ?? ''}
                                </span>
                                <span className={styles.pnlDetailQty}>
                                    {/* 平倉筆的數量帶方向正負 — 顯示絕對值 */}
                                    {Math.abs(r.quantity).toLocaleString()}
                                    {r.market === 'S' ? '張' : '口'}
                                </span>
                                <span
                                    className={`${styles.pnlDetailVal} ${panel.dirText[dirOfAmount(r.pnl)]}`}
                                >
                                    {maskMoney(fmtSigned(r.pnl, 0), privMoney)}
                                </span>
                            </div>
                        ))}
                </>
            )}
        </section>
    );
}

// ---- 交易額度 ----

function LimitsSection({
    limits,
    loading,
    sim,
    privMoney,
}: {
    limits: TradingLimits | null | undefined;
    loading: boolean;
    sim: boolean;
    privMoney: boolean;
}) {
    const money = (n: number) => maskMoney(fmtMoney(n), privMoney);
    const allZero =
        !!limits &&
        Object.values(limits).every((v) => v === 0);
    return (
        <section className={styles.acctSection}>
            <div className={styles.acctTitle}>
                交易額度 Trading Limits
                <span className={styles.acctTitleNote}>
                    交易日 08:30–15:00
                </span>
            </div>
            {loading || limits === undefined ? (
                <Loading text='載入交易額度' />
            ) : sim && (limits === null || allZero) ? (
                <span className={styles.acctHint}>模擬模式無法查詢</span>
            ) : limits === null || allZero ? (
                <span className={styles.acctHint}>
                    非交易時段無額度資料（交易日 08:30–15:00 提供）
                </span>
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
                </>
            )}
        </section>
    );
}

// ---- 預收券款/圈存 ----

interface ReserveData {
    summary: ReserveStocksSummary | null;
    detail: ReserveStocksDetail | null;
    earmark: EarmarkStocksDetail | null;
}

function ReserveSection({
    reserve,
    sim,
    privMoney,
}: {
    reserve: ReserveData | undefined;
    sim: boolean;
    privMoney: boolean;
}) {
    let body;
    if (reserve === undefined) {
        body = <Loading text='載入預收資訊' />;
    } else if (sim) {
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
                            {sumRows.map((s) => (
                                <div
                                    key={s.contract.code}
                                    className={styles.rsvRow}
                                >
                                    <span>{s.contract.code}</span>
                                    <span className={styles.rsvInfo} />
                                    <span className={styles.rsvVal}>
                                        {s.available_share.toLocaleString()} /{' '}
                                        {s.reserved_share.toLocaleString()} 股
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
                                        {s.share.toLocaleString()} 股
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
                                        {s.share.toLocaleString()} 股・
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
        </section>
    );
}

// ---- pane 本體 ----

export function AccountPane({
    positions,
    balance,
    margin,
    market,
    scopeAccount,
}: {
    positions: AccountedPosition[];
    balance?: AccountBalance;
    margin?: Margin;
    market: MarketFilter;
    scopeAccount: Account | null;
}) {
    const privMoney = usePrivacyMoney();
    const { ref, width } = useMeasuredWidth();
    const wide = sizeClassOf(width) === 'wide';

    // 模擬環境判斷：空狀態文案（無法查詢 vs 非交易時段）靠這個分流
    const [simulation, setSimulation] = useState<boolean | null>(null);
    useEffect(() => {
        let alive = true;
        fetchInfo()
            .then((i) => {
                if (alive) setSimulation(i.simulation);
            })
            .catch(() => {
                if (alive) setSimulation(null);
            });
        return () => {
            alive = false;
        };
    }, []);
    const sim = simulation === true;

    // 全域帳戶範圍：scope 選 [期] 只顯示期貨區塊、[證] 只顯示證券區塊；
    // 市場篩選 chips 同樣生效
    const showStock =
        market !== 'F' && (!scopeAccount || scopeAccount.account_type === 'S');
    const showFut =
        market !== 'S' && (!scopeAccount || scopeAccount.account_type === 'F');

    const stockSel: AccountSelector | undefined =
        scopeAccount?.account_type === 'S'
            ? {
                  broker_id: scopeAccount.broker_id,
                  account_id: scopeAccount.account_id,
              }
            : undefined;
    const selKey = `${scopeAccount?.broker_id ?? ''}-${scopeAccount?.account_id ?? ''}`;

    // 只篩掉不在範圍內市場的持倉（股票市值估算用）
    const scopedPositions = useMemo(
        () =>
            positions.filter((p) =>
                isStockPosition(p) ? showStock : showFut,
            ),
        [positions, showStock, showFut],
    );

    // 交割行事曆（證券）
    const { data: settlements, refresh: refreshSettle } = usePoll<
        Settlement[]
    >(
        useCallback(
            () =>
                showStock
                    ? fetchSettlements().catch(() => [])
                    : Promise.resolve([]),
            [showStock],
        ),
        60000,
    );

    // 今日已實現損益：profit_loss 給列表/筆數；profitloss_sum 給權威總額。
    // 模擬環境 sum 回全 0 但 profit_loss 有 paper 資料 — 以列表加總 fallback
    const pnlFetcher = useCallback(async (): Promise<PnlData> => {
        const markets: ('S' | 'F')[] = [];
        if (showStock) markets.push('S');
        if (showFut) markets.push('F');
        const rows: AccountedPnl[] = [];
        let sumTotal = 0;
        let haveSum = false;
        await Promise.all(
            markets.map(async (m) => {
                const sel =
                    scopeAccount && scopeAccount.account_type === m
                        ? {
                              broker_id: scopeAccount.broker_id,
                              account_id: scopeAccount.account_id,
                          }
                        : undefined;
                const [list, sum] = await Promise.all([
                    fetchProfitLoss(m, sel).catch(
                        () => [] as ProfitLoss[],
                    ),
                    fetchProfitLossSummary(m, sel).catch(() => null),
                ]);
                for (const r of list) rows.push({ ...r, market: m });
                if (
                    sum &&
                    (sum.total.pnl !== 0 || sum.profitloss_sum.length > 0)
                ) {
                    haveSum = true;
                    sumTotal += sum.total.pnl;
                }
            }),
        );
        rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
        return {
            rows,
            total: haveSum
                ? sumTotal
                : rows.reduce((s, r) => s + r.pnl, 0),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showStock, showFut, selKey]);
    const { data: pnl, refresh: refreshPnl } = usePoll<PnlData>(
        pnlFetcher,
        30000,
    );

    // 交易額度（證券）
    const { data: limits, refresh: refreshLimits } = usePoll<TradingLimits | null>(
        useCallback(
            () =>
                showStock
                    ? fetchTradingLimits(stockSel).catch(() => null)
                    : Promise.resolve(null),
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [showStock, selKey],
        ),
        60000,
    );

    // 預收券款/圈存（證券、查詢類）— 個別 catch，任一失敗不拖垮整區
    const { data: reserve, refresh: refreshReserve } = usePoll<ReserveData>(
        useCallback(async () => {
            if (!showStock) {
                return { summary: null, detail: null, earmark: null };
            }
            const [summary, detail, earmark] = await Promise.all([
                fetchStockReserveSummary(stockSel).catch(() => null),
                fetchStockReserveDetail(stockSel).catch(() => null),
                fetchEarmarkingDetail(stockSel).catch(() => null),
            ]);
            return { summary, detail, earmark };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [showStock, selKey]),
        60000,
    );

    // usePoll 換 fetcher 不會立即重跑（interval 綁定 stable run）—
    // 帳戶範圍/市場篩選切換時主動 refresh，不等下一個 tick
    useEffect(() => {
        refreshSettle();
        refreshPnl();
        refreshLimits();
        refreshReserve();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selKey, showStock, showFut]);

    const left = (
        <div className={styles.acctCol}>
            <FundsSection
                balance={balance}
                margin={margin}
                positions={scopedPositions}
                showStock={showStock}
                showFut={showFut}
                sim={sim}
                privMoney={privMoney}
            />
            {showStock && (
                <SettleSection
                    settlements={settlements}
                    privMoney={privMoney}
                />
            )}
            {showStock && (
                <LimitsSection
                    limits={limits}
                    loading={limits === undefined}
                    sim={sim}
                    privMoney={privMoney}
                />
            )}
        </div>
    );
    const right = (
        <div className={styles.acctCol}>
            <PnlSection pnl={pnl} privMoney={privMoney} />
            {showStock && (
                <ReserveSection
                    reserve={reserve}
                    sim={sim}
                    privMoney={privMoney}
                />
            )}
        </div>
    );

    return (
        <div ref={ref}>
            <div
                className={`${styles.acctWrap} ${wide ? styles.acctWrapWide : ''}`}
            >
                {left}
                {right}
            </div>
        </div>
    );
}
