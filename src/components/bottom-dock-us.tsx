// src/components/bottom-dock-us.tsx — 底部 dock 的美股（H 帳戶）列
//
// 美股委託／庫存直接併進委託、持倉表（bottom-dock-orders / -positions），
// 這裡只放美股專用的部分：資料彙總、列 key、價格／數量文字、逐筆操作
// （刪單、減量、兩步改價）。數量與價格一律是 decimal 字串，金額是 USD，
// 絕不和台股（TWD、張）相加。
// 列的 key 一律帶 `us:` 前綴與帳戶，不和台股裸代碼／委託 id 撞名。

import { ArrowRight, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAccounts } from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import { orderNumber, orderStatusLabel } from '../lib/order-status-label';
import type { AccountedUsTrade, UsOrderReq } from '../lib/types/us';
import { decAdd, decIsPositive, decToInt, fmtDec, fmtUsPrice } from '../lib/us/decimal';
import { cancelUsTrade, placeReplacement, US_FILLED_BEFORE_CANCEL, type UsCancelResult, priceChangeProblem, reduceUsTrade, replacementOrder, UsCancelTooEarlyError } from '../lib/us/us-order-actions';
import { getUsTradingState, subscribeUsTradingState, usRemaining, type UsTradingState } from '../lib/us/us-trading-state';
import { UsMarketBadge } from './us-order-panel';
import * as styles from './us-order-panel.css';
import * as dock from './bottom-dock.css';
export { fmtUsPnl, usAccountGroupKey, usAmountDir, usPositionRowKey, UsTag, type UsPositionRow } from './bottom-dock-shared';

function useHasIntlAccount() {
    const { accounts } = useAccounts();
    return accounts.some(a => a.account_type === 'H' && canTrade(a));
}

export interface UsDockSummary {
    /** 有可交易的 H 帳戶（不論篩選） */
    has: boolean;
    /** 有可交易的 H 帳戶且目前篩選會顯示美股 */
    shown: boolean;
    /** 美股庫存筆數；尚未就緒為 null */
    positions: number | null;
    activeOrders: number;
    totalOrders: number;
    /** 美股未實現損益合計（USD 字串）；沒有可加總的值為 null。絕不和台幣相加 */
    pnlUsd: string | null;
    /** 有庫存因沒有市價（損益 null）沒算進 pnlUsd */
    pnlPartial: boolean;
    /** 目前的美股交易狀態（shown=false 時 dock 不畫美股列） */
    state: UsTradingState;
}

/** 底部 dock 分頁計數、摘要與合併列的資料來源：只讀狀態，不啟動查詢 */
export function useUsDockSummary(visible: boolean): UsDockSummary {
    const has = useHasIntlAccount();
    const s = useSyncExternalStore(subscribeUsTradingState, getUsTradingState);
    return useMemo(() => {
        const shown = visible && has;
        if (!shown) return { has, shown, positions: null, activeOrders: 0, totalOrders: 0, pnlUsd: null, pnlPartial: false, state: s };
        let pnl: string | null = null;
        let partial = false;
        if (s.positionsStatus === 'ready') {
            for (const p of s.positions) {
                if (p.pnl === null || p.pnl === undefined) { partial = true; continue; }
                pnl = decAdd(pnl ?? '0', String(p.pnl)) ?? pnl;
            }
        }
        return {
            has,
            shown,
            positions: s.positionsStatus === 'ready' ? s.positions.length : null,
            activeOrders: s.trades.filter(t => decIsPositive(usRemaining(t))).length,
            totalOrders: s.trades.length,
            pnlUsd: pnl,
            pnlPartial: partial && pnl !== null,
            state: s,
        };
    }, [visible, has, s]);
}

// ---- 列 key 與文字 ----

/** React key：帶 us 前綴與帳戶，不和台股委託 id 共用命名空間 */
export const usOrderRowKey = (t: AccountedUsTrade) => `us:${t.account.broker_id}:${t.account.account_id}:${t.order.id}`;

export function usOrderPriceText(t: AccountedUsTrade): string {
    if (t.order.price_type === 'MKT') return '市價';
    return fmtUsPrice(t.order.price);
}

export function usStatusBucket(t: AccountedUsTrade): 'active' | 'filled' | 'dead' {
    if (decIsPositive(usRemaining(t))) return 'active';
    if (t.status.status === 'Filled') return 'filled';
    return 'dead';
}




// ---- 逐筆操作：刪單／減量／改價（美股專用，不走台股 mutation） ----

export function UsOrderActions({ t }: { t: AccountedUsTrade }) {
    // 每筆各自的處理中狀態：一筆在刪單時，其他筆仍可操作
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [reducing, setReducing] = useState(false);
    const [reduceQty, setReduceQty] = useState('');
    const [repricing, setRepricing] = useState(false);
    const remaining = usRemaining(t);
    const working = decIsPositive(remaining);

    const cancel = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await cancelUsTrade(t);
            setMsg({ kind: r.confirmed ? 'ok' : 'err', text: r.filled ? US_FILLED_BEFORE_CANCEL : r.confirmed ? `已刪單（取消 ${fmtDec(r.cancelled)} 股）` : '刪單已送出，尚未確認；請稍後按更新查看' });
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof UsCancelTooEarlyError ? e.message : e instanceof Error ? e.message : String(e) });
        } finally { setBusy(false); }
    };

    const reduce = async () => {
        const n = Number(reduceQty);
        if (busy) return;
        setBusy(true);
        try {
            await reduceUsTrade(t, n);
            setMsg({ kind: 'ok', text: `減量 ${n} 股已送出` });
            setReducing(false);
            setReduceQty('');
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
        } finally { setBusy(false); }
    };

    return (
        // 操作與改價對話框裡的點擊不連動商品
        <span className={dock.usActions} onClick={e => e.stopPropagation()}>
            {working && (reducing ? (
                <>
                    <input
                        className={dock.qtyInline}
                        inputMode='numeric'
                        aria-label='減少股數'
                        placeholder={`1–${decToInt(remaining) ?? ''}`}
                        value={reduceQty}
                        onChange={e => setReduceQty(e.target.value.replace(/\D/g, ''))}
                    />
                    <button className={dock.cancelBtn} disabled={busy || !reduceQty} onClick={() => void reduce()}>確認減量</button>
                    <button className={dock.cancelBtn} onClick={() => { setReducing(false); setReduceQty(''); }}>取消</button>
                </>
            ) : (
                <>
                    <button className={dock.cancelBtn} disabled={busy || t.order.price_type === 'MKT'} title={t.order.price_type === 'MKT' ? '市價單不能改價' : '美股改價＝先刪單再以新價格重下'} onClick={() => setRepricing(true)}>改價</button>
                    <button className={dock.cancelBtn} disabled={busy} title='減少股數' onClick={() => { setReducing(true); setReduceQty(''); }}>減量</button>
                    <button className={dock.cancelBtn} disabled={busy} onClick={() => void cancel()}>{busy ? '處理中…' : '刪單'}</button>
                </>
            ))}
            {msg && <span className={msg.kind === 'err' ? styles.rowError : styles.infoMeta} role='status'>{msg.text}</span>}
            {repricing && <UsRepriceDialog row={t} onClose={() => setRepricing(false)} />}
        </span>
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
    const [price, setPrice] = useState(() => {
        const shown = fmtUsPrice(row.order.price);
        return shown === '—' ? '' : shown;
    });
    const [step1, setStep1] = useState<StepState>({ state: 'pending', text: `刪除原委託（未成交 ${fmtDec(usRemaining(row))} 股 @ ${fmtUsPrice(row.order.price)}）` });
    const [step2, setStep2] = useState<StepState>({ state: 'pending', text: '以新價格重新下單' });
    const [next, setNext] = useState<{ order: UsOrderReq; env: UsCancelResult['env'] } | null>(null);
    const [running, setRunning] = useState(false);
    // 開窗時價格等於原價：使用者改過之後才顯示檢查結果
    const [edited, setEdited] = useState(false);
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
            if (r.filled) {
                setStep1({ state: 'ok', text: `${US_FILLED_BEFORE_CANCEL}，沒有取消任何股數` });
                setStep2({ state: 'err', text: '已全部成交，不重下' });
                return;
            }
            setStep1({ state: 'ok', text: `原委託已刪除，取消 ${fmtDec(r.cancelled)} 股` });
            const order = replacementOrder(row, r.cancelled ?? '0', price);
            if (typeof order === 'string') { setStep2({ state: 'err', text: order }); return; }
            setNext({ order, env: r.env });
            setStep2({ state: 'pending', text: `以 ${fmtUsPrice(order.price)} 重下 ${order.quantity} 股（${order.time_in_force}）— 請按「送出新委託」確認` });
        } catch (e) {
            setStep1({ state: 'err', text: e instanceof UsCancelTooEarlyError ? e.message : e instanceof Error ? e.message : String(e) });
        } finally { setRunning(false); }
    };

    const runPlace = async () => {
        if (!next) return;
        setRunning(true);
        setStep2(s => ({ ...s, state: 'running' }));
        try {
            const t = await placeReplacement(row, next.order, next.env);
            setStep2({ state: 'ok', text: `新委託已送出：${orderStatusLabel(t.status?.status)} #${orderNumber(t)}，${next.order.quantity} 股 @ ${fmtUsPrice(next.order.price)}` });
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
                        onChange={e => { setEdited(true); setPrice(e.target.value.replace(/[^\d.]/g, '')); }}
                    />
                    <ArrowRight size={12} aria-hidden />
                </label>
                {/* 固定保留一行高度：錯誤出現時對話框不跳動 */}
                <span className={styles.rowError} style={{ minHeight: '1.4em' }} aria-live='polite'>{!started && edited && problem ? problem : ''}</span>
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
