// src/components/pending-confirm.tsx — 委託待確認卡 (#201 ③, A 方案). After a
// crash / restart the background engine may hold orders it sent but could not
// confirm (no response, no trade_id, never seen in the order listing). Each
// one gets a card: what was sent, a way to the order list, and the user's
// decision — 已送出 or 確認沒有送出（取消這筆）. The card never sends or
// resends an order; to order again the user uses an order ticket. Orders
// whose trading session already changed are shown as 已失效 only.
// The main window shows the cards; popouts only a badge.

import { CalendarX2, ChevronDown, ChevronUp, CircleHelp, ListChecks, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { requestOpenOrdersTab } from '../lib/dock-events';
import { refreshPendingConfirm, resolvePendingConfirm, usePendingConfirm } from '../lib/execution/pending-confirm';
import { UNIT_LABEL, type PendingConfirmItem, type PendingResolution } from '../lib/execution/pending-confirm-contract';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { currentProtectionEnv, protectionEnvLabel } from '../lib/protection-env';
import { useServerInfo } from '../lib/server-info-store';
import { fmtPrice } from '../lib/utils/format';
import { focusMainWindow } from '../lib/window-role';
import * as styles from './pending-confirm.css';

const pad = (n: number) => String(n).padStart(2, '0');

/** HH:MM:SS today, otherwise M/D HH:MM:SS. */
export function sentAtLabel(at: number, now = new Date()): string {
    const d = new Date(at);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return d.toDateString() === now.toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function sessionLabel(item: PendingConfirmItem): string {
    const [, m, d] = item.session.tradingDay.split('-').map(Number);
    return `${m}/${d} ${item.session.period === 'night' ? '夜盤' : '日盤'}`;
}

export function ownerLabel(item: PendingConfirmItem): string {
    const leg = item.owner.leg === 'stop' ? '停損' : item.owner.leg === 'take' ? '停利' : '';
    return item.owner.kind === 'bracket' ? `括號單${leg || ''}` : `${leg}觸價單`;
}

export function priceLabel(item: PendingConfirmItem): string {
    return item.order.priceType === 'MKT' || item.order.price === null ? '市價' : `限價 ${fmtPrice(item.order.price)}`;
}

function Facts({ item }: { item: PendingConfirmItem }) {
    const priv = usePrivacyMode();
    const { order } = item;
    return (
        <>
            <div className={styles.product}>
                <span className={styles.productName}>{order.name ?? order.code}</span>
                {order.name && <span className={styles.code}>{order.code}</span>}
            </div>
            <div className={styles.chips}>
                <span className={order.action === 'Buy' ? styles.chipBuy : styles.chipSell}>
                    {order.action === 'Buy' ? '買進' : '賣出'} {order.quantity} {UNIT_LABEL[order.quantityUnit]}
                </span>
                <span className={styles.chip}>{priceLabel(item)} · {order.orderType}</span>
                <span className={styles.chip}>送出 {sentAtLabel(item.submittedAt)}</span>
                <span className={styles.chip}>
                    {ownerLabel(item)}{order.triggerPrice !== null ? ` · 觸發價 ${fmtPrice(order.triggerPrice)}` : ''}
                </span>
            </div>
            <div className={styles.note.muted}>
                {item.account.accountType === 'F' ? '期貨' : '證券'}帳戶 {maskAccountId(item.account.accountId, priv)}
                {' · '}{protectionEnvLabel(item.env)}環境 · {sessionLabel(item)}
            </div>
        </>
    );
}

/** 開啟委託查詢 + a note when this layout has no orders dock. */
function OpenOrdersButton() {
    const [missing, setMissing] = useState(false);
    return (
        <>
            <button type='button' className={styles.button} onClick={() => setMissing(!requestOpenOrdersTab())}
                title='切到下方「委託」分頁（全部狀態、全部帳戶）並更新一次'>
                <ListChecks size={12} aria-hidden />開啟委託查詢
            </button>
            {missing && (
                <span className={styles.note.warn}>目前版面沒有委託區，請從面板庫加入下方 Dock 後再核對</span>
            )}
        </>
    );
}

function useRun() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, run };
}

type Choice = Extract<PendingResolution, 'confirmedSent' | 'confirmedNotSent'>;

function ConfirmCard({ item, envNow }: { item: PendingConfirmItem; envNow: string | null }) {
    const [why, setWhy] = useState(false);
    const [choice, setChoice] = useState<Choice | null>(null);
    const { busy, error, run } = useRun();
    const here = item.env === envNow;
    const locked = busy || !here;
    const primaryLabel = choice === 'confirmedSent' ? '確認已送出，結束追蹤'
        : choice === 'confirmedNotSent' ? '確認沒有送出，取消這筆' : '請先選擇核對結果';
    return (
        <div className={styles.cardConfirm} role='group' aria-label={`${item.order.code} 送出結果待確認`}>
            <div className={styles.cardTitle}>
                <TriangleAlert size={13} aria-hidden />
                <span className={styles.grow}>送出結果不明，請核對委託</span>
                <button type='button' className={styles.iconButton} aria-label='為什麼要確認'
                    aria-expanded={why} onClick={() => setWhy(w => !w)}>
                    <CircleHelp size={13} aria-hidden />
                </button>
            </div>
            {why && (
                <div className={styles.note.muted}>
                    {`背景執行送出這筆委託後沒有收到券商回應，也沒有委託編號；之後完整查詢委託清單 ${item.listingChecks} 次都沒有找到它（自訂欄位 ${item.tag}）。`}
                    查不到不代表沒有送出：它可能已送達券商甚至已成交。為了避免重複下單，系統不會自動重送；
                    請一併核對委託、成交與持倉後再選擇。
                </div>
            )}
            <Facts item={item} />
            <div className={styles.stepRow}>
                <span className={styles.stepLabel}>① 核對委託、成交與持倉</span>
                <OpenOrdersButton />
            </div>
            <div className={styles.stepRow}>
                <span className={styles.stepLabel}>② 核對結果</span>
            </div>
            <div className={styles.choices} role='radiogroup' aria-label='核對結果'>
                <label className={styles.choice}>
                    <input type='radio' name={`pc-${item.id}`} checked={choice === 'confirmedSent'} disabled={locked}
                        onChange={() => setChoice('confirmedSent')} />
                    <span>已確認已送出或已成交<span className={styles.note.muted}>（委託、成交或持倉找得到）</span></span>
                </label>
                <label className={styles.choice}>
                    <input type='radio' name={`pc-${item.id}`} checked={choice === 'confirmedNotSent'} disabled={locked}
                        onChange={() => setChoice('confirmedNotSent')} />
                    <span>確認沒有送出，取消這筆<span className={styles.note.muted}>（委託、成交與持倉都沒有）</span></span>
                </label>
            </div>
            {!here && (
                <div className={styles.note.warn}>
                    {envNow ? `這筆屬於${protectionEnvLabel(item.env)}環境，切回${protectionEnvLabel(item.env)}環境才能核對與確認`
                        : '伺服器模式尚未確認，暫時不能確認'}
                </div>
            )}
            {error && <div className={styles.note.err}>{error}</div>}
            <button
                type='button'
                className={styles.primary}
                disabled={locked || choice === null}
                title='只記錄你的核對結果；不會送出、重送或刪除任何委託'
                onClick={() => { if (choice) void run(() => resolvePendingConfirm(item, choice)); }}
            >
                {busy ? '處理中…' : primaryLabel}
            </button>
            <div className={styles.note.muted}>這張卡不會送出任何委託，也不會自動重送。若要重新下單，請到下單面板自行下單。</div>
        </div>
    );
}

function ExpiredCard({ item }: { item: PendingConfirmItem }) {
    const { busy, error, run } = useRun();
    return (
        <div className={styles.cardExpired} role='group' aria-label={`${item.order.code} 委託已失效`}>
            <div className={styles.cardTitleQuiet}>
                <CalendarX2 size={13} aria-hidden />
                <span className={styles.grow}>盤別已更換，不需確認</span>
                <span className={styles.chipExpired}>已失效</span>
            </div>
            <Facts item={item} />
            <div className={styles.note.muted}>
                {`${sessionLabel(item)}結束時仍查不到這筆的結果。委託不跨盤別，已自動失效，不會再成交，系統也不會重送。若失效前可能已成交，請到成交查詢與持倉核對。`}
            </div>
            {error && <div className={styles.note.err}>{error}</div>}
            <div className={styles.stepRow}>
                <OpenOrdersButton />
                <button type='button' className={styles.button} disabled={busy}
                    onClick={() => void run(() => resolvePendingConfirm(item, 'acknowledgeExpired'))}>
                    {busy ? '處理中…' : '知道了，移除'}
                </button>
            </div>
        </div>
    );
}

export function PendingConfirmPanel({ compact = false }: { compact?: boolean }) {
    const { snapshot, error, generation } = usePendingConfirm();
    const [open, setOpen] = useState(true);
    useServerInfo(); // re-render when the server mode becomes known / changes
    const items = snapshot?.items ?? [];
    const confirm = items.filter(i => i.state === 'needsConfirm');
    const expired = items.filter(i => i.state === 'expired');
    if (items.length === 0 && !error) return null;
    if (compact) {
        return (
            <div className={styles.badgeWrap} role='status'>
                <button type='button' className={styles.badge} title='在主視窗處理待確認委託'
                    onClick={() => void focusMainWindow().catch(() => undefined)}>
                    <TriangleAlert size={12} aria-hidden />
                    {confirm.length > 0 || error ? `委託待確認 ${confirm.length} 筆` : `委託已失效 ${expired.length} 筆`} · 請在主視窗處理
                </button>
            </div>
        );
    }
    const envNow = currentProtectionEnv();
    const quiet = confirm.length === 0 && !error;
    const counts = [confirm.length > 0 && `待確認 ${confirm.length} 筆`, expired.length > 0 && `已失效 ${expired.length} 筆`]
        .filter(Boolean).join(' · ');
    return (
        <div className={!open ? styles.panelCollapsed : quiet ? styles.panelQuiet : styles.panel} role='region' aria-label='委託待確認'>
            <div className={styles.header}>
                <span className={quiet ? styles.titleQuiet : styles.title} role={quiet ? 'status' : 'alert'}>
                    <TriangleAlert size={14} aria-hidden />{quiet ? '委託已失效' : '委託待確認'}
                    {counts && <span className={styles.count}>{counts}</span>}
                </span>
                <button type='button' className={styles.button} onClick={() => setOpen(o => !o)} aria-expanded={open}>
                    {open ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
                    {open ? '收合' : '展開'}
                </button>
            </div>
            {open && (
                <>
                    {snapshot?.uncleanShutdown && confirm.length > 0 && (
                        <div className={styles.banner}>
                            <TriangleAlert size={13} aria-hidden />
                            <span>上次 App 沒有正常關閉，以下委託的送出結果需要你確認。系統不會自動重送。</span>
                        </div>
                    )}
                    {error && (
                        <div className={styles.stepRow}>
                            <span className={`${styles.note.err} ${styles.grow}`}>{error}</span>
                            <button type='button' className={styles.button} onClick={() => void refreshPendingConfirm()}>
                                <RefreshCw size={12} aria-hidden />重新整理
                            </button>
                        </div>
                    )}
                    {confirm.map(i => <ConfirmCard key={`${generation}:${snapshot?.runId}:${i.id}:${i.revision}`} item={i} envNow={envNow} />)}
                    {expired.map(i => <ExpiredCard key={`${generation}:${snapshot?.runId}:${i.id}:${i.revision}`} item={i} />)}
                </>
            )}
        </div>
    );
}
