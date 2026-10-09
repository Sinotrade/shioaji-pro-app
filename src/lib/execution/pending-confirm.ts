// src/lib/execution/pending-confirm.ts — 委託待確認 state (#201 ③, A 方案).
// Reads the background engine's pending-confirm list through a pluggable
// backend, notifies once per new item and forwards the user's decision.
// Nothing here places, resends or cancels a broker order.
//
// No backend is installed by default, so today's trigger / bracket paths are
// untouched. ①-3 installs `createTauriPendingConfirmBackend()` once the Rust
// commands exist; dev builds can install the mock (see main.tsx).

import { useSyncExternalStore } from 'react';
import { notify } from '../trade';
import { isChildWindow } from '../window-role';
import {
    PENDING_CONFIRM_CHANGED_EVENT,
    PENDING_CONFIRM_COMMAND,
    parsePendingConfirmSnapshot,
    parseResolvePendingResult,
    resolutionAllowed,
    UNIT_LABEL,
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
    /** Calls back when the engine's list changed (and once when listening
     * starts); `onError` when listening failed. Returns an unsubscribe. */
    subscribe?(onChanged: () => void, onError?: (e: unknown) => void): () => void;
}

export interface PendingConfirmState {
    snapshot: PendingConfirmSnapshot | null; // last valid list
    error: string | null; // last read failed (the old list stays visible)
    /** listening for changes failed: the list will not update by itself */
    subscriptionError: string | null;
    loading: boolean;
    /** bumps per installed backend: decisions never carry across transports */
    generation: number;
}

let generation = 0;
const empty = (): PendingConfirmState => ({ snapshot: null, error: null, subscriptionError: null, loading: false, generation });
let state: PendingConfirmState = empty();
let backend: PendingConfirmBackend | null = null;
let unsubscribe: (() => void) | null = null;
let adoptions = 0; // bumps on every adopted snapshot
let tickets = 0; // request order: every list / resolve takes the next ticket
let adoptedTicket = 0; // ticket of the request whose snapshot is shown
const retiredRuns = new Set<string>(); // engine runs a newer run replaced
const seen = new Set<string>(); // `${id}:${state}` already notified (per backend)
const listeners = new Set<() => void>();

function set(next: Partial<PendingConfirmState>) {
    state = { ...state, ...next };
    listeners.forEach(l => l());
}

/** Only the main window resolves and announces; popouts mirror. Uses the
 * native window label too, not only `?popout`. */
const isMain = () => !isChildWindow();

const side = (i: PendingConfirmItem) =>
    `${i.order.action === 'Buy' ? '買進' : '賣出'} ${i.order.quantity} ${UNIT_LABEL[i.order.quantityUnit]}`;

function announce(snapshot: PendingConfirmSnapshot) {
    if (!isMain()) return; // popouts only mirror; the main window speaks once
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

/** Adopts `snapshot` (answer to request `ticket`) unless it is older than
 * what is shown. Same engine run: by sequence. Another run: only when the
 * request started after the one that is shown (a late answer from an older
 * request never brings an old run back), and never a run already replaced. */
function adopt(snapshot: PendingConfirmSnapshot, ticket: number): boolean {
    const cur = state.snapshot;
    if (retiredRuns.has(snapshot.runId)) return false;
    if (cur && cur.runId === snapshot.runId) {
        if (snapshot.sequence < cur.sequence) return false;
    } else if (cur && ticket < adoptedTicket) {
        return false;
    }
    if (cur && cur.runId !== snapshot.runId) retiredRuns.add(cur.runId);
    adoptedTicket = Math.max(adoptedTicket, ticket);
    adoptions += 1;
    announce(snapshot);
    set({ snapshot, error: null, loading: false });
    return true;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function refreshPendingConfirm(): Promise<void> {
    const b = backend;
    if (!b) return;
    const gen = generation;
    const ticket = ++tickets;
    const since = adoptions;
    set({ loading: true });
    try {
        const snapshot = parsePendingConfirmSnapshot(await b.list());
        if (gen !== generation) return;
        if (!adopt(snapshot, ticket)) set({ loading: false });
    } catch (e) {
        // a newer list already arrived, or the transport changed: stale error
        if (gen !== generation || adoptions !== since) return;
        const error = `待確認清單讀取失敗：${message(e)}`;
        if (state.error !== error && isMain()) notify({ kind: 'err', title: '委託待確認', body: error });
        set({ error, loading: false });
    }
}

const REFUSAL_TEXT: Record<ResolvePendingRefusal, string> = {
    notFound: '這筆已不在待確認清單（可能已在其他地方處理）',
    stale: '待確認狀態已更新，請重新核對後再確認',
    invalidForState: '這筆目前不能這樣處理，請重新核對',
    windowNotAllowed: '只能在主視窗處理待確認委託',
    notEnabled: '「背景持續執行」沒有開啟，無法重新啟用；請先在設定開啟',
    invalidRequest: '口數不正確，請重新輸入',
    rearmFailed: '背景執行沒有接受新的觸價單（可能尚未連線），這筆仍保留，請稍後再試',
};

/** Records the user's decision. Throws (with a user-facing message) when it
 * was not applied; the card then stays. */
export async function resolvePendingConfirm(item: PendingConfirmItem, resolution: PendingResolution,
    opts: { quantity?: number } = {}): Promise<void> {
    if (!isMain()) throw new Error(REFUSAL_TEXT.windowNotAllowed);
    if (!resolutionAllowed(item.state, resolution)) throw new Error(REFUSAL_TEXT.invalidForState);
    const rearm = resolution === 'rearmInNewSession';
    if (rearm && (state.snapshot?.version ?? 1) < 2) throw new Error('背景執行版本不支援重新啟用，請更新 App');
    if (rearm && !(Number.isSafeInteger(opts.quantity) && opts.quantity! > 0)) throw new Error(REFUSAL_TEXT.invalidRequest);
    // only the item as currently shown (same transport, same list) may be
    // decided; anything else is a stale card
    if (!state.snapshot?.items.includes(item)) throw new Error(REFUSAL_TEXT.stale);
    const b = backend;
    if (!b) throw new Error('背景執行尚未啟用，無法處理待確認委託');
    const gen = generation;
    const ticket = ++tickets;
    let result: ResolvePendingResult;
    try {
        result = parseResolvePendingResult(await b.resolve({ id: item.id, revision: item.revision, resolution,
            ...(rearm ? { quantity: opts.quantity } : {}) }));
    } catch (e) {
        // outcome unknown: re-read so the card shows what the engine has
        void refreshPendingConfirm();
        throw new Error(`處理結果未確認：${message(e)}`);
    }
    if (gen !== generation) {
        // the transport was replaced meanwhile: do not report success
        void refreshPendingConfirm();
        throw new Error('處理結果未確認：背景執行已重新連線，請重新核對');
    }
    if (!adopt(result.snapshot, ticket)) {
        // the answer is older than what is shown: cannot tell it applied
        void refreshPendingConfirm();
        throw new Error('處理結果未確認：清單已更新，請重新核對');
    }
    if (!result.ok) throw new Error(REFUSAL_TEXT[result.reason]);
}

/** Installs the transport and loads the list. Returns an uninstall. */
export function installPendingConfirmBackend(next: PendingConfirmBackend): () => void {
    unsubscribe?.();
    unsubscribe = null;
    backend = next;
    generation += 1;
    seen.clear();
    retiredRuns.clear();
    adoptedTicket = 0;
    set(empty());
    const gen = generation;
    unsubscribe = next.subscribe?.(
        () => { if (gen === generation) void refreshPendingConfirm(); },
        e => {
            if (gen !== generation) return;
            set({ subscriptionError: `待確認清單不會自動更新（監聽失敗：${message(e)}），請按重新整理或重新開啟 App` });
        },
    ) ?? null;
    void refreshPendingConfirm();
    return () => {
        if (gen !== generation) return;
        unsubscribe?.();
        unsubscribe = null;
        backend = null;
        generation += 1;
        set(empty());
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
    seen.clear();
    retiredRuns.clear();
    adoptedTicket = 0;
    generation += 1;
    state = empty();
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
        subscribe(onChanged, onError) {
            let stop: (() => void) | null = null;
            let closed = false;
            void import('@tauri-apps/api/event')
                .then(({ listen }) => listen(PENDING_CONFIRM_CHANGED_EVENT, () => onChanged()))
                .then(un => {
                    if (closed) { un(); return; }
                    stop = un;
                    // changes between the first list and the listener being
                    // ready would be missed: re-list once it is listening
                    onChanged();
                })
                .catch(e => { if (!closed) onError?.(e); });
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
            current = { ...current, sequence: current.sequence + 1, items: current.items.filter(i => i.id !== id) };
            return { ok: true, snapshot: copy() };
        },
        subscribe(onChanged) {
            changed.add(onChanged);
            return () => { changed.delete(onChanged); };
        },
        replace(snapshot) {
            // keeps the contract: a replacement within the run moves forward
            current = structuredClone(snapshot.runId === current.runId && snapshot.sequence <= current.sequence
                ? { ...snapshot, sequence: current.sequence + 1 } : snapshot);
            changed.forEach(l => l());
        },
    };
}
