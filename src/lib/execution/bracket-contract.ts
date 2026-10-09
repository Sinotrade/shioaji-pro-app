// src/lib/execution/bracket-contract.ts — App ↔ background engine contract
// for brackets (括號單) run in the background (#201 ②, desktop only, setting
// 「背景持續執行（實驗）」 on). The single source of truth for the commands,
// payloads and the per-bracket view that any UI (the order ticket's minimal
// list today, the 條件單管理面板 #226 next) builds on. Pure: no I/O here;
// background.ts invokes the commands.
//
// Trading rules this contract carries (user decisions, 2026-10-08/09):
// - A bracket protects an entry order the order ticket placed (its trade id
//   is sent along): an OCO stop / take, market IOC, closing only, for the
//   FILLED lots only. One bracket per entry order.
// - Orders never span trading sessions (盤別). At a session change the
//   protection does NOT carry over: the bracket shows `lapsed` (a reminder)
//   and offers 「在新盤別重新啟用」 — the user re-reads the account's
//   positions and confirms a quantity (capped by the closable position and
//   by what the bracket held). The new protection is single shot, gets new
//   ids (never one from the send ledger), and its first tick decides: if a
//   leg is already past, it waits for the user (待確認), nothing is sent.
// - An entry fill after the bracket stopped protecting (entry ended, exit
//   fired, past session) is `unprotected` and notified; never covered
//   automatically.
// - 「我已自行處理」 is always available while the engine tracks something:
//   it ends the tracking (nothing is sent or cancelled — a still-working
//   order stays with the user), refused only for the seconds a request is
//   leaving (`inFlight`).
// - Pause stops new entries only; stop / take keep watching.
// - An unknown send outcome is never resent: it goes to 委託待確認
//   (pending-confirm-contract.ts, owner kind `bracket`).
// Defaults above are the engine's `BracketPolicy` (model.ts); settings for
// them come with the panel.
//
// Commands (Tauri `invoke`, main window unless noted):
//   execution_create_bracket({ request: CreateBracketRequest }) -> CommandReply
//       Main window and popouts (order tickets). Refused when the setting is
//       off, the engine is not live on the request's environment, the entry
//       is already protected by another bracket, or the request is invalid.
//   execution_mark_handled({ programId, levelId? })            -> CommandReply
//   execution_rearm_bracket({ request: RearmBracketRequest })   -> RearmBracketResult
//   execution_resolve_trigger({ request: { programId, levelId, choice: 'send' | 'keep', allowUnpast } })
//       -> CommandReply: a `needsConfirm` leg (send the exit now / keep
//       watching until the price crosses again). Main window only.
//   execution_pause({ programId }) / execution_resume({ programId }) -> CommandReply
//   execution_remove({ programId })                             -> CommandReply
//       Brackets: only a finished one (`actions.remove`); otherwise refused.
// Reads: execution_programs (every window) → OrderProgram[]; build views
// with `bracketViews`. Event `execution://changed` → re-read;
// `execution://notice` → BracketNoticeCode notices.

import type { AccountKey, Binding, BracketPolicy, Level, OrderProgram, OrderSlot } from './model';

export type { BracketPolicy } from './model';

/** v2: bracket settings (`BracketPolicy`) get / set, origin `lateFill`,
 * notices of the automatic protection. */
export const BRACKET_CONTRACT_VERSION = 2 as const;

export const BRACKET_COMMAND = {
    create: 'execution_create_bracket',
    markHandled: 'execution_mark_handled',
    rearm: 'execution_rearm_bracket',
    pause: 'execution_pause',
    resume: 'execution_resume',
    remove: 'execution_remove',
    /** v2: () -> BracketPolicy (any window; an unreadable file is an error). */
    getPolicy: 'execution_get_bracket_policy',
    /** v2: ({ policy: BracketPolicy }) -> BracketPolicy (main window only).
     * Saved durably first; then every tracked bracket and every new one runs
     * with it (a failed save changes nothing). */
    setPolicy: 'execution_set_bracket_policy',
} as const;

// ---- settings (v2) ----
// All off by default. Every automatic action follows the same rules as the
// user's one click: the account's positions are read again (a failed read
// protects nothing), the quantity is capped by what is closable now and not
// already protected by another bracket, the new protection is single shot
// with new ids, and if a leg is already past on its first tick it waits for
// the user (待確認) — nothing is sent by itself then.

export const DEFAULT_BRACKET_POLICY: BracketPolicy = { autoRearm: false, autoProtectLateFill: false, pauseStopsExits: false };

/** Labels and help for a settings UI (Traditional Chinese). */
export const BRACKET_POLICY_TEXT: Record<keyof BracketPolicy, { label: string; help: string }> = {
    autoRearm: {
        label: '換盤別後自動重新啟用保護',
        help: '盤別更換時，背景執行重新查詢該帳戶持倉，以可平倉量為上限自動在新盤別重新盯停損停利（單次）。若當下已穿價，會先等你決定，不會自動送單。關閉時需要你手動按「在新盤別重新啟用」。',
    },
    autoProtectLateFill: {
        label: '保護結束後才成交的口數自動補上保護',
        help: '進場單在保護結束後才成交的口數，背景執行重新查詢持倉後自動為它建立新的停損停利（單次，以未被其他括號單保護的可平倉量為上限）。關閉時標示「未受保護」並通知你。',
    },
    pauseStopsExits: {
        label: '暫停時連停損停利一起暫停',
        help: '開啟後，暫停的括號單不再盯停損停利、不會觸發；暫停前已觸發、正在送出的平倉單照常送出。恢復後若已穿價，會先等你決定。關閉時暫停只停止新進場，停損停利照常盯價。',
    },
};

/** A settings answer from the App: exactly three booleans, else an error. */
export function parseBracketPolicy(raw: unknown): BracketPolicy {
    const o = raw as Record<string, unknown> | null;
    if (typeof o !== 'object' || o === null) throw new Error('括號單設定格式不正確');
    const keys = ['autoRearm', 'autoProtectLateFill', 'pauseStopsExits'] as const;
    for (const k of keys) if (typeof o[k] !== 'boolean') throw new Error(`括號單設定格式不正確（${k}）`);
    return { autoRearm: o.autoRearm as boolean, autoProtectLateFill: o.autoProtectLateFill as boolean,
        pauseStopsExits: o.pauseStopsExits as boolean };
}

/** After the entry order was accepted by the order ticket. */
export interface CreateBracketRequest {
    /** `bkt-` + [A-Za-z0-9_-], ≤ 80 chars; never reused. */
    id: string;
    binding: Binding;
    /** The entry's side and original quantity (口). */
    side: 'Buy' | 'Sell';
    qty: number;
    stop: number | null;
    take: number | null;
    /** The entry order: trade id (`order.id`), seqno / ordno when known
     * (ordno may come later with the New report). */
    entry: { tradeId: string; seqno: string | null; ordno: string | null;
        /** ms epoch the entry was sent: an entry of another trading session
         * than now is refused (orders do not cross sessions). */
        sentAt: number };
}

export interface RearmBracketRequest {
    programId: string;
    levelId: string;
    /** Confirmed by the user against a fresh read of this account's
     * positions; ≤ closable position and ≤ `BracketView.held`. */
    quantity: number;
}

export type RearmBracketRefusal = 'notFound' | 'notLapsed' | 'notEnabled' | 'invalidRequest' | 'rearmFailed'
    | 'rearmInProgress';

export interface RearmBracketResult {
    ok: boolean;
    reason?: RearmBracketRefusal;
    /** The new program on success. */
    programId?: string;
}

export const REARM_REFUSAL_TEXT: Record<RearmBracketRefusal, string> = {
    notFound: '找不到這張括號單',
    notLapsed: '這張括號單目前不需要重新啟用',
    notEnabled: '要先在設定開啟「背景持續執行（實驗）」才能重新啟用',
    invalidRequest: '數量不正確（需為正整數，且不超過括號單原本持有的部位）',
    rearmFailed: '重新啟用沒有完成，請稍後再試',
    rearmInProgress: '先前重新啟用的保護已經送出委託，不能再重新啟用；請到委託查詢與持倉核對',
};

/** Notice codes (execution://notice) a bracket UI may show. */
export const BRACKET_NOTICE_TEXT: Record<string, string> = {
    protectionLapsed: '括號單保護沒有延續到新盤別，需要的話請重新啟用',
    'issue.unprotectedFill': '括號單有未受保護的成交',
    handled: '括號單已改由你自行處理',
    handledFill: '已自行處理的括號單仍收到成交，請到持倉核對',
    'bracket.rearmed': '括號單已在新盤別重新啟用',
    'bracket.autoRearmed': '括號單已自動在新盤別重新啟用（若已穿價會先等你決定）',
    protectedAgain: '晚到成交的口數已自動補上保護（若已穿價會先等你決定）',
    'bracket.autoSkipped': '括號單沒有自動補上保護，請自行處理',
};

/** Where a bracket stands, one value for the UI to key on. */
export type BracketState =
    | 'waitingEntry' // entry working, nothing filled yet
    | 'protected' // holding: stop / take watching
    | 'exiting' // an exit (or an OCO switch) is working
    | 'needsConfirm' // a leg was already past when watching resumed: the user decides
    | 'unknown' // a send's outcome is unknown: 委託待確認 decides it
    | 'lapsed' // the session changed: protection did not carry over
    | 'unprotected' // lots held without protection (exit refused / incomplete / late fill)
    | 'done' // exited, or the entry ended unfilled
    | 'handled' // the user took it over
    | 'rearmed'; // went on as another program in a new session

export interface BracketView {
    programId: string;
    levelId: string;
    /** `rearm:…` programs: protection turned back on in a new session. */
    rearm: boolean;
    /** v2: what it protects: the entry order, a rearm, or late lots. */
    origin: 'entry' | 'rearm' | 'lateFill';
    env: string; // `${serverId}|simulation|production` (protection env key)
    account: AccountKey;
    quoteCode: string;
    orderCode: string;
    side: 'Buy' | 'Sell';
    quantity: number;
    stop: number | null;
    take: number | null;
    state: BracketState;
    /** The program is paused (entries only; exits keep watching). */
    paused: boolean;
    /** Held from another environment / disconnected: nothing runs now. */
    held: 'envMismatch' | 'disconnected' | 'unknownEnv' | null;
    entryFilled: number;
    /** Lots the engine holds for this bracket (what a rearm may protect). */
    position: number;
    unprotected: number;
    /** The exit currently out (or last), if any. */
    exit: { leg: 'stop' | 'take'; status: OrderSlot['status']; qty: number; filled: number } | null;
    /** The leg waiting for the user's decision (`needsConfirm`). */
    pendingLeg: 'stop' | 'take' | null;
    /** Something the user should act on (需要你處理). */
    attention: boolean;
    actions: {
        markHandled: boolean;
        rearm: boolean;
        /** `needsConfirm`: send the exit now, or keep watching (re-cross). */
        decide: boolean;
        pause: boolean;
        resume: boolean;
        remove: boolean;
    };
    detail: string | null;
    createdAt: number;
    updatedAt: number;
}

const leaving = (lv: Level) => lv.orders.some(o => o.status === 'pendingSubmit');
const unknownOpen = (lv: Level) => lv.orders.some(o => o.status === 'unknown' && !o.acknowledged);
const active = (lv: Level) => lv.orders.some(o => o.status === 'pendingSubmit' || o.status === 'working');

/** Protection that lapsed with its session (mirror of the engine's check;
 * the engine re-checks on rearm). */
export function lapsedLevel(lv: Level): boolean {
    return lv.phase === 'disabled' && lv.detail === 'sessionEnded' && lv.position > 0 && !active(lv) && !unknownOpen(lv);
}

function stateOf(p: OrderProgram, lv: Level): BracketState {
    if (lv.phase === 'done' && lv.detail === 'handledByUser') return 'handled';
    if (unknownOpen(lv) || lv.phase === 'unknown' || lv.pending?.reason === 'unknownNotSent') return 'unknown';
    if (lapsedLevel(lv)) return 'lapsed';
    if (lv.phase === 'needsConfirm') return 'needsConfirm';
    // a rearmed bracket still shows lots it knew unprotected
    if (lv.unprotected > 0 || lv.phase === 'disabled') return 'unprotected';
    if (lv.phase === 'done' && lv.detail === 'rearmed') return 'rearmed';
    if (lv.phase === 'exiting') return 'exiting';
    if (lv.phase === 'holding') return 'protected';
    if (lv.phase === 'working' || (lv.phase === 'idle' && p.status !== 'stopped')) return 'waitingEntry';
    return 'done';
}

/** Nothing left for the engine: removable. */
export function bracketFinished(p: OrderProgram): boolean {
    return p.levels.every(lv => lv.position <= 0 && lv.unprotected <= 0 && !active(lv) && !unknownOpen(lv)
        && lv.pending?.reason !== 'unknownNotSent' && (lv.phase === 'done' || p.status === 'stopped'));
}

const envKey = (b: Binding) => `${b.serverId}|${b.env}`;

/** The views of every background bracket (kind `bracket`). */
export function bracketViews(programs: readonly OrderProgram[]): BracketView[] {
    const out: BracketView[] = [];
    for (const p of programs) {
        if (p.kind !== 'bracket') continue;
        const finished = bracketFinished(p);
        for (const lv of p.levels) {
            const exitSpec = lv.exit?.type === 'oco' ? lv.exit : null;
            const exits = lv.orders.filter(o => o.role === 'exit' && o.cycle === lv.cycles);
            const last = exits[exits.length - 1];
            const state = stateOf(p, lv);
            const tracking = state !== 'handled' && state !== 'rearmed' && !finished;
            out.push({
                programId: p.id,
                levelId: lv.id,
                rearm: p.id.startsWith('rearm:'),
                origin: p.id.startsWith('rearm:') ? 'rearm' : p.id.startsWith('late:') ? 'lateFill' : 'entry',
                env: envKey(p.binding),
                account: p.binding.account,
                quoteCode: p.binding.contract.quoteCode,
                orderCode: p.binding.contract.orderCode,
                side: lv.side,
                quantity: lv.qty,
                stop: exitSpec?.stop?.price ?? null,
                take: exitSpec?.take?.price ?? null,
                state,
                paused: p.status === 'paused',
                held: p.hold,
                entryFilled: lv.entryFilled,
                position: Math.max(0, lv.position),
                unprotected: lv.unprotected,
                exit: last && (last.leg === 'stop' || last.leg === 'take')
                    ? { leg: last.leg, status: last.status, qty: last.qty, filled: last.filled } : null,
                pendingLeg: lv.phase === 'needsConfirm' && (lv.pending?.leg === 'stop' || lv.pending?.leg === 'take')
                    ? lv.pending.leg : null,
                attention: ['lapsed', 'unprotected', 'unknown', 'needsConfirm'].includes(state),
                actions: {
                    markHandled: tracking && !leaving(lv),
                    rearm: state === 'lapsed',
                    decide: state === 'needsConfirm' && p.status !== 'stopped',
                    pause: p.status === 'running' && tracking,
                    resume: p.status === 'paused',
                    remove: finished,
                },
                detail: lv.detail,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
            });
        }
    }
    return out;
}

export const BRACKET_STATE_TEXT: Record<BracketState, string> = {
    waitingEntry: '等待進場成交',
    protected: '保護中',
    exiting: '出場中',
    needsConfirm: '待確認：恢復盯價時已穿價',
    unknown: '送出結果不明（請到委託待確認核對）',
    lapsed: '盤別已更換，保護未延續',
    unprotected: '未受保護',
    done: '已結束',
    handled: '已改由你自行處理',
    rearmed: '已在新盤別重新啟用',
};
