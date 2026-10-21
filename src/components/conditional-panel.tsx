// src/components/conditional-panel.tsx — 條件單管理面板 (#226, design v4).
// Every conditional order in one place: 需要你處理 pinned on top, then the
// running ones; each row can be modified, paused / resumed or cancelled, and
// expands into its edit form and history. Narrow placements (the dock) show
// cards. Every action is a command to the engine that owns the order (with
// its own checks); nothing here sends an order by itself, and the panel
// never shows which engine runs a row.

import {
    AppWindow,
    ChevronRight,
    CircleAlert,
    CircleCheck,
    Crosshair,
    History,
    Info,
    ListChecks,
    OctagonX,
    Settings2,
    Pause,
    Pencil,
    Play,
    Plus,
    Server,
    ChevronDown,
    Trash2,
    TriangleAlert,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { acknowledgeBracketExit, dismissBracket, modifyBracket, reconcileBracket } from '../lib/bracket';
import { ensureContract, useContract } from '../lib/contracts-cache';
import { isMainWindow } from '../lib/main-window-commands';
import {
    markBackgroundHandled,
    pauseBackgroundProgram,
    removeBackgroundBracket,
    resolveBackgroundTrigger,
    resumeBackgroundProgram,
} from '../lib/execution/background';
import { contractLabel } from '../lib/pending-trigger-view';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { useRevealText } from '../lib/privacy-text';
import {
    acknowledgeExit,
    modifyTrigger,
    modifyTriggerGroup,
    removeTrigger,
    requestPendingPrices,
    setTriggerGroup,
    resolvePendingTrigger,
    setTriggerPaused,
    type HistoryEntry,
    type TriggerOrder,
} from '../lib/trigger-engine';
import { accountTag, bgBracketRows, KIND_LABEL, rowRunner, rowsForTab, shortStatus, TABS, type CondRow, type CondTab } from '../lib/conditional/rows';
import { useConditionalView, useStreamStatus, type ConditionalView } from '../lib/conditional/use-conditional';
import { useConditionalSettings } from '../lib/conditional/settings';
import { useBracketPolicy } from '../lib/conditional/bracket-policy';
import { flattenSummary, pauseAll, pauseAllEligible, runFlatten } from '../lib/conditional/runtime';
import { dismissFlattenLeftover } from '../lib/conditional/flatten-leftovers';
import { currentProtectionEnv } from '../lib/protection-env';
import { pauseAllButton } from '../lib/conditional/pause-all';
import { useBackgroundPrograms, useBackgroundSetting } from '../lib/execution/background';
import { bracketViews } from '../lib/execution/bracket-contract';
import { fmtClock, fmtNum } from '../lib/conditional/session';
import type { ContractInfo } from '../lib/types/contract';
import { PendingConfirmItemCard } from './pending-confirm';
import { BracketRearm } from './background-bracket-status';
import { ConditionalSettingsDialog, FlattenDialog } from './conditional-dialogs';
import { FORM_DEFAULTS, NewConditionalDialog, SendControl, sendOf, ValidityControl, validityOf, type SendState, type ValidityState } from './conditional-form';
import { useLastPrice } from './conditional-ui';
import * as styles from './conditional-panel.css';

/** Window event: show (or open) the 條件單管理 panel. */
export const OPEN_CONDITIONAL_PANEL_EVENT = 'sj:open-conditional-panel';

/** Width below which the panel switches to cards (dock / narrow column). */
export const NARROW_PX = 640;
/** Clicks this soon after a button changed meaning are ignored. */
const CONFIRM_GUARD_MS = 400;
const CONFIRM_TIMEOUT_MS = 10_000;

// ---- small hooks ----

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
    const ref = useRef<T | null>(null);
    const [width, setWidth] = useState(1200);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setWidth(el.getBoundingClientRect().width || 1200);
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width;
            if (w) setWidth(w);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, width];
}

/** A two-step button state: armed for CONFIRM_TIMEOUT_MS; a click right
 * after arming is ignored, so a double-click never passes both steps. */
function useConfirmStep<T extends string>() {
    const [step, setStepState] = useState<T | null>(null);
    const armedAt = useRef(0);
    useEffect(() => {
        if (!step) return;
        const timer = setTimeout(() => setStepState(null), CONFIRM_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [step]);
    return {
        step,
        arm: (s: T | null) => { armedAt.current = Date.now(); setStepState(s); },
        settled: () => Date.now() - armedAt.current >= CONFIRM_GUARD_MS,
    };
}

function useRun() {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: 'err' | 'muted'; text: string } | null>(null);
    const run = async (fn: () => Promise<unknown>, done?: string) => {
        setBusy(true);
        setMessage(null);
        try {
            await fn();
            if (done) setMessage({ tone: 'muted', text: done });
            return true;
        } catch (e) {
            setMessage({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
            return false;
        } finally {
            setBusy(false);
        }
    };
    // 錯誤訊息保留產生當下的字串（例如全平摘要的持倉量）：渲染時依目前開關重遮（#268）
    const reveal = useRevealText();
    const shown = message && { ...message, text: reveal(message.text) };
    return { busy, message: shown, setMessage, run };
}

// ---- cells ----

function ProductCell({ row }: { row: CondRow }) {
    const contract = useContract(row.code);
    useEffect(() => { void ensureContract(row.code).catch(() => undefined); }, [row.code]);
    const name = contractLabel(row.code, contract);
    const code = row.orderCode && /\d/.test(row.orderCode) ? row.orderCode : row.code;
    return (
        <span className={styles.nameText} title={name !== row.code ? `${code} ${name}` : code}>
            <span className={styles.code}>{code}</span>
            {name !== row.code && <span className={styles.muted}> {name}</span>}
        </span>
    );
}

function PriceCell({ row }: { row: CondRow }) {
    const last = useLastPrice(row.code);
    if (last === undefined) return <span className={styles.muted}>—</span>;
    // distance the price still has to travel to the level (design: ≤ 47,900 at 48,212 → −312)
    const d = row.level ? row.level.price - last : null;
    const crossed = row.level && d !== null && (row.level.condition === 'below' ? d >= 0 : d <= 0);
    return (
        <span className={styles.mono}>
            {fmtNum(last)}
            {d !== null && (
                <span className={crossed ? styles.tone.err : styles.muted}>
                    {' '}{crossed ? '已穿價' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtNum(Math.abs(d))}`}
                </span>
            )}
        </span>
    );
}

function SideText({ side }: { side: CondRow['side'] }) {
    return <span className={side.dir === 'Buy' ? styles.up : side.dir === 'Sell' ? styles.down : undefined}>{side.text}</span>;
}

function AccountText({ row }: { row: CondRow }) {
    const priv = usePrivacyMode();
    return <span className={styles.muted}>{accountTag(row.account, id => maskAccountId(id, priv))}</span>;
}

/** Where a row keeps running — shown only while 「背景持續執行（實驗）」 is
 * on (panel-created orders stay on the window engine on purpose). */
export const RUNNER_TEXT = { background: '關閉視窗後仍執行', window: '只在視窗開著時執行' } as const;

function RunnerTag({ row }: { row: CondRow }) {
    const on = useBackgroundSetting() === true;
    const runner = on ? rowRunner(row) : null;
    if (!runner) return null;
    const Icon = runner === 'background' ? Server : AppWindow;
    return (
        <span className={styles.runner[runner]} title={RUNNER_TEXT[runner]} aria-label={RUNNER_TEXT[runner]} role='img'>
            <Icon size={11} aria-hidden />
        </span>
    );
}

// ---- actions ----

type Step = 'cancel' | 'send' | 'handled' | 'retry';

/** 「我已自行處理」: the engine stops tracking it; nothing is sent or cancelled. */
export const HANDLED_TEXT = '刪除這張條件單，不送任何委託、不動持倉';

function RowActions({ row, expanded, onToggle, compact }: {
    row: CondRow;
    expanded: boolean;
    onToggle: () => void;
    compact?: boolean;
}) {
    const { busy, message, run } = useRun();
    const confirm = useConfirmStep<Step>();
    const src = row.source;
    // the App takes background bracket decisions from the main window only
    const elsewhere = src.type === 'bgBracket' && !isMainWindow();
    const a = elsewhere ? { ...row.actions, pause: false, resume: false, send: false, keep: false, rearm: false, handled: false } : row.actions;
    const triggers: TriggerOrder[] = src.type === 'trigger' ? [src.trigger] : src.type === 'oco' ? src.triggers : [];

    const pause = (on: boolean) => void run(async () => {
        if (src.type === 'bgBracket') {
            await (on ? pauseBackgroundProgram(src.view.programId) : resumeBackgroundProgram(src.view.programId));
            return;
        }
        if (src.type === 'oco') { await setTriggerGroup(triggers.map(t => t.id), on ? 'pause' : 'resume'); return; }
        for (const t of triggers) await setTriggerPaused(t.id, on);
    });
    const handled = () => {
        if (src.type !== 'bgBracket') return;
        if (confirm.step !== 'cancel') { confirm.arm('cancel'); return; }
        if (!confirm.settled()) return;
        confirm.arm(null);
        void run(() => markBackgroundHandled(src.view.programId, src.view.levelId));
    };
    const cancel = () => {
        if (confirm.step !== 'cancel') { confirm.arm('cancel'); return; }
        if (!confirm.settled()) return;
        confirm.arm(null);
        void run(async () => {
            if (src.type === 'bracket') await dismissBracket(src.plan.id);
            else if (src.type === 'bgBracket') await removeBackgroundBracket(src.view.programId);
            else if (src.type === 'trigger' && src.trigger.pending) await resolvePendingTrigger(src.trigger.id, 'cancel');
            else if (src.type === 'oco') await setTriggerGroup(triggers.map(t => t.id), 'remove');
            else for (const t of triggers) await removeTrigger(t.id);
        });
    };
    const pendingId = src.type === 'trigger' && src.trigger.pending ? src.trigger.id
        : src.type === 'bracket' ? src.legs.find(l => l.pending)?.id
            : src.type === 'oco' ? src.triggers.find(l => l.pending)?.id : undefined;
    const bg = src.type === 'bgBracket' ? src.view : null;
    const send = (allowUnpast = false) => {
        if (bg) {
            if (confirm.step !== 'send') { confirm.arm('send'); return; }
            if (!confirm.settled()) return;
            confirm.arm(null);
            void run(() => resolveBackgroundTrigger(bg.programId, bg.levelId, 'send'));
            return;
        }
        if (!pendingId) return;
        if (confirm.step !== 'send' && !allowUnpast) {
            confirm.arm('send');
            void requestPendingPrices().catch(() => undefined);
            return;
        }
        if (!allowUnpast && !confirm.settled()) return;
        confirm.arm(null);
        void run(() => resolvePendingTrigger(pendingId, 'send', { allowUnpast }));
    };
    const retry = () => {
        if (src.type !== 'leftover') return;
        if (confirm.step !== 'retry') { confirm.arm('retry'); return; }
        if (!confirm.settled()) return;
        confirm.arm(null);
        const o = src.leftover.order;
        void run(async () => {
            if (currentProtectionEnv() !== src.leftover.env) throw new Error('伺服器或模擬／正式模式與全平時不同，未送出');
            const r = await runFlatten({ type: 'code', codes: [o.code], account: o.account });
            if (r.remaining.length || r.notSent.length || r.cancelFailed.length) throw new Error(flattenSummary(r));
        }, '已再次平倉');
    };
    // 操作欄：固定格位（主要文字鈕｜其他動作｜編輯｜暫停／繼續｜刪除），沒有的動作留空
    type Act = { key: string; label: string; title: string; run: () => void; tone?: 'primary' | 'danger' | 'plain'; expands?: boolean };
    const acts: Act[] = [];
    if (message?.text.includes('未穿價') && pendingId) acts.push({ key: 'force', label: '仍要送出', title: '目前已未穿價；仍要依原設定送出一次', run: () => send(true), tone: 'danger' });
    if (a.send) acts.push({ key: 'send', label: confirm.step === 'send' ? '確認送出' : '現在送出', title: '重新檢查行情、環境與帳戶後，依原設定送出一次', run: () => send(), tone: confirm.step === 'send' ? 'danger' : 'primary' });
    if (a.confirm) acts.push({ key: 'confirm', label: '確認成交', title: '展開確認這筆委託的結果', run: onToggle, tone: 'primary', expands: true });
    if (a.rearm) acts.push({ key: 'rearm', label: '重新啟用', title: '重新查詢持倉、確認口數後，在這個盤別重新開始盯停損停利；不會立即送單', run: onToggle, tone: 'primary', expands: true });
    if (a.retry) acts.push({ key: 'retry', label: confirm.step === 'retry' ? '確認再平倉' : '再平倉', title: '重新查詢委託與持倉，刪除此商品未成交委託後再平倉剩餘部位', run: retry, tone: confirm.step === 'retry' ? 'danger' : 'primary' });
    if (a.keep && (pendingId || bg)) acts.push({ key: 'keep', label: '保留盯價', title: '先不送單；價格回到觸發價另一側、再次穿過時才會觸發',
        run: () => void run(() => bg ? resolveBackgroundTrigger(bg.programId, bg.levelId, 'keep') : resolvePendingTrigger(pendingId!, 'keep')) });
    if (a.acknowledge) acts.push({ key: 'ack', label: '我已核對', title: '已在委託與持倉確認結果；不會送出任何委託',
        run: () => void run(async () => src.type === 'bracket' ? acknowledgeBracketExit(src.plan.id)
            : src.type === 'exit' ? acknowledgeExit(src.exit.id) : src.type === 'leftover' ? dismissFlattenLeftover(src.leftover.id) : undefined) });
    if (a.reconcile && row.attention && src.type === 'bracket') acts.push({ key: 'reconcile', label: '對帳', title: '向券商更新此帳戶委託（會使用查詢額度）',
        run: () => void run(() => reconcileBracket(src.plan.id), '對帳完成') });
    const [primary, ...more] = acts;
    // 刪除：取消條件單與「我已自行處理」是同一件事（不送委託、不動持倉），同一顆鈕、同一個二次確認
    const del = a.handled ? handled : a.cancel ? cancel : null;
    const deleting = confirm.step === 'cancel';
    return (
        <div className={compact ? styles.cardActions : styles.actionsWrap} onClick={e => e.stopPropagation()}>
            {(() => {
                const slots: [string, ReactNode][] = [
                    ['primary', elsewhere && (row.actions.send || row.actions.rearm || row.actions.handled) && !primary
                        ? <span className={styles.muted} title='這張由背景執行，請在主視窗處理'>主視窗處理</span>
                        : primary ? (
                            <button type='button' className={styles.opButton[primary.tone ?? 'plain']} disabled={busy} title={primary.title}
                                aria-expanded={primary.expands ? expanded : undefined} onClick={primary.run}>
                                {primary.label}
                            </button>
                        ) : null],
                    ['more', more.length > 0 ? <MoreMenu items={more} busy={busy} /> : null],
                    ['edit', a.modify ? (
                        <button type='button' className={expanded ? styles.iconButton.active : styles.iconButton.plain}
                            title='修改' aria-label='修改' aria-expanded={expanded} onClick={onToggle}>
                            <Pencil size={13} aria-hidden />
                        </button>
                    ) : null],
                    ['pause', a.pause ? (
                        <button type='button' className={styles.iconButton.plain} disabled={busy} title='暫停（不再盯價，之後可恢復）'
                            aria-label='暫停' onClick={() => pause(true)}>
                            <Pause size={13} aria-hidden />
                        </button>
                    ) : a.resume ? (
                        <button type='button' className={styles.iconButton.plain} disabled={busy}
                            title='恢復盯價；若暫停期間已穿價，會先等你確認，不會直接送出' aria-label='恢復' onClick={() => pause(false)}>
                            <Play size={13} aria-hidden />
                        </button>
                    ) : null],
                    ['delete', del ? (
                        <button type='button' className={deleting ? styles.iconButton.dangerSolid : styles.iconButton.danger} disabled={busy}
                            title={deleting ? `再按一次確認：${HANDLED_TEXT}` : HANDLED_TEXT}
                            aria-label={deleting ? `再按一次確認：${HANDLED_TEXT}` : HANDLED_TEXT}
                            data-testid='cond-delete' onClick={del}>
                            <Trash2 size={13} aria-hidden />
                        </button>
                    ) : null],
                ];
                // wide table: fixed slots (empty ones keep their place, rows line up);
                // narrow card: the same order, packed to the right
                if (compact) {
                    return <div className={styles.opsRow}>{slots.filter(([, el]) => el).map(([k, el]) => <span key={k} className={styles.opsItem}>{el}</span>)}</div>;
                }
                return (
                    <div className={styles.opsGrid}>
                        {slots.map(([k, el]) => <span key={k} className={k === 'primary' ? styles.opsPrimary : styles.opsSlot}>{el}</span>)}
                    </div>
                );
            })()}
            {deleting && <span className={styles.opsNote.danger}>再按一次刪除</span>}
            {message && !deleting && <span className={styles.opsNote[message.tone]} role='status' title={message.text}>{message.text}</span>}
        </div>
    );
}

/** Secondary actions in the primary slot (keeps every row's slots aligned). */
function MoreMenu({ items, busy }: { items: { key: string; label: string; title: string; run: () => void }[]; busy: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <span className={styles.moreAnchor}>
            <button type='button' className={styles.iconButton.plain} disabled={busy} title='其他動作' aria-label='其他動作'
                aria-haspopup='menu' aria-expanded={open} onClick={() => setOpen(!open)}>
                <ChevronDown size={13} aria-hidden />
            </button>
            {open && (
                <>
                    <span className={styles.moreBackdrop} onClick={() => setOpen(false)} />
                    <span className={styles.moreMenu} role='menu'>
                        {items.map(it => (
                            <button key={it.key} type='button' role='menuitem' className={styles.moreItem} title={it.title}
                                onClick={() => { setOpen(false); it.run(); }}>
                                {it.label}
                            </button>
                        ))}
                    </span>
                </>
            )}
        </span>
    );
}

// ---- expanded: edit + history ----

function HistoryList({ entries }: { entries: HistoryEntry[] }) {
    // 歷程文字（含出場明細 detail）保留產生當下的字串：渲染時依目前開關重遮（#268）
    const reveal = useRevealText();
    if (!entries.length) return <div className={styles.muted}>尚無紀錄</div>;
    return (
        <div className={styles.history}>
            {entries.map((e, i) => (
                <div key={`${e.at}:${i}`} className={styles.historyItem}>
                    <span className={styles.dot[e.tone ?? 'plain']} />
                    <span className={`${styles.mono} ${styles.muted}`}>{fmtClock(e.at)}</span>
                    <span>{reveal(e.text)}</span>
                </div>
            ))}
        </div>
    );
}

function parsePrice(v: string): number | null {
    const n = Number(v.replace(/,/g, '').trim());
    return v.trim() === '' || !Number.isFinite(n) ? null : n;
}

/** Blank = not set (null); anything else must be a positive number. */
function optionalPrice(v: string, label: string): number | null {
    if (v.trim() === '') return null;
    const n = parsePrice(v);
    if (n === null || n <= 0) throw new Error(`${label}必須是正數（不設請留空）`);
    return n;
}

function Distance({ code, price }: { code: string; price: number | null }) {
    const last = useLastPrice(code);
    if (last === undefined) return <span className={styles.muted}>現價未知</span>;
    if (price === null || price <= 0) return <span className={styles.muted}>現價 {fmtNum(last)}</span>;
    const d = price - last;
    const pct = (d / last) * 100;
    return (
        <span className={styles.muted}>
            現價 {fmtNum(last)} · 距離 {d > 0 ? '+' : d < 0 ? '−' : ''}{fmtNum(Math.abs(d))}（{pct > 0 ? '+' : pct < 0 ? '−' : ''}{Math.abs(pct).toFixed(2)}%）
        </span>
    );
}

function TriggerEdit({ trigger, onDone }: { trigger: TriggerOrder; onDone: () => void }) {
    const [price, setPrice] = useState(String(trigger.price));
    const [qty, setQty] = useState(String(trigger.quantity));
    const t0 = trigger.send ?? { type: 'MKT' as const };
    const [send, setSend] = useState<SendState>({ type: t0.type, ticks: t0.type === 'LMT' ? String(t0.ticks) : '0' });
    const [validity, setValidity] = useState<ValidityState>({ type: trigger.validity?.type ?? 'none',
        date: trigger.validity?.type === 'date' ? new Date(trigger.validity.until + 8 * 3600_000).toISOString().slice(0, 10) : '' });
    const { busy, message, run } = useRun();
    const p = parsePrice(price);
    const q = Number(qty);
    const alert = trigger.kind === 'alert';
    const full = !alert && !('background' in trigger) && trigger.orderLot !== 'IntradayOdd';
    const market = trigger.account?.account_type === 'S' ? 'stock' as const : 'futures' as const;
    const save = () => void run(async () => {
        if (p === null || p <= 0) throw new Error('觸發價必須是正數');
        if (!alert && (!Number.isSafeInteger(q) || q <= 0)) throw new Error('數量必須是正整數');
        if (!full) {
            await modifyTrigger(trigger.id, alert ? { price: p } : { price: p, quantity: q });
            onDone();
            return;
        }
        const s = sendOf(send);
        if (typeof s === 'string') throw new Error(s);
        const keepValidity = validity.type === (trigger.validity?.type ?? 'none') && validity.type !== 'date';
        const v = keepValidity ? (trigger.validity ?? null) : validityOf(validity, market);
        if (typeof v === 'string') throw new Error(v);
        await modifyTrigger(trigger.id, { price: p, quantity: q, send: s, validity: v });
        onDone();
    });
    const unit = trigger.account?.account_type === 'S' ? (trigger.orderLot === 'IntradayOdd' ? '股' : '張') : '口';
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>觸發價</span>
                <input className={styles.input} value={price} inputMode='decimal' aria-label='觸發價'
                    onChange={e => setPrice(e.target.value)} />
                <Distance code={trigger.code} price={p} />
            </div>
            {!alert && (
                <div className={styles.formRow}>
                    <span className={styles.label}>數量</span>
                    <input className={styles.inputNarrow} value={qty} inputMode='numeric' aria-label='數量'
                        onChange={e => setQty(e.target.value)} />
                    <span>{unit}</span>
                </div>
            )}
            {full && <SendControl value={send} onChange={setSend} futures={market === 'futures'} label='送出方式' />}
            {full && <ValidityControl value={validity} onChange={setValidity} market={market} allowNone={!trigger.validity} />}
            <div className={styles.formRow}>
                <button type='button' className={styles.button.primary} disabled={busy} onClick={save}>儲存修改</button>
                <button type='button' className={styles.button.plain} disabled={busy} onClick={onDone}>取消</button>
                <span className={styles.muted}>只改條件，不會立刻送單；新價格若已穿過，會先等你確認</span>
            </div>
            {message && <div className={styles.message[message.tone]}>{message.text}</div>}
        </>
    );
}

function OcoEdit({ legs, onDone }: { legs: TriggerOrder[]; onDone: () => void }) {
    const [prices, setPrices] = useState(() => legs.map(l => String(l.price)));
    const { busy, message, run } = useRun();
    const save = () => void run(async () => {
        const parsed = prices.map(parsePrice);
        if (parsed.some(v => v === null || v <= 0)) throw new Error('觸發價必須是正數');
        const patches = legs.map((l, i) => ({ id: l.id, patch: { price: parsed[i]! } })).filter((p, i) => p.patch.price !== legs[i]!.price);
        if (patches.length) await modifyTriggerGroup(patches);
        onDone();
    });
    return (
        <>
            {legs.map((l, i) => (
                <div key={l.id} className={styles.formRow}>
                    <span className={styles.label}>{l.condition === 'above' ? '上方' : '下方'}</span>
                    <span>{l.condition === 'above' ? '≥' : '≤'}</span>
                    <input className={styles.input} value={prices[i]} inputMode='decimal' aria-label={`${l.condition === 'above' ? '上方' : '下方'}觸發價`}
                        onChange={e => setPrices(ps => ps.map((v, j) => j === i ? e.target.value : v))} />
                    <span className={l.action === 'Buy' ? styles.up : styles.down}>{l.action === 'Buy' ? '買進' : '賣出'} {l.quantity}</span>
                </div>
            ))}
            <div className={styles.formRow}>
                <button type='button' className={styles.button.primary} disabled={busy} onClick={save}>儲存修改</button>
                <button type='button' className={styles.button.plain} disabled={busy} onClick={onDone}>取消</button>
                <span className={styles.muted}>只改條件，不會立刻送單</span>
            </div>
            {message && <div className={styles.message[message.tone]}>{message.text}</div>}
        </>
    );
}

function BracketEdit({ row, onDone }: { row: CondRow; onDone: () => void }) {
    const plan = row.source.type === 'bracket' ? row.source.plan : null;
    // the armed stop may have moved (移動停損／保本): edit from where it is now
    const curStop = row.source.type === 'bracket' ? (row.source.legs.find(l => l.kind === 'stop')?.price ?? plan?.stopPrice ?? null) : null;
    const [stop, setStop] = useState(curStop === null ? '' : String(curStop));
    const [take, setTake] = useState(plan?.takePrice === null || !plan ? '' : String(plan.takePrice));
    const { busy, message, run } = useRun();
    if (!plan) return null;
    const s = parsePrice(stop);
    const t = parsePrice(take);
    const long = plan.action === 'Buy';
    const loosened = curStop !== null && s !== null && (long ? s < curStop : s > curStop);
    return (
        <>
            <div className={styles.formRow}>
                <span className={styles.label}>停損</span>
                <input className={styles.input} value={stop} inputMode='decimal' aria-label='停損價' placeholder='不設'
                    onChange={e => setStop(e.target.value)} />
                <Distance code={plan.quoteCode} price={s} />
            </div>
            <div className={styles.formRow}>
                <span className={styles.label}>停利</span>
                <input className={styles.input} value={take} inputMode='decimal' aria-label='停利價' placeholder='不設'
                    onChange={e => setTake(e.target.value)} />
                <Distance code={plan.quoteCode} price={t} />
            </div>
            {loosened && <div className={styles.message.warn}>停損放寬，風險會變大；確定再儲存</div>}
            <div className={styles.formRow}>
                <button type='button' className={styles.button.primary} disabled={busy}
                    onClick={() => void run(async () => {
                        await modifyBracket(plan.id, optionalPrice(stop, '停損價'), optionalPrice(take, '停利價'));
                        onDone();
                    })}>
                    儲存修改
                </button>
                <button type='button' className={styles.button.plain} disabled={busy} onClick={onDone}>取消</button>
                <span className={styles.muted}>只改停損停利，不會立刻送單</span>
            </div>
            {row.actions.reconcile && (
                <div className={styles.formRow}>
                    <button type='button' className={styles.button.plain} disabled={busy}
                        title='向券商更新此帳戶委託（會使用查詢額度）'
                        onClick={() => void run(() => reconcileBracket(plan.id), '對帳完成')}>
                        對帳
                    </button>
                    <span className={styles.muted}>確認進場成交與保護數量</span>
                </div>
            )}
            {message && <div className={styles.message[message.tone]}>{message.text}</div>}
        </>
    );
}

function editTitle(row: CondRow): string {
    if (row.source.type === 'trigger') return `修改：${row.code} ${row.condition.split(' ').slice(-1)[0]}觸價單`;
    if (row.source.type === 'oco') return `修改：${row.code} 二擇一`;
    if (row.source.type === 'bracket') return `修改：${row.code} 括號單`;
    if (row.source.type === 'pendingConfirm') return '確認委託結果';
    if (row.source.type === 'bgBracket' && row.actions.rearm) return `在新盤別重新啟用：${row.code} 括號單`;
    return '詳細';
}

function Expanded({ row, onClose }: { row: CondRow; onClose: () => void }) {
    const reveal = useRevealText();
    const src = row.source;
    let left: ReactNode = null;
    if (src.type === 'trigger' && row.actions.modify) left = <TriggerEdit trigger={src.trigger} onDone={onClose} />;
    else if (src.type === 'oco' && row.actions.modify) left = <OcoEdit legs={src.triggers} onDone={onClose} />;
    else if (src.type === 'bracket' && row.actions.modify) left = <BracketEdit row={row} onDone={onClose} />;
    else if (src.type === 'pendingConfirm') left = <PendingConfirmItemCard id={src.item.id} />;
    else if (src.type === 'bgBracket' && row.actions.rearm) left = <BracketRearm v={src.view} onClose={onClose} />;
    else left = null;
    return (
        <div className={styles.expandGrid} onClick={e => e.stopPropagation()}>
            <div className={styles.pane}>
                <div className={styles.paneTitle}>
                    {src.type === 'pendingConfirm' ? <TriangleAlert size={13} aria-hidden /> : <Pencil size={13} aria-hidden />}
                    {editTitle(row)}
                    <span className={styles.muted} style={{ fontWeight: 400 }}>{row.side.text} · <AccountText row={row} /></span>
                </div>
                <div className={`${styles.statusFull} ${styles.tone[row.status.tone]}`} data-testid='cond-status-full'>{reveal(row.status.text)}</div>
                {left}
            </div>
            <div className={styles.paneSplit}>
                <div className={styles.paneTitle}><History size={13} aria-hidden />歷程</div>
                <HistoryList entries={row.history} />
            </div>
        </div>
    );
}

// ---- wide table ----

/** Short status label; the whole sentence on hover and in the expanded row. */
function StatusLabel({ row }: { row: CondRow }) {
    const text = useRevealText()(row.status.text);
    return <span className={styles.tone[row.status.tone]} title={text} data-testid='cond-status'>{shortStatus(text)}</span>;
}

function TableRow({ row, expanded, onToggle }: { row: CondRow; expanded: boolean; onToggle: () => void }) {
    const cls = [row.attention ? styles.rowAlert : '', expanded ? styles.rowSelected : '', styles.rowClickable].filter(Boolean).join(' ');
    return (
        <>
            {/* the row opens its details (full status, edit, history) */}
            <tr className={cls} onClick={onToggle} aria-expanded={expanded}>
                <td className={styles.nameCell}><ProductCell row={row} /></td>
                <td>{KIND_LABEL[row.kind]}<RunnerTag row={row} /></td>
                <td><SideText side={row.side} /></td>
                <td className={styles.numCell} title={row.condition}>{row.condition}</td>
                <td className={`${styles.colPrice} ${styles.numCell}`}><PriceCell row={row} /></td>
                <td className={styles.statusCell}><StatusLabel row={row} /></td>
                <td className={`${styles.muted} ${styles.colValidity}`}>{row.validity}</td>
                <td className={styles.colAccount}><AccountText row={row} /></td>
                <td className={styles.opsCell}><RowActions row={row} expanded={expanded} onToggle={onToggle} /></td>
            </tr>
            {expanded && (
                <tr className={styles.expand}>
                    <td colSpan={9}><Expanded row={row} onClose={onToggle} /></td>
                </tr>
            )}
        </>
    );
}

function Table({ rows, ended, expanded, onToggle }: {
    rows: CondRow[];
    ended: boolean;
    expanded: string | null;
    onToggle: (id: string) => void;
}) {
    const attention = rows.filter(r => r.attention);
    const running = rows.filter(r => !r.attention);
    return (
        <table className={styles.table}>
            {/* one table, one set of widths: 需要你處理 and 執行中 line up */}
            <colgroup>
                <col className={styles.cName} /><col className={styles.cKind} /><col className={styles.cSide} /><col />
                <col className={`${styles.cPrice} ${styles.colPrice}`} /><col className={styles.cStatus} />
                <col className={`${styles.cValidity} ${styles.colValidity}`} /><col className={`${styles.cAccount} ${styles.colAccount}`} />
                <col className={styles.cOps} />
            </colgroup>
            <thead>
                <tr>
                    <th>商品</th><th>類型</th><th>方向／數量</th><th className={styles.thRight}>條件</th><th className={`${styles.colPrice} ${styles.thRight}`}>現價／距離</th>
                    <th>狀態</th><th className={styles.colValidity}>{ended ? '結束時間' : '有效期'}</th>
                    <th className={styles.colAccount}>帳戶</th><th className={`${styles.thRight} ${styles.opsCell}`}>操作</th>
                </tr>
            </thead>
            <tbody>
                {attention.length > 0 && <tr className={styles.section}><td colSpan={9}>需要你處理</td></tr>}
                {attention.map(r => <TableRow key={r.id} row={r} expanded={expanded === r.id} onToggle={() => onToggle(r.id)} />)}
                {!ended && attention.length > 0 && running.length > 0 && <tr className={styles.section}><td colSpan={9}>執行中</td></tr>}
                {running.map(r => <TableRow key={r.id} row={r} expanded={expanded === r.id} onToggle={() => onToggle(r.id)} />)}
            </tbody>
        </table>
    );
}

// ---- narrow cards ----

function Card({ row, expanded, onToggle }: { row: CondRow; expanded: boolean; onToggle: () => void }) {
    const last = useLastPrice(row.code);
    const distance = row.level && last !== undefined ? row.level.price - last : null;
    const facts = [
        row.condition,
        distance !== null ? `距離 ${distance > 0 ? '+' : distance < 0 ? '−' : ''}${fmtNum(Math.abs(distance))}` : null,
        row.validity !== '—' ? row.validity : null,
    ].filter(Boolean).join(' · ');
    return (
        <div className={`${row.attention ? styles.card.alert : expanded ? styles.card.selected : styles.card.plain} ${styles.rowClickable}`}
            onClick={onToggle} aria-expanded={expanded}>
            <div className={styles.cardHead}>
                <span className={styles.cardTitle}>
                    <ProductCell row={row} />
                    <span>{KIND_LABEL[row.kind]}<RunnerTag row={row} /></span>
                    <SideText side={row.side} />
                </span>
                <StatusLabel row={row} />
            </div>
            <div className={`${styles.numText} ${styles.muted} ${styles.cardText}`}>{facts}</div>
            <div className={styles.cardFoot}>
                <span className={styles.muted}><AccountText row={row} /></span>
                <RowActions row={row} expanded={expanded} onToggle={onToggle} compact />
            </div>
            {expanded && <Expanded row={row} onClose={onToggle} />}
        </div>
    );
}

// ---- header ----

function runStatus(v: ConditionalView): { text: string; tone: 'ok' | 'warn' | 'err'; icon: ReactNode } {
    if (v.stream !== 'live') return { text: '連線中斷 · 暫停盯價', tone: 'err', icon: <CircleAlert size={12} aria-hidden /> };
    if (!v.envNow) return { text: '伺服器模式確認中', tone: 'warn', icon: <CircleAlert size={12} aria-hidden /> };
    if (!v.executing) return { text: '主視窗未執行', tone: 'warn', icon: <CircleAlert size={12} aria-hidden /> };
    return { text: '執行中 · 已連線', tone: 'ok', icon: <CircleCheck size={12} aria-hidden /> };
}

function EmptyState({ onNew }: { onNew: () => void }) {
    return (
        <div className={styles.empty}>
            <ListChecks size={18} aria-hidden />
            <div className={styles.emptyTitle}>目前沒有條件單</div>
            觸價單、二擇一與括號單都會集中在這裡，可以修改、暫停或取消。
            <div style={{ marginTop: 12 }}>
                <button type='button' className={styles.button.primary} onClick={onNew}><Plus size={13} aria-hidden />新增條件單</button>
            </div>
        </div>
    );
}

const TAB_EMPTY: Partial<Record<CondTab, string>> = {
    grid: '蛛網交易完成後會出現在這裡',
    time: '目前沒有時間條件單',
    ended: '今天還沒有結束的條件單',
};

export function ConditionalPanel({ contract }: { contract?: ContractInfo | null }) {
    const view = useConditionalView();
    const [ref, width] = useWidth<HTMLDivElement>();
    const narrow = width < NARROW_PX;
    const [tab, setTab] = useState<CondTab>('all');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [dialog, setDialog] = useState<'settings' | 'flatten' | null>(null);
    const settings = useConditionalSettings();
    useBracketPolicy(); // keeps 全部暫停 in line with the engine's pauseStopsExits
    // the same rule as 全部暫停 itself
    const legsOf = (r: CondRow): TriggerOrder[] => r.source.type === 'trigger' ? [r.source.trigger] : r.source.type === 'oco' ? r.source.triggers : [];
    const eligible = view.rows.filter(r => r.source.type === 'bgBracket' ? r.actions.pause
        : legsOf(r).some(t => !t.paused && !t.pending && pauseAllEligible(t, settings.pauseStopsExits)));
    const anyPaused = view.rows.some(r => r.paused || legsOf(r).some(t => t.paused) || (r.source.type === 'bgBracket' && r.actions.resume));
    const anyRunning = eligible.length > 0;
    const pauseButton = pauseAllButton(anyRunning, anyPaused);
    const pa = useRun();
    const rows = useMemo(() => rowsForTab(view, tab), [view, tab]);
    const toggle = (id: string) => setExpanded(e => e === id ? null : id);
    const status = runStatus(view);
    const nothing = view.rows.length === 0 && view.ended.length === 0;
    const header = narrow ? (
        <div className={styles.header}>
            <span className={styles.title}><Crosshair size={14} aria-hidden />條件單</span>
            {view.counts.attention > 0 && <span className={styles.pill.err}>待確認 {view.counts.attention}</span>}
            <span className={styles.grow} />
            <button type='button' className={styles.iconButton.plain} title='新增條件單' aria-label='新增條件單' onClick={() => setCreating(true)}>
                <Plus size={13} aria-hidden />
            </button>
            <button type='button' className={styles.iconButton.plain} title='設定' aria-label='設定' onClick={() => setDialog('settings')}>
                <Settings2 size={13} aria-hidden />
            </button>
        </div>
    ) : (
        <div className={styles.header}>
            <span className={styles.title}><Crosshair size={14} aria-hidden />條件單管理</span>
            <span className={styles.pill[status.tone]}>{status.icon}{status.text}</span>
            {!nothing && <span className={styles.pill.plain}>進行中 {view.counts.active}</span>}
            {view.counts.attention > 0 && (
                <span className={styles.pill.err}><TriangleAlert size={12} aria-hidden />待確認 {view.counts.attention}</span>
            )}
            {!nothing && <span className={styles.pill.muted}>今日已觸發 {view.counts.firedToday}</span>}
            <span className={styles.grow} />
            <button type='button' className={styles.button.primary} onClick={() => setCreating(true)}>
                <Plus size={13} aria-hidden />新增條件單
            </button>
            {!nothing && (
                <>
                    <button type='button' className={styles.button.plain} onClick={() => setDialog('settings')}>
                        <Settings2 size={13} aria-hidden />設定
                    </button>
                    <button type='button' className={styles.button.plain} disabled={pa.busy || pauseButton.disabled}
                        title={settings.pauseStopsExits ? '暫停全部條件單（含停損停利；暫停前已觸發、正在送出的平倉單照常送出）'
                            : '暫停新進場的條件單；停損停利保護繼續執行（可在設定修改）'}
                        onClick={() => void pa.run(async () => {
                            const r = await pauseAll(pauseButton.mode === 'pause');
                            if (r.failed.length) throw new Error(r.failed.join('；'));
                        })}>
                        {pauseButton.mode === 'pause' ? <><Pause size={13} aria-hidden />全部暫停</> : <><Play size={13} aria-hidden />全部恢復</>}
                    </button>
                    <button type='button' className={styles.button.danger} onClick={() => setDialog('flatten')}>
                        <OctagonX size={13} aria-hidden />全平並取消
                    </button>
                </>
            )}
            {pa.message && <span className={styles.message[pa.message.tone]}>{pa.message.text}</span>}
        </div>
    );
    return (
        <div className={styles.container} ref={ref}>
            <div className={styles.root} aria-label='條件單管理'>
                {header}
                {nothing ? <EmptyState onNew={() => setCreating(true)} /> : (
                    <>
                        <div className={styles.tabs} role='tablist'>
                            {TABS.map(t => (
                                <button key={t.id} type='button' role='tab' aria-selected={tab === t.id}
                                    className={tab === t.id ? styles.tab.on : styles.tab.off}
                                    style={t.id === 'ended' && !narrow ? { marginLeft: 'auto' } : undefined}
                                    onClick={() => { setTab(t.id); setExpanded(null); }}>
                                    {t.label}<span className={styles.tabCount}>{view.counts.byTab[t.id]}</span>
                                </button>
                            ))}
                        </div>
                        <div className={styles.body}>
                            {rows.length === 0 ? (
                                <div className={styles.empty}><Info size={14} aria-hidden /> {TAB_EMPTY[tab] ?? '這個分頁目前沒有條件單'}</div>
                            ) : narrow ? (
                                <div className={styles.cards}>
                                    {rows.map(r => <Card key={r.id} row={r} expanded={expanded === r.id} onToggle={() => toggle(r.id)} />)}
                                </div>
                            ) : (
                                <Table rows={rows} ended={tab === 'ended'} expanded={expanded} onToggle={toggle} />
                            )}
                        </div>
                    </>
                )}
            </div>
            {creating && <NewConditionalDialog contract={contract ?? null} onClose={() => setCreating(false)} defaults={{ ...FORM_DEFAULTS,
                send: settings.defaultSend, validity: settings.defaultValidity, ocoMode: settings.ocoMode, quickQty: settings.quickQty }} />}
            {dialog === 'settings' && <ConditionalSettingsDialog onClose={() => setDialog(null)} />}
            {dialog === 'flatten' && <FlattenDialog contract={contract ?? null} rows={view.rows} onClose={() => setDialog(null)} />}
        </div>
    );
}

/** Background brackets of one product as panel cards (under the order
 * ticket's submit button); the same rows and actions as the 條件單管理面板.
 * Ended ones collapse into a count with a way to the panel, so they never
 * pile up in the ticket. */
export function ConditionalBracketCards({ code }: { code: string }) {
    const programs = useBackgroundPrograms();
    const stream = useStreamStatus();
    const [expanded, setExpanded] = useState<string | null>(null);
    const all = useMemo(() => bgBracketRows(bracketViews(programs), stream === 'live')
        .filter(r => r.code === code || r.orderCode === code), [programs, stream, code]);
    if (all.length === 0) return null;
    const rows = all.filter(r => !r.ended);
    const ended = all.length - rows.length;
    const main = isMainWindow();
    return (
        <div className={styles.cards} aria-label='括號單（條件單管理）'>
            {rows.map(r => <Card key={r.id} row={r} expanded={expanded === r.id} onToggle={() => setExpanded(e => e === r.id ? null : r.id)} />)}
            <div className={styles.cardsFoot}>
                {ended > 0 && <span>已結束 {ended} 張</span>}
                {main ? (
                    <button type='button' className={styles.linkButton}
                        onClick={() => window.dispatchEvent(new Event(OPEN_CONDITIONAL_PANEL_EVENT))}>
                        {ended > 0 ? '在條件單管理查看' : '完整清單在條件單管理'}<ChevronRight size={12} aria-hidden />
                    </button>
                ) : <span>完整清單請開「條件單管理」面板</span>}
            </div>
        </div>
    );
}
