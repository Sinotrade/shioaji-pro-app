// src/components/pending-triggers.tsx — 觸價單待確認 (#144). Stop/take
// triggers that were already past their price when protection resumed are
// held here instead of sent; the user sends, cancels or keeps each one.
// Every action is a command to the executing main window.

import { useState } from 'react';
import { dismissBracket } from '../lib/bracket';
import { usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import {
    describePending,
    requestPendingPrices,
    resolvePendingTrigger,
    usePendingPrices,
    useTriggers,
    type PendingChoice,
    type TriggerOrder,
} from '../lib/trigger-engine';
import * as styles from './pending-triggers.css';

function detectedAt(at: number): string {
    const d = new Date(at);
    const time = d.toLocaleTimeString('en-GB');
    return d.toDateString() === new Date().toDateString() ? time
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${time}`;
}

function Row({ trigger, price, envNow }: { trigger: TriggerOrder; price: number | undefined; envNow: string | null }) {
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    // two-step; the armed label follows the latest price until the 2nd click
    const [confirm, setConfirm] = useState<'send' | 'cancel' | null>(null);
    const here = !!trigger.env && trigger.env === envNow;
    // the tick feed belongs to the current environment only
    const shown = here ? price : undefined;
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
    const resolve = (choice: PendingChoice) => void run(() => resolvePendingTrigger(trigger.id, choice));
    const side = `市價${trigger.action === 'Buy' ? '買' : '賣'} ${trigger.quantity}`;
    return (
        <div className={styles.row}>
            <span className={styles.line}>{describePending(trigger, shown, priv)}</span>
            <span className={styles.hint}>
                {trigger.env ? `${protectionEnvLabel(trigger.env)}環境` : '環境未知'}
                {here ? '' : envNow ? '（非目前環境，目前價不顯示；切回該環境才能送出）' : '（伺服器模式未確認）'}
                {trigger.pending && ` · 偵測時價格 ${trigger.pending.price} · 偵測時間 ${detectedAt(trigger.pending.at)}`}
            </span>
            {message && <span className={styles.message}>{message}</span>}
            <div className={styles.actions}>
                <button
                    className={styles.primary}
                    disabled={busy || shown === undefined}
                    title='重新檢查行情連線、環境與帳戶後，以原設定送出市價單'
                    onClick={() => {
                        if (confirm !== 'send') {
                            setConfirm('send');
                            void requestPendingPrices().catch(() => undefined);
                            return;
                        }
                        resolve('send');
                    }}
                >
                    {confirm === 'send' ? `再按一次：${side}（目前 ${shown}）` : '送出'}
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

export function PendingTriggers() {
    const pending = useTriggers().filter(t => t.pending);
    const prices = usePendingPrices();
    useServerInfo(); // re-render when the server mode becomes known / changes
    const envNow = currentProtectionEnv();
    if (pending.length === 0) return null;
    return (
        <div className={styles.panel} role='alert'>
            <div className={styles.title}>觸價單待確認（{pending.length}）</div>
            <div className={styles.hint}>
                App 關閉或未執行期間價格已穿過觸價，系統未自動送單。請逐筆選擇送出、保留或取消；OCO 同組一筆送出後其餘自動取消。
            </div>
            {pending.map(t => <Row key={t.id} trigger={t} price={prices[t.code]} envNow={envNow} />)}
        </div>
    );
}
