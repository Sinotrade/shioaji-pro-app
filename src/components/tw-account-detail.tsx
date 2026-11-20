// src/components/tw-account-detail.tsx — 台股（證券／期貨）庫存明細與沖銷明細
//
// - TwPositionDetail：持倉列展開的逐筆庫存（list_position_detail），互動同美股 UsPositionDetail
// - TwPnlDetail：已實現損益列展開的沖銷明細（list_profit_loss_detail），互動同美股 UsPnlDetail
// - TwRealizedTable：損益面板的台股已實現損益列表（每列可展開）
//
// 明細經券商 TKAP01 損益後台／r6：暫時性失敗（503、6044 裸 500、AS400 未連線）灰字＋重試，
// 其他才是紅字錯誤（#435）；模擬環境不分類。模擬環境 SDK 對台股明細回空陣列，顯示說明而非「沒有」。

import { useCallback } from 'react';
import { useQuery } from '../hooks/use-query';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import { useServerInfo } from '../lib/server-info-store';
import type { ProfitLoss, StockProfitLoss } from '../lib/shioaji';
import { classifyAccountQueryError } from '../lib/trading-limits-error';
import {
    fetchTwPositionDetail,
    fetchTwProfitDetail,
    TW_PNL_DETAIL_MISMATCH,
    TW_POSITION_DETAIL_MISMATCH,
    twCondLabel,
    twIsoDate,
    type TwFuturePositionDetail,
    type TwFutureProfitDetail,
    type TwMarket,
    type TwPositionDetail as TwPositionDetailRow,
    type TwPositionKey,
    type TwProfitDetail,
    type TwStockPositionDetail,
    type TwStockProfitDetail,
} from '../lib/tw-account-detail';
import type { Account } from '../lib/types/portfolio';
import { fmtPrice, fmtSigned, fmtStockLots } from '../lib/utils/format';
import { AccountQueryFailure, RetryButton } from './account-query-failure';
import { DetailTable, DetailView, ExpandableRow, type DetailColumn } from './account-detail';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

const acctKey = (a: Account) => `${a.account_type}:${a.broker_id}:${a.account_id}`;
const amountDir = (v: number): 'up' | 'down' | 'flat' => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
// 期貨手續費／稅可能有小數（SDK 為 f64）：保留到 2 位，整數不顯示小數
const money = (v: number, priv: boolean) => maskMoney(v.toLocaleString('en-US', { maximumFractionDigits: 2 }), priv);
const signed = (v: number, priv: boolean) => maskMoney(fmtSigned(v, 0), priv);
/** 只在有任何一列非 0 時才顯示的欄位（融資、利息、股利等） */
const ifAny = <T,>(rows: T[], pick: (r: T) => number, col: DetailColumn<T>): DetailColumn<T>[] => (rows.some(r => pick(r) !== 0) ? [col] : []);

/** 明細查詢失敗：對不上列（快取已變）是一般提示；其餘同帳務查詢（暫時性灰字＋重試） */
function useDetailError(what: string, retry: () => void) {
    const sim = useServerInfo()?.simulation === true;
    return (error: string) => (error === TW_POSITION_DETAIL_MISMATCH || error === TW_PNL_DETAIL_MISMATCH
        ? <span className={dock.usNote} role='status'>{error} <RetryButton onRetry={retry} /></span>
        : <AccountQueryFailure what={what} error={error} kind={sim ? null : classifyAccountQueryError(error)} onRetry={retry} />);
}

function useEmptyText(what: string) {
    const sim = useServerInfo()?.simulation === true;
    return sim ? `模擬環境不提供台股${what}（正式環境由券商帳務提供）` : `沒有${what}`;
}

// ---- 庫存明細 ----

export function TwPositionDetail({ account, market, row, version }: {
    account: Account;
    market: TwMarket;
    row: TwPositionKey & { quantity: number };
    /** 持倉快照版本（台股持倉查詢時間）：id 每次查詢重新編號 */
    version: number;
}) {
    const priv = usePrivacyMoney();
    const { data, error, loading, refresh } = useQuery(
        useCallback(() => fetchTwPositionDetail(account, market, row),
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [acctKey(account), market, row.id, row.code, row.direction, row.cond]),
        `tw-pos-detail:${acctKey(account)}:${row.code}:${row.direction}:${row.cond ?? ''}:${row.id}:${row.quantity}:v${version}`, true,
    );
    const renderError = useDetailError('庫存明細', () => void refresh());
    const emptyText = useEmptyText('庫存明細');
    return (
        <DetailView data={data} error={error} loading={loading} loadingText='庫存明細查詢中…' emptyText={emptyText} renderError={renderError}>
            {rows => market === 'S'
                ? <StockLots rows={rows as TwStockPositionDetail[]} priv={priv} />
                : <FutureLots rows={rows as TwFuturePositionDetail[]} priv={priv} />}
        </DetailView>
    );
}

const lotKey = (d: TwPositionDetailRow, i: number) => `${d.date}:${d.dseq}:${i}`;

function StockLots({ rows, priv }: { rows: TwStockPositionDetail[]; priv: boolean }) {
    const columns: DetailColumn<TwStockPositionDetail>[] = [
        { header: '成交日', cell: d => d.date || '—' },
        { header: '條件', cell: d => twCondLabel(d.cond) },
        // 券商以「張」回傳（SDK 未帶 unit），零股截成 0
        { header: '數量', cell: d => maskMoney(d.quantity > 0 ? `${d.quantity.toLocaleString('en-US')} 張` : '未滿 1 張', priv) },
        // 成交價即成本價：和持倉表的成本一樣隨遮金額隱藏
        { header: '成交價', cell: d => maskMoney(fmtPrice(d.price), priv) },
        { header: '現價', cell: d => fmtPrice(d.last_price) },
        { header: '損益', cell: d => signed(d.pnl, priv), dir: d => amountDir(d.pnl) },
        { header: '手續費', cell: d => money(d.fee, priv) },
        ...ifAny(rows, d => d.margintrading_amt, { header: '融資金額', cell: d => money(d.margintrading_amt, priv) }),
        ...ifAny(rows, d => d.collateral, { header: '擔保品', cell: d => money(d.collateral, priv) }),
        ...ifAny(rows, d => d.interest, { header: '利息', cell: d => money(d.interest, priv) }),
        ...ifAny(rows, d => d.ex_dividends, { header: '除權息', cell: d => money(d.ex_dividends, priv) }),
    ];
    return (
        <>
            <DetailTable label='台股庫存明細' rows={rows} rowKey={lotKey} columns={columns} />
            <span className={dock.usNote}>券商庫存明細以「張」計，未滿 1 張的零股不列股數；合計以持倉列為準。</span>
        </>
    );
}

function FutureLots({ rows, priv }: { rows: TwFuturePositionDetail[]; priv: boolean }) {
    return (
        <DetailTable
            label='期貨庫存明細'
            rows={rows}
            rowKey={lotKey}
            columns={[
                { header: '成交日', cell: d => d.date || '—' },
                { header: '方向', cell: d => (d.direction === 'Buy' ? '多' : '空'), dir: d => (d.direction === 'Buy' ? 'up' : 'down') },
                { header: '口數（原始）', cell: d => maskMoney(`${d.quantity}（${d.entry_quantity}）口`, priv) },
                { header: '成交價', cell: d => maskMoney(fmtPrice(d.price), priv) },
                { header: '現價', cell: d => fmtPrice(d.last_price) },
                { header: '損益', cell: d => signed(d.pnl, priv), dir: d => amountDir(d.pnl) },
                { header: '手續費', cell: d => money(d.fee, priv) },
            ]}
        />
    );
}

// ---- 沖銷明細 ----

const pnlRowKey = (r: ProfitLoss) => ('dseq' in r ? `${r.dseq}:${r.seqno}` : `${r.direction}:${r.entry_price}:${r.cover_price}:${r.quantity}`);

export function TwPnlDetail({ account, market, row, version }: {
    account: Account;
    market: TwMarket;
    row: ProfitLoss;
    /** 損益列表的查詢時間：列表更新後重新展開會重查明細 */
    version: number;
}) {
    const priv = usePrivacyMoney();
    const { data, error, loading, refresh } = useQuery(
        // eslint-disable-next-line react-hooks/exhaustive-deps
        useCallback(() => fetchTwProfitDetail(account, market, row), [acctKey(account), market, row.code, row.date, pnlRowKey(row), row.pnl]),
        `tw-pnl-detail:${acctKey(account)}:${market}:${row.code}:${twIsoDate(row.date)}:${pnlRowKey(row)}:${row.pnl}:v${version}`, true,
    );
    const renderError = useDetailError('沖銷明細', () => void refresh());
    const emptyText = useEmptyText('沖銷明細');
    return (
        <DetailView data={data} error={error} loading={loading} loadingText='明細查詢中…' emptyText={emptyText} renderError={renderError}>
            {rows => market === 'S'
                ? <StockCloses rows={rows as TwStockProfitDetail[]} priv={priv} />
                : <FutureCloses rows={rows as TwFutureProfitDetail[]} priv={priv} />}
        </DetailView>
    );
}

const closeKey = (d: TwProfitDetail, i: number) => `${d.date}:${d.dseq}:${i}`;

function StockCloses({ rows, priv }: { rows: TwStockProfitDetail[]; priv: boolean }) {
    const columns: DetailColumn<TwStockProfitDetail>[] = [
        { header: '原成交日', cell: d => d.date || '—' },
        { header: '條件', cell: d => twCondLabel(d.cond) },
        { header: '股數', cell: d => maskMoney(fmtStockLots(Math.abs(d.quantity)), priv) },
        { header: '原成交價', cell: d => maskMoney(fmtPrice(d.price), priv) },
        { header: '成本', cell: d => money(d.cost, priv) },
        { header: '手續費', cell: d => money(d.fee, priv) },
        { header: '交易稅', cell: d => money(d.tax, priv) },
        ...ifAny(rows, d => d.interest, { header: '利息', cell: d => money(d.interest, priv) }),
        ...ifAny(rows, d => d.shortselling_fee, { header: '融券手續費', cell: d => money(d.shortselling_fee, priv) }),
        ...ifAny(rows, d => d.ex_dividend_amt, { header: '除權息', cell: d => money(d.ex_dividend_amt, priv) }),
        ...ifAny(rows, d => d.rep_margintrading_amt, { header: '償還融資', cell: d => money(d.rep_margintrading_amt, priv) }),
        ...ifAny(rows, d => d.rep_collateral, { header: '退還擔保品', cell: d => money(d.rep_collateral, priv) }),
        ...ifAny(rows, d => d.rep_margin, { header: '退還保證金', cell: d => money(d.rep_margin, priv) }),
    ];
    return <DetailTable label='沖銷明細' rows={rows} rowKey={closeKey} columns={columns} />;
}

function FutureCloses({ rows, priv }: { rows: TwFutureProfitDetail[]; priv: boolean }) {
    return (
        <DetailTable
            label='沖銷明細'
            rows={rows}
            rowKey={closeKey}
            columns={[
                { header: '開倉日', cell: d => d.entry_date || '—' },
                { header: '方向', cell: d => (d.direction === 'Buy' ? '多' : '空'), dir: d => (d.direction === 'Buy' ? 'up' : 'down') },
                { header: '口數', cell: d => maskMoney(`${Math.abs(d.quantity)} 口`, priv) },
                { header: '開倉價', cell: d => maskMoney(fmtPrice(d.entry_price), priv) },
                { header: '平倉價', cell: d => fmtPrice(d.cover_price) },
                { header: '損益', cell: d => signed(d.pnl, priv), dir: d => amountDir(d.pnl) },
                { header: '手續費', cell: d => money(d.fee, priv) },
                { header: '交易稅', cell: d => money(d.tax, priv) },
            ]}
        />
    );
}

// ---- 損益面板：台股已實現損益列表 ----

export interface TwRealizedRow {
    account: Account;
    market: TwMarket;
    row: ProfitLoss;
}

/** 報酬率（%）：股票 1.8+ 給 pnl_pct（百分比），舊版只有 pr_ratio（分數）；期貨沒有 */
function retPct(r: ProfitLoss): number | null {
    if (!('dseq' in r)) return null;
    const s = r as StockProfitLoss;
    if (typeof s.pnl_pct === 'number' && Number.isFinite(s.pnl_pct)) return s.pnl_pct;
    return typeof s.pr_ratio === 'number' && Number.isFinite(s.pr_ratio) ? s.pr_ratio * 100 : null;
}

export function twRealizedQty(market: TwMarket, quantity: number): string {
    // 平倉筆的數量可能帶方向正負：顯示絕對值；股票為股數（unit=Share）
    return market === 'S' ? fmtStockLots(Math.abs(quantity)) : `${Math.abs(quantity).toLocaleString('en-US')} 口`;
}

export function TwRealizedTable({ rows, priv, version }: { rows: TwRealizedRow[]; priv: boolean; version: number }) {
    return (
        <table className={dock.table} aria-label='台股已實現損益'>
            <thead>
                <tr>
                    <th className={dock.th} style={{ width: '1.4rem' }} />
                    <th className={dock.th}>日期</th>
                    <th className={dock.th}>代碼</th>
                    <th className={dock.th}>數量</th>
                    <th className={dock.th}>成交價</th>
                    <th className={dock.th}>損益</th>
                    <th className={dock.th}>報酬率</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(({ account, market, row }) => {
                    const dir = amountDir(row.pnl);
                    const pct = retPct(row);
                    const stock = 'dseq' in row;
                    return (
                        <ExpandableRow
                            key={`${acctKey(account)}:${market}:${twIsoDate(row.date)}:${row.code}:${pnlRowKey(row)}:${row.id}`}
                            title='展開沖銷明細'
                            detailSpan={6}
                            renderDetail={() => <TwPnlDetail account={account} market={market} row={row} version={version} />}
                            cells={<>
                                <td className={dock.td}>{twIsoDate(row.date)}</td>
                                <td className={dock.td}>
                                    {row.code}
                                    {stock
                                        ? (row as StockProfitLoss).cond && (row as StockProfitLoss).cond !== 'Cash' && <span className={dock.usTag}>{twCondLabel((row as StockProfitLoss).cond)}</span>
                                        : <span className={`${dock.usTag} ${panel.dirText[row.direction === 'Buy' ? 'up' : 'down']}`}>{row.direction === 'Buy' ? '多' : '空'}</span>}
                                </td>
                                <td className={dock.td}>{maskMoney(twRealizedQty(market, row.quantity), priv)}</td>
                                <td className={dock.td}>{fmtPrice(stock ? (row as StockProfitLoss).price : row.cover_price)}</td>
                                <td className={`${dock.td} ${panel.dirText[dir]}`}>{signed(row.pnl, priv)}</td>
                                <td className={`${dock.td} ${pct === null ? '' : panel.dirText[dir]}`}>{pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</td>
                            </>}
                        />
                    );
                })}
            </tbody>
        </table>
    );
}
