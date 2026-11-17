// src/components/us-dock.tsx — 底部 dock 的美股（H 帳戶）委託與庫存區段
//
// 美股委託與台股委託分開投影（數量是 decimal 字串、回報語意不同），在委託／
// 持倉分頁下方各接一個區段；沒有 H 帳戶時什麼都不顯示。
// 美股帳務沒有保證金、交割、可用額度（H 帳戶 422），帳務分頁不顯示美股。

import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { orderNumber, orderStatusLabel } from '../lib/order-status-label';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import type { AccountedUsTrade, UsOrderReq } from '../lib/types/us';
import { decIsPositive, decToInt, fmtDec } from '../lib/us/decimal';
import { cancelUsTrade, placeReplacement, priceChangeProblem, reduceUsTrade, replacementOrder, UsCancelTooEarlyError } from '../lib/us/us-order-actions';
import { refreshUsPositions, refreshUsTrades, useUsTradingState, usRemaining, US_POSITIONS_UNAVAILABLE } from '../lib/us/us-trading-state';
import { RefreshButton } from './refresh-button';
import { UsMarketBadge } from './us-order-panel';
import * as styles from './us-order-panel.css';
import * as panel from './panel.css';

function useHasIntlAccount() {
    const { accounts } = useAccounts();
    return accounts.some(a => a.account_type === 'H' && canTrade(a));
}

const rowKey = (t: AccountedUsTrade) => `${t.account.broker_id}:${t.account.account_id}:${t.order.id}`;

function priceCell(t: AccountedUsTrade) {
    if (t.order.price_type === 'MKT') return '市價';
    return fmtDec(t.order.price);
}

// ---- 委託 ----

export function UsOrdersSection() {
    const has = useHasIntlAccount();
    const s = useUsTradingState();
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState<string | null>(null);
    const [rowMsg, setRowMsg] = useState<Record<string, { kind: 'ok' | 'err'; text: string }>>({});
    const [reduceFor, setReduceFor] = useState<string | null>(null);
    const [reduceQty, setReduceQty] = useState('');
    const [repriceRow, setRepriceRow] = useState<AccountedUsTrade | null>(null);

    const rows = useMemo(() => [...s.trades].sort((a, b) => {
        const wa = decIsPositive(usRemaining(a)) ? 1 : 0;
        const wb = decIsPositive(usRemaining(b)) ? 1 : 0;
        return wb - wa || (b.status.order_ts ?? 0) - (a.status.order_ts ?? 0);
    }), [s.trades]);

    if (!has) return null;
    const say = (t: AccountedUsTrade, kind: 'ok' | 'err', text: string) => setRowMsg(m => ({ ...m, [rowKey(t)]: { kind, text } }));

    const cancel = async (t: AccountedUsTrade) => {
        setBusy(rowKey(t));
        try {
            const r = await cancelUsTrade(t);
            say(t, r.confirmed ? 'ok' : 'err', r.confirmed ? `已刪單（取消 ${fmtDec(r.cancelled)} 股）` : '刪單已送出，尚未確認；請稍後按更新查看');
        } catch (e) {
            say(t, 'err', e instanceof UsCancelTooEarlyError ? e.message : e instanceof Error ? e.message : String(e));
        } finally { setBusy(null); }
    };

    const reduce = async (t: AccountedUsTrade) => {
        const n = Number(reduceQty);
        setBusy(rowKey(t));
        try {
            await reduceUsTrade(t, n);
            say(t, 'ok', `減量 ${n} 股已送出`);
            setReduceFor(null);
            setReduceQty('');
        } catch (e) {
            say(t, 'err', e instanceof Error ? e.message : String(e));
        } finally { setBusy(null); }
    };

    return (
        <div className={styles.section} aria-label='美股委託'>
            <div className={styles.sectionHead}>
                <UsMarketBadge />
                <span>美股委託 {rows.length ? `（${rows.length}）` : ''}</span>
                <span style={{ flex: 1 }} />
                <RefreshButton label='更新美股委託' loading={s.loading} onClick={() => void refreshUsTrades()} iconSize={12} />
            </div>
            {s.hint && <div className={styles.hint} role='status'><AlertTriangle size={12} aria-hidden />{s.hint}</div>}
            {s.error && <div className={`${styles.hint} ${panel.statusText.err}`} role='status'>{s.error}</div>}
            {rows.length === 0 ? (
                <div className={styles.sectionHead}>{s.updatedAt ? '今日沒有美股委託' : s.loading ? '查詢中…' : '尚未查詢'}</div>
            ) : (
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th className={styles.th}>商品</th>
                            <th className={styles.th}>帳戶</th>
                            <th className={styles.th}>買賣</th>
                            <th className={`${styles.th} ${styles.num}`}>價格</th>
                            <th className={`${styles.th} ${styles.num}`}>委託／成交／未成交（股）</th>
                            <th className={`${styles.th} ${styles.num}`}>成交均價</th>
                            <th className={styles.th}>時效</th>
                            <th className={styles.th}>狀態</th>
                            <th className={styles.th} />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(t => {
                            const k = rowKey(t);
                            const remaining = usRemaining(t);
                            const working = decIsPositive(remaining);
                            const msg = rowMsg[k];
                            return (
                                <tr key={k}>
                                    <td className={styles.td}>
                                        <span className={panel.mono}>{t.contract.code}</span>
                                        {t.contract.name ? ` ${t.contract.name}` : ''}
                                        <div className={styles.infoMeta}>#{orderNumber(t)}{t.order.trade_date ? ` · ${t.order.trade_date}` : ''}</div>
                                    </td>
                                    <td className={`${styles.td} ${panel.mono}`}>{t.account.broker_id}-{maskAccountId(t.account.account_id, priv)}</td>
                                    <td className={`${styles.td} ${panel.dirText[t.order.action === 'Buy' ? 'up' : 'down']}`}>{t.order.action === 'Buy' ? '買進' : '賣出'}</td>
                                    <td className={`${styles.td} ${styles.num}`}>{priceCell(t)}</td>
                                    <td className={`${styles.td} ${styles.num}`}>
                                        {fmtDec(t.order.quantity)} / {fmtDec(t.status.deal_quantity)} / {fmtDec(remaining)}
                                    </td>
                                    <td className={`${styles.td} ${styles.num}`}>{t.status.avg_price ? fmtDec(t.status.avg_price) : '—'}</td>
                                    <td className={styles.td}>{t.order.time_in_force ?? ''}{t.order.session && t.order.session !== 'Regular' ? ` ${t.order.session}` : ''}</td>
                                    <td className={styles.td} title={t.status.msg || undefined}>
                                        {orderStatusLabel(t.status.status)}
                                        {t.status.status === 'Failed' && t.status.msg && <div className={styles.rowError}>{t.status.msg}</div>}
                                        {msg && <div className={msg.kind === 'err' ? styles.rowError : `${styles.infoMeta} ${panel.statusText.ok}`}>{msg.text}</div>}
                                    </td>
                                    <td className={styles.td}>
                                        {working && (
                                            <div className={styles.actions}>
                                                {reduceFor === k ? (
                                                    <>
                                                        <input
                                                            className={styles.inlineInput}
                                                            inputMode='numeric'
                                                            aria-label='減少股數'
                                                            placeholder={`1–${decToInt(remaining) ?? ''}`}
                                                            value={reduceQty}
                                                            onChange={e => setReduceQty(e.target.value.replace(/\D/g, ''))}
                                                        />
                                                        <button className={styles.smallBtn} disabled={busy === k || !reduceQty} onClick={() => void reduce(t)}>確認減量</button>
                                                        <button className={styles.smallBtn} onClick={() => { setReduceFor(null); setReduceQty(''); }}>取消</button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button className={styles.smallBtn} disabled={busy === k} onClick={() => { setReduceFor(k); setReduceQty(''); }}>減量</button>
                                                        <button className={styles.smallBtn} disabled={busy === k || t.order.price_type === 'MKT'} title={t.order.price_type === 'MKT' ? '市價單不能改價' : '美股改價＝先刪單再以新價格重下'} onClick={() => setRepriceRow(t)}>改價</button>
                                                        <button className={styles.smallBtn} disabled={busy === k} onClick={() => void cancel(t)}>{busy === k ? '處理中…' : '刪單'}</button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {repriceRow && <UsRepriceDialog row={repriceRow} onClose={() => setRepriceRow(null)} />}
        </div>
    );
}

// ---- 改價：刪單後重下（兩步確認） ----

type StepState = { state: 'pending' | 'running' | 'ok' | 'err'; text: string };

function StepLine({ n, step }: { n: number; step: StepState }) {
    const Icon = step.state === 'ok' ? CheckCircle2 : step.state === 'err' ? XCircle : step.state === 'running' ? Loader2 : Circle;
    return (
        <div className={styles.step[step.state]}>
            <Icon size={14} aria-hidden />
            <span>第 {n} 步：{step.text}</span>
        </div>
    );
}

export function UsRepriceDialog({ row, onClose }: { row: AccountedUsTrade; onClose: () => void }) {
    const [price, setPrice] = useState(String(row.order.price ?? ''));
    const [step1, setStep1] = useState<StepState>({ state: 'pending', text: `刪除原委託（未成交 ${fmtDec(usRemaining(row))} 股 @ ${fmtDec(row.order.price)}）` });
    const [step2, setStep2] = useState<StepState>({ state: 'pending', text: '以新價格重新下單' });
    const [next, setNext] = useState<UsOrderReq | null>(null);
    const [running, setRunning] = useState(false);
    const problem = priceChangeProblem(row, price);
    const started = step1.state !== 'pending';

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [running, onClose]);

    const runCancel = async () => {
        if (problem) return;
        setRunning(true);
        setStep1(s => ({ ...s, state: 'running' }));
        try {
            const r = await cancelUsTrade(row);
            if (!r.confirmed) {
                setStep1({ state: 'err', text: '刪單已送出但尚未確認，為避免重複下單不會重下；請稍後按更新查看' });
                return;
            }
            setStep1({ state: 'ok', text: `原委託已刪除，取消 ${fmtDec(r.cancelled)} 股` });
            const order = replacementOrder(row, r.cancelled ?? '0', price);
            if (typeof order === 'string') { setStep2({ state: 'err', text: order }); return; }
            setNext(order);
            setStep2({ state: 'pending', text: `以 ${order.price} 重下 ${order.quantity} 股（${order.time_in_force}）— 請按「送出新委託」確認` });
        } catch (e) {
            setStep1({ state: 'err', text: e instanceof UsCancelTooEarlyError ? e.message : e instanceof Error ? e.message : String(e) });
        } finally { setRunning(false); }
    };

    const runPlace = async () => {
        if (!next) return;
        setRunning(true);
        setStep2(s => ({ ...s, state: 'running' }));
        try {
            const t = await placeReplacement(row, next);
            setStep2({ state: 'ok', text: `新委託已送出：${orderStatusLabel(t.status?.status)} #${orderNumber(t)}，${next.quantity} 股 @ ${next.price}` });
            setNext(null);
        } catch (e) {
            // 拒單照原文顯示
            setStep2({ state: 'err', text: `新委託失敗：${e instanceof Error ? e.message : String(e)}（原委託已刪除）` });
        } finally { setRunning(false); }
    };

    return (
        <div className={styles.backdrop} role='dialog' aria-modal='true' aria-label='美股改價'>
            <div className={styles.dialog}>
                <div className={styles.dialogTitle}><UsMarketBadge />改價 {row.contract.code}（刪單後重下）</div>
                <div className={styles.notice}>
                    美股不能直接改價：會先刪除原委託，確認刪除後再由你按一次送出新委託。兩步之間若有成交，只重下實際取消的股數。
                </div>
                <label className={styles.header}>
                    <span className={styles.unit}>新價格（USD）</span>
                    <input
                        className={styles.inlineInput}
                        style={{ flex: 1 }}
                        inputMode='decimal'
                        aria-label='新價格'
                        disabled={started}
                        value={price}
                        onChange={e => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
                    />
                    <ArrowRight size={12} aria-hidden />
                </label>
                {!started && problem && <span className={styles.rowError}>{problem}</span>}
                <StepLine n={1} step={step1} />
                <StepLine n={2} step={step2} />
                <div className={styles.dialogActions}>
                    <button className={styles.smallBtn} disabled={running} onClick={onClose}>{step2.state === 'ok' || step1.state === 'err' || step2.state === 'err' ? '關閉' : '取消'}</button>
                    {!started && <button className={styles.smallBtn} disabled={running || !!problem} onClick={() => void runCancel()}>確認刪除原委託</button>}
                    {next && step2.state === 'pending' && <button className={styles.smallBtn} disabled={running} onClick={() => void runPlace()}>送出新委託</button>}
                </div>
            </div>
        </div>
    );
}

// ---- 庫存（feat/intl-portfolio，能力未確認時降級） ----

export function UsPositionsSection() {
    const has = useHasIntlAccount();
    const s = useUsTradingState();
    const privMoney = usePrivacyMoney();
    useEffect(() => { if (has) void refreshUsPositions(); }, [has]);
    if (!has) return null;
    return (
        <div className={styles.section} aria-label='美股庫存'>
            <div className={styles.sectionHead}>
                <UsMarketBadge />
                <span>美股庫存</span>
                <span style={{ flex: 1 }} />
                {s.positionsStatus !== 'unsupported' && (
                    <RefreshButton label='更新美股庫存' loading={s.positionsStatus === 'loading'} onClick={() => void refreshUsPositions()} iconSize={12} />
                )}
            </div>
            {s.positionsStatus === 'unsupported' || s.positionsStatus === 'error' ? (
                <div className={styles.sectionHead}>{US_POSITIONS_UNAVAILABLE}</div>
            ) : s.positionsStatus !== 'ready' ? (
                <div className={styles.sectionHead}>查詢中…</div>
            ) : s.positions.length === 0 ? (
                <div className={styles.sectionHead}>沒有美股庫存</div>
            ) : (
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th className={styles.th}>商品</th>
                            <th className={styles.th}>方向</th>
                            <th className={`${styles.th} ${styles.num}`}>股數</th>
                            <th className={`${styles.th} ${styles.num}`}>成本均價</th>
                            <th className={`${styles.th} ${styles.num}`}>市價</th>
                            <th className={`${styles.th} ${styles.num}`}>市值</th>
                            <th className={`${styles.th} ${styles.num}`}>損益</th>
                            <th className={`${styles.th} ${styles.num}`}>報酬率</th>
                        </tr>
                    </thead>
                    <tbody>
                        {s.positions.map(p => {
                            const pnlDir = p.pnl === null || p.pnl === undefined ? 'flat' : String(p.pnl).trim().startsWith('-') ? 'down' : decIsPositive(p.pnl) ? 'up' : 'flat';
                            return (
                                <tr key={`${p.account.broker_id}:${p.account.account_id}:${p.code}:${p.id}`}>
                                    <td className={`${styles.td} ${panel.mono}`}>{p.code}</td>
                                    <td className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}>{p.direction === 'Buy' ? '多' : '空'}</td>
                                    <td className={`${styles.td} ${styles.num}`}>{fmtDec(p.quantity)}</td>
                                    <td className={`${styles.td} ${styles.num}`}>{fmtDec(p.price)}</td>
                                    <td className={`${styles.td} ${styles.num}`}>{fmtDec(p.market_price)}</td>
                                    <td className={`${styles.td} ${styles.num}`}>{p.market_value === null || p.market_value === undefined ? '—' : maskMoney(fmtDec(p.market_value, { minFraction: 2, maxFraction: 2 }), privMoney)}</td>
                                    <td className={`${styles.td} ${styles.num} ${panel.dirText[pnlDir]}`}>{p.pnl === null || p.pnl === undefined ? '—' : maskMoney(fmtDec(p.pnl, { minFraction: 2, maxFraction: 2 }), privMoney)}</td>
                                    <td className={`${styles.td} ${styles.num} ${panel.dirText[pnlDir]}`}>{p.pnl_pct === null || p.pnl_pct === undefined ? '—' : `${fmtDec(p.pnl_pct, { maxFraction: 2 })}%`}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}
