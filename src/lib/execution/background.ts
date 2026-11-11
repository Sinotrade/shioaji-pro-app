// src/lib/execution/background.ts — client of the background execution
// engine (#201 ①-3; desktop only; 「背景持續執行（實驗）」, off by default).
//
// The engine runs in the App process (Tauri): it owns its own sidecar
// connection, sends and reconciles orders itself and keeps running while a
// window reloads or is closed. This module only:
// - reads and changes the setting (stored by the App, main window only);
// - mirrors the background programs for display (every window), refreshed
//   on `execution://changed`;
// - creates / removes background triggers and forwards 待確認 decisions;
// - in the main window: keeps the quote feed of background triggers retained
//   (closing a chart never unsubscribes a watched contract), remembers the
//   latest price of their codes for the 待確認 rows, drops finished triggers,
//   shows the engine's notices and installs the 委託待確認 backend.
//
// With the setting off and no background program, nothing here changes what
// the window's own trigger engine does (see trigger-engine.ts).

import { useSyncExternalStore } from 'react';
import { orderCodeHintsChanged, setOrderCodeHint } from '../order-code-hints';
import { backgroundFills, backgroundFillsIncreased, orderCodeOf } from './background-orders';
import { ensureContract } from '../contracts-cache';
import { isMainWindow } from '../main-window-commands';
import { currentProtectionEnv, onProtectionEnvChange } from '../protection-env';
import { pinQuote } from '../quote-ownership';
import { getStreamStatus, onAnyBidAsk, onAnyTick, onOddLotTick, subscribeStatusStore } from '../stream';
import { notify } from '../trade';
import { envKeyOf } from './adapter';
import { programFinished } from './background-view';
import {
    BRACKET_COMMAND,
    BRACKET_NOTICE_TEXT,
    noticeBody,
    DEFAULT_BRACKET_POLICY,
    parseBracketPolicy,
    type BracketPolicy,
    REARM_REFUSAL_TEXT,
    type CreateBracketRequest,
    type RearmBracketResult,
} from './bracket-contract';
import type { Notice, OrderProgram } from './model';
import { createTauriPendingConfirmBackend, installPendingConfirmBackend } from './pending-confirm';

export interface BackgroundHealth {
    enabled: boolean;
    state: 'idle' | 'connecting' | 'live' | 'down';
    env: 'simulation' | 'production' | null;
    serverId: string | null;
    lastError: string | null;
    partitionErrors: string[];
    programs: number;
    activePrograms: number;
    revision: number;
}

interface CommandReply {
    accepted: boolean;
    notices: Notice[];
    revision: number;
}

interface ProgramsView {
    revision: number;
    programs: OrderProgram[];
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeImpl: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!invokeImpl) invokeImpl = (await import('@tauri-apps/api/core')).invoke as Invoke;
    return invokeImpl<T>(cmd, args);
}

// Same detection as runtime.ts `isTauri`, kept here so tests can switch it.
let isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let health: BackgroundHealth | null = null;
/** The saved setting as the App last said; null: not read yet / unreadable. */
let setting: boolean | null = null;
let programs: OrderProgram[] = [];
let revision = -1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function backgroundSupported(): boolean {
    return isTauri;
}

/** The saved 「背景持續執行（實驗）」 setting; null while unknown. */
export function getBackgroundSetting(): boolean | null {
    return isTauri ? setting : false;
}

export function useBackgroundSetting(): boolean | null {
    return useSyncExternalStore(subscribeBackground, getBackgroundSetting);
}

export const BACKGROUND_UNAVAILABLE = '背景執行目前無法使用，請稍後再試或關閉背景持續執行改用本視窗';
export const BACKGROUND_NOT_LIVE = '背景執行尚未連上目前的伺服器，請稍後再試或關閉背景持續執行改用本視窗';
export const BACKGROUND_SETTING_UNKNOWN = '背景持續執行的開關狀態不明，請稍後再試或到設定確認開關';

async function readSetting(): Promise<boolean | null> {
    try {
        const on = await invoke<boolean>('execution_get_enabled');
        if (typeof on !== 'boolean') throw new Error('bad setting');
        return on;
    } catch {
        return null;
    }
}

/** Who runs a new futures / options stop or take: off → this window
 * (exactly as before, the engine's state does not matter); on → the
 * background engine, or a refusal while it cannot be reached; unknown
 * setting → a refusal (never a silent guess either way). */
export async function backgroundOwnerForNew(opts: { liveOn?: string } = {}): Promise<'window' | 'background' | { refused: string }> {
    if (!isTauri) return 'window';
    // read now, every time: a cached value never decides (another window may
    // have changed it, or the file became unreadable)
    const on = await readSetting();
    adoptSetting(on);
    if (on === null) return { refused: BACKGROUND_SETTING_UNKNOWN };
    if (!on) return 'window';
    let h: BackgroundHealth | null = null;
    try {
        h = await invoke<BackgroundHealth>('execution_status');
    } catch {
        h = null;
    }
    adoptHealth(h);
    // the engine must be up and running with the setting on
    if (!h || h.enabled !== true) return { refused: BACKGROUND_UNAVAILABLE };
    // a bracket is taken over only by an engine live on its environment now
    // (its entry is not sent otherwise)
    if (opts.liveOn !== undefined && (h.state !== 'live' || `${h.serverId}|${h.env}` !== opts.liveOn)) {
        return { refused: BACKGROUND_NOT_LIVE };
    }
    return 'background';
}

/** A read result replaces what is shown, failures included (unknown). */
function adoptSetting(on: boolean | null) {
    if (on !== setting) { setting = on; emit(); }
}

function adoptHealth(h: BackgroundHealth | null) {
    if (h === null ? health !== null : JSON.stringify(h) !== JSON.stringify(health)) { health = h; emit(); }
}

export function getBackgroundHealth(): BackgroundHealth | null {
    return health;
}

export function getBackgroundPrograms(): OrderProgram[] {
    return programs;
}

export function subscribeBackground(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function useBackgroundHealth(): BackgroundHealth | null {
    return useSyncExternalStore(subscribeBackground, getBackgroundHealth);
}

export function useBackgroundPrograms(): OrderProgram[] {
    return useSyncExternalStore(subscribeBackground, getBackgroundPrograms);
}

/** A background order filled: the window's positions / orders did not send
 * it, so read them again — now, and once more after the trading store's
 * cooldown (a read already in flight or just finished would swallow it). */
let trailingFillRefresh: ReturnType<typeof setTimeout> | null = null;
export const FILL_REFRESH_TRAIL_MS = 2500;
function afterBackgroundFill(): void {
    const refresh = () => void import('../trading-state').then(m => m.refreshTradingState('all')).catch(() => undefined);
    refresh();
    if (trailingFillRefresh) clearTimeout(trailingFillRefresh);
    trailingFillRefresh = setTimeout(() => { trailingFillRefresh = null; refresh(); }, FILL_REFRESH_TRAIL_MS);
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let epoch = 0; // bumps when the setting changes: older reads are not adopted
/** Re-read status and programs (coalesced). */
export function refreshBackground(): Promise<void> {
    if (!isTauri) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    const started = epoch;
    refreshing = (async () => {
        // the setting is read on its own: it is known even when the engine is not
        const saved = await readSetting();
        if (started === epoch) adoptSetting(saved);
        try {
            const [view, h] = await Promise.all([
                invoke<ProgramsView>('execution_programs'),
                invoke<BackgroundHealth>('execution_status'),
            ]);
            if (started !== epoch) { refreshAgain = true; return; }
            const first = health === null;
            if (view.revision !== revision || JSON.stringify(h) !== JSON.stringify(health)) {
                revision = view.revision;
                const filledBefore = backgroundFills(programs);
                const hadPrograms = programs.length > 0 || !first;
                programs = view.programs;
                orderCodeHintsChanged();
                if (isMainWindow() && hadPrograms && backgroundFillsIncreased(filledBefore, backgroundFills(programs))) afterBackgroundFill();
                health = h;
                emit();
            }
            if (isMainWindow()) { housekeeping(); syncQuotes(); }
            if (first) onFirstStatus();
        } catch {
            // the engine cannot be reached: nothing shown as running
            if (started === epoch) adoptHealth(null);
        }
    })().finally(() => {
        refreshing = null;
        if (refreshAgain) { refreshAgain = false; void refreshBackground(); }
    });
    return refreshing;
}

/** One program read from the App now (not the cached mirror); throws when
 * the App cannot be read — a caller that must be sure never guesses. */
export async function readBackgroundProgram(programId: string): Promise<OrderProgram | null> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    const view = await invoke<ProgramsView>('execution_programs');
    if (!view || !Array.isArray(view.programs)) throw new Error('背景執行清單無法讀取');
    return view.programs.find(p => p.id === programId) ?? null;
}

/** Refreshed until no read is in flight (every read started after now). */
async function settled(): Promise<void> {
    await refreshBackground();
    while (refreshing) await refreshing;
}

// ---- setting ----

/** Main window only (the App refuses other windows). */
export async function setBackgroundEnabled(on: boolean): Promise<void> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    epoch += 1;
    try {
        health = await invoke<BackgroundHealth>('execution_set_enabled', { enabled: on });
        setting = on;
    } finally {
        // success or not, show what the App has now (a failed save may still
        // have changed the file)
        epoch += 1;
        emit();
        await settled();
    }
}

// ---- commands ----

const REJECT_TEXT: Record<string, string> = {
    'rejected.envMismatch': '背景執行目前連線的伺服器或模式與這張單不同',
    'rejected.unknownEnv': '背景執行尚未連上伺服器',
    'rejected.staleVersion': '狀態已變更，請再試一次',
    'rejected.duplicateProgram': '這張單已建立',
    'rejected.hasOrdersOrPosition': '委託尚未結束，結束後才會移除',
    'rejected.unpast': '價格已回到觸發價另一側，需要再確認',
    'rejected.noPrice': '背景執行尚未收到即時成交價',
    'rejected.notPending': '這張單已不在待確認',
    'rejected.inFlight': '委託送出中，請稍候再按',
    'rejected.notRunning': '這張單目前不是執行中',
    'rejected.notPaused': '這張單目前沒有暫停',
    'rejected.exitBusy': '停損停利的出場單正在送出或結果未知，沒有取消',
    'rejected.expired': '有效期已過',
    'rejected.notReplaceable': '這張單已觸發、待確認或狀態已變，沒有修改；請看清單與委託',
    'rejected.invalidReplace': '修改內容與原本的單不符',
    'rejected.noTickTable': '跳動點級距尚未取得，無法計算限價',
    'rejected.invalidFeed': '對手價設定不正確',
    'rejected.invalidLimit': '限價檔數不正確',
    'rejected.invalidOrder': '送出方式不正確',
    'rejected.invalidValidity': '有效期不正確',
    'rejected.invalidPrice': '觸發價不正確',
    // 權證（背景執行引擎依交易所規則拒絕，docs/qa/warrant-rules.md）
    'rejected.warrantOddLot': '權證沒有零股，只能整張',
    'rejected.warrantCredit': '權證只能現股，不能融資融券或當沖先賣',
    'rejected.warrantMarket': '外國標的權證不能下市價，請用限價',
    'rejected.warrantOffTick': '價格不在權證升降單位上',
    'partition.failed': '背景執行資料無法寫入，這個環境已停止，請重新啟動 App',
};

/** The App answered and refused: nothing was created / changed. */
export class BackgroundRefusal extends Error {}

/** The user-facing text of an engine refusal code (`rejected.*`). */
export function rejectionText(code: string): string {
    return REJECT_TEXT[code] ?? `背景執行未接受（${code}）`;
}

function rejection(reply: CommandReply): string {
    const bad = reply.notices.find(n => n.code.startsWith('rejected.') || n.code === 'partition.failed');
    return bad ? rejectionText(bad.code) : '背景執行未接受';
}

async function command(cmd: string, args: Record<string, unknown>): Promise<CommandReply> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    const reply = await invoke<CommandReply>(cmd, args);
    await refreshBackground();
    if (!reply.accepted) throw new BackgroundRefusal(rejection(reply));
    return reply;
}

/** `created` / `refused` (definitely not created) / `unconfirmed` (the
 * answer was lost: the App may hold it — the user must check, not retry). */
export async function createBackgroundTrigger(program: OrderProgram): Promise<'created' | { refused: string } | { unconfirmed: string }> {
    try {
        await command('execution_create', { program });
        return 'created';
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (e instanceof BackgroundRefusal) return { refused: why };
        await settled();
        return programs.some(p => p.id === program.id) ? 'created' : { unconfirmed: why };
    }
}

/** #226 修改: the untouched trigger `programId` becomes `program` in one
 * engine step (never both armed). `replaced`, `refused` (nothing changed)
 * or `unconfirmed` (the answer was lost: check the list, do not retry). */
export async function replaceBackgroundTrigger(programId: string, program: OrderProgram): Promise<'replaced' | { refused: string } | { unconfirmed: string }> {
    try {
        await command('execution_replace', { programId, program });
        return 'replaced';
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (e instanceof BackgroundRefusal) return { refused: why };
        // the App's own error text, or a lost answer: what it holds now decides
        await settled();
        if (programs.some(p => p.id === program.id)) return 'replaced';
        if (programs.some(p => p.id === programId)) return { refused: why };
        return { unconfirmed: why };
    }
}

/** Removes a background trigger (one with an order still working is
 * stopped first and dropped once it ended). */
export async function removeBackgroundTrigger(programId: string): Promise<void> {
    removing.add(programId);
    try {
        await command('execution_remove', { programId });
    } finally {
        removing.delete(programId);
    }
}

export async function resolveBackgroundTrigger(programId: string, levelId: string, choice: 'send' | 'cancel' | 'keep',
    allowUnpast = false): Promise<void> {
    await command('execution_resolve_trigger', { request: { programId, levelId, choice, allowUnpast } });
}

// ---- brackets (括號單, #201 ②; see bracket-contract.ts) ----

/** Right after the entry order was accepted. Like a trigger: `created`,
 * `refused` (definitely not created) or `unconfirmed` (answer lost). */
export async function createBackgroundBracket(request: CreateBracketRequest): Promise<'created' | { refused: string } | { unconfirmed: string }> {
    if (!isTauri) return { refused: '背景持續執行僅限桌面版' };
    try {
        const reply = await invoke<CommandReply>(BRACKET_COMMAND.create, { request });
        await refreshBackground();
        if (!reply.accepted) return { refused: rejection(reply) };
        return 'created';
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        await settled();
        if (programs.some(p => p.id === request.id)) return 'created';
        // the App answered with a refusal text (a string error): not created
        return typeof e === 'string' ? { refused: why } : { unconfirmed: why };
    }
}

/** #226 修改 a bracket whose 觸價 entry did not fire yet: the engine builds
 * the new one from `request` and replaces it in one step. */
export async function replaceBackgroundBracket(programId: string, request: CreateBracketRequest): Promise<'replaced' | { refused: string } | { unconfirmed: string }> {
    if (!isTauri) return { refused: '背景持續執行僅限桌面版' };
    try {
        const reply = await invoke<CommandReply>(BRACKET_COMMAND.replace, { programId, request });
        await refreshBackground();
        if (!reply.accepted) return { refused: rejection(reply) };
        return 'replaced';
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        await settled();
        if (programs.some(p => p.id === request.id)) return 'replaced';
        if (programs.some(p => p.id === programId)) return { refused: why };
        return { unconfirmed: why };
    }
}

/** 「我已自行處理」: the engine stops tracking; nothing is sent or cancelled. */
/** `scope`: the flash panel's account and product — a flash popout must
 * send it (the App then ends only that protection, and only while no exit of
 * it is out, in one engine step). */
export async function markBackgroundHandled(programId: string, levelId?: string,
    scope?: { account: { accountType: string; brokerId: string; accountId: string }; codes: string[] }): Promise<void> {
    // only 平倉 (flash panel) sends a scope: its `handled` notice says so
    if (scope) endedByFlatten.set(programId, Date.now() + FLATTEN_NOTE_MS);
    try {
        await command(BRACKET_COMMAND.markHandled, { programId, levelId: levelId ?? null, ...(scope ? { scope } : {}) });
    } catch (e) {
        endedByFlatten.delete(programId);
        throw e;
    }
}

const FLATTEN_NOTE_MS = 60_000;
/** programId -> until when its `handled` notice is one ended by 平倉 */
const endedByFlatten = new Map<string, number>();
/** The `handled` notice of `programId` came from 平倉 (consumed once). */
function takeEndedByFlatten(programId: string | null | undefined): boolean {
    if (!programId) return false;
    const until = endedByFlatten.get(programId);
    endedByFlatten.delete(programId);
    return until !== undefined && until >= Date.now();
}

/** 「在新盤別重新啟用」 (nothing is sent then). */
export async function rearmBackgroundBracket(programId: string, levelId: string, quantity: number): Promise<string> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    const r = await invoke<RearmBracketResult>(BRACKET_COMMAND.rearm, { request: { programId, levelId, quantity } });
    await refreshBackground();
    if (!r.ok) throw new BackgroundRefusal(REARM_REFUSAL_TEXT[r.reason ?? 'rearmFailed'] ?? '重新啟用沒有完成');
    return r.programId ?? '';
}

/** The saved bracket settings (v2); throws when unreadable. */
export async function getBracketPolicy(): Promise<BracketPolicy> {
    if (!isTauri) return { ...DEFAULT_BRACKET_POLICY };
    return parseBracketPolicy(await invoke<unknown>(BRACKET_COMMAND.getPolicy));
}

/** Save the bracket settings (main window only); resolves with what holds. */
export async function setBracketPolicy(policy: BracketPolicy): Promise<BracketPolicy> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    const saved = parseBracketPolicy(await invoke<unknown>(BRACKET_COMMAND.setPolicy, { policy }));
    await refreshBackground();
    return saved;
}

/** Pause stops new entries only; stop / take keep watching. */
export async function pauseBackgroundProgram(programId: string): Promise<void> {
    await command(BRACKET_COMMAND.pause, { programId });
}

export async function resumeBackgroundProgram(programId: string): Promise<void> {
    await command(BRACKET_COMMAND.resume, { programId });
}

/** A finished bracket leaves the list (the App refuses one still tracking). */
export async function removeBackgroundBracket(programId: string): Promise<void> {
    await command(BRACKET_COMMAND.remove, { programId });
}

// ---- main window upkeep ----

const removing = new Set<string>();
const swept = new Map<string, number>(); // program id → version already tried
/** Finished background triggers leave the engine's store (once per
 * version: a refused remove is not retried until the program changes; the
 * engine's change event refreshes the list). */
function housekeeping() {
    for (const p of programs) {
        if ((p.kind !== 'trigger' && p.kind !== 'flatten') || !programFinished(p) || removing.has(p.id) || swept.get(p.id) === p.version) continue;
        swept.set(p.id, p.version);
        // a failed request is tried again on the next refresh
        void invoke<CommandReply>('execution_remove', { programId: p.id }).catch(() => { swept.delete(p.id); });
    }
}

const quoteHolds = new Map<string, { release?: () => void }>();
/** Keep the feeds of the current environment's background triggers
 * retained by this window (the engine subscribes them too): ticks, and the
 * book of 對手價 conditions — closing the last chart or quote panel never
 * unsubscribes what a background condition watches. */
function syncQuotes() {
    const env = currentProtectionEnv();
    const wanted = new Map<string, { code: string; type: 'Tick' | 'BidAsk'; odd?: boolean }>();
    for (const p of programs) {
        if (p.status === 'stopped' || envKeyOf(p.binding) !== env) continue;
        const code = p.binding.contract.quoteCode;
        wanted.set(`${code}|Tick`, { code, type: 'Tick' });
        const feeds = p.levels.filter(lv => lv.phase !== 'done' && lv.entry.type === 'touch')
            .map(lv => lv.entry.type === 'touch' ? lv.entry.feed : undefined);
        if (feeds.some(f => f === 'bid' || f === 'ask')) wanted.set(`${code}|BidAsk`, { code, type: 'BidAsk' });
        // 零股 conditions: the 盤中零股 trades
        if (feeds.includes('odd')) wanted.set(`${code}|TickOdd`, { code, type: 'Tick', odd: true });
    }
    for (const [key, hold] of quoteHolds) {
        if (!wanted.has(key)) { hold.release?.(); quoteHolds.delete(key); }
    }
    for (const [key, { code, type, odd }] of wanted) {
        if (quoteHolds.has(key)) continue;
        const hold: { release?: () => void } = {};
        quoteHolds.set(key, hold);
        void ensureContract(code).then(contract => {
            if (quoteHolds.get(key) === hold) hold.release = pinQuote(contract, type, odd ? { oddLot: true } : undefined);
        }).catch(() => { if (quoteHolds.get(key) === hold) quoteHolds.delete(key); });
    }
}

// latest window-feed price of background codes: the 待確認 rows show it and
// arm 送出 with it (the engine re-checks against its own feed)
let prices: Record<string, number> = {};
export function getBackgroundPrices(): Record<string, number> {
    return prices;
}

const NOTICE_TEXT: Record<string, string> = {
    fired: '背景觸價單已觸發',
    needsConfirm: '背景觸價單待確認：恢復盯價時已穿價，未自動送單',
    notSent: '背景觸價單未送出',
    unknown: '背景觸價單送出結果不明（不會自動重送）',
    'session.lapsed': '背景觸價單：盤別已結束',
    expired: '背景條件單已到期或時間已過，沒有送出',
    'flatten.started': '收盤前平倉：背景執行開始全平並取消',
    'flatten.done': '收盤前平倉：背景執行全平並取消已完成',
    'flatten.failed': '收盤前平倉：背景執行沒有完成，請手動處理',
    'ledger.failed': '背景執行資料無法寫入，已停止',
    'partition.failed': '背景執行資料無法寫入，已停止',
};

const BRACKET_FIRED_TEXT: Record<string, string> = {
    fired: '背景括號單出場已觸發',
    needsConfirm: '背景括號單待確認：恢復盯價時已穿價，未自動送單',
    notSent: '背景括號單出場未送出',
    unknown: '背景括號單出場送出結果不明（不會自動重送）',
};

const INFO_NOTICES = new Set(['fired', 'needsConfirm', 'expired', 'flatten.started', 'flatten.done', 'handled', 'bracket.rearmed', 'bracket.autoRearmed', 'protectedAgain']);

let pendingInstalled = false;
function onFirstStatus() {
    // the engine answered: its 委託待確認 list is the real one
    if (!pendingInstalled) {
        pendingInstalled = true;
        installPendingConfirmBackend(createTauriPendingConfirmBackend());
    }
}

/** The engine's 全平並取消 started (`detail`: its account, codes and time
 * order): this window stops its own conditional orders in that scope, waits
 * until none of them is sending, and answers — the engine cancels and
 * closes nothing before that answer (or gives up after a while). */
async function stopWindowConditionals(detail: string): Promise<void> {
    let programId = '';
    let ok = false;
    let why = '';
    try {
        const d = JSON.parse(detail) as { programId: string;
            account: { accountType: 'F' | 'S'; brokerId: string; accountId: string }; codes: string[] | null };
        programId = d.programId;
        const account = { account_type: d.account.accountType, broker_id: d.account.brokerId, account_id: d.account.accountId };
        const { stopConditionalInScope, waitInFlight } = await import('../conditional/runtime');
        const scope = d.codes ? { type: 'code' as const, codes: d.codes, account } : { type: 'account' as const, account };
        const r = await stopConditionalInScope(scope);
        const drained = r.failed.length === 0 && await waitInFlight(scope);
        // an order that just went out may have armed new protection: stop again
        const again = drained ? await stopConditionalInScope(scope) : { stopped: 0, failed: [] as string[] };
        const failed = [...r.failed, ...again.failed];
        // an exit whose outcome is unknown may still be live at the broker: the user decides first
        const { getExits } = await import('../trigger-engine');
        const { inScope } = await import('../conditional/flatten');
        if (getExits().some(e => e.status === 'unknown' && !e.acknowledged && inScope(scope, e.account, e.orderCode))) {
            failed.push('本視窗有觸價單送出結果不明，請先核對');
        }
        ok = drained && failed.length === 0;
        why = failed.length ? failed.join('；') : drained ? '' : '本視窗有條件單仍在送單';
    } catch (e) {
        why = e instanceof Error ? e.message : String(e);
    }
    if (programId) await invoke<void>('execution_flatten_ack', { programId, ok, detail: why }).catch(() => undefined);
    if (!ok) notify({ kind: 'err', title: '收盤前平倉：本視窗的條件單沒有全部停止', body: why || '請手動處理' });
}

/** A window's 全平並取消 holds the one shared with the engine's 收盤前平倉
 * (they never read the same holdings at once). Resolves false when the
 * engine's is running; true when held (or there is no engine to share with). */
let sharedHold = false; // the engine granted it (else: no engine was running)
let holdLost = false;
export async function beginWindowFlatten(): Promise<boolean> {
    sharedHold = false;
    holdLost = false;
    if (!isTauri) return true;
    let granted: boolean;
    try {
        granted = await invoke<boolean>('execution_flatten_begin');
    } catch {
        return true; // the engine is not running: it runs none
    }
    sharedHold = granted;
    return granted;
}

/** Keep the hold while the window's 全平並取消 runs (the engine only takes
 * over a hold not renewed for two minutes). A renewal that fails or is
 * refused loses it for good: this run sends nothing more. */
export const FLATTEN_RENEW_MS = 30_000;
let renewTimer: ReturnType<typeof setInterval> | null = null;
async function renewHold(): Promise<boolean> {
    if (!sharedHold || holdLost) return !holdLost;
    try {
        if (await invoke<boolean>('execution_flatten_renew') === true) return true;
    } catch { /* unknown: not held */ }
    holdLost = true;
    return false;
}
export function keepWindowFlatten(): void {
    if (!isTauri || renewTimer) return;
    renewTimer = setInterval(() => { void renewHold(); }, FLATTEN_RENEW_MS);
}

/** Right before each cancel / close of the window's 全平並取消: still the
 * holder (renewed now)? False: stop, send nothing more. */
export async function stillHoldingFlatten(): Promise<boolean> {
    if (!isTauri) return true;
    return renewHold();
}

export async function endWindowFlatten(): Promise<void> {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    const held = sharedHold && !holdLost;
    sharedHold = false;
    if (!isTauri || !held) return;
    await invoke<void>('execution_flatten_end').catch(() => undefined);
}

// ---- risk settings for opening entries (#226) ----

/** Push at least this often while the engine may send an opening entry:
 * the App stops trusting settings it has not heard for 10 s. */
export const RISK_PUSH_MS = 2000;
let lastRisk = '';
/** The App's risk settings (kill switch / lock, per-order cap, daily loss
 * limit and the day's P&L, whether that P&L was read): on every change and
 * as a heartbeat (`force`). Main window only (the App refuses others). */
let riskQueue: Promise<void> = Promise.resolve();
export function pushBackgroundRisk(force = false): Promise<void> {
    if (!isTauri) return Promise.resolve();
    // one at a time, each reading the state when it runs: an older read can
    // never land after a newer one
    const run = riskQueue.then(() => pushRiskNow(force));
    riskQueue = run.catch(() => undefined);
    return run;
}

async function pushRiskNow(force: boolean): Promise<void> {
    // loaded on use: risk.ts reads window / localStorage when imported
    const [{ getRiskSettings }, { getTradingState }] = await Promise.all([import('../risk'), import('../trading-state')]);
    const s = getRiskSettings();
    const t = getTradingState();
    // one account's P&L: the futures account whose margin was read ("F:<broker>:<account>"),
    // its settled P&L plus the unrealized P&L of its own positions only
    const [type, brokerId, accountId] = (t.marginAccount ?? '').split(':');
    const pnlAccount = type === 'F' && brokerId && accountId ? { brokerId, accountId } : null;
    const own = (t.positions ?? []).filter(p => p.account && p.account.account_type === 'F'
        && p.account.broker_id === brokerId && p.account.account_id === accountId);
    const dailyPnl = own.reduce((sum, p) => sum + (Number(p.pnl) || 0), 0) + (Number(t.margin?.future_settle_profitloss) || 0);
    // trusted only as read: positions and margin in, nothing left to reconcile
    // (a stream outage or a failed read raises one), the stream live
    const pnlKnown = pnlAccount !== null && t.margin !== undefined && t.queries.positions.updatedAt !== null
        && !t.queries.positions.needsReconcile && !t.queries.account.needsReconcile && getStreamStatus() === 'live';
    const risk = { enabled: s.enabled, maxQty: s.maxQty, maxDailyLoss: s.maxDailyLoss, locked: s.locked,
        dailyPnl, pnlKnown, pnlAccount };
    const key = JSON.stringify(risk);
    if (!force && key === lastRisk) return;
    await invoke<void>('execution_set_risk', { risk });
    lastRisk = key;
}

/** The engine may send an opening entry: the setting is on, or one exists. */
function riskWanted(): boolean {
    return setting === true || programs.some(p => p.opens && p.status !== 'stopped');
}

let started = false;
/** Every window mirrors; the main window also keeps quotes, shows notices
 * and drops finished triggers. A no-op outside the desktop App. */
export function startBackgroundExecution(): void {
    if (started || !isTauri) return;
    started = true;
    const main = isMainWindow();
    setOrderCodeHint((id, account) => orderCodeOf(programs, id, account));
    void import('@tauri-apps/api/event').then(({ listen }) => {
        // a change between the first read and the listener being ready would
        // be missed: read again once it listens
        void listen('execution://changed', () => void refreshBackground()).then(() => refreshBackground());
        if (main) {
            void listen<Notice[]>('execution://notice', e => {
                for (const n of e.payload ?? []) {
                    // 收盤前平倉 run by the engine: this window stops its own conditional orders in scope
                    if (n.code === 'flatten.started') { void stopWindowConditionals(n.detail); continue; }
                    const owner = programs.find(p => p.id === n.programId);
                    // a panel bracket's entry level (its 觸價 entry) is no exit
                    const entryLevel = !!owner && owner.levels.some(lv => lv.id === n.levelId && lv.exit === null);
                    const bracket = (owner?.kind === 'bracket' && !entryLevel)
                        || n.code.startsWith('bracket.') || n.code === 'protectedAgain';
                    const title = bracket ? (BRACKET_NOTICE_TEXT[n.code] ?? BRACKET_FIRED_TEXT[n.code]) : NOTICE_TEXT[n.code];
                    const byFlatten = n.code === 'handled' && takeEndedByFlatten(n.programId);
                    if (title) notify({ kind: INFO_NOTICES.has(n.code) ? 'info' : 'err', title, body: noticeBody(n.code, n.detail, byFlatten) ?? '' });
                }
            });
        }
    }).catch(() => undefined);
    if (main) {
        // opening entries: the settings on change, and every 2 s as a heartbeat
        void import('../risk').then(({ subscribeRiskSettings }) => subscribeRiskSettings(() => {
            if (riskWanted()) void pushBackgroundRisk().catch(() => undefined);
        })).catch(() => undefined);
        setInterval(() => { if (riskWanted()) void pushBackgroundRisk(true).catch(() => undefined); }, RISK_PUSH_MS);
        // window-feed prices belong to one environment and a live stream
        const dropPrices = () => { if (Object.keys(prices).length) { prices = {}; emit(); } };
        onProtectionEnvChange(() => { dropPrices(); syncQuotes(); });
        subscribeStatusStore(() => { if (getStreamStatus() !== 'live') dropPrices(); });
        onAnyTick(tick => {
            if (tick.simtrade || !programs.some(p => p.binding.contract.quoteCode === tick.code
                && p.levels.some(lv => lv.phase === 'needsConfirm'))) return;
            const price = Number(tick.close);
            if (Number.isFinite(price) && price > 0 && prices[tick.code] !== price) {
                prices = { ...prices, [tick.code]: price };
                emit();
            }
        });
        // 零股 rows: the 盤中零股 trades (`<code>#odd`)
        onOddLotTick(tick => {
            if (tick.simtrade || !programs.some(p => p.binding.contract.quoteCode === tick.code
                && p.levels.some(lv => lv.phase === 'needsConfirm' && lv.entry.type === 'touch' && lv.entry.feed === 'odd'))) return;
            const price = Number(tick.close);
            const key = `${tick.code}#odd`;
            if (Number.isFinite(price) && price > 0 && prices[key] !== price) { prices = { ...prices, [key]: price }; emit(); }
        });
        // 對手價 rows: their side of the book, under the same keys as this
        // window's triggers (`<code>#bid` / `<code>#ask`)
        onAnyBidAsk(ba => {
            if (ba.simtrade || ba.intraday_odd || !programs.some(p => p.binding.contract.quoteCode === ba.code
                && p.levels.some(lv => lv.phase === 'needsConfirm' && lv.entry.type === 'touch' && lv.entry.feed))) return;
            const next = { ...prices };
            let changed = false;
            for (const [feed, raw] of [['bid', ba.bid_price?.[0]], ['ask', ba.ask_price?.[0]]] as const) {
                const price = Number(raw);
                const key = `${ba.code}#${feed}`;
                if (Number.isFinite(price) && price > 0 && next[key] !== price) { next[key] = price; changed = true; }
            }
            if (changed) { prices = next; emit(); }
        });
    }
    void refreshBackground();
}

/** Test hook: replace the Tauri invoke and reset the mirror. */
export function __setBackgroundInvokeForTest(fn: Invoke | null, opts: { desktop?: boolean } = {}): void {
    invokeImpl = fn;
    if (opts.desktop !== undefined) isTauri = opts.desktop;
    health = null;
    setting = null;
    programs = [];
    revision = -1;
    prices = {};
    pendingInstalled = false;
    swept.clear();
    epoch = 0;
    lastRisk = '';
    riskQueue = Promise.resolve();
}
