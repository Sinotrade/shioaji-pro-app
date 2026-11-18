// src/components/us-account-panels.tsx — 美股（H 帳戶）帳務畫面
//
// - UsAccountSection：帳務分頁的美股區（餘額、可下單金額、圈存、未交割款）
// - UsRealizedPnlSection：損益面板的美股已實現損益（可展開沖銷明細）與現金股利
// - UsPositionDetail：庫存列展開的取得批次明細
//
// 金額一律 USD decimal 字串，絕不和台幣相加。服務未開放（503）顯示一行狀態，
// 不跳錯誤；每個帳戶各自查詢，一個帳戶失敗不影響其他帳戶。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useCallback, useState } from 'react';
import { useQuery } from '../hooks/use-query';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import type { Account } from '../lib/types/portfolio';
import { decAdd, decRound, fmtDec, fmtUsPrice } from '../lib/us/decimal';
import {
    fetchUsBalance,
    fetchUsDividends,
    fetchUsPositionDetail,
    fetchUsProfitLoss,
    fetchUsProfitLossDetail,
    fetchUsSettlements,
    isUsAccountUnavailable,
    US_ACCOUNT_UNAVAILABLE,
    usAccountErrorText,
    usHeldAmount,
    type IntlAccountBalance,
    type IntlDividend,
    type IntlProfitLoss,
    type IntlSettlement,
} from '../lib/us/us-account-api';
import { dateStrOffset } from '../lib/utils/kbars';
import { fmtUsPnl, usAmountDir, UsTag } from './bottom-dock-shared';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

const acctKey = (a: Account) => `H:${a.broker_id}:${a.account_id}`;
const usd = (v: string | null | undefined, priv: boolean) => (v === null || v === undefined || v === '' ? '—' : `${maskMoney(fmtDec(decRound(v, 2), { minFraction: 2, maxFraction: 2 }), priv)} USD`);
const signedUsd = (v: string | null | undefined, priv: boolean) => (v === null || v === undefined || v === '' ? '—' : `${maskMoney(fmtUsPnl(v), priv)} USD`);

/** 每個帳戶的查詢結果：成功、尚未開放、或錯誤訊息 */
export type PerAccount<T> = { account: Account } & ({ state: 'ok'; data: T } | { state: 'unavailable' } | { state: 'error'; error: string });

export async function queryEachAccount<T>(accounts: Account[], fetch: (a: Account) => Promise<T>): Promise<PerAccount<T>[]> {
    const settled = await Promise.allSettled(accounts.map(fetch));
    return settled.map((r, i) => {
        const account = accounts[i]!;
        if (r.status === 'fulfilled') return { account, state: 'ok', data: r.value };
        if (isUsAccountUnavailable(r.reason)) return { account, state: 'unavailable' };
        return { account, state: 'error', error: usAccountErrorText(r.reason) };
    });
}

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

/** 全部帳戶都未開放時只顯示一行；部分帳戶失敗時各自顯示 */
function allUnavailable<T>(rows: PerAccount<T>[] | undefined) {
    return !!rows && rows.length > 0 && rows.every(r => r.state === 'unavailable');
}

// ---- 帳務分頁：餘額／可下單／圈存／未交割 ----

interface UsFunds { balance: IntlAccountBalance | null; settlements: IntlSettlement[] | null; balanceError?: string; settlementsError?: string }

async function fetchUsFunds(account: Account): Promise<UsFunds> {
    const [b, s] = await Promise.allSettled([fetchUsBalance(account), fetchUsSettlements(account)]);
    // 兩支都未開放：整個帳戶當成未開放
    if (b.status === 'rejected' && s.status === 'rejected' && isUsAccountUnavailable(b.reason) && isUsAccountUnavailable(s.reason)) throw b.reason;
    const errText = (e: unknown) => usAccountErrorText(e);
    return {
        balance: b.status === 'fulfilled' ? b.value : null,
        settlements: s.status === 'fulfilled' ? s.value : null,
        balanceError: b.status === 'rejected' ? errText(b.reason) : undefined,
        settlementsError: s.status === 'rejected' ? errText(s.reason) : undefined,
    };
}

export function UsAccountSection({ accounts }: { accounts: Account[] }) {
    const privMoney = usePrivacyMoney();
    const privacy = usePrivacyMode();
    const key = accounts.map(acctKey).join(',');
    const { data, error, loading } = useQuery(
        useCallback(() => queryEachAccount(accounts, fetchUsFunds), [key]), `us-funds:${key}`, accounts.length > 0,
    );
    return (
        <section aria-label='美股帳務' className={dock.acctSection}>
            <UsHeader title='美股帳務（USD）' note='不和台幣合計' />
            {accounts.length === 0 ? null
                : !data ? <div className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '美股帳務查詢中…' : ' '}</div>
                : allUnavailable(data) ? <div className={dock.usNote} role='status'>{US_ACCOUNT_UNAVAILABLE}</div>
                : data.map(r => {
                    const label = `[美] ${r.account.broker_id}-${maskAccountId(r.account.account_id, privacy)}`;
                    if (r.state !== 'ok') {
                        return <FundRow key={acctKey(r.account)} label={label} value={r.state === 'unavailable' ? US_ACCOUNT_UNAVAILABLE : r.error} />;
                    }
                    const { balance, settlements } = r.data;
                    const held = balance ? usHeldAmount(balance) : null;
                    let pending: string | null = null;
                    for (const s of settlements ?? []) pending = decAdd(pending ?? '0', s.net_amount) ?? pending;
                    return (
                        <Fragment key={acctKey(r.account)}>
                            <div className={dock.fundLabel}>{label}</div>
                            {balance ? (
                                <>
                                    <FundRow label='帳戶餘額' value={usd(balance.balance, privMoney)} />
                                    <FundRow label='可下單金額' value={usd(balance.buying_power, privMoney)} />
                                    <FundRow label='委託圈存' value={usd(held, privMoney)} />
                                </>
                            ) : <FundRow label='帳戶餘額' value={r.data.balanceError ?? '—'} />}
                            {settlements ? (
                                settlements.length === 0 ? <FundRow label='未交割款' value='無' /> : (
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
                                )
                            ) : <FundRow label='未交割款' value={r.data.settlementsError ?? '—'} />}
                        </Fragment>
                    );
                })}
            {data && !allUnavailable(data) && <div className={dock.usNote}>未交割款只列尚未交割的部分；當日成交次一營業日才出現。正數為入帳、負數為扣款（含費用）。</div>}
        </section>
    );
}

// ---- 損益面板：已實現損益＋沖銷明細、現金股利 ----

interface UsPnlData { pnl: PerAccount<IntlProfitLoss[]>[]; dividends: PerAccount<IntlDividend[]>[] }

export function UsRealizedPnlSection({ accounts, days = 30 }: { accounts: Account[]; days?: number }) {
    const privMoney = usePrivacyMoney();
    const key = accounts.map(acctKey).join(',');
    const begin = dateStrOffset(days);
    const end = dateStrOffset(0);
    const { data, error, loading, refresh } = useQuery<UsPnlData>(
        useCallback(async () => ({
            pnl: await queryEachAccount(accounts, a => fetchUsProfitLoss(a, begin, end)),
            dividends: await queryEachAccount(accounts, a => fetchUsDividends(a, begin, end)),
        }), [key, begin, end]),
        `us-pnl:${key}:${begin}:${end}`, accounts.length > 0,
    );
    if (accounts.length === 0) return null;
    const pnlRows = (data?.pnl ?? []).flatMap(r => (r.state === 'ok' ? r.data.map(p => ({ ...p, account: r.account })) : []));
    const divRows = (data?.dividends ?? []).flatMap(r => (r.state === 'ok' ? r.data.map(d => ({ ...d, account: r.account })) : []));
    let total: string | null = null;
    for (const p of pnlRows) total = decAdd(total ?? '0', p.pnl) ?? total;
    let divTotal: string | null = null;
    for (const d of divRows) divTotal = decAdd(divTotal ?? '0', d.net_amount) ?? divTotal;
    const errors = [...(data?.pnl ?? []), ...(data?.dividends ?? [])].filter(r => r.state === 'error').map(r => (r.state === 'error' ? r.error : ''));
    const unavailable = !!data && allUnavailable(data.pnl) && allUnavailable(data.dividends);

    return (
        <section aria-label='美股已實現損益' className={dock.acctSection}>
            <UsHeader title={`美股 ${days} 日已實現損益（USD）`} note='不和台幣合計' />
            {!data ? <div className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '美股損益查詢中…' : ' '}</div>
                : unavailable ? <div className={dock.usNote} role='status'>{US_ACCOUNT_UNAVAILABLE}</div>
                : (
                    <>
                        {errors.length > 0 && <div className={dock.usNote} role='status'>{[...new Set(errors)].join('；')}</div>}
                        <FundRow label='已實現損益合計' value={signedUsd(total, privMoney)} dir={usAmountDir(total)} />
                        {pnlRows.length === 0 ? <div className={dock.usNote}>近 {days} 日無美股已實現損益</div> : (
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
                                    {pnlRows.map(p => <UsPnlRow key={`${acctKey(p.account)}:${p.detail_id}:${p.date}:${p.code}`} row={p} account={p.account} priv={privMoney} />)}
                                </tbody>
                            </table>
                        )}
                        <UsHeader title='美股現金股利（USD）' />
                        {divRows.length === 0 ? <div className={dock.usNote}>近 {days} 日無美股現金股利</div> : (
                            <>
                                <FundRow label='股利淨額合計' value={signedUsd(divTotal, privMoney)} dir={usAmountDir(divTotal)} />
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
                                                <td className={dock.td}>{d.pay_date}</td>
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
            <button type='button' className={dock.cancelBtn} disabled={loading} onClick={() => void refresh()}>{loading ? '更新中…' : '更新美股損益'}</button>
        </section>
    );
}

function UsPnlRow({ row, account, priv }: { row: IntlProfitLoss; account: Account; priv: boolean }) {
    const [open, setOpen] = useState(false);
    const dir = usAmountDir(row.pnl);
    return (
        <>
            <tr className={dock.clickableRow} onClick={() => setOpen(o => !o)} aria-expanded={open} title='展開沖銷明細'>
                <td className={dock.td}>{open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}</td>
                <td className={dock.td}>{row.date}</td>
                <td className={dock.td}>{row.code}<UsTag /></td>
                <td className={dock.td}>{maskMoney(`${fmtDec(row.quantity)} 股`, priv)}</td>
                <td className={dock.td}>{fmtUsPrice(row.price)}</td>
                <td className={`${dock.td} ${panel.dirText[dir]}`}>{signedUsd(row.pnl, priv)}</td>
                {/* pnl_pct 已是百分比 */}
                <td className={`${dock.td} ${panel.dirText[dir]}`}>{`${fmtUsPnl(row.pnl_pct)}%`}</td>
            </tr>
            {open && (
                <tr>
                    <td className={dock.td} />
                    <td className={dock.td} colSpan={6}><UsPnlDetail account={account} detailId={row.detail_id} priv={priv} /></td>
                </tr>
            )}
        </>
    );
}

function UsPnlDetail({ account, detailId, priv }: { account: Account; detailId: string; priv: boolean }) {
    const { data, error, loading } = useQuery(
        useCallback(() => fetchUsProfitLossDetail(account, detailId), [acctKey(account), detailId]),
        `us-pnl-detail:${acctKey(account)}:${detailId}`, true,
    );
    if (!data) return <span className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '明細查詢中…' : ' '}</span>;
    if (data.length === 0) return <span className={dock.usNote}>沒有沖銷明細</span>;
    return (
        <>
            <table className={dock.table} aria-label='沖銷明細'>
                <thead>
                    <tr>
                        <th className={dock.th}>買進日</th>
                        <th className={dock.th}>股數</th>
                        <th className={dock.th}>買價</th>
                        <th className={dock.th}>成本</th>
                        <th className={dock.th}>原委託手續費</th>
                        <th className={dock.th}>原委託稅</th>
                        <th className={dock.th}>其他規費</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((d, i) => (
                        <tr key={`${d.acquired_date ?? 'x'}:${i}`}>
                            <td className={dock.td}>{d.acquired_date ?? '—'}</td>
                            <td className={dock.td}>{maskMoney(`${fmtDec(d.quantity)} 股`, priv)}</td>
                            <td className={dock.td}>{fmtUsPrice(d.price)}</td>
                            <td className={dock.td}>{usd(d.cost, priv)}</td>
                            <td className={dock.td}>{usd(d.fee, priv)}</td>
                            <td className={dock.td}>{usd(d.tax, priv)}</td>
                            <td className={dock.td}>{usd(d.other_fees, priv)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <span className={dock.usNote}>先進先出（FIFO）沖銷；手續費與稅是整筆原始委託的金額，不按本次股數分攤。</span>
        </>
    );
}

// ---- 庫存列展開：取得批次 ----

export function UsPositionDetail({ account, detailId }: { account: Account; detailId: number }) {
    const priv = usePrivacyMoney();
    const { data, error, loading } = useQuery(
        useCallback(() => fetchUsPositionDetail(account, detailId), [acctKey(account), detailId]),
        `us-pos-detail:${acctKey(account)}:${detailId}`, true,
    );
    if (!data) return <span className={dock.usNote} role='status'>{error ? usAccountErrorText(error) : loading ? '庫存明細查詢中…' : ' '}</span>;
    if (data.length === 0) return <span className={dock.usNote}>沒有庫存明細</span>;
    return (
        <table className={dock.table} aria-label='美股庫存明細'>
            <thead>
                <tr>
                    <th className={dock.th}>取得日</th>
                    <th className={dock.th}>方式</th>
                    <th className={dock.th}>股數（原始）</th>
                    <th className={dock.th}>成交價</th>
                    <th className={dock.th}>成本</th>
                    <th className={dock.th}>損益</th>
                </tr>
            </thead>
            <tbody>
                {data.map((d, i) => {
                    const dir = usAmountDir(d.pnl);
                    return (
                        <tr key={`${d.acquired_date}:${i}`}>
                            <td className={dock.td}>{d.acquired_date}</td>
                            <td className={dock.td}>{d.acquisition_type === 'NonTrade' ? '非交易' : '買進'}</td>
                            <td className={dock.td}>{maskMoney(`${fmtDec(d.quantity)}（${fmtDec(d.original_quantity)}）股`, priv)}</td>
                            <td className={dock.td}>{fmtUsPrice(d.price)}</td>
                            <td className={dock.td}>{usd(d.cost, priv)}</td>
                            <td className={`${dock.td} ${panel.dirText[dir]}`}>{signedUsd(d.pnl, priv)}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
