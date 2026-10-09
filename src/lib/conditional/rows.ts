// src/lib/conditional/rows.ts — one list of conditional orders for the
// 條件單管理面板 (#226). Pure projection: price triggers (this window's
// engine and the background engine look the same), brackets, 委託待確認 and
// today's finished ones become rows with a kind, a plain-language condition,
// a status and the actions that apply. No I/O and no decision here — every
// action still goes through the engine that owns the order, with its own
// checks. The UI never shows which engine runs a row.

import {
    bracketPhase,
    isLive,
    protectionQuantity,
    unprotectedQuantity,
    workingEntryAfterExit,
    type AccountRef,
    type BracketPlan,
} from '../bracket-core';
import { BRACKET_STATE_TEXT, type BracketView } from '../execution/bracket-contract';
import type { PendingConfirmItem } from '../execution/pending-confirm-contract';
import { isOddLot } from '../odd-lot';

import type { EndedTrigger, ExitRecord, HistoryEntry, TriggerOrder } from '../trigger-engine';
import type { RestoreReason } from '../trigger-engine';
import { fmtNum, fmtUntil, sameTradingDay } from './session';

export type CondKind = 'trigger' | 'oco' | 'bracket' | 'time' | 'grid';
export type CondTab = 'all' | CondKind | 'ended';
export type Tone = 'ok' | 'warn' | 'err' | 'muted';

export const KIND_LABEL: Record<CondKind, string> = {
    trigger: '觸價單',
    oco: '二擇一',
    bracket: '括號單',
    time: '時間',
    grid: '蛛網',
};

export const TABS: { id: CondTab; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'trigger', label: '觸價單' },
    { id: 'oco', label: '二擇一' },
    { id: 'bracket', label: '括號單' },
    { id: 'time', label: '時間' },
    { id: 'grid', label: '蛛網' },
    { id: 'ended', label: '已結束（今日）' },
];

/** What a row can do; each one is offered only where its engine accepts it. */
export interface RowActions {
    modify: boolean;
    pause: boolean;
    resume: boolean;
    cancel: boolean;
    /** 待確認 trigger: 現在送出 / 保留盯價 */
    send: boolean;
    keep: boolean;
    /** bracket: authoritative reconcile (對帳) */
    reconcile: boolean;
    /** unknown exit outcome: the user checked it by hand */
    acknowledge: boolean;
    /** 委託待確認 card */
    confirm: boolean;
    /** background bracket: 「我已自行處理」 ends the tracking */
    handled: boolean;
    /** background bracket: 在新盤別重新啟用 */
    rearm: boolean;
}

const NO_ACTIONS: RowActions = {
    modify: false, pause: false, resume: false, cancel: false, send: false, keep: false,
    reconcile: false, acknowledge: false, confirm: false, handled: false, rearm: false,
};

export type RowSource =
    | { type: 'trigger'; trigger: TriggerOrder }
    | { type: 'oco'; triggers: TriggerOrder[] }
    | { type: 'bracket'; plan: BracketPlan; legs: TriggerOrder[] }
    | { type: 'bgBracket'; view: BracketView }
    | { type: 'exit'; exit: ExitRecord; trigger: TriggerOrder | null }
    | { type: 'pendingConfirm'; item: PendingConfirmItem }
    | { type: 'ended'; ended: EndedTrigger; exit: ExitRecord | null };

export interface CondRow {
    id: string;
    kind: CondKind;
    /** quote code (price / name lookups) */
    code: string;
    orderCode: string | null;
    side: { text: string; dir: 'Buy' | 'Sell' | null };
    condition: string;
    /** for 現價／距離: the level the price is compared with */
    level: { price: number; condition: 'below' | 'above' } | null;
    status: { text: string; tone: Tone };
    validity: string;
    account: AccountRef | null;
    env: string | null;
    /** 需要你處理 */
    attention: boolean;
    paused: boolean;
    actions: RowActions;
    source: RowSource;
    history: HistoryEntry[];
    createdAt: number;
    /** finished today (已結束) */
    ended: boolean;
}

export interface Sources {
    triggers: readonly TriggerOrder[];
    brackets: readonly BracketPlan[];
    exits: readonly ExitRecord[];
    ended: readonly EndedTrigger[];
    pendingConfirm: readonly PendingConfirmItem[];
    /** brackets run by the background engine (bracket-contract views) */
    bgBrackets?: readonly BracketView[];
    feedMissing: readonly string[];
    /** this window (or the window it mirrors) is the executor */
    executing: boolean;
    /** the protection environment now (null: unknown) */
    envNow: string | null;
    streamLive: boolean;
    now: number;
}

const unitOf = (account: AccountRef | undefined | null, orderLot?: string) =>
    account?.account_type === 'S' ? (isOddLot(orderLot as never) ? '股' : '張') : '口';

const sideText = (action: 'Buy' | 'Sell', qty: number, unit: string) => `${action === 'Buy' ? '買進' : '賣出'} ${qty} ${unit}`;

/** 停損 / 突破 / 拉回 / 停利: what a level means for the order it sends. */
export function levelWord(condition: 'below' | 'above', action: 'Buy' | 'Sell', kind?: TriggerOrder['kind']): string {
    if (kind === 'alert') return condition === 'below' ? '跌破通知' : '突破通知';
    if (kind === 'take') return '停利';
    if (condition === 'below') return action === 'Sell' ? '停損' : '拉回買進';
    return action === 'Buy' ? '突破' : '停利';
}

export function conditionText(t: Pick<TriggerOrder, 'condition' | 'price' | 'action' | 'kind'> & Partial<Pick<TriggerOrder, 'cross' | 'source'>>): string {
    const op = t.cross ? (t.condition === 'below' ? '下穿' : '上穿') : t.condition === 'below' ? '≤' : '≥';
    return `${t.source === 'opposite' ? '對手價 ' : ''}${op} ${fmtNum(t.price)} ${levelWord(t.condition, t.action, t.kind)}`;
}

const VALIDITY_WORD: Record<'session' | 'today' | 'date', string> = { session: '本盤', today: '今日', date: '至' };

function triggerSide(t: TriggerOrder): CondRow['side'] {
    if (t.kind === 'alert') return { text: '只通知', dir: null };
    return { text: sideText(t.action, t.quantity, unitOf(t.account, t.orderLot)), dir: t.action };
}

function triggerValidity(t: TriggerOrder, now: number): string {
    if (t.validity) return `${VALIDITY_WORD[t.validity.type]} ${fmtUntil(t.validity.until, now)}`;
    if ('background' in t) return '本盤';
    return '直到取消';
}

/** Short status words for a 待確認 trigger (the full reason is in its history). */
export const PENDING_SHORT: Record<RestoreReason, string> = {
    restart: '恢復時已穿價',
    disconnect: '斷線恢復時已穿價',
    env: '切回此環境時已穿價',
    rearm: '重新啟用時已穿價',
    resume: '恢復盯價時已穿價',
};

function triggerStatus(t: TriggerOrder, s: Sources): { text: string; tone: Tone } {
    if (t.pending) return { text: `${PENDING_SHORT[t.pending.reason ?? 'restart']}，未自動送出`, tone: 'err' };
    if (t.suspended) return { text: `已停用：${t.suspended}`, tone: 'err' };
    if (t.paused) return { text: '已暫停', tone: 'warn' };
    if (t.kind !== 'alert' && t.env !== s.envNow) {
        return { text: s.envNow ? '屬於其他伺服器或模式，目前不執行' : '伺服器模式未確認，暫停盯價', tone: 'warn' };
    }
    if (!s.streamLive) return { text: '連線中斷，暫停盯價', tone: 'warn' };
    if (!('background' in t) && !s.executing) return { text: '主視窗未執行，暫停盯價', tone: 'warn' };
    if (s.feedMissing.includes(t.code)) return { text: '行情未訂閱，自動重試中', tone: 'warn' };
    if (t.ocoLock) return { text: '另一邊已觸發，等成交後扣掉對應口數', tone: 'warn' };
    if (t.awaitingRecross) return { text: t.cross ? '盯價中（等待穿越）' : '等待價格回到另一側再穿過', tone: 'ok' };
    return { text: t.kind === 'alert' ? '盯價中（只通知）' : '盯價中', tone: 'ok' };
}

function triggerActions(t: TriggerOrder): RowActions {
    if (t.pending) return { ...NO_ACTIONS, send: true, keep: true, cancel: true };
    if (t.ocoLock) return { ...NO_ACTIONS, cancel: true };
    return {
        ...NO_ACTIONS,
        modify: !t.suspended,
        pause: !t.paused && !t.suspended,
        resume: !!t.paused,
        cancel: true,
    };
}

function timeCondition(t: TriggerOrder): string {
    const time = t.time!;
    return time.kind === 'flatten'
        ? `${fmtUntil(time.at)} 全平並取消（${time.scope === 'code' ? '此商品' : '此帳戶'}）`
        : `${fmtUntil(time.at)} 送出`;
}

function triggerRow(t: TriggerOrder, s: Sources): CondRow {
    if (t.time) {
        const st = triggerStatus(t, s);
        return {
            id: t.id,
            kind: 'time',
            code: t.code,
            orderCode: t.orderCode ?? null,
            side: t.time.kind === 'flatten' ? { text: '平掉剩餘部位', dir: null } : triggerSide(t),
            condition: timeCondition(t),
            level: null,
            status: st.tone === 'ok' ? { text: '等待時間到', tone: 'ok' } : st,
            validity: `今日 ${fmtUntil(t.time.at, s.now)}`,
            account: t.account ?? null,
            env: t.env ?? null,
            attention: false,
            paused: !!t.paused,
            actions: { ...NO_ACTIONS, pause: !t.paused, resume: !!t.paused, cancel: true },
            source: { type: 'trigger', trigger: t },
            history: t.history ?? [],
            createdAt: t.createdAt ?? 0,
            ended: false,
        };
    }
    return {
        id: t.id,
        kind: 'trigger',
        code: t.code,
        orderCode: t.orderCode ?? null,
        side: triggerSide(t),
        condition: conditionText(t),
        level: { price: t.price, condition: t.condition },
        status: triggerStatus(t, s),
        validity: triggerValidity(t, s.now),
        account: t.account ?? null,
        env: t.env ?? null,
        attention: !!t.pending,
        paused: !!t.paused,
        actions: triggerActions(t),
        source: { type: 'trigger', trigger: t },
        history: t.history ?? [{ at: t.createdAt ?? s.now, text: '建立' }],
        createdAt: t.createdAt ?? 0,
        ended: false,
    };
}

/** Manual OCO pair (two-sided): one row; actions apply to both legs. */
function ocoRow(legs: TriggerOrder[], s: Sources): CondRow {
    const first = legs[0]!;
    const pending = legs.find(l => l.pending);
    const statuses = legs.map(l => triggerStatus(l, s));
    const worst = statuses.find(x => x.tone === 'err') ?? statuses.find(x => x.tone === 'warn') ?? statuses[0]!;
    const paused = legs.every(l => l.paused);
    return {
        id: `oco:${first.env ?? ''}|${first.group}`,
        kind: 'oco',
        code: first.code,
        orderCode: first.orderCode ?? null,
        side: legs.length === 2 && legs[0]!.action !== legs[1]!.action
            ? { text: `雙向 ${first.quantity} ${unitOf(first.account, first.orderLot)}`, dir: null }
            : triggerSide(first),
        condition: legs.map(conditionText).join(' · '),
        level: null,
        status: pending ? triggerStatus(pending, s) : worst,
        validity: triggerValidity(first, s.now),
        account: first.account ?? null,
        env: first.env ?? null,
        attention: !!pending,
        paused,
        actions: pending ? { ...NO_ACTIONS, send: true, keep: true, cancel: true } : {
            ...NO_ACTIONS, modify: true, pause: !paused, resume: paused, cancel: true,
        },
        source: { type: 'oco', triggers: legs },
        history: legs.flatMap(l => l.history ?? []).sort((a, b) => a.at - b.at),
        createdAt: Math.min(...legs.map(l => l.createdAt ?? 0)),
        ended: false,
    };
}

const EXIT_TEXT: Record<string, string> = {
    sending: '出場送單中',
    working: '出場委託已送出',
    filled: '已出場',
    incomplete: '出場未完全成交',
    'not-sent': '出場未送出',
    unknown: '出場結果不明（不會自動重送）',
};

function bracketStatus(p: BracketPlan, legs: TriggerOrder[], s: Sources): { text: string; tone: Tone; attention: boolean } {
    const phase = bracketPhase(p);
    const filled = Math.min(p.filled, p.quantity);
    const unprotected = unprotectedQuantity(p);
    const unit = unitOf(p.account, p.orderLot);
    const pendingLeg = legs.find(l => l.pending);
    if (pendingLeg) return { ...triggerStatus(pendingLeg, s), attention: true };
    if (p.exit?.status === 'unknown' && !p.exit.acknowledged) return { text: EXIT_TEXT.unknown!, tone: 'err', attention: true };
    if (unprotected > 0) return { text: `未受保護 ${unprotected} ${unit}，請對帳後處理`, tone: 'err', attention: true };
    if (workingEntryAfterExit(p) > 0) return { text: `已出場，進場單仍有 ${workingEntryAfterExit(p)} ${unit}未成交`, tone: 'err', attention: true };
    if (p.exit && (p.exit.status === 'not-sent' || p.exit.status === 'incomplete')) {
        return { text: `${p.exit.kind === 'stop' ? '停損' : '停利'}${EXIT_TEXT[p.exit.status]}`, tone: 'err', attention: true };
    }
    if (isLive(p) && p.env !== s.envNow) return { text: s.envNow ? '屬於其他伺服器或模式，目前不執行' : '伺服器模式未確認，暫停保護', tone: 'warn', attention: false };
    if (isLive(p) && !s.streamLive) return { text: '連線中斷，暫停保護', tone: 'warn', attention: false };
    if (isLive(p) && !s.executing) return { text: '主視窗未執行，暫停保護', tone: 'warn', attention: false };
    if (phase === 'exiting') return { text: `${p.exit?.kind === 'stop' ? '停損' : '停利'}${EXIT_TEXT[p.exit?.status ?? 'sending']}`, tone: 'ok', attention: false };
    if (p.issues.length > 0 && isLive(p)) return { text: `保護未確認，請對帳 · 成交 ${filled}/${p.quantity}`, tone: 'warn', attention: false };
    if (phase === 'protected') return { text: `保護中 · 成交 ${filled}/${p.quantity}`, tone: 'ok', attention: false };
    if (phase === 'waiting') return { text: '等待進場成交', tone: 'ok', attention: false };
    if (phase === 'closed') return { text: '進場未成交，已結束', tone: 'muted', attention: false };
    return { text: p.exit ? `${p.exit.kind === 'stop' ? '停損' : '停利'}${EXIT_TEXT[p.exit.status]}` : '已結束', tone: 'muted', attention: false };
}

function bracketHistory(p: BracketPlan): HistoryEntry[] {
    const out: HistoryEntry[] = [{ at: p.createdAt, text: `建立 · ${p.action === 'Buy' ? '買進' : '賣出'} ${p.quantity} 成交後掛停損停利` }];
    for (const e of p.edits ?? []) out.push({ at: e.at, text: e.text });
    for (const i of p.issues) out.push({ at: i.at, text: i.detail, tone: 'warn' });
    if (p.exit) out.push({ at: p.exit.at, text: `${p.exit.kind === 'stop' ? '停損' : '停利'}${EXIT_TEXT[p.exit.status] ?? p.exit.status} ${p.exit.filled}/${p.exit.quantity}`,
        tone: p.exit.status === 'filled' ? 'ok' : p.exit.status === 'sending' || p.exit.status === 'working' ? undefined : 'err' });
    return out.sort((a, b) => a.at - b.at);
}

function bracketRow(p: BracketPlan, legs: TriggerOrder[], s: Sources): CondRow {
    const st = bracketStatus(p, legs, s);
    const live = isLive(p);
    const unit = unitOf(p.account, p.orderLot);
    // the armed stop may have moved (移動停損／保本)
    const stopLeg = legs.find(l => l.kind === 'stop');
    const stop = stopLeg?.price ?? p.stopPrice;
    const waitingRules = p.rules && p.base === undefined;
    const parts = waitingRules
        ? [`停損 成交價${p.action === 'Buy' ? '−' : '+'}${p.rules!.stopTicks} 檔`,
            p.rules!.takeTicks !== null ? `停利 ${p.action === 'Buy' ? '+' : '−'}${p.rules!.takeTicks} 檔` : null]
        : [stop !== null ? `停損 ${fmtNum(stop)}${stopLeg?.trail?.active ? '（移動中）' : ''}` : null, p.takePrice !== null ? `停利 ${fmtNum(p.takePrice)}` : null];
    if (p.rules?.trail && !parts.some(x => x?.includes('移動'))) parts.push('移動停損');
    const pendingLeg = legs.find(l => l.pending);
    return {
        id: `bracket:${p.id}`,
        kind: 'bracket',
        code: p.quoteCode,
        orderCode: p.orderCode,
        side: { text: `${sideText(p.action, p.quantity, unit)}${p.tier && p.tier.count > 1 ? `（第 ${p.tier.index + 1}/${p.tier.count} 層）` : ''}`, dir: p.action },
        condition: parts.filter(Boolean).join(' · '),
        level: null,
        status: { text: st.text, tone: st.tone },
        validity: live ? '直到出場' : '—',
        account: p.account,
        env: p.env,
        attention: st.attention,
        paused: false,
        actions: {
            ...NO_ACTIONS,
            // a rules bracket gets its prices at the first fill: nothing to edit before
            modify: live && !p.exit && !pendingLeg && !waitingRules,
            cancel: true,
            send: !!pendingLeg,
            keep: !!pendingLeg,
            reconcile: live,
            acknowledge: p.exit?.status === 'unknown' && !p.exit.acknowledged,
        },
        source: { type: 'bracket', plan: p, legs },
        history: bracketHistory(p),
        createdAt: p.createdAt,
        ended: !live,
    };
}

function bgBracketRow(v: BracketView, s: Sources): CondRow {
    const parts = [v.stop !== null ? `停損 ${fmtNum(v.stop)}` : null, v.take !== null ? `停利 ${fmtNum(v.take)}` : null];
    const ended = v.state === 'done' || v.state === 'handled' || v.state === 'rearmed';
    let status: { text: string; tone: Tone } = { text: BRACKET_STATE_TEXT[v.state], tone: v.attention ? 'err' : ended ? 'muted' : 'ok' };
    if (v.state === 'protected' || v.state === 'exiting') status = { text: `${BRACKET_STATE_TEXT[v.state]} · 成交 ${Math.min(v.entryFilled, v.quantity)}/${v.quantity}`, tone: 'ok' };
    if (v.state === 'unprotected' && v.unprotected > 0) status = { text: `未受保護 ${v.unprotected} 口`, tone: 'err' };
    if (!v.attention && !ended) {
        if (v.held) status = { text: v.held === 'envMismatch' ? '屬於其他伺服器或模式，目前不執行' : '未連線，暫停保護', tone: 'warn' };
        else if (v.paused) status = { text: `${status.text}（已暫停進場；停損停利照常）`, tone: 'warn' };
    }
    void s;
    return {
        id: `bgb:${v.programId}:${v.levelId}`,
        kind: 'bracket',
        code: v.quoteCode,
        orderCode: v.orderCode,
        side: { text: sideText(v.side, v.quantity, '口'), dir: v.side },
        condition: parts.filter(Boolean).join(' · '),
        level: null,
        status,
        validity: ended ? '—' : '本盤',
        account: { account_type: v.account.accountType, broker_id: v.account.brokerId, account_id: v.account.accountId },
        env: v.env,
        attention: v.attention,
        paused: v.paused,
        actions: {
            ...NO_ACTIONS,
            pause: v.actions.pause,
            resume: v.actions.resume,
            send: v.actions.decide,
            keep: v.actions.decide,
            handled: v.actions.markHandled,
            rearm: v.actions.rearm,
            cancel: v.actions.remove,
        },
        source: { type: 'bgBracket', view: v },
        history: [
            { at: v.createdAt, text: `建立 · ${v.side === 'Buy' ? '買進' : '賣出'} ${v.quantity} 口成交後掛停損停利` },
            ...(v.updatedAt > v.createdAt ? [{ at: v.updatedAt, text: BRACKET_STATE_TEXT[v.state],
                tone: (v.attention ? 'err' : undefined) as HistoryEntry['tone'] }] : []),
        ],
        createdAt: v.createdAt,
        ended: ended && !v.attention,
    };
}

/** Background bracket rows alone (the order ticket's list). */
export function bgBracketRows(views: readonly BracketView[], streamLive: boolean): CondRow[] {
    const s = { triggers: [], brackets: [], exits: [], ended: [], pendingConfirm: [], feedMissing: [], executing: true,
        envNow: null, streamLive, now: Date.now() } as Sources;
    return views.map(v => bgBracketRow(v, s));
}

function exitAttentionRow(e: ExitRecord, trigger: TriggerOrder | null): CondRow {
    const unit = e.market === 'stock' ? (isOddLot(e.orderLot) ? '股' : '張') : '口';
    return {
        id: `exit:${e.id}`,
        kind: 'trigger',
        code: trigger?.code ?? e.orderCode,
        orderCode: e.orderCode,
        side: { text: sideText(e.action, e.quantity, unit), dir: e.action },
        condition: trigger ? conditionText(trigger) : '觸價送出',
        level: null,
        status: { text: `送出結果不明，請到委託與持倉核對（不會自動重送）`, tone: 'err' },
        validity: '—',
        account: e.account,
        env: e.env,
        attention: true,
        paused: false,
        actions: { ...NO_ACTIONS, acknowledge: true },
        source: { type: 'exit', exit: e, trigger },
        history: [...(trigger?.history ?? []), { at: e.at, text: e.detail ?? '送單結果未知', tone: 'err' }],
        createdAt: trigger?.createdAt ?? e.at,
        ended: false,
    };
}

const CONFIRM_UNIT: Record<PendingConfirmItem['order']['quantityUnit'], string> = { contract: '口', lot: '張', share: '股' };

function pendingConfirmRow(item: PendingConfirmItem): CondRow {
    const o = item.order;
    const cond = o.triggerPrice !== null
        ? `${o.triggerCondition === 'above' ? '≥' : o.triggerCondition === 'below' ? '≤' : '觸價'} ${fmtNum(o.triggerPrice)}`
        : o.priceType === 'LMT' && o.price !== null ? `限價 ${fmtNum(o.price)}` : '市價';
    return {
        id: `confirm:${item.id}`,
        kind: item.owner.kind === 'bracket' ? 'bracket' : 'trigger',
        code: o.code,
        orderCode: o.code,
        side: { text: sideText(o.action, o.quantity, CONFIRM_UNIT[o.quantityUnit]), dir: o.action },
        condition: cond,
        level: null,
        status: item.state === 'needsConfirm'
            ? { text: '送出結果不明，請確認是否成交', tone: 'err' }
            : { text: '盤別已更換，委託已失效，請核對', tone: 'err' },
        validity: item.state === 'expired' && item.expiredAt ? `已於 ${fmtUntil(item.expiredAt)} 失效` : '—',
        account: item.account.brokerId && (item.account.accountType === 'F' || item.account.accountType === 'S')
            ? { account_type: item.account.accountType, broker_id: item.account.brokerId, account_id: item.account.accountId }
            : { account_type: item.account.accountType === 'F' ? 'F' : 'S', broker_id: '', account_id: item.account.accountId },
        env: item.env,
        attention: true,
        paused: false,
        actions: { ...NO_ACTIONS, confirm: true },
        source: { type: 'pendingConfirm', item },
        history: [
            { at: item.submittedAt, text: '送出委託，未收到確認', tone: 'warn' },
            ...(item.lastCheckedAt ? [{ at: item.lastCheckedAt, text: `查詢委託清單 ${item.listingChecks} 次，沒有找到這筆` }] : []),
            ...(item.expiredAt ? [{ at: item.expiredAt, text: '盤別更換，委託失效', tone: 'err' as const }] : []),
        ],
        createdAt: item.submittedAt,
        ended: false,
    };
}

const ENDED_TEXT: Record<EndedTrigger['reason'], string> = {
    fired: '已觸發',
    cancelled: '已取消',
    oco: '另一邊觸發，已刪除',
    expired: '有效期已過',
};

function endedRow(e: EndedTrigger, exit: ExitRecord | null): CondRow {
    const t = e.trigger;
    const exitText = exit ? ` · ${EXIT_TEXT[exit.status] ?? exit.status}${exit.status !== 'not-sent' ? ` ${exit.filled}/${exit.quantity}` : ''}` : '';
    return {
        id: `ended:${e.id}`,
        kind: t.time ? 'time' : t.group ? 'oco' : 'trigger',
        code: t.code,
        orderCode: t.orderCode ?? null,
        side: t.time?.kind === 'flatten' ? { text: '平掉剩餘部位', dir: null } : triggerSide(t),
        condition: t.time ? timeCondition(t) : conditionText(t),
        level: null,
        status: { text: `${ENDED_TEXT[e.reason]}${exitText}`, tone: e.reason === 'fired' ? (exit?.status === 'filled' ? 'ok' : exit && exit.status !== 'working' && exit.status !== 'sending' ? 'err' : 'ok') : 'muted' },
        validity: fmtUntil(e.at),
        account: t.account ?? null,
        env: t.env ?? null,
        attention: false,
        paused: false,
        actions: NO_ACTIONS,
        source: { type: 'ended', ended: e, exit },
        history: [...(t.history ?? []), ...(exit ? [{ at: exit.at, text: `${EXIT_TEXT[exit.status] ?? exit.status}${exit.detail ? `：${exit.detail}` : ''}` }] : [])],
        createdAt: t.createdAt ?? e.at,
        ended: true,
    };
}

export interface Projection {
    /** active rows; attention rows first */
    rows: CondRow[];
    ended: CondRow[];
    counts: { active: number; attention: number; firedToday: number; byTab: Record<CondTab, number> };
}

export function projectRows(s: Sources): Projection {
    const rows: CondRow[] = [];
    const bracketLegs = new Map<string, TriggerOrder[]>();
    const groups = new Map<string, TriggerOrder[]>();
    for (const t of s.triggers) {
        if (t.bracketId) {
            bracketLegs.set(t.bracketId, [...(bracketLegs.get(t.bracketId) ?? []), t]);
        } else if (t.group) {
            const key = `${t.env ?? ''}|${t.group}`;
            groups.set(key, [...(groups.get(key) ?? []), t]);
        } else {
            rows.push(triggerRow(t, s));
        }
    }
    for (const legs of groups.values()) rows.push(legs.length > 1 ? ocoRow(legs, s) : triggerRow(legs[0]!, s));
    const ended: CondRow[] = [];
    for (const p of s.brackets) {
        if (p.dismissed) continue;
        const row = bracketRow(p, bracketLegs.get(p.id) ?? [], s);
        (row.ended && !row.attention ? ended : rows).push(row);
    }
    for (const v of s.bgBrackets ?? []) {
        const row = bgBracketRow(v, s);
        (row.ended ? ended : rows).push(row);
    }
    const byTrigger = new Map(s.triggers.map(t => [t.id, t]));
    const endedById = new Map(s.ended.map(e => [e.id, e]));
    for (const e of s.exits) {
        if (e.bracketId || e.status !== 'unknown' || e.acknowledged) continue;
        rows.push(exitAttentionRow(e, byTrigger.get(e.triggerId) ?? endedById.get(e.triggerId)?.trigger ?? null));
    }
    for (const item of s.pendingConfirm) rows.push(pendingConfirmRow(item));
    const exitByTrigger = new Map(s.exits.filter(e => !e.bracketId).map(e => [e.triggerId, e]));
    for (const e of s.ended) ended.push(endedRow(e, exitByTrigger.get(e.id) ?? null));
    ended.sort((a, b) => b.createdAt - a.createdAt);
    rows.sort((a, b) => Number(b.attention) - Number(a.attention) || a.createdAt - b.createdAt);
    const byTab = { all: rows.length, trigger: 0, oco: 0, bracket: 0, time: 0, grid: 0, ended: ended.length } as Record<CondTab, number>;
    for (const r of rows) byTab[r.kind] += 1;
    const firedToday = s.ended.filter(e => e.reason === 'fired').length
        + s.brackets.filter(p => p.exit && p.exit.at && sameTradingDay(p.exit.at, s.now)).length;
    const attention = rows.filter(r => r.attention).length;
    return { rows, ended, counts: { active: rows.length - attention, attention, firedToday, byTab } };
}

export function rowsForTab(p: Projection, tab: CondTab): CondRow[] {
    if (tab === 'ended') return p.ended;
    if (tab === 'all') return p.rows;
    return p.rows.filter(r => r.kind === tab);
}

/** `[期] •••••67` — the account follows privacy mode (masked by the caller). */
export function accountTag(a: AccountRef | null, masked: (id: string) => string): string {
    if (!a) return '—';
    return `${a.account_type === 'F' ? '[期]' : '[證]'} ${masked(a.account_id)}`;
}
