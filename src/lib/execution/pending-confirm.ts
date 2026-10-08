// src/lib/execution/pending-confirm.ts — 委託待確認 state (#201 ③, A 方案).
// Reads the background engine's pending-confirm list through a pluggable
// backend, notifies once per new item and forwards the user's decision.
// Nothing here places, resends or cancels a broker order.
//
// No backend is installed by default, so today's trigger / bracket paths are
// untouched. ①-3 installs `createTauriPendingConfirmBackend()` once the Rust
// commands exist; dev builds can install the mock (see main.tsx).

import { useSyncExternalStore } from 'react';
import { isMainWindow } from '../main-window-commands';
import { notify } from '../trade';
import {
    PENDING_CONFIRM_CHANGED_EVENT,
    PENDING_CONFIRM_COMMAND,
    parsePendingConfirmSnapshot,
    parseResolvePendingResult,
    resolutionAllowed,
    type PendingConfirmItem,
    type PendingConfirmSnapshot,
    type PendingResolution,
    type ResolvePendingRefusal,
    type ResolvePendingRequest,
    type ResolvePendingResult,
} from './pending-confirm-contract';

/** Raw transport; payloads are validated here, not trusted. */
export interface PendingConfirmBackend {
    list(): Promise<unknown>;
    resolve(request: ResolvePendingRequest): Promise<unknown>;
    /** Calls back when the engine's list changed; returns an unsubscribe. */
    subscribe?(onChanged: () => void): () => void;
}

export interface PendingConfirmState {
    snapshot: PendingConfirmSnapshot | null; // last valid list
    error: string | null; // last read failed (the old list stays visible)
    loading: boolean;
}

const EMPTY: PendingConfirmState = { snapshot: null, error: null, loading: false };
let state: PendingConfirmState = EMPTY;
let backend: PendingConfirmBackend | null = null;
let unsubscribe: (() => void) | null = null;
let seq = 0; // newest request wins; a slow older read never overwrites it
const seen = new Set<string>(); // `${id}:${state}` already notified
const listeners = new Set<() => void>();

function set(next: Partial<PendingConfirmState>) {
    state = { ...state, ...next };
    listeners.forEach(l => l());
}

const side = (i: PendingConfirmItem) => `${i.order.action === 'Buy' ? '買進' : '賣出'} ${i.order.quantity} 口`;

function announce(snapshot: PendingConfirmSnapshot) {
    if (!isMainWindow()) return; // popouts only mirror; the main window speaks once
    for (const item of snapshot.items) {
        const key = `${item.id}:${item.state}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.state === 'needsConfirm') {
            notify({ kind: 'err', title: '委託待確認', body: `${item.order.code} ${side(item)} 送出結果不明，請到待確認卡核對（不會自動重送）` });
        } else {
            notify({ kind: 'info', title: '委託已失效', body: `${item.order.code} ${side(item)} 盤別已更換，委託已失效；請核對當時是否已成交` });
        }
    }
}

function adopt(snapshot: PendingConfirmSnapshot) {
    announce(snapshot);
    set({ snapshot, error: null, loading: false });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function refreshPendingConfirm(): Promise<void> {
    const b = backend;
    if (!b) return;
    const mine = ++seq;
    set({ loading: true });
    try {
        const snapshot = parsePendingConfirmSnapshot(await b.list());
        if (mine === seq && b === backend) adopt(snapshot);
    } catch (e) {
        if (mine !== seq || b !== backend) return;
        const error = `待確認清單讀取失敗：${message(e)}`;
        if (state.error !== error && isMainWindow()) notify({ kind: 'err', title: '委託待確認', body: error });
        set({ error, loading: false });
    }
}

const REFUSAL_TEXT: Record<ResolvePendingRefusal, string> = {
    notFound: '這筆已不在待確認清單（可能已在其他地方處理）',
    stale: '待確認狀態已更新，請重新核對後再確認',
    invalidForState: '這筆目前不能這樣處理，請重新核對',
    windowNotAllowed: '只能在主視窗處理待確認委託',
};

/** Records the user's decision. Throws (with a user-facing message) when it
 * was not applied; the card then stays. */
export async function resolvePendingConfirm(item: PendingConfirmItem, resolution: PendingResolution): Promise<void> {
    if (!isMainWindow()) throw new Error(REFUSAL_TEXT.windowNotAllowed);
    if (!resolutionAllowed(item.state, resolution)) throw new Error(REFUSAL_TEXT.invalidForState);
    const b = backend;
    if (!b) throw new Error('背景執行尚未啟用，無法處理待確認委託');
    const mine = ++seq;
    let result: ResolvePendingResult;
    try {
        result = parseResolvePendingResult(await b.resolve({ id: item.id, revision: item.revision, resolution }));
    } catch (e) {
        // outcome unknown: re-read so the card shows what the engine has
        void refreshPendingConfirm();
        throw new Error(`處理結果未確認：${message(e)}`);
    }
    if (mine === seq && b === backend) adopt(result.snapshot);
    if (!result.ok) throw new Error(REFUSAL_TEXT[result.reason]);
}

/** Installs the transport and loads the list. Returns an uninstall. */
export function installPendingConfirmBackend(next: PendingConfirmBackend): () => void {
    unsubscribe?.();
    unsubscribe = null;
    backend = next;
    seq++;
    set(EMPTY);
    unsubscribe = next.subscribe?.(() => void refreshPendingConfirm()) ?? null;
    void refreshPendingConfirm();
    return () => {
        if (backend !== next) return;
        unsubscribe?.();
        unsubscribe = null;
        backend = null;
        seq++;
        set(EMPTY);
    };
}

export function getPendingConfirmState(): PendingConfirmState {
    return state;
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function usePendingConfirm(): PendingConfirmState {
    return useSyncExternalStore(subscribe, getPendingConfirmState, getPendingConfirmState);
}

export function resetPendingConfirmForTest() {
    unsubscribe?.();
    unsubscribe = null;
    backend = null;
    seq++;
    seen.clear();
    state = EMPTY;
}

// ---- backends ----

/** The real transport (①-3 implements the Rust side of the contract). */
export function createTauriPendingConfirmBackend(): PendingConfirmBackend {
    return {
        async list() {
            const { invoke } = await import('@tauri-apps/api/core');
            return invoke(PENDING_CONFIRM_COMMAND.list);
        },
        async resolve(request) {
            const { invoke } = await import('@tauri-apps/api/core');
            return invoke(PENDING_CONFIRM_COMMAND.resolve, { request });
        },
        subscribe(onChanged) {
            let stop: (() => void) | null = null;
            let closed = false;
            void import('@tauri-apps/api/event')
                .then(({ listen }) => listen(PENDING_CONFIRM_CHANGED_EVENT, () => onChanged()))
                .then(un => { if (closed) un(); else stop = un; })
                .catch(() => undefined);
            return () => { closed = true; stop?.(); };
        },
    };
}

export interface MockPendingConfirmBackend extends PendingConfirmBackend {
    /** Swap the engine-side list (tests / dev preview) and signal a change. */
    replace(snapshot: PendingConfirmSnapshot): void;
}

/** In-memory stand-in with the backend's resolve rules. It never sends. */
export function createMockPendingConfirmBackend(initial: PendingConfirmSnapshot): MockPendingConfirmBackend {
    let current = structuredClone(initial);
    const changed = new Set<() => void>();
    const copy = () => structuredClone(current);
    return {
        async list() { return copy(); },
        async resolve({ id, revision, resolution }) {
            const item = current.items.find(i => i.id === id);
            if (!item) return { ok: false, reason: 'notFound', snapshot: copy() };
            if (item.revision !== revision) return { ok: false, reason: 'stale', snapshot: copy() };
            if (!resolutionAllowed(item.state, resolution)) return { ok: false, reason: 'invalidForState', snapshot: copy() };
            // the result carries the fresh list; no change event needed
            current = { ...current, items: current.items.filter(i => i.id !== id) };
            return { ok: true, snapshot: copy() };
        },
        subscribe(onChanged) {
            changed.add(onChanged);
            return () => { changed.delete(onChanged); };
        },
        replace(snapshot) {
            current = structuredClone(snapshot);
            changed.forEach(l => l());
        },
    };
}
