// src/components/pending-triggers.tsx — 觸價單待確認 (#144). Stop/take
// triggers that were already past their price when protection resumed are
// held here instead of sent; the user sends, cancels or keeps each one.
// Every action is a command to the executing main window. The main window
// shows the full, collapsible list; popouts only a compact badge.

import { useEffect, useRef, useState } from 'react';
import { dismissBracket } from '../lib/bracket';
import { usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import {
    describePending,
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
    const side = `市價${trigger.action === 'Buy' ? '買' : '賣'} ${trigger.quantity}`;
    return (
        <div className={styles.row}>
            <span className={styles.line}>{describePending(trigger, shown, priv)}</span>
            <span className={styles.hint}>
                {trigger.env ? `${protectionEnvLabel(trigger.env)}環境` : '環境未知'}
                {here ? '' : envNow ? '（非目前環境，目前價不顯示；切回該環境才能送出）' : '（伺服器模式未確認）'}
                {trigger.pending && ` · 偵測時價格 ${trigger.pending.price} · 偵測時間 ${detectedAt(trigger.pending.at)}`}
            </span>
            {trigger.pending && (
                <span className={styles.hint}>原因：{RESTORE_REASON_TEXT[trigger.pending.reason ?? 'restart']}，未自動送單</span>
            )}
            {unpast && (
                <span className={styles.message}>目前已未穿價（價格已回到觸價另一側）；送出仍會立即以市價成交，需再多確認一次</span>
            )}
            {sending && <span className={styles.message}>送出處理中…（若開啟下單確認，請在主視窗確認）</span>}
            {message && <span className={styles.message}>{message}</span>}
            <div className={styles.actions}>
                <button
                    className={styles.primary}
                    disabled={busy || sending || shown === undefined}
                    title='重新檢查行情連線、環境與帳戶後，以原設定送出市價單'
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
                        : confirm === 'send-unpast' ? `目前已未穿價：再按一次仍${side}（目前 ${shown}）`
                            : confirm === 'send' ? `再按一次：${side}（目前 ${shown}）` : '送出'}
                </button>
                <button
                    className={styles.button}
                    disabled={busy}
                    title='保留觸價單；價格先回到觸價另一側、再次穿價才會觸發'
                    onClick={() => resolve('keep')}
                >
                    保留
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
                        ? trigger.bracketId ? '再按一次：移除括號單保護' : '再按一次：取消'
                        : trigger.bracketId ? '移除括號單' : '取消'}
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
                <span className={styles.title}>觸價單待確認（{pending.length}）</span>
                <button className={styles.button} onClick={() => setOpen(o => !o)} aria-expanded={open}>
                    {open ? '收合' : '展開'}
                </button>
            </div>
            {open && (
                <>
                    <div className={styles.hint}>
                        恢復盯價時價格已穿過觸價，系統未自動送單（原因見各筆）。請逐筆選擇送出、保留或取消；OCO 同組一筆送出後其餘自動取消。
                    </div>
                    {pending.map(t => <Row key={t.id} trigger={t} price={prices[t.code]} envNow={envNow} sending={sending.includes(t.id)} />)}
                </>
            )}
        </div>
    );
}
