// src/lib/runtime.ts — environment detection (zero dependencies; safe to
// import from anywhere without cycles)

export const isTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Default port for the bundled shioaji server. 21322 = 0x534A ("SJ") —
// far from 8080/8000/3000-style dev defaults and below every OS ephemeral
// range, so it's essentially never taken by another service.
export const DEFAULT_PORT = 21322;
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

// The shioaji server may run on a non-default port when the preferred one is
// occupied — the chosen port is persisted here and read by every API/SSE
// consumer.
const PORT_KEY = 'sj-pro-api-port';

export function getApiPort(): number {
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

// In Tauri the frontend is served from tauri://localhost — API calls must
// target the local shioaji server explicitly. The host stays 127.0.0.1;
// with 本機 HTTPS enabled the mkcert certificate covers it alongside
// localhost and ::1.
export function getApiBase(): string {
    const env = import.meta.env.VITE_API_BASE as string | undefined;
    if (env) return env;
    return isTauri ? `${getApiScheme()}://127.0.0.1:${getApiPort()}` : '';
}

// Since shioaji 1.7.2 every event family rides ONE aggregate SSE
// connection, so the browser's HTTP/1.1 per-origin pool is no longer a
// concern and streams share the API origin. (Before, six per-channel
// streams needed a sibling-loopback-origin workaround in dev.)
export function getStreamBase(): string {
    const env = import.meta.env.VITE_STREAM_BASE as string | undefined;
    if (env) return env;
    return getApiBase();
}
