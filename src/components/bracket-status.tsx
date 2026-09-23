// src/components/bracket-status.tsx — explicit bracket (括號單) protection
// status for one symbol (#102). Shows filled / protected / unprotected
// quantities, why protection is NOT confirmed, and offers the manual actions:
// authoritative reconcile (update_status), acknowledging an unknown exit and
// removing a plan. Nothing here sends or resends an order.

import { useEffect, useState } from 'react';
import {
    acknowledgeBracketExit,
    bracketSnapshotStale,
    cancelRemainingEntry,
    dismissBracket,
    reconcileBracket,
    useBrackets,
    type BracketPlan,
} from '../lib/bracket';
import {
    bracketPhase,
    isLive,
    protectionQuantity,
    unprotectedQuantity,
    workingEntryAfterExit,
} from '../lib/bracket-core';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import { useTriggerFeed } from '../lib/trigger-engine';
import * as styles from './bracket-status.css';

const PHASE: Record<ReturnType<typeof bracketPhase>, string> = {
    waiting: '等待進場成交',
    protected: '保護中',
    exiting: '出場中',
    done: '已出場',
    closed: '進場未成交',
};

const EXIT: Record<string, string> = {
    sending: '出場送單中',
    working: '出場委託已送出，等待成交',
    filled: '出場已成交',
    incomplete: '出場未完全成交',
    'not-sent': '出場未送出',
    unknown: '出場結果未知（不會自動重送）',
};

function Row({ plan, envNow, feedMissing, executing, stale }: {
    plan: BracketPlan;
    envNow: string | null;
    feedMissing: boolean;
    executing: boolean;
    stale: boolean;
}) {
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const workingEntry = workingEntryAfterExit(plan);
    const phase = bracketPhase(plan);
    const protectedQty = protectionQuantity(plan);
    const unprotected = unprotectedQuantity(plan);
    const unknownExit = plan.exit?.status === 'unknown' && !plan.exit.acknowledged;
    const elsewhere = plan.env !== envNow;
    const notRunning = stale || (isLive(plan) && (elsewhere || feedMissing || !executing));
    const tone = unprotected > 0 || unknownExit || plan.exit?.status === 'not-sent' || plan.exit?.status === 'incomplete'
        ? 'err' : plan.issues.length > 0 || notRunning ? 'warn' : 'ok';
    const run = async (fn: () => Promise<unknown>, done?: (v: unknown) => string) => {
        setBusy(true);
        setMessage(null);
        try {
            const value = await fn();
            if (done) setMessage(done(value));
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className={styles.row[tone]}>
            <div className={styles.head}>
                <span>{plan.account.account_type === 'F' ? '[期]' : '[證]'} {maskAccountId(plan.account.account_id, priv)}</span>
                <span className={styles.grow}>{PHASE[phase]}</span>
                <span>成交 {Math.min(plan.filled, plan.quantity)}/{plan.quantity}</span>
            </div>
            <div className={styles.note.muted}>
                {plan.action === 'Buy' ? '買進' : '賣出'}
                {plan.stopPrice !== null ? ` 停損 ${plan.stopPrice}` : ''}
                {plan.takePrice !== null ? ` 停利 ${plan.takePrice}` : ''}
                {protectedQty > 0 ? ` · OCO 保護 ${protectedQty}` : ''}
            </div>
            {plan.exit && (
                <div className={styles.note[tone === 'ok' ? 'ok' : 'err']}>
                    {plan.exit.kind === 'stop' ? '停損' : '停利'} {EXIT[plan.exit.status] ?? plan.exit.status}
                    {` ${plan.exit.filled}/${plan.exit.quantity}`}
                    {plan.exit.detail ? ` — ${plan.exit.detail}` : ''}
                </div>
            )}
            {stale && (
                <div className={styles.note.warn}>主視窗狀態未更新（可能已關閉或重新載入），以下為最後已知狀態，不代表保護正在執行</div>
            )}
            {workingEntry > 0 && (
                <div className={styles.note.err}>進場單仍有 {workingEntry} 未成交委託在場上；出場已觸發，之後的成交不受保護</div>
            )}
            {unprotected > 0 && (
                <div className={styles.note.err}>可能未保護 {unprotected}（待確認）：請先按「對帳」確認實際成交，勿直接另下出場單；系統不會自動重送</div>
            )}
            {isLive(plan) && elsewhere && (
                <div className={styles.note.warn}>
                    此括號單屬於{protectionEnvLabel(plan.env)}環境／其他伺服器，目前不執行{envNow ? '' : '（伺服器模式未確認）'}
                </div>
            )}
            {isLive(plan) && !elsewhere && !executing && !stale && (
                <div className={styles.note.warn}>此視窗／分頁不是執行中的主視窗，保護由主視窗執行</div>
            )}
            {isLive(plan) && feedMissing && (
                <div className={styles.note.warn}>此商品行情尚未訂閱成功，觸價可能不會觸發（自動重試中）</div>
            )}
            {plan.issues.length > 0 ? (
                <div className={styles.note.warn}>
                    保護未確認完整：{plan.issues.map(i => i.detail).join('；')}
                </div>
            ) : isLive(plan) && !notRunning ? (
                <div className={styles.note.ok}>回報追蹤正常</div>
            ) : null}
            {message && <div className={styles.note.muted}>{message}</div>}
            <div className={styles.actions}>
                {isLive(plan) && (
                    <button
                        className={styles.button}
                        disabled={busy}
                        title='向券商更新此帳戶委託（update_status，會使用查詢額度）'
                        onClick={() => void run(() => reconcileBracket(plan.id),
                            v => `對帳完成，回報快取狀態 ${(v as { health: string }).health}`)}
                    >
                        對帳
                    </button>
                )}
                {workingEntry > 0 && plan.entryCancel === 'unconfirmed' && (
                    <button
                        className={styles.button}
                        disabled={busy}
                        title='刪單已送出但未確認取消；向券商更新委託核對，不會重送刪單'
                        onClick={() => void run(() => reconcileBracket(plan.id),
                            v => `對帳完成，回報快取狀態 ${(v as { health: string }).health}`)}
                    >
                        刪單待確認 · 對帳
                    </button>
                )}
                {workingEntry > 0 && plan.entryCancel !== 'unconfirmed' && (
                    <button
                        className={styles.button}
                        disabled={busy || plan.entryCancel === 'sending'}
                        title='只送出一次刪單，不會自動重試或重送任何委託'
                        onClick={() => {
                            if (!confirmCancel) { setConfirmCancel(true); return; }
                            setConfirmCancel(false);
                            void run(() => cancelRemainingEntry(plan),
                                v => v === 'cancelled' ? '已確認取消剩餘進場單' : '刪單已送出但未確認取消，請按「刪單待確認 · 對帳」');
                        }}
                    >
                        {plan.entryCancel === 'sending' ? '刪單處理中…' : confirmCancel ? '再按一次：刪除剩餘進場單' : '刪除剩餘進場單'}
                    </button>
                )}
                {unknownExit && (
                    <button
                        className={styles.button}
                        disabled={busy}
                        title='已在委託／持倉確認出場結果；釋放保留量，不會送出任何委託'
                        onClick={() => void run(() => acknowledgeBracketExit(plan.id))}
                    >
                        已確認出場結果
                    </button>
                )}
                <button
                    className={styles.button}
                    disabled={busy}
                    onClick={() => {
                        if (isLive(plan) && !confirmRemove) {
                            setConfirmRemove(true);
                            return;
                        }
                        void run(() => dismissBracket(plan.id));
                    }}
                >
                    {confirmRemove ? '再按一次：移除並撤銷保護' : isLive(plan) ? '移除追蹤' : '關閉'}
                </button>
            </div>
        </div>
    );
}

export function BracketStatusList({ code }: { code: string }) {
    const plans = useBrackets().filter(p => !p.dismissed && (p.quoteCode === code || p.orderCode === code));
    useServerInfo(); // re-render when the server mode becomes known / changes
    const feed = useTriggerFeed();
    // re-evaluate mirror staleness without any broker request
    const [, setClock] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setClock(c => c + 1), 5000);
        return () => clearInterval(timer);
    }, []);
    if (plans.length === 0) return null;
    const stale = bracketSnapshotStale();
    const envNow = currentProtectionEnv();
    const paused = !envNow && plans.some(p => isLive(p));
    return (
        <div className={styles.list}>
            {paused && (
                <div className={styles.banner} role='alert'>
                    保護暫停：伺服器模式未確認 — 停損停利目前不會送出，確認後自動恢復
                </div>
            )}
            {plans.map(p => (
                <Row key={p.id} plan={p} envNow={envNow}
                    feedMissing={feed.feedMissing.includes(p.quoteCode)} executing={feed.executing} stale={stale} />
            ))}
        </div>
    );
}
