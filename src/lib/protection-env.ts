// src/lib/protection-env.ts — the execution environment of protection
// triggers / bracket plans (#102): API base AND server mode. On desktop a
// simulation ↔ production switch restarts the sidecar on the same port, so
// the base alone cannot keep a simulation stop from firing in production.
// Unknown mode = no environment: nothing is created or executed until
// /api/v1/info (local, no broker quota) has answered.

import { getApiBase } from './runtime';
import { fetchInfo } from './shioaji';
import { forgetServerInfo, knownServerInfo, subscribeServerInfo } from './server-info-store';
import { getStreamStatus, subscribeStatusStore } from './stream';

export function currentProtectionEnv(): string | null {
    const info = knownServerInfo();
    if (!info || typeof info.simulation !== 'boolean') return null;
    return `${getApiBase()}|${info.simulation ? 'simulation' : 'production'}`;
}

export function protectionEnvLabel(env: string): string {
    return env.endsWith('|simulation') ? '模擬' : env.endsWith('|production') ? '正式' : '未知模式';
}

/** Ask the local server for its mode (observed into the server-info store). */
export function refreshProtectionEnv(): Promise<void> {
    return fetchInfo().then(() => undefined, () => undefined);
}

/** Backoff for re-asking /info while the stream is LIVE but the mode is
 * still unknown (protection is paused meanwhile). Local call only. */
export const MODE_RETRY_MS = [1000, 2000, 5000, 10000, 20000, 30000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryIndex = 0;
function ensureMode() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (getStreamStatus() !== 'live' || currentProtectionEnv()) { retryIndex = 0; return; }
    void refreshProtectionEnv().then(() => {
        if (getStreamStatus() !== 'live' || currentProtectionEnv()) { retryIndex = 0; return; }
        const delay = MODE_RETRY_MS[Math.min(retryIndex, MODE_RETRY_MS.length - 1)]!;
        retryIndex += 1;
        retryTimer = setTimeout(() => { retryTimer = null; ensureMode(); }, delay);
    });
}

export function onProtectionEnvChange(listener: () => void): () => void {
    return subscribeServerInfo(listener);
}

/** API base part of an environment key. */
export function envBase(env: string): string {
    const i = env.lastIndexOf('|');
    return i < 0 ? env : env.slice(0, i);
}

/** Does a report received from `base` belong to `env`? Strict on the mode
 * once it is known; before that, only the base can be compared. */
export function reportEnvMatches(env: string, base: string): boolean {
    const current = currentProtectionEnv();
    return current ? env === current : envBase(env) === base;
}

/** While the stream is down the sidecar may restart in the other mode on the
 * same port: forget its mode at once (protection stops dispatching — no
 * environment) and learn it again from a fresh /info after reconnecting. */
let watching = false;
export function watchProtectionEnv() {
    if (watching) return;
    watching = true;
    let live = getStreamStatus() === 'live';
    subscribeStatusStore(() => {
        const now = getStreamStatus() === 'live';
        if (now === live) return;
        live = now;
        if (!now) {
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            retryIndex = 0;
            forgetServerInfo(getApiBase());
        } else ensureMode();
    });
    ensureMode();
}
