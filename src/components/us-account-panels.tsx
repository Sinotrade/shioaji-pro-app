// src/components/us-account-panels.tsx — 美股（H 帳戶）帳務畫面
//
// - UsAccountSection：帳務分頁的美股區（餘額、可下單金額、圈存、未交割款）
// - UsRealizedPnlSection：損益面板的美股已實現損益（可展開沖銷明細）與現金股利
// - UsPositionDetail：庫存列展開的取得批次明細
//
// 金額一律 USD decimal 字串，絕不和台幣相加。服務未開放（503）顯示一行狀態，
// 不跳錯誤。多帳戶批次查詢見 lib/us/us-account-batch.ts：同一批只用一種伺服器
// 模式；某帳戶失敗時保留它上次的資料並標示，合計只算這次成功的帳戶。

import { Fragment, useCallback, useEffect } from 'react';
import { useQuery } from '../hooks/use-query';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import type { Account } from '../lib/types/portfolio';
import { decAdd, decRound, fmtDec, fmtUsAvgPrice } from '../lib/us/decimal';
import {
    fetchUsBalance,
    fetchUsDividends,
    fetchUsPositionDetail,
    fetchUsProfitLoss,
    fetchUsProfitLossDetail,
    fetchUsSettlements,
    US_ACCOUNT_UNAVAILABLE,
    usAccountErrorText,
    usHeldAmount,
    type IntlAccountBalance,
    type IntlDividend,
    type IntlPositionDetail,
    type IntlProfitLoss,
    type IntlProfitLossDetail,
    type IntlSettlement,
} from '../lib/us/us-account-api';
import {
    allFailed,
    allUnavailable,
    failureText,
    onUsAccountRefresh,
    runUsBatch,
    someFailed,
    type PerAccount,
} from '../lib/us/us-account-batch';
import { TW_POSITION_DETAIL_MISMATCH } from '../lib/tw-account-detail';
import { dateStrOffset } from '../lib/utils/kbars';
import { DetailTable, DetailView, ExpandableRow } from './account-detail';
import { fmtUsPnl, usAmountDir, UsTag } from './bottom-dock-shared';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';
import { RefreshButton } from './refresh-button';

const acctKey = (a: Account) => `H:${a.broker_id}:${a.account_id}`;
const usd = (v: string | null | undefined, priv: boolean) => (v === null || v === undefined || v === '' ? '—' : `${maskMoney(fmtDec(decRound(v, 2), { minFraction: 2, maxFraction: 2 }), priv)} USD`);
const signedUsd = (v: string | null | undefined, priv: boolean) => (v === null || v === undefined || v === '' ? '—' : `${maskMoney(fmtUsPnl(v), priv)} USD`);

export const US_PARTIAL_FAILURE = '部分帳戶查詢失敗，合計不含這些帳戶';
const STALE_MARK = '（上次查詢）';

function UsHeader({ title, note }: { title: string; note?: string }) {
    return (
        <div className={dock.usNote}>
            <span className={dock.usTag}>美股</span>
            <span>{title}</span>
            {note && <span>{note}</span>}
        </div>
    );
}

function FundRow({ label, value, dir }: { label: string; value: string; dir?: 'up' | 'down' | 'flat' }) {
    return (
        <div className={dock.fundRow}>
            <span className={dock.fundLabel}>{label}</span>
            <span className={`${dock.fundValue} ${dir ? panel.dirText[dir] : ''}`}>{value}</span>
        </div>
    );
}

/** 有資料可顯示（這次成功或上次成功） */
const rowsOf = <T,>(r: PerAccount<T>): T | null => (r.state === 'ok' || r.state === 'stale' ? r.data : null);

// ---- 帳務分頁：餘額／可下單／圈存／未交割 ----

interface UsFundsData { balance: PerAccount<IntlAccountBalance>[]; settlements: PerAccount<IntlSettlement[]>[] }

export function UsAccountSection({ accounts }: { accounts: Account[] }) {
    const privMoney = usePrivacyMoney();
    const privacy = usePrivacyMode();
    const key = accounts.map(acctKey).join(',');
    const { data, error, loading, refresh } = useQuery<UsFundsData>(
        useCallback(() => runUsBatch(async batch => ({
            balance: await batch.each('balance', accounts, a => fetchUsBalance(a)),
            settlements: await batch.each('settlements', accounts, fetchUsSettlements),
        })), [key]),
        `us-funds:${key}`, accounts.length > 0,
    );
    // dock「更新帳務」與美股下單／刪單／減量後重查（502／503 之後也能再試）
    useEffect(() => onUsAccountRefresh(() => void refresh()), [refresh]);
    const unavailable = !!data && allUnavailable(data.balance) && allUnavailable(data.settlements);
    return (
        <section aria-label='美股帳務' className={dock.acctSection}>
            <UsHeader title='美股帳務（USD）' note='不和台幣合計' />
            {accounts.length === 0 ? null
                : !data ? <div className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '美股帳務查詢中…' : ' '}</div>
                : unavailable ? <div className={dock.usNote} role='status'>{US_ACCOUNT_UNAVAILABLE}</div>
                : (
                    <>
                        {error && <div className={dock.usNote} role='status'>{usAccountErrorText(error)}（顯示上次資料）</div>}
                        {accounts.map((account, i) => {
                            const b = data.balance[i];
                            const st = data.settlements[i];
                            if (!b || !st) return null;
                            const label = `[美] ${account.broker_id}-${maskAccountId(account.account_id, privacy)}`;
                            const balance = rowsOf(b);
                            const settlements = rowsOf(st);
                            const held = balance ? usHeldAmount(balance) : null;
                            let pending: string | null = null;
                            for (const s of settlements ?? []) pending = decAdd(pending ?? '0', s.net_amount) ?? pending;
                            const failNote = (r: PerAccount<unknown>) => (r.state === 'stale' ? `${STALE_MARK}更新失敗：${r.error}` : '');
                            return (
                                <Fragment key={acctKey(account)}>
                                    <div className={dock.fundLabel}>{label}</div>
                                    {balance ? (
                                        <>
                                            {b.state === 'stale' && <div className={dock.usNote} role='status'>{failNote(b)}</div>}
                                            <FundRow label='帳戶餘額' value={usd(balance.balance, privMoney)} />
                                            <FundRow label='可下單金額' value={usd(balance.buying_power, privMoney)} />
                                            <FundRow label='委託圈存' value={usd(held, privMoney)} />
                                        </>
                                    ) : <FundRow label='帳戶餘額' value={b.state === 'unavailable' ? US_ACCOUNT_UNAVAILABLE : b.state === 'error' ? b.error : '—'} />}
                                    {settlements ? (
                                        <>
                                            {st.state === 'stale' && <div className={dock.usNote} role='status'>{failNote(st)}</div>}
                                            {settlements.length === 0 ? <FundRow label='未交割款' value='無' /> : (
                                                <>
                                                    <FundRow label='未交割合計' value={signedUsd(pending, privMoney)} dir={usAmountDir(pending)} />
                                                    {settlements.map(s => (
                                                        <FundRow
                                                            key={`${s.trade_date}:${s.settlement_date}:${s.net_amount}`}
                                                            label={`${s.settlement_date} 交割（${s.trade_date} 成交）`}
                                                            value={signedUsd(s.net_amount, privMoney)}
                                                            dir={usAmountDir(s.net_amount)}
                                                        />
                                                    ))}
                                                </>
                                            )}
                                        </>
                                    ) : <FundRow label='未交割款' value={st.state === 'unavailable' ? US_ACCOUNT_UNAVAILABLE : st.state === 'error' ? st.error : '—'} />}
                                </Fragment>
                            );
                        })}
                        <div className={dock.usNote}>未交割款只列尚未交割的部分；當日成交次一營業日才出現。正數為入帳、負數為扣款（含費用）。</div>
                    </>
                )}
        </section>
    );
}

// ---- 損益面板：已實現損益＋沖銷明細、現金股利 ----

interface UsPnlData { pnl: PerAccount<IntlProfitLoss[]>[]; dividends: PerAccount<IntlDividend[]>[] }

type Tagged<T> = T & { account: Account; stale: boolean };
function flatten<T>(rows: PerAccount<T[]>[]): Tagged<T>[] {
    return rows.flatMap(r => (r.state === 'ok' || r.state === 'stale' ? r.data.map(d => ({ ...d, account: r.account, stale: r.state === 'stale' })) : []));
}
/** 合計只算這次成功的帳戶 */
function freshTotal<T>(rows: Tagged<T>[], pick: (r: T) => string): string | null {
    let total: string | null = null;
    for (const r of rows) if (!r.stale) total = decAdd(total ?? '0', pick(r)) ?? total;
    return total;
}

export function UsRealizedPnlSection({ accounts, days = 30 }: { accounts: Account[]; days?: number }) {
    const privMoney = usePrivacyMoney();
    const key = accounts.map(acctKey).join(',');
    const begin = dateStrOffset(days);
    const end = dateStrOffset(0);
    const { data, error, loading, refresh } = useQuery<UsPnlData>(
        useCallback(() => runUsBatch(async batch => ({
            pnl: await batch.each('pnl', accounts, a => fetchUsProfitLoss(a, begin, end)),
            dividends: await batch.each('dividends', accounts, a => fetchUsDividends(a, begin, end)),
        })), [key, begin, end]),
        `us-pnl:${key}:${begin}:${end}`, accounts.length > 0,
    );
    if (accounts.length === 0) return null;
    const pnlRows = flatten(data?.pnl ?? []);
    const divRows = flatten(data?.dividends ?? []);
    const total = freshTotal(pnlRows, p => p.pnl);
    const divTotal = freshTotal(divRows, d => d.net_amount);
    const unavailable = !!data && allUnavailable(data.pnl) && allUnavailable(data.dividends);
    const pnlFailed = allFailed(data?.pnl);
    const divFailed = allFailed(data?.dividends);
    const partial = someFailed(data?.pnl) || someFailed(data?.dividends);

    return (
        <section aria-label='美股已實現損益' className={dock.acctSection}>
            <UsHeader title={`美股 ${days} 日已實現損益（USD）`} note='不和台幣合計' />
            {!data ? <div className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '美股損益查詢中…' : ' '}</div>
                : unavailable ? <div className={dock.usNote} role='status'>{US_ACCOUNT_UNAVAILABLE}</div>
                : (
                    <>
                        {error && <div className={dock.usNote} role='status'>{usAccountErrorText(error)}（顯示上次資料）</div>}
                        {partial && !(pnlFailed && divFailed) && <div className={dock.usNote} role='status'>{US_PARTIAL_FAILURE}：{failureText([...data.pnl, ...data.dividends] as PerAccount<unknown>[])}</div>}
                        {pnlFailed
                            ? <div className={dock.usNote} role='alert'>美股已實現損益查詢失敗：{failureText(data.pnl)}</div>
                            : <FundRow label='已實現損益合計' value={signedUsd(total, privMoney)} dir={usAmountDir(total)} />}
                        {pnlRows.length === 0 ? (pnlFailed ? null : <div className={dock.usNote}>近 {days} 日無美股已實現損益</div>) : (
                            <table className={dock.table}>
                                <thead>
                                    <tr>
                                        <th className={dock.th} style={{ width: '1.4rem' }} />
                                        <th className={dock.th}>日期</th>
                                        <th className={dock.th}>代碼</th>
                                        <th className={dock.th}>股數</th>
                                        <th className={dock.th}>賣價</th>
                                        <th className={dock.th}>損益</th>
                                        <th className={dock.th}>報酬率</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pnlRows.map(p => <UsPnlRow key={`${acctKey(p.account)}:${p.detail_id}:${p.date}:${p.code}`} row={p} account={p.account} priv={privMoney} stale={p.stale} />)}
                                </tbody>
                            </table>
                        )}
                        <UsHeader title='美股現金股利（USD）' />
                        {divFailed && <div className={dock.usNote} role='alert'>美股現金股利查詢失敗：{failureText(data.dividends)}</div>}
                        {divRows.length === 0 ? (divFailed ? null : <div className={dock.usNote}>近 {days} 日無美股現金股利</div>) : (
                            <>
                                {!divFailed && <FundRow label='股利淨額合計' value={signedUsd(divTotal, privMoney)} dir={usAmountDir(divTotal)} />}
                                <table className={dock.table}>
                                    <thead>
                                        <tr>
                                            <th className={dock.th}>發放日</th>
                                            <th className={dock.th}>代碼</th>
                                            <th className={dock.th}>股數</th>
                                            <th className={dock.th}>總額</th>
                                            <th className={dock.th}>預扣稅</th>
                                            <th className={dock.th}>淨額</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {divRows.map(d => (
                                            <tr key={`${acctKey(d.account)}:${d.code}:${d.pay_date}:${d.record_date}`}>
                                                <td className={dock.td}>{d.pay_date}{d.stale ? STALE_MARK : ''}</td>
                                                <td className={dock.td}>{d.code}<UsTag /></td>
                                                <td className={dock.td}>{maskMoney(`${fmtDec(d.quantity)} 股`, privMoney)}</td>
                                                <td className={dock.td}>{usd(d.gross_amount, privMoney)}</td>
                                                <td className={dock.td}>{usd(d.withholding_tax, privMoney)}</td>
                                                <td className={dock.td}>{usd(d.net_amount, privMoney)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        )}
                    </>
                )}
            <div className={panel.refreshToolbar}><RefreshButton label='更新美股損益' loading={loading} onClick={() => void refresh()} /></div>
        </section>
    );
}

function UsPnlRow({ row, account, priv, stale }: { row: IntlProfitLoss; account: Account; priv: boolean; stale: boolean }) {
    const dir = usAmountDir(row.pnl);
    return (
        <ExpandableRow
            title='展開沖銷明細'
            detailSpan={6}
            renderDetail={() => <UsPnlDetail account={account} detailId={row.detail_id} priv={priv} />}
            cells={<>
                <td className={dock.td}>{row.date}{stale ? STALE_MARK : ''}</td>
                <td className={dock.td}>{row.code}<UsTag /></td>
                <td className={dock.td}>{maskMoney(`${fmtDec(row.quantity)} 股`, priv)}</td>
                <td className={dock.td}>{fmtUsAvgPrice(row.price)}</td>
                <td className={`${dock.td} ${panel.dirText[dir]}`}>{signedUsd(row.pnl, priv)}</td>
                {/* pnl_pct 已是百分比 */}
                <td className={`${dock.td} ${panel.dirText[dir]}`}>{`${fmtUsPnl(row.pnl_pct)}%`}</td>
            </>}
        />
    );
}

const usDetailError = (error: string) => <span className={dock.usNote} role='status'>{usAccountErrorText(error)}</span>;

function UsPnlDetail({ account, detailId, priv }: { account: Account; detailId: string; priv: boolean }) {
    const { data, error, loading } = useQuery(
        useCallback(() => fetchUsProfitLossDetail(account, detailId), [acctKey(account), detailId]),
        `us-pnl-detail:${acctKey(account)}:${detailId}`, true,
    );
    return (
        <DetailView data={data} error={error} loading={loading} loadingText='明細查詢中…' emptyText='沒有沖銷明細' renderError={usDetailError}>
            {rows => (
                <>
                    <DetailTable<IntlProfitLossDetail>
                        label='沖銷明細'
                        rows={rows}
                        rowKey={(d, i) => `${d.acquired_date ?? 'x'}:${i}`}
                        columns={[
                            { header: '買進日', cell: d => d.acquired_date ?? '—' },
                            { header: '股數', cell: d => maskMoney(`${fmtDec(d.quantity)} 股`, priv) },
                            { header: '買價', cell: d => maskMoney(fmtUsAvgPrice(d.price), priv) },
                            { header: '成本', cell: d => usd(d.cost, priv) },
                            { header: '原委託手續費', cell: d => usd(d.fee, priv) },
                            { header: '原委託稅', cell: d => usd(d.tax, priv) },
                            { header: '其他規費', cell: d => usd(d.other_fees, priv) },
                        ]}
                    />
                    <span className={dock.usNote}>先進先出（FIFO）沖銷；手續費與稅是整筆原始委託的金額，不按本次股數分攤。</span>
                </>
            )}
        </DetailView>
    );
}

// ---- 庫存列展開：取得批次 ----

/** 和台股庫存明細同一句（兩個市場同一種互動） */
export const US_POSITION_DETAIL_MISMATCH = TW_POSITION_DETAIL_MISMATCH;

export function UsPositionDetail({ account, detailId, code, version }: { account: Account; detailId: number; code: string; version: number }) {
    const priv = usePrivacyMoney();
    // SDK 每次庫存查詢都重新編 id：快取以帳戶＋代碼＋庫存版本為準，並核對回來的代碼
    const { data, error, loading } = useQuery(
        useCallback(async () => {
            const rows = await fetchUsPositionDetail(account, detailId);
            if (rows.some(r => r.code.toUpperCase() !== code.toUpperCase())) throw new Error(US_POSITION_DETAIL_MISMATCH);
            return rows;
        }, [acctKey(account), detailId, code]),
        `us-pos-detail:${acctKey(account)}:${code}:v${version}`, true,
    );
    return (
        <DetailView data={data} error={error} loading={loading} loadingText='庫存明細查詢中…' emptyText='沒有庫存明細' renderError={usDetailError}>
            {rows => (
                <DetailTable<IntlPositionDetail>
                    label='美股庫存明細'
                    rows={rows}
                    rowKey={(d, i) => `${d.acquired_date}:${i}`}
                    columns={[
                        { header: '取得日', cell: d => d.acquired_date },
                        { header: '方式', cell: d => (d.acquisition_type === 'NonTrade' ? '非交易' : '買進') },
                        { header: '股數（原始）', cell: d => maskMoney(`${fmtDec(d.quantity)}（${fmtDec(d.original_quantity)}）股`, priv) },
                        // 成交價即成本價：和持倉表的成本一樣隨遮金額隱藏
                        { header: '成交價', cell: d => maskMoney(fmtUsAvgPrice(d.price), priv) },
                        { header: '成本', cell: d => usd(d.cost, priv) },
                        { header: '損益', cell: d => signedUsd(d.pnl, priv), dir: d => usAmountDir(d.pnl) },
                    ]}
                />
            )}
        </DetailView>
    );
}
