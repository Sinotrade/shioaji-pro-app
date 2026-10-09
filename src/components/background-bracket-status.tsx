// src/components/background-bracket-status.tsx — minimal list of background
// brackets (#201 ②) under the order ticket, until the 條件單管理面板 (#226)
// takes over. Built only on bracket-contract.ts views and actions:
// state, 未受保護, the session-change reminder with 「在新盤別重新啟用」
// (positions re-read, quantity capped), 「我已自行處理」 and 移除.
// Nothing here sends an order by itself.

import { CalendarClock, Eye, RotateCcw, Send, ShieldAlert, ShieldCheck, Trash2, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isMainWindow } from '../lib/main-window-commands';
import {
    markBackgroundHandled,
    resolveBackgroundTrigger,
    rearmBackgroundBracket,
    removeBackgroundBracket,
    useBackgroundPrograms,
} from '../lib/execution/background';
import { BRACKET_STATE_TEXT, bracketViews, type BracketView } from '../lib/execution/bracket-contract';
import { checkRearmQuantity, fetchAccountPositions, rearmPlan, type PositionView, type RearmSubject } from '../lib/execution/rearm';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './bracket-status.css';

/** The position a rearm protects: the exit closes the bracket's side. */
export function rearmSubject(v: BracketView): RearmSubject {
    return {
        order: { code: v.orderCode, action: v.side === 'Buy' ? 'Sell' : 'Buy', quantity: v.position, quantityUnit: 'contract' },
        account: { accountType: 'F', accountId: v.account.accountId, brokerId: v.account.brokerId },
    };
}

function useRun() {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const run = async (fn: () => Promise<unknown>, done?: string) => {
        setBusy(true);
        setMessage(null);
        try {
            await fn();
            if (done) setMessage(done);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return { busy, message, run };
}

type Positions = { state: 'loading' } | { state: 'ok'; view: PositionView } | { state: 'failed' };

function Rearm({ v, onClose }: { v: BracketView; onClose: () => void }) {
    const [pos, setPos] = useState<Positions>({ state: 'loading' });
    const [qty, setQty] = useState<string | null>(null);
    const { busy, message, run } = useRun();
    const subject = rearmSubject(v);
    // read this account's positions when the confirmation opens: the only
    // basis for the suggestion and the cap
    useEffect(() => {
        let alive = true;
        fetchAccountPositions(rearmSubject(v)).then(view => { if (alive) setPos({ state: 'ok', view }); },
            () => { if (alive) setPos({ state: 'failed' }); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const plan = pos.state === 'ok' ? rearmPlan(subject, pos.view)
        : { quantity: null, closable: null, notes: [pos.state === 'loading' ? '正在查詢這個帳戶的持倉…' : '無法確認持倉，暫時不能重新啟用'] };
    // protection closes only what is held now: a known closable position is required
    const cap = plan.closable !== null && plan.closable > 0 ? Math.min(plan.closable, v.position) : 0;
    const value = qty ?? (plan.quantity === null ? '' : String(plan.quantity));
    const n = Number(value);
    const valid = value !== '' && Number.isSafeInteger(n) && n > 0 && n <= cap;
    return (
        <div className={styles.row.warn} role='group' aria-label='確認重新啟用的內容'>
            <div className={styles.note.muted}>
                {`${v.orderCode} · ${v.stop !== null ? `停損 ${fmtPrice(v.stop)}` : ''}${v.stop !== null && v.take !== null ? ' · ' : ''}${
                    v.take !== null ? `停利 ${fmtPrice(v.take)}` : ''} · 觸發後市價${v.side === 'Buy' ? '賣出' : '買進'}平倉`}
            </div>
            {plan.notes.map(t => <div key={t} className={styles.note.warn}>{t}</div>)}
            <div className={styles.note.muted}>
                {cap > 0 ? `最多 ${cap} 口（目前可平倉量與括號單原本持有部位的較小者）`
                    : pos.state === 'ok' ? '目前沒有可平倉的部位，不需要重新啟用；若部位已自行處理，請按「我已自行處理」' : ''}
            </div>
            <label className={styles.actions}>
                <span>口數</span>
                <input aria-label='重新啟用口數' inputMode='numeric' value={value} disabled={busy || pos.state === 'loading'}
                    onChange={e => setQty(e.target.value.trim())} />
            </label>
            <div className={styles.note.muted}>
                確認後才會在這個盤別重新開始盯價，不會立即送單；價格穿過時送出的平倉單就是你在這裡核可的內容。若現在價格已穿過，會先等你決定。重新啟用為單次，不會循環。
            </div>
            {message && <div className={styles.note.err} role='alert'>{message}</div>}
            <div className={styles.actions}>
                <button type='button' className={styles.button} disabled={busy} onClick={onClose}>返回</button>
                <button type='button' className={styles.button} disabled={busy || pos.state === 'loading' || !valid}
                    onClick={() => void run(async () => {
                        const over = checkRearmQuantity(subject, n, pos.state === 'ok' ? pos.view : { known: false, positions: [] });
                        if (over) throw new Error(over);
                        await rearmBackgroundBracket(v.programId, v.levelId, n);
                        onClose();
                    })}>
                    {busy ? '處理中…' : `確認重新啟用（${valid ? n : '?'} 口）`}
                </button>
            </div>
        </div>
    );
}

function Row({ v, envNow, main }: { v: BracketView; envNow: string | null; main: boolean }) {
    const priv = usePrivacyMode();
    const [asking, setAsking] = useState(false);
    const [rearming, setRearming] = useState(false);
    const [sending, setSending] = useState(false);
    const { busy, message, run } = useRun();
    const here = v.env === envNow;
    const tone = v.attention ? 'err' : v.held || v.paused ? 'warn' : 'ok';
    const Icon = v.state === 'lapsed' ? CalendarClock : v.attention ? ShieldAlert : ShieldCheck;
    return (
        <div className={styles.row[tone]}>
            <div className={styles.head}>
                <Icon size={12} aria-hidden />
                <span>[期] {maskAccountId(v.account.accountId, priv)}</span>
                <span className={styles.grow}>{BRACKET_STATE_TEXT[v.state]}{v.paused ? '（已暫停進場；停損停利照常）' : ''}</span>
                <span>成交 {Math.min(v.entryFilled, v.quantity)}/{v.quantity}</span>
            </div>
            <div className={styles.note.muted}>
                背景執行 · {v.side === 'Buy' ? '買進' : '賣出'}
                {v.stop !== null ? ` 停損 ${fmtPrice(v.stop)}` : ''}
                {v.take !== null ? ` 停利 ${fmtPrice(v.take)}` : ''}
                {v.state === 'protected' || v.state === 'exiting' ? ` · 保護 ${v.position} 口` : ''}
                {v.rearm ? ' · 新盤別重新啟用' : ''}
            </div>
            {v.state === 'lapsed' && (
                <div className={styles.note.err}>
                    {`盤別已更換，原本 ${v.position} 口的停損停利沒有延續到這個盤別（委託不跨盤別）。需要的話請重新啟用，或按「我已自行處理」。`}
                </div>
            )}
            {v.unprotected > 0 && (
                <div className={styles.note.err}>
                    {`未受保護 ${v.unprotected} 口：保護結束後才成交，系統不會自動補掛；請到持倉核對後自行處理。`}
                </div>
            )}
            {v.state === 'needsConfirm' && (
                <div className={styles.note.err}>
                    {`恢復盯價時${v.pendingLeg === 'take' ? '停利' : '停損'}已穿價，沒有自動送單；請決定要立即平倉或繼續盯價。`}
                </div>
            )}
            {v.state === 'unknown' && (
                <div className={styles.note.err}>出場委託送出結果不明，不會自動重送；請在「委託待確認」核對。</div>
            )}
            {v.held && (
                <div className={styles.note.warn}>
                    {`此括號單屬於${protectionEnvLabel(v.env)}環境，目前${v.held === 'envMismatch' ? '連線的是其他環境' : '未連線'}，暫停執行`}
                </div>
            )}
            {message && <div className={styles.note.muted}>{message}</div>}
            {asking && (
                <div className={styles.note.warn}>
                    背景執行會停止追蹤這張括號單（包含部位與保護），不會送出或刪除任何委託；仍在委託中的單與持有的部位請你自行處理。
                </div>
            )}
            {rearming && <Rearm v={v} onClose={() => setRearming(false)} />}
            {main && !rearming && (
                <div className={styles.actions}>
                    {v.actions.rearm && (
                        <button type='button' className={styles.button} disabled={busy || !here}
                            title={here ? undefined : '切回原環境才能重新啟用'} onClick={() => setRearming(true)}>
                            <RotateCcw size={12} aria-hidden /> 在新盤別重新啟用
                        </button>
                    )}
                    {v.actions.decide && (
                        <>
                            <button type='button' className={styles.button} disabled={busy || !here}
                                title='恢復盯價時價格已穿過；立即以市價平倉這張括號單持有的口數'
                                onClick={() => {
                                    if (!sending) { setSending(true); return; }
                                    setSending(false);
                                    void run(() => resolveBackgroundTrigger(v.programId, v.levelId, 'send'));
                                }}>
                                <Send size={12} aria-hidden /> {sending ? `再按一次：市價平倉 ${v.position} 口` : '送出平倉單'}
                            </button>
                            <button type='button' className={styles.button} disabled={busy || !here}
                                title='不送單；價格回到觸發價另一側後再次穿過才觸發'
                                onClick={() => void run(() => resolveBackgroundTrigger(v.programId, v.levelId, 'keep'))}>
                                <Eye size={12} aria-hidden /> 繼續盯價
                            </button>
                        </>
                    )}
                    {v.actions.markHandled && (
                        <button type='button' className={styles.button} disabled={busy}
                            onClick={() => {
                                if (!asking) { setAsking(true); return; }
                                setAsking(false);
                                void run(() => markBackgroundHandled(v.programId, v.levelId));
                            }}>
                            <UserCheck size={12} aria-hidden /> {asking ? '再按一次：確認我已自行處理' : '我已自行處理'}
                        </button>
                    )}
                    {v.actions.remove && (
                        <button type='button' className={styles.button} disabled={busy}
                            onClick={() => void run(() => removeBackgroundBracket(v.programId))}>
                            <Trash2 size={12} aria-hidden /> 移除
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export function BackgroundBracketList({ code }: { code: string }) {
    const programs = useBackgroundPrograms();
    useServerInfo(); // re-render when the server mode becomes known / changes
    const views = bracketViews(programs).filter(v => v.quoteCode === code || v.orderCode === code);
    if (views.length === 0) return null;
    const envNow = currentProtectionEnv();
    const main = isMainWindow();
    return (
        <div className={styles.list}>
            {views.map(v => <Row key={`${v.programId}:${v.levelId}`} v={v} envNow={envNow} main={main} />)}
        </div>
    );
}
