// src/components/bracket-status.tsx — explicit bracket (括號單) protection
// status for one symbol (#102). Shows filled / protected / unprotected
// quantities, why protection is NOT confirmed, and offers the manual actions:
// authoritative reconcile (update_status), acknowledging an unknown exit and
// removing a plan. Nothing here sends or resends an order.

import { useState } from 'react';
import {
    acknowledgeBracketExit,
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
} from '../lib/bracket-core';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
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

function Row({ plan }: { plan: BracketPlan }) {
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const phase = bracketPhase(plan);
    const protectedQty = protectionQuantity(plan);
    const unprotected = unprotectedQuantity(plan);
    const unknownExit = plan.exit?.status === 'unknown';
    const tone = unprotected > 0 || unknownExit || plan.exit?.status === 'not-sent' || plan.exit?.status === 'incomplete'
        ? 'err' : plan.issues.length > 0 ? 'warn' : 'ok';
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
            {unprotected > 0 && (
                <div className={styles.note.err}>未保護 {unprotected}：請手動處理出場，系統不會自動重送</div>
            )}
            {plan.issues.length > 0 ? (
                <div className={styles.note.warn}>
                    保護未確認完整：{plan.issues.map(i => i.detail).join('；')}
                </div>
            ) : isLive(plan) ? (
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
    if (plans.length === 0) return null;
    return (
        <div className={styles.list}>
            {plans.map(p => <Row key={p.id} plan={p} />)}
        </div>
    );
}
