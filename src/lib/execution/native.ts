// src/lib/execution/native.ts — client of the native execution engine
// (#201, desktop only, EXPERIMENTAL opt-in, default off).
//
// The engine runs in the App's native process (Tauri): it owns the sidecar
// connection, sends and reconciles orders itself, and keeps running while
// any webview reloads. This module only:
// - holds the 「原生執行引擎（實驗）」 toggle (off by default; the web build
//   never turns it on) and tells the host;
// - mirrors the native programs for display (every window) from
//   `execution_programs`, refreshed on `execution://changed`;
// - sends versioned user commands (`execution_command`, schema execution-v1);
// - in the main window: keeps the quote feed of native programs retained
//   (so closing a chart never unsubscribes a protected symbol) and drops
//   finished trigger programs from the native store.

import { useSyncExternalStore } from 'react';
import { ensureContract } from '../contracts-cache';
import { isMainWindow } from '../main-window-commands';
import { currentProtectionEnv, onProtectionEnvChange } from '../protection-env';
import { retainQuote } from '../quote-ownership';
import { notify } from '../trade';
import { envKeyOf } from './adapter';
import { EXECUTION_SCHEMA_VERSION, type Notice, type OrderProgram, type UserCommand } from './model';
import { programFinished } from './native-view';

export const NATIVE_TOGGLE_KEY = 'sj-pro-native-execution';

// Same detection as runtime.ts `isTauri`, evaluated here so that this module
// stays importable from tests that mock runtime.ts partially.
let isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface NativeHealth {
    enabled: boolean;
    state: 'idle' | 'connecting' | 'live' | 'down' | 'failed';
    env: 'simulation' | 'production' | null;
    serverId: string | null;
    lastError: string | null;
    partitionErrors: string[];
    /** Watched quotes without a tick for a while (the engine resubscribes them). */
    staleQuotes?: string[];
    programs: number;
    activePrograms?: number;
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
    lastPrices: Record<string, number>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invokeImpl: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!invokeImpl) invokeImpl = (await import('@tauri-apps/api/core')).invoke as Invoke;
    return invokeImpl<T>(cmd, args);
}

// ---- toggle ----

function readToggle(): boolean {
    try { return globalThis.localStorage?.getItem(NATIVE_TOGGLE_KEY) === '1'; } catch { return false; }
}

let enabled = readToggle();
const toggleListeners = new Set<() => void>();

/** The desktop App can run the native engine; the web build never does. */
export function nativeExecutionSupported(): boolean {
    return isTauri;
}

export function getNativeExecutionEnabled(): boolean {
    return isTauri && enabled;
}

/** New triggers / brackets are created as native programs (the ownership
 * decision; existing TS-run ones keep running in TS until they finish). */
export function nativeOwnsNew(): boolean {
    return getNativeExecutionEnabled();
}

export function setNativeExecutionEnabled(on: boolean): void {
    if (!isTauri) return;
    enabled = on;
    try { globalThis.localStorage?.setItem(NATIVE_TOGGLE_KEY, on ? '1' : '0'); } catch { /* session only */ }
    toggleListeners.forEach(l => l());
    if (isMainWindow()) void syncToggle();
}

async function syncToggle() {
    try {
        health = await invoke<NativeHealth>('execution_set_enabled', { enabled: getNativeExecutionEnabled() });
        emit();
    } catch (e) {
        notify({ kind: 'err', title: '原生執行引擎', body: e instanceof Error ? e.message : String(e) });
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener?.('storage', e => {
        if (e.key !== NATIVE_TOGGLE_KEY) return;
        enabled = readToggle();
        toggleListeners.forEach(l => l());
    });
}

export function useNativeExecutionEnabled(): boolean {
    return useSyncExternalStore(l => { toggleListeners.add(l); return () => { toggleListeners.delete(l); }; },
        getNativeExecutionEnabled);
}

// ---- mirrored programs ----

let programs: OrderProgram[] = [];
let lastPrices: Record<string, number> = {};
let health: NativeHealth | null = null;
let revision = 0;
const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }

export function getNativePrograms(): OrderProgram[] {
    return programs;
}

export function getNativeLastPrices(): Record<string, number> {
    return lastPrices;
}

export function getNativeHealth(): NativeHealth | null {
    return health;
}

export function subscribeNative(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function useNativePrograms(): OrderProgram[] {
    return useSyncExternalStore(subscribeNative, getNativePrograms);
}

export function useNativeHealth(): NativeHealth | null {
    return useSyncExternalStore(subscribeNative, getNativeHealth);
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
export function refreshNative(): Promise<void> {
    if (!isTauri) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
        try {
            const [view, h] = await Promise.all([
                invoke<ProgramsView>('execution_programs'),
                invoke<NativeHealth>('execution_status'),
            ]);
            if (view.revision !== revision || JSON.stringify(h) !== JSON.stringify(health)) {
                revision = view.revision;
                programs = view.programs;
                lastPrices = view.lastPrices ?? {};
                health = h;
                emit();
                if (isMainWindow()) { housekeeping(); syncQuotes(); }
            }
        } catch {
            // host not ready (engine failed to open): health stays null
        }
    })().finally(() => {
        refreshing = null;
        if (refreshAgain) { refreshAgain = false; void refreshNative(); }
    });
    return refreshing;
}

// ---- commands ----

const REJECT_TEXT: Record<string, string> = {
    'rejected.envMismatch': '原生引擎目前連線的伺服器／模式與此單不同',
    'rejected.unknownEnv': '原生引擎尚未連上伺服器（模式未確認）',
    'rejected.staleVersion': '狀態已變更，請再試一次',
    'rejected.duplicateProgram': '此單已建立',
    'rejected.hasOrdersOrPosition': '仍有委託或部位，先停止並等待結束',
    'rejected.unpast': '目前已未穿價，需要再確認',
    'rejected.noPrice': '尚未收到即時成交價',
    'partition.failed': '原生引擎儲存失敗，已停止此環境的執行',
};

function rejection(reply: CommandReply): string {
    const bad = reply.notices.find(n => n.code.startsWith('rejected.') || n.code === 'partition.failed');
    return bad ? (REJECT_TEXT[bad.code] ?? `${bad.code} ${bad.detail}`) : '原生引擎未接受此指令';
}

let seq = 0;
/** Programs a remove is in flight for (user or housekeeping). */
const removing = new Set<string>();
export async function sendNativeCommand(command: UserCommand): Promise<CommandReply> {
    if (!isTauri) throw new Error('原生執行引擎僅限桌面版');
    const id = `ui-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const reply = await invoke<CommandReply>('execution_command', { envelope: { schema: EXECUTION_SCHEMA_VERSION, id, command } });
    await refreshNative();
    if (!reply.accepted) throw new Error(rejection(reply));
    return reply;
}

export async function createNativeProgram(program: OrderProgram): Promise<void> {
    await sendNativeCommand({ op: 'create', program });
}

function findProgram(id: string): OrderProgram | undefined {
    return programs.find(p => p.id === id);
}

/** Stop a program (cancels what it has working) and drop it once nothing
 * is left; a program with a position / unknown order stays until resolved. */
export async function removeNativeProgram(programId: string): Promise<void> {
    removing.add(programId); // housekeeping leaves it to this call
    try {
        await refreshNative();
        let p = findProgram(programId);
        if (!p) return;
        if (p.status !== 'stopped' && p.status !== 'stopping') {
            await sendNativeCommand({ op: 'stop', programId, version: p.version });
            p = findProgram(programId);
            if (!p) return;
        }
        if (programFinished(p)) await sendNativeCommand({ op: 'remove', programId, version: p.version });
    } finally {
        removing.delete(programId);
    }
}

export async function resolveNativePending(programId: string, levelId: string, choice: 'send' | 'cancel' | 'keep',
    allowUnpast?: boolean): Promise<void> {
    await refreshNative();
    const p = findProgram(programId);
    if (!p) throw new Error('找不到此原生單');
    await sendNativeCommand({ op: 'resolvePending', programId, version: p.version, levelId, choice,
        ...(allowUnpast ? { allowUnpast: true } : {}) });
}

export async function acknowledgeNativeUnknown(programId: string, levelId: string): Promise<void> {
    await refreshNative();
    const p = findProgram(programId);
    if (!p) throw new Error('找不到此原生單');
    await sendNativeCommand({ op: 'ackUnknown', programId, version: p.version, levelId });
}

/** Before an entry is sent with a native bracket: the engine must be live
 * on exactly the environment the order goes to. */
export function ensureNativeHost(env: string | null): void {
    const h = health;
    if (!h || h.state !== 'live' || !h.env || !h.serverId) throw new Error('原生執行引擎尚未連上伺服器，括號單未送出');
    if (!env || `${h.serverId}|${h.env}` !== env) throw new Error('原生執行引擎連線的伺服器／模式與目前不同，括號單未送出');
}

// ---- main window upkeep ----

/** Finished trigger programs leave the native store (brackets stay until the
 * user closes them in the bracket panel, like the TS plans). */
function housekeeping() {
    for (const p of programs) {
        if (p.kind !== 'trigger' || !programFinished(p) || removing.has(p.id)) continue;
        removing.add(p.id);
        void sendNativeCommand({ op: 'remove', programId: p.id, version: p.version })
            .catch(() => undefined).finally(() => removing.delete(p.id));
    }
}

const quoteHolds = new Map<string, { release?: () => void }>();
/** Keep the Tick feed of native programs of the current environment
 * retained by this window's quote ownership (the engine subscribes it too). */
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
            if (quoteHolds.get(code) === hold) hold.release = retainQuote(contract, 'Tick');
        }).catch(() => { if (quoteHolds.get(code) === hold) quoteHolds.delete(code); });
    }
}

const NOTICE_TEXT: Record<string, string> = {
    needsConfirm: '原生觸價單待確認：恢復盯價時已穿價，未自動送單',
    notSent: '原生委託未送出',
    unknown: '原生委託結果未知（不會自動重送）',
    'partition.failed': '原生執行引擎儲存失敗，此環境已停止執行',
};

let started = false;
/** Every window mirrors; the main window also syncs the toggle to the host. */
export function startNativeExecution(): void {
    if (started || !isTauri) return;
    started = true;
    void import('@tauri-apps/api/event').then(({ listen }) => {
        void listen('execution://changed', () => void refreshNative());
        if (isMainWindow()) {
            void listen<Notice[]>('execution://notice', e => {
                for (const n of e.payload ?? []) {
                    const title = NOTICE_TEXT[n.code];
                    if (title) notify({ kind: n.code === 'needsConfirm' ? 'info' : 'err', title, body: n.detail });
                }
            });
        }
    }).catch(() => undefined);
    if (isMainWindow()) {
        void syncToggle().then(() => refreshNative());
        onProtectionEnvChange(() => syncQuotes());
    } else {
        void refreshNative();
    }
}

/** Test hook: replace the Tauri invoke and reset the mirror. */
export function __setNativeInvokeForTest(fn: Invoke | null, opts: { enabled?: boolean; desktop?: boolean } = {}): void {
    invokeImpl = fn;
    if (opts.desktop !== undefined) isTauri = opts.desktop;
    programs = [];
    lastPrices = {};
    health = null;
    revision = 0;
    if (opts.enabled !== undefined) enabled = opts.enabled;
}
