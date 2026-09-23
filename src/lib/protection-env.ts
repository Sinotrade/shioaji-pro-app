// src/lib/protection-env.ts — the execution environment of protection
// triggers / bracket plans (#102): API base AND server mode. On desktop a
// simulation ↔ production switch restarts the sidecar on the same port, so
// the base alone cannot keep a simulation stop from firing in production.
// Unknown mode = no environment: nothing is created or executed until
// /api/v1/info (local, no broker quota) has answered.

import { getApiBase } from './runtime';
import { fetchInfo } from './shioaji';
import { getServerInfo, subscribeServerInfo } from './server-info-store';

export function currentProtectionEnv(): string | null {
    const info = getServerInfo();
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
