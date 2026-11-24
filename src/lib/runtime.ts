// src/lib/runtime.ts — environment detection (zero dependencies; safe to
// import from anywhere without cycles)

export const isTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Default port for the bundled shioaji server. 21322 = 0x534A ("SJ") —
// far from 8080/8000/3000-style dev defaults and below every OS ephemeral
// range, so it's essentially never taken by another service.
export const DEFAULT_PORT = 21322;
// 隔離 dev App 的整組服務，包含原生管理與 SSE；不可只覆寫 REST URL。
export function getDevServerPort(): number | undefined {
    const raw = import.meta.env.DEV ? import.meta.env.VITE_DEV_SERVER_PORT : undefined;
    if (!raw) return undefined;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('VITE_DEV_SERVER_PORT 必須是 1024–65535');
    return port;
}
// The shioaji CLI itself still defaults to 8080 — a user-run daemon lives
// there, so it stays a probe candidate for attach.
export const LEGACY_PORT = 8080;

// The server version this build expects（repo 根目錄 SHIOAJI_VERSION，
// build 時注入；存 '1.5.5' 形式、去掉 v 前綴）。Empty when the define is
// unavailable（tests）— consumers must treat empty as "don't check".
export const EXPECTED_SERVER_VERSION: string =
    typeof __SHIOAJI_SERVER_VERSION__ === 'string'
        ? __SHIOAJI_SERVER_VERSION__.replace(/^v/, '')
        : '';

/**
 * 版本字串的同一種寫法：Python 套件用 PEP 440（1.8.0b1），sidecar 回報 Cargo
 * 的 semver（1.8.0-beta.1）。預發布 aN／bN／rcN 與 -alpha.N／-beta.N／-rc.N
 * 都轉成 semver 形式；去掉 v 前綴、不分大小寫。認不得的照原字串比。
 */
export function canonicalServerVersion(v: string): string {
    const s = v.trim().replace(/^v/i, '').toLowerCase();
    const pep = /^(\d+(?:\.\d+)*)[.-]?(a|b|rc|alpha|beta)[.-]?(\d+)$/.exec(s);
    if (pep) {
        const tag = pep[2] === 'a' || pep[2] === 'alpha' ? 'alpha' : pep[2] === 'b' || pep[2] === 'beta' ? 'beta' : 'rc';
        return `${pep[1]}-${tag}.${Number(pep[3])}`;
    }
    return s;
}

/** 版本握手：1.8.0b1 與 1.8.0-beta.1 視為同一版 */
export function sameServerVersion(a: string, b: string): boolean {
    return canonicalServerVersion(a) === canonicalServerVersion(b);
}

/**
 * SDK 版本是否已到 1.8.0b2（含 1.8.0 正式版之後）：美股 TickFull、台股庫存明細
 * unit=Share 都從這一版開始。認不得的版本字串回 null（呼叫端自行決定要不要試）。
 */
export function serverVersionAtLeast180b2(version: string | undefined | null): boolean | null {
    const v = canonicalServerVersion(String(version ?? ''));
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(v);
    if (!m) return null;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (maj !== 1) return maj > 1;
    if (min !== 8) return min > 8;
    if (pat > 0 || !m[4] || m[4] === 'rc') return true;
    if (m[4] === 'alpha') return false;
    return Number(m[5]) >= 2;
}

// The shioaji server may run on a non-default port when the preferred one is
// occupied — the chosen port is persisted here and read by every API/SSE
// consumer.
const PORT_KEY = 'sj-pro-api-port';

export function getApiPort(): number {
    const fixed = getDevServerPort();
    if (fixed) return fixed;
    try {
        const p = Number(localStorage.getItem(PORT_KEY));
        if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    } catch {
        // storage unavailable
    }
    return DEFAULT_PORT;
}

// returns true when the port actually changed (caller should reload)
export function setApiPort(port: number): boolean {
    const changed = getApiPort() !== port;
    try {
        localStorage.setItem(PORT_KEY, String(port));
    } catch {
        // storage unavailable
    }
    if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('sj-pro-api-base-changed'));
    return changed;
}

// 本機 HTTPS：the sidecar's listener is either plaintext (http/1.1) or TLS
// (https + h2) — the active scheme is persisted next to the port so every
// API/SSE consumer builds matching URLs.
export type ApiScheme = 'http' | 'https';
const SCHEME_KEY = 'sj-pro-api-scheme';

export function getApiScheme(): ApiScheme {
    try {
        if (localStorage.getItem(SCHEME_KEY) === 'https') return 'https';
    } catch {
        // storage unavailable
    }
    return 'http';
}

// returns true when the scheme actually changed (caller should reload)
export function setApiScheme(scheme: ApiScheme): boolean {
    const changed = getApiScheme() !== scheme;
    try {
        localStorage.setItem(SCHEME_KEY, scheme);
    } catch {
        // storage unavailable
    }
    if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('sj-pro-api-base-changed'));
    return changed;
}

// PID and port of the server we spawned — the CLI daemon registry never sees
// a foreground `server start`, so stopping/restarting across app launches
// relies on remembering the child ourselves. The port lets status reporting
// tell "our spawn" apart from an attached external server (whose pid we
// don't know).
const PID_KEY = 'sj-pro-server-pid';
const SPAWN_PORT_KEY = 'sj-pro-server-port';

export function getSpawnPort(): number | null {
    try {
        const p = Number(localStorage.getItem(SPAWN_PORT_KEY));
        if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    } catch {
        // storage unavailable
    }
    return null;
}

export function setSpawnPort(port: number | null) {
    try {
        if (port === null) localStorage.removeItem(SPAWN_PORT_KEY);
        else localStorage.setItem(SPAWN_PORT_KEY, String(port));
    } catch {
        // storage unavailable
    }
}

export function getServerPid(): number | null {
    if (getDevServerPort() && getSpawnPort() !== getDevServerPort()) return null;
    try {
        const p = Number(localStorage.getItem(PID_KEY));
        if (Number.isInteger(p) && p > 0) return p;
    } catch {
        // storage unavailable
    }
    return null;
}

export function setServerPid(pid: number | null) {
    try {
        if (pid === null) localStorage.removeItem(PID_KEY);
        else localStorage.setItem(PID_KEY, String(pid));
    } catch {
        // storage unavailable
    }
}

// #285: the block of another program's server lives in the dependency-free
// server-read-gate (api.ts / stream.ts check it on every request)
export {
    blockForeignServerPort,
    foreignServerBlockedError,
    foreignServerPortBlocked,
    serverUrlBlocked,
} from './server-read-gate';

// In Tauri the frontend is served from tauri://localhost — API calls must
// target the local shioaji server explicitly. The host stays 127.0.0.1;
// with 本機 HTTPS enabled the mkcert certificate covers it alongside
// localhost and ::1.
export function getApiBase(): string {
    const env = import.meta.env.VITE_API_BASE as string | undefined;
    if (getDevServerPort() && env && env !== `${getApiScheme()}://127.0.0.1:${getDevServerPort()}`) {
        throw new Error('隔離 dev 服務與 VITE_API_BASE 不一致，拒絕連線');
    }
    if (env) return env;
    if (!isTauri) return '';
    return `${getApiScheme()}://127.0.0.1:${getApiPort()}`;
}

// Since shioaji 1.7.2 every event family rides ONE aggregate SSE
// connection, so the browser's HTTP/1.1 per-origin pool is no longer a
// concern and streams share the API origin. (Before, six per-channel
// streams needed a sibling-loopback-origin workaround in dev.)
export function getStreamBase(): string {
    const env = import.meta.env.VITE_STREAM_BASE as string | undefined;
    if (getDevServerPort() && env) {
        const direct = `${getApiScheme()}://127.0.0.1:${getDevServerPort()}`;
        const sameOrigin = typeof location !== 'undefined' ? location.origin : undefined;
        if (env !== direct && env !== sameOrigin) throw new Error('隔離 dev 服務與 SSE 目的地不一致，拒絕連線');
    }
    if (env) return env;
    return getApiBase();
}
