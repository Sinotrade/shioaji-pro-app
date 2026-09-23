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

export function beginServerInfoRequest(): ServerInfoRequest {
    sequence += 1;
    return { base: getApiBase(), sequence };
}

export function observeServerInfo(request: ServerInfoRequest, info: ServerInfo | undefined) {
    const { base } = request;
    if (base !== getApiBase()) return;
    if ((applied.get(base) ?? 0) > request.sequence) return;
    applied.set(base, request.sequence);
    if (info) infos.set(base, info);
    else infos.delete(base);
    for (const listener of listeners) listener();
}

// Hoisted so useSyncExternalStore keeps one subscription per component instead
// of re-subscribing on every render.
export function subscribeServerInfo(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function currentServerInfo() { return infos.get(getApiBase()); }
/** Last /info observed for the current API base, without a new request. */
export const knownServerInfo = currentServerInfo;

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
