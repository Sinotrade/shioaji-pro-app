// src/components/pending-triggers.tsx — 觸價單待確認 (#144). Stop/take
// triggers that were already past their price when protection resumed are
// held here instead of sent; the user sends, cancels or keeps each one.
// Every action is a command to the executing main window.

import { useState } from 'react';
import { dismissBracket } from '../lib/bracket';
import { usePrivacyMode } from '../lib/privacy';
import {
    describePending,
    resolvePendingTrigger,
    usePendingPrices,
    useTriggers,
    type PendingChoice,
    type TriggerOrder,
} from '../lib/trigger-engine';
import * as styles from './pending-triggers.css';

function Row({ trigger, price }: { trigger: TriggerOrder; price: number | undefined }) {
    const priv = usePrivacyMode();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    // two-step: the second click confirms the price shown at that moment
    const [confirm, setConfirm] = useState<{ choice: 'send' | 'cancel'; price: number | undefined } | null>(null);
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
    const resolve = (choice: PendingChoice, seenPrice?: number) =>
        void run(() => resolvePendingTrigger(trigger.id, choice, seenPrice));
    const side = `市價${trigger.action === 'Buy' ? '買' : '賣'} ${trigger.quantity}`;
    return (
        <div className={styles.row}>
            <span className={styles.line}>{describePending(trigger, price, priv)}</span>
            {trigger.pending && (
                <span className={styles.hint}>
                    偵測時價格 {trigger.pending.price} · {new Date(trigger.pending.at).toLocaleTimeString('en-GB')}
                </span>
            )}
            {message && <span className={styles.message}>{message}</span>}
            <div className={styles.actions}>
                <button
                    className={styles.primary}
                    disabled={busy || price === undefined}
                    title='重新檢查目前價與帳戶後，以原設定送出市價單'
                    onClick={() => {
                        if (confirm?.choice !== 'send') { setConfirm({ choice: 'send', price }); return; }
                        resolve('send', confirm.price);
                    }}
                >
                    {confirm?.choice === 'send' ? `再按一次：${side}（目前 ${confirm.price}）` : '送出'}
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
                        if (confirm?.choice !== 'cancel') { setConfirm({ choice: 'cancel', price }); return; }
                        void run(() => trigger.bracketId
                            ? dismissBracket(trigger.bracketId)
                            : resolvePendingTrigger(trigger.id, 'cancel'));
                    }}
                >
                    {confirm?.choice === 'cancel'
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
    if (pending.length === 0) return null;
    return (
        <div className={styles.panel} role='alert'>
            <div className={styles.title}>觸價單待確認（{pending.length}）</div>
            <div className={styles.hint}>
                App 關閉或未執行期間價格已穿過觸價，系統未自動送單。請逐筆選擇送出、保留或取消；OCO 同組一筆送出後其餘自動取消。
            </div>
            {pending.map(t => <Row key={t.id} trigger={t} price={prices[t.code]} />)}
        </div>
    );
}
