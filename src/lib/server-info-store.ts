import { useSyncExternalStore } from 'react';
import { getApiBase } from './runtime';
import type { ServerInfo } from './shioaji';

// Observe existing info requests; displaying compatibility notices must not
// create another polling loop or account query.
//
// Requests are ordered per API base: a response (success or failure) that
// settles after a newer request for the same base has already been applied
// is dropped, so a slow first /info call cannot overwrite fresher info and a
// late failure cannot blank a newer success. Responses for a base that is no
// longer current are ignored (server switch isolation).
export interface ServerInfoRequest {
    readonly base: string;
    readonly sequence: number;
}

const infos = new Map<string, ServerInfo>();
const applied = new Map<string, number>();
const listeners = new Set<() => void>();
let sequence = 0;
let modeVersion = 0;
let activeBase: string | undefined;
let channel: BroadcastChannel | null = null;

// Reuse the existing account-state broadcast transport. A long-lived popout
// must retire its /info requests even when the main reloads on the same port.
function syncBase() {
    const base = getApiBase();
    if (activeBase === base) return base;
    if (activeBase !== undefined) {
        modeVersion += 1;
        channel?.postMessage({ kind: 'server-info-invalidated', base: activeBase });
        sequence += 1;
        infos.clear();
        applied.clear();
        applied.set(base, sequence);
    }
    channel?.close();
    activeBase = base;
    channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`sj-trading-state:${base}`);
    channel?.addEventListener('message', event => {
        if (event.data?.kind === 'server-info-invalidated' && event.data.base === base && base === getApiBase()) {
            invalidate(base);
        }
    });
    return base;
}

function invalidate(base: string) {
    modeVersion += 1;
    sequence += 1;
    applied.set(base, sequence);
    infos.delete(base);
    for (const listener of listeners) listener();
}

export function beginServerInfoRequest(): ServerInfoRequest {
    const base = syncBase();
    sequence += 1;
    return { base, sequence };
}

export function observeServerInfo(request: ServerInfoRequest, info: ServerInfo | undefined) {
    const { base } = request;
    if (base !== syncBase()) return;
    if ((applied.get(base) ?? 0) > request.sequence) return;
    if (infos.get(base)?.simulation !== info?.simulation
        || infos.get(base)?.instance_id !== info?.instance_id) modeVersion += 1;
    applied.set(base, request.sequence);
    if (info) infos.set(base, info);
    else infos.delete(base);
    for (const listener of listeners) listener();
}

/** Drop what is known for `base` (e.g. the stream went down: the sidecar may
 * be restarting in another mode on the same port). Responses to requests
 * started before this are ignored; only a fresh /info repopulates it. */
export function forgetServerInfo(base: string) {
    syncBase();
    // Publish even if this freshly reloaded main has no local cache yet.
    channel?.postMessage({ kind: 'server-info-invalidated', base });
    invalidate(base);
}

function forgetCurrentServerInfo() { forgetServerInfo(syncBase()); }
function onStorage(event: StorageEvent) {
    if (event.key === 'sj-pro-api-port' || event.key === 'sj-pro-api-scheme') forgetCurrentServerInfo();
}
if (typeof window !== 'undefined') {
    window.addEventListener('sj-pro-api-base-changed', forgetCurrentServerInfo);
    window.addEventListener('storage', onStorage);
}
import.meta.hot?.dispose(() => {
    channel?.close();
    if (typeof window !== 'undefined') {
        window.removeEventListener('sj-pro-api-base-changed', forgetCurrentServerInfo);
        window.removeEventListener('storage', onStorage);
    }
});

// Hoisted so useSyncExternalStore keeps one subscription per component instead
// of re-subscribing on every render.
export function subscribeServerInfo(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function currentServerInfo() { return infos.get(syncBase()); }
/** Last /info observed for the current API base, without a new request. */
export const knownServerInfo = currentServerInfo;

/** Changes of mode or server invalidate in-flight accounting responses,
 * including a switch away and back while a request is waiting. */
export function getServerModeVersion() {
    syncBase();
    return modeVersion;
}

export function useServerInfo() {
    return useSyncExternalStore(subscribeServerInfo, currentServerInfo);
}

// Versions whose simulation yd_quantity was verified to follow the position
// unit. Empty until Sinotrade/Shioaji#233 is fixed and re-verified read-only.
const YD_QUANTITY_UNIT_FIXED = new Set<string>();

export function yesterdayQuantityNotice(info: Pick<ServerInfo, 'version' | 'simulation'> | undefined): string | undefined {
    if (!info) return '尚未取得伺服器資訊；昨餘單位待確認。';
    // Sinotrade/Shioaji#233 (app #107): simulation yd_quantity does not follow
    // the Common/Share unit (read-only reproduced on 1.7.5 and 1.7.6). Warn in
    // simulation unless the version is known fixed; never assume a bump fixed it.
    return info.simulation === true && !YD_QUANTITY_UNIT_FIXED.has(info.version)
        ? `Shioaji ${info.version} 模擬帳務的昨餘單位待確認；保留 API 原值，不推算張／股。`
        : undefined;
}
