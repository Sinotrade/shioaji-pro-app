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
import { ensureContract } from '../contracts-cache';
import { isMainWindow } from '../main-window-commands';
import { currentProtectionEnv, onProtectionEnvChange } from '../protection-env';
import { pinQuote } from '../quote-ownership';
import { getStreamStatus, onAnyTick, subscribeStatusStore } from '../stream';
import { notify } from '../trade';
import { envKeyOf } from './adapter';
import { programFinished } from './background-view';
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
let programs: OrderProgram[] = [];
let revision = -1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function backgroundSupported(): boolean {
    return isTauri;
}

/** New futures / options stop and take triggers run in the background. */
export function getBackgroundEnabled(): boolean {
    return isTauri && health?.enabled === true;
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

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let epoch = 0; // bumps when the setting changes: older reads are not adopted
/** Re-read status and programs (coalesced). */
export function refreshBackground(): Promise<void> {
    if (!isTauri) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    const started = epoch;
    refreshing = (async () => {
        try {
            const [view, h] = await Promise.all([
                invoke<ProgramsView>('execution_programs'),
                invoke<BackgroundHealth>('execution_status'),
            ]);
            if (started !== epoch) { refreshAgain = true; return; }
            const first = health === null;
            if (view.revision !== revision || JSON.stringify(h) !== JSON.stringify(health)) {
                revision = view.revision;
                programs = view.programs;
                health = h;
                emit();
            }
            if (isMainWindow()) { housekeeping(); syncQuotes(); }
            if (first) onFirstStatus();
        } catch {
            // the engine did not start: no background, the window's own engine only
        }
    })().finally(() => {
        refreshing = null;
        if (refreshAgain) { refreshAgain = false; void refreshBackground(); }
    });
    return refreshing;
}

/** Refreshed until no read is in flight (every read started after now). */
async function settled(): Promise<void> {
    await refreshBackground();
    while (refreshing) await refreshing;
}

/** Status known (read once if not yet): the setting decides who owns a new trigger. */
export async function ensureBackgroundStatus(): Promise<void> {
    if (isTauri && !health) await settled();
}

// ---- setting ----

/** Main window only (the App refuses other windows). */
export async function setBackgroundEnabled(on: boolean): Promise<void> {
    if (!isTauri) throw new Error('背景持續執行僅限桌面版');
    epoch += 1;
    health = await invoke<BackgroundHealth>('execution_set_enabled', { enabled: on });
    epoch += 1;
    emit();
    await settled();
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
    'partition.failed': '背景執行資料無法寫入，這個環境已停止，請重新啟動 App',
};

/** The App answered and refused: nothing was created / changed. */
export class BackgroundRefusal extends Error {}

function rejection(reply: CommandReply): string {
    const bad = reply.notices.find(n => n.code.startsWith('rejected.') || n.code === 'partition.failed');
    return bad ? (REJECT_TEXT[bad.code] ?? `背景執行未接受（${bad.code}）`) : '背景執行未接受';
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

// ---- main window upkeep ----

const removing = new Set<string>();
const swept = new Map<string, number>(); // program id → version already tried
/** Finished background triggers leave the engine's store (once per
 * version: a refused remove is not retried until the program changes; the
 * engine's change event refreshes the list). */
function housekeeping() {
    for (const p of programs) {
        if (p.kind !== 'trigger' || !programFinished(p) || removing.has(p.id) || swept.get(p.id) === p.version) continue;
        swept.set(p.id, p.version);
        // a failed request is tried again on the next refresh
        void invoke<CommandReply>('execution_remove', { programId: p.id }).catch(() => { swept.delete(p.id); });
    }
}

const quoteHolds = new Map<string, { release?: () => void }>();
/** Keep the tick feed of the current environment's background triggers
 * retained by this window (the engine subscribes it too). */
function syncQuotes() {
    const env = currentProtectionEnv();
    const codes = new Set(programs.filter(p => p.status !== 'stopped' && envKeyOf(p.binding) === env)
        .map(p => p.binding.contract.quoteCode));
    for (const [code, hold] of quoteHolds) {
        if (!codes.has(code)) { hold.release?.(); quoteHolds.delete(code); }
    }
    for (const code of codes) {
        if (quoteHolds.has(code)) continue;
        const hold: { release?: () => void } = {};
        quoteHolds.set(code, hold);
        void ensureContract(code).then(contract => {
            if (quoteHolds.get(code) === hold) hold.release = pinQuote(contract, 'Tick');
        }).catch(() => { if (quoteHolds.get(code) === hold) quoteHolds.delete(code); });
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
    'ledger.failed': '背景執行資料無法寫入，已停止',
    'partition.failed': '背景執行資料無法寫入，已停止',
};

let pendingInstalled = false;
function onFirstStatus() {
    // the engine answered: its 委託待確認 list is the real one
    if (!pendingInstalled) {
        pendingInstalled = true;
        installPendingConfirmBackend(createTauriPendingConfirmBackend());
    }
}

let started = false;
/** Every window mirrors; the main window also keeps quotes, shows notices
 * and drops finished triggers. A no-op outside the desktop App. */
export function startBackgroundExecution(): void {
    if (started || !isTauri) return;
    started = true;
    const main = isMainWindow();
    void import('@tauri-apps/api/event').then(({ listen }) => {
        // a change between the first read and the listener being ready would
        // be missed: read again once it listens
        void listen('execution://changed', () => void refreshBackground()).then(() => refreshBackground());
        if (main) {
            void listen<Notice[]>('execution://notice', e => {
                for (const n of e.payload ?? []) {
                    const title = NOTICE_TEXT[n.code];
                    if (title) notify({ kind: n.code === 'fired' || n.code === 'needsConfirm' ? 'info' : 'err', title, body: n.detail });
                }
            });
        }
    }).catch(() => undefined);
    if (main) {
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
    }
    void refreshBackground();
}

/** Test hook: replace the Tauri invoke and reset the mirror. */
export function __setBackgroundInvokeForTest(fn: Invoke | null, opts: { desktop?: boolean } = {}): void {
    invokeImpl = fn;
    if (opts.desktop !== undefined) isTauri = opts.desktop;
    health = null;
    programs = [];
    revision = -1;
    prices = {};
    pendingInstalled = false;
    swept.clear();
    epoch = 0;
}
