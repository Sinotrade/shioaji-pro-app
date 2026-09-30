// src/components/pending-triggers.tsx — 觸價單待確認 (#144). Stop/take
// triggers that were already past their price when protection resumed are
// held here instead of sent; the user sends, cancels or keeps each one.
// Every action is a command to the executing main window. The main window
// shows the full, collapsible list; popouts only a compact badge.

import { useEffect, useRef, useState } from 'react';
import { dismissBracket } from '../lib/bracket';
import { ensureContract, useContract } from '../lib/contracts-cache';
import {
    actionLabel,
    conditionLabel,
    contractLabel,
    distanceLabel,
    kindLabel,
} from '../lib/pending-trigger-view';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import {
    isPendingUnpast,
    RESTORE_REASON_TEXT,
    requestPendingPrices,
    resolvePendingTrigger,
    usePendingPrices,
    useSendingTriggers,
    useTriggers,
    type PendingChoice,
    type TriggerOrder,
} from '../lib/trigger-engine';
import { isNativeTrigger } from '../lib/execution/native-view';
import { fmtPrice } from '../lib/utils/format';
import { focusMainWindow } from '../lib/window-role';
import * as styles from './pending-triggers.css';

/** Clicks this soon after a button entered its confirm state are ignored: a
 * double-click must never pass a two-step confirmation. */
export const CONFIRM_GUARD_MS = 400;
/** An armed confirmation falls back to the plain button after this. */
export const CONFIRM_TIMEOUT_MS = 10_000;

type ConfirmStep = 'send' | 'send-unpast' | 'cancel';

function detectedAt(at: number): string {
    const d = new Date(at);
    const time = d.toLocaleTimeString('en-GB');
    return d.toDateString() === new Date().toDateString() ? time
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`;
}

function Row({ trigger, price, envNow, sending }: {
    trigger: TriggerOrder;
    price: number | undefined;
    envNow: string | null;
    sending: boolean; // the main window is still processing a 送出 (e.g. its confirm dialog)
}) {
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    // two-step; the armed label follows the latest price until the 2nd click
    const [confirm, setConfirmState] = useState<ConfirmStep | null>(null);
    const armedAt = useRef(0);
    const setConfirm = (step: ConfirmStep | null) => {
        armedAt.current = Date.now();
        setConfirmState(step);
    };
    /** false for a click that lands right after the button changed meaning */
    const settled = () => Date.now() - armedAt.current >= CONFIRM_GUARD_MS;
    const here = !!trigger.env && trigger.env === envNow;
    // the tick feed belongs to the current environment only
    const shown = here ? price : undefined;
    const unpast = shown !== undefined && isPendingUnpast(trigger, shown);
    // no current price (stream down, environment changed): disarm 送出
    useEffect(() => {
        if (shown === undefined) setConfirmState(c => c === 'send' || c === 'send-unpast' ? null : c);
    }, [shown]);
    // an armed confirmation does not wait forever
    useEffect(() => {
        if (!confirm) return;
        const timer = setTimeout(() => setConfirmState(null), CONFIRM_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [confirm]);
    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setMessage(null);
        try {
            await fn();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            setConfirm(null);
        }
    };
    const resolve = (choice: PendingChoice, allowUnpast = false) =>
        void run(() => resolvePendingTrigger(trigger.id, choice, { allowUnpast }));
    const contract = useContract(trigger.code);
    useEffect(() => { void ensureContract(trigger.code).catch(() => undefined); }, [trigger.code]);
    const name = contractLabel(trigger.code, contract);
    const act = actionLabel(trigger);
    const distance = shown === undefined ? null : distanceLabel(trigger, shown);
    const acct = trigger.account
        ? `${trigger.account.account_type === 'F' ? '期貨' : '證券'}帳戶 ${maskAccountId(trigger.account.account_id, priv)}`
        : null;
    return (
        <div className={styles.row}>
            <div className={styles.rowHead}>
                <span className={trigger.kind === 'take' ? styles.kindTake : styles.kindStop}>{kindLabel(trigger)}</span>
                <span className={trigger.action === 'Buy' ? styles.buy : styles.sell}>{act}</span>
                <span className={styles.orderType}>市價單</span>
                {isNativeTrigger(trigger) && <span className={styles.orderType} title='由 App 原生執行引擎（實驗）執行'>原生</span>}
                {trigger.pending && <span className={styles.detected}>偵測於 {detectedAt(trigger.pending.at)}</span>}
            </div>
            <div className={styles.product}>
                <span className={styles.productName}>{name}</span>
                {name !== trigger.code && <span className={styles.code}>{trigger.code}</span>}
            </div>
            <div className={styles.facts}>
                <div className={styles.fact}>
                    <span className={styles.factLabel}>觸發條件</span>
                    <span className={styles.factValue}>{conditionLabel(trigger)}</span>
                </div>
                <div className={styles.fact}>
                    <span className={styles.factLabel}>目前價格</span>
                    <span className={styles.factValue}>{shown === undefined ? '未知' : fmtPrice(shown)}</span>
                </div>
                <div className={styles.fact}>
                    <span className={styles.factLabel}>狀態</span>
                    <span className={distance === null ? styles.factMuted : distance.past ? styles.factPast : styles.factUnpast}>
                        {distance === null ? '等待行情' : distance.text}
                    </span>
                </div>
            </div>
            {trigger.pending && (
                <span className={styles.hint}>
                    原因：{RESTORE_REASON_TEXT[trigger.pending.reason ?? 'restart']}，系統沒有自動送單
                    {`（偵測時價格 ${fmtPrice(trigger.pending.price)}）`}
                </span>
            )}
            <span className={styles.hint}>
                {[acct, trigger.env ? `${protectionEnvLabel(trigger.env)}環境` : '環境未知'].filter(Boolean).join(' · ')}
            </span>
            {!here && (
                <span className={styles.message}>
                    {envNow ? '這筆不屬於目前的伺服器環境，切回該環境才能送出' : '伺服器模式尚未確認，暫時不能送出'}
                </span>
            )}
            {unpast && (
                <span className={styles.message}>目前已未穿價：價格已經回到觸發價另一側。現在送出仍會立刻以市價成交，需要多確認一次。</span>
            )}
            {sending && <span className={styles.message}>送出處理中…（若開啟下單確認，請在主視窗確認）</span>}
            {message && <span className={styles.message}>{message}</span>}
            <div className={styles.actions}>
                <button
                    className={styles.primary}
                    disabled={busy || sending || shown === undefined}
                    title='重新檢查行情連線、環境與帳戶後，以原設定立即送出市價單'
                    onClick={() => {
                        if (confirm !== 'send' && confirm !== 'send-unpast') {
                            setConfirm('send');
                            void requestPendingPrices().catch(() => undefined);
                            return;
                        }
                        if (!settled()) return;
                        if (confirm === 'send' && unpast) { setConfirm('send-unpast'); return; }
                        resolve('send', confirm === 'send-unpast');
                    }}
                >
                    {sending ? '送出處理中'
                        : confirm === 'send-unpast' ? `目前已未穿價：再按一次仍市價${act}（目前 ${fmtPrice(shown)}）`
                            : confirm === 'send' ? `再按一次確認：市價${act}（目前 ${fmtPrice(shown)}）` : '立即送出市價單'}
                </button>
                <button
                    className={styles.button}
                    disabled={busy}
                    title='先不送單；價格回到觸發價另一側、再次穿過時才會觸發'
                    onClick={() => resolve('keep')}
                >
                    保留，等再次穿價
                </button>
                <button
                    className={styles.button}
                    disabled={busy}
                    title={trigger.bracketId ? '移除此括號單的追蹤與保護（同組停損停利一併移除）' : '刪除這筆觸價單，不送單'}
                    onClick={() => {
                        if (confirm !== 'cancel') { setConfirm('cancel'); return; }
                        if (!settled()) return;
                        void run(() => trigger.bracketId
                            ? dismissBracket(trigger.bracketId)
                            : resolvePendingTrigger(trigger.id, 'cancel'));
                    }}
                >
                    {confirm === 'cancel'
                        ? trigger.bracketId ? '再按一次：移除括號單保護' : '再按一次：取消這筆'
                        : trigger.bracketId ? '移除括號單' : '取消這筆'}
                </button>
            </div>
        </div>
    );
}

export function PendingTriggers({ compact = false }: { compact?: boolean }) {
    const pending = useTriggers().filter(t => t.pending);
    const prices = usePendingPrices();
    const sending = useSendingTriggers();
    const [open, setOpen] = useState(true);
    useServerInfo(); // re-render when the server mode becomes known / changes
    const envNow = currentProtectionEnv();
    if (pending.length === 0) return null;
    if (compact) {
        // popouts: a badge only; the decisions are made in the main window
        return (
            <button className={styles.badge} role='alert' title='在主視窗處理待確認觸價單'
                onClick={() => void focusMainWindow().catch(() => undefined)}>
                觸價單待確認 {pending.length} 筆 · 請在主視窗處理
            </button>
        );
    }
    return (
        <div className={open ? styles.panel : styles.panelCollapsed} role='alert'>
            <div className={styles.header}>
                <span className={styles.title}><span className={styles.dot} />觸價單待確認 · {pending.length} 筆</span>
                <button className={styles.button} onClick={() => setOpen(o => !o)} aria-expanded={open}>
                    {open ? '收合' : '展開'}
                </button>
            </div>
            {open && (
                <>
                    <div className={styles.hint}>
                        App 恢復盯價時，價格已經穿過這些單的觸發價。為了避免意外成交，系統先不送單，請逐筆決定。同一組停損停利（OCO）送出其中一筆後，其餘會自動取消。
                    </div>
                    {pending.map(t => <Row key={t.id} trigger={t} price={prices[t.code]} envNow={envNow} sending={sending.includes(t.id)} />)}
                </>
            )}
        </div>
    );
}
