// src/lib/tauri.ts — desktop bridge: sidecar server management, popout
// windows, auto-updates. Every entry point is a no-op in the browser.

import type {
    DownloadEvent,
    Update,
} from '@tauri-apps/plugin-updater';
import {
    type ApiScheme,
    DEFAULT_PORT,
    EXPECTED_SERVER_VERSION,
    LEGACY_PORT,
    getApiBase,
    getApiPort,
    getApiScheme,
    getServerPid,
    getSpawnPort,
    isTauri,
    setApiPort,
    setApiScheme,
    setServerPid,
    setSpawnPort,
} from './runtime';
import {
    getStoredSpawnKeyHash,
    hashCredentials,
    setStoredSpawnKeyHash,
    shouldForceRespawn,
} from './spawn-keys';
import {
    cacheAgentHarnessEnabled,
    resolveAgentHarnessSetting,
} from './agent-harness-state';
import {
    harnessOwnershipCompatible,
    recoverHarnessOwnership,
} from './sidecar-ownership';
import { notify } from './trade';

export { isTauri } from './runtime';
export {
    isAgentHarnessEnabled,
    subscribeAgentHarnessEnabled,
} from './agent-harness-state';
export { harnessOwnershipCompatible } from './sidecar-ownership';

// poll /health until it answers, then reload — used after a fresh start so
// every panel bootstraps cleanly instead of racing a server that's still
// warming up (login + CA activation + contract load)
export function reloadWhenHealthy(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    const t = setInterval(async () => {
        if (Date.now() > deadline) {
            clearInterval(t);
            return;
        }
        try {
            const { fetchHealth } = await import('./shioaji');
            await fetchHealth();
            clearInterval(t);
            window.location.reload();
        } catch {
            // not up yet
        }
    }, 2000);
}

// ---- shioaji server sidecar ----

export interface ServerStatus {
    running: boolean;
    pid?: number;
    port?: number;
    healthy?: boolean;
    simulation?: boolean;
    version?: string;
    scheme?: ApiScheme;
    agentHarnessEnabled?: boolean;
}

export interface SidecarResult {
    ok: boolean;
    output: string;
}

// the CLI emits ANSI color escapes even when piped (sinotrade/shioaji#206)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

async function sidecar(
    args: string[],
    env?: Record<string, string>,
): Promise<SidecarResult> {
    const { Command } = await import('@tauri-apps/plugin-shell');
    const cmd = Command.sidecar('binaries/shioaji', args, {
        env: { NO_COLOR: '1', ...env },
    });
    const out = await cmd.execute();
    const text = `${out.stdout}\n${out.stderr}`
        .replace(ANSI_RE, '')
        .trim();
    return { ok: out.code === 0, output: text };
}

// `shioaji server start` runs the server in the FOREGROUND — it never exits,
// so awaiting execute() hangs the UI on 啟動中 forever. Spawn it instead and
// poll health to know when it's actually up; surface the captured log only if
// the process dies with an error before the server answers.
//
// The spawn itself happens on the RUST side with output routed to a file:
// a plugin-shell spawn streams every output line through a webview channel,
// and the boot flow reloads the page right after the server turns healthy —
// the dead channel then ate a "Couldn't find callback" warning per line for
// the rest of the session, degrading WKWebView IPC until健康 servers got
// restarted by their own watchdog (2026-08-07 盤中).
async function spawnServer(
    args: string[],
    env: Record<string, string>,
    port: number,
    scheme: ApiScheme = 'http',
    agentHarnessEnabled = true,
): Promise<SidecarResult> {
    const fullEnv = { NO_COLOR: '1', ...env };
    const { invoke } = await import('@tauri-apps/api/core');
    let pid: number;
    try {
        pid = await invoke<number>('spawn_server', {
            args,
            env: fullEnv,
            port,
            agentHarnessEnabled,
        });
    } catch (e) {
        if (/not found|unknown/i.test(String(e))) {
            // older Rust shell without the command — channel streaming
            return spawnServerViaChannels(args, env, port, scheme);
        }
        return { ok: false, output: `啟動失敗：${String(e)}` };
    }
    setServerPid(pid);
    setSpawnPort(port);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await probeInfo(port, scheme)) {
            return { ok: true, output: await readServerLog(port) };
        }
        const alive = await invoke<boolean>('process_alive', { pid }).catch(
            () => true, // transient IPC failure must not read as "died"
        );
        if (!alive) {
            setServerPid(null);
            return { ok: false, output: await readServerLog(port) };
        }
    }
    return {
        ok: false,
        output: `${await readServerLog(port)}\n啟動逾時（45 秒未就緒）`.trim(),
    };
}

export async function nativeOwnsHarnessSidecar(port: number): Promise<boolean> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<boolean>('agent_harness_sidecar_owned', { port });
    } catch {
        return false;
    }
}

// Agent Harness ownership recovery — after a crash/force-quit the next app
// launch ADOPTS the healthy orphan sidecar (good for plain trading), but the
// harness signing boundary is process-local, so every harness entry point
// dead-ends with 「需要目前 App instance 自己啟動的…」 until the server is
// respawned by THIS process. Restart through serverStart: its harnessMismatch
// branch stops the unowned daemon only with full is-shioaji ownership proof
// (foreign servers are refused, fail-closed) and spawns fresh natively.
// Single-flight so a settings toggle and an agent start racing each other
// (or a boot-time restore) never stack concurrent respawns.
let harnessRecoveryInFlight: Promise<StartResult | null> | null = null;
export function ensureHarnessOwnedServer(): Promise<StartResult | null> {
    if (!harnessRecoveryInFlight) {
        harnessRecoveryInFlight = recoverHarnessOwnership({
            nativeOwned: () => nativeOwnsHarnessSidecar(getApiPort()),
            loadSettings: loadDesktopSettings,
            restart: async () => {
                const settings = await loadDesktopSettings();
                return serverStart({ ...settings, agentHarnessEnabled: true });
            },
        }).finally(() => {
            harnessRecoveryInFlight = null;
        });
    }
    return harnessRecoveryInFlight;
}

// startup/login output lands in ~/.shioaji/sjpro-server-<port>.log now —
// read it back for error surfacing and the CA-activation warning scan
async function readServerLog(port: number): Promise<string> {
    try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const { homeDir, join } = await import('@tauri-apps/api/path');
        const p = await join(
            await homeDir(),
            '.shioaji',
            `sjpro-server-${port}.log`,
        );
        const text = await readTextFile(p);
        return text.replace(ANSI_RE, '').trim().slice(-4000);
    } catch {
        return '';
    }
}

async function spawnServerViaChannels(
    args: string[],
    env: Record<string, string>,
    port: number,
    scheme: ApiScheme = 'http',
): Promise<SidecarResult> {
    const { Command } = await import('@tauri-apps/plugin-shell');
    const cmd = Command.sidecar('binaries/shioaji', args, {
        env: { NO_COLOR: '1', ...env },
    });
    let buf = '';
    let exitCode: number | null = null;
    cmd.stdout.on('data', (l) => (buf += l));
    cmd.stderr.on('data', (l) => (buf += l));
    cmd.on('close', (e: { code: number | null }) => {
        exitCode = e.code ?? -1;
    });
    cmd.on('error', (e) => {
        buf += `\n${String(e)}`;
        exitCode = -1;
    });
    let child: { pid?: number } | null = null;
    try {
        child = await cmd.spawn();
    } catch (e) {
        return { ok: false, output: `啟動失敗：${String(e)}` };
    }
    // Remember the child pid for legacy stop/restart behavior. This fallback
    // intentionally cannot register a trusted harness sidecar: renderer-owned
    // PID/port input must never establish the native signing boundary.
    if (child?.pid) {
        setServerPid(child.pid);
        setSpawnPort(port);
    }
    // poll until the server answers, or it dies, or we give up (~45s covers a
    // production login + CA activation + contract load)
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await probeInfo(port, scheme)) {
            return { ok: true, output: buf.replace(ANSI_RE, '').trim() };
        }
        if (exitCode !== null && exitCode !== 0) {
            // process exited before serving — a real start failure
            setServerPid(null);
            return { ok: false, output: buf.replace(ANSI_RE, '').trim() };
        }
    }
    return {
        ok: false,
        output:
            `${buf.replace(ANSI_RE, '').trim()}\n啟動逾時（45 秒未就緒）`.trim(),
    };
}

// Ports a shioaji server could be answering on: whatever the app last used,
// the app default, and the CLI default (a user-run `shioaji server` daemon).
function candidatePorts(): number[] {
    return [...new Set([getApiPort(), DEFAULT_PORT, LEGACY_PORT])];
}

// ---- 本機 HTTPS（mkcert 憑證）----
// The sidecar (shioaji ≥1.7.2) serves HTTPS with HTTP/2 when
// SJ_HTTP_TLS_CERT/KEY point at a certificate. mkcert is BUNDLED as a
// second sidecar (binaries/mkcert) so users never install anything — one
// click generates a local CA + a localhost / 127.0.0.1 / ::1 leaf under
// ~/.shioaji/tls (the upstream-documented location). The only interaction
// left is the OS-native trust dialog, which by design must be the user's
// own click (macOS asks for the login password, Windows shows a confirm).

const IS_WINDOWS =
    typeof navigator !== 'undefined' &&
    /Win/i.test(navigator.platform || navigator.userAgent);
const IS_MAC =
    typeof navigator !== 'undefined' &&
    /Mac/i.test(navigator.platform || navigator.userAgent);

async function tlsPaths(): Promise<{ dir: string; cert: string; key: string }> {
    const { homeDir, join } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const dir = await join(home, '.shioaji', 'tls');
    return {
        dir,
        cert: await join(dir, 'localhost.pem'),
        key: await join(dir, 'localhost-key.pem'),
    };
}

export async function localTlsCertExists(): Promise<boolean> {
    if (!isTauri) return false;
    try {
        const { exists } = await import('@tauri-apps/plugin-fs');
        const p = await tlsPaths();
        return (await exists(p.cert)) && (await exists(p.key));
    } catch {
        return false;
    }
}

// run a user shell command through the already-scoped agent-sh/agent-cmd
// shell entries (same mechanism the AI agent uses)
async function runUserShell(script: string): Promise<SidecarResult> {
    const { Command } = await import('@tauri-apps/plugin-shell');
    const cmd = IS_WINDOWS
        ? Command.create('agent-cmd', ['/C', script])
        : Command.create('agent-sh', ['-c', script]);
    const out = await cmd.execute();
    const text = `${out.stdout}\n${out.stderr}`.replace(ANSI_RE, '').trim();
    return { ok: out.code === 0, output: text };
}

// run the bundled mkcert sidecar
async function runMkcert(args: string[]): Promise<SidecarResult> {
    try {
        const { Command } = await import('@tauri-apps/plugin-shell');
        const out = await Command.sidecar('binaries/mkcert', args).execute();
        const text = `${out.stdout}\n${out.stderr}`.replace(ANSI_RE, '').trim();
        return { ok: out.code === 0, output: text };
    } catch (e) {
        // dev builds without scripts/fetch-mkcert.sh, or a broken bundle
        return { ok: false, output: `MKCERT_SIDECAR_MISSING: ${String(e)}` };
    }
}

// make the OS trust the mkcert local CA, so both the WKWebView and the
// Rust HTTP layer (rustls-tls-native-roots) accept the leaf. Idempotent.
async function ensureCaTrusted(leafCert: string): Promise<SidecarResult> {
    if (IS_WINDOWS) {
        // mkcert -install on Windows writes to the CurrentUser Root store —
        // no admin needed; Windows itself pops the confirm dialog once and
        // mkcert skips silently when the CA is already installed.
        return runMkcert(['-install']);
    }
    if (IS_MAC) {
        // already trusted (System or login keychain)? then no dialog at all
        const verify = await runUserShell(
            `security verify-cert -c "${leafCert}" >/dev/null 2>&1`,
        );
        if (verify.ok) return { ok: true, output: '' };
        // mkcert -install would shell out to sudo (no TTY here) — instead
        // trust the CA in the *user* domain, which pops the native
        // "Certificate Trust Settings" password dialog and needs no admin.
        const caroot = await runMkcert(['-CAROOT']);
        if (!caroot.ok) return caroot;
        const add = await runUserShell(
            `security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "${caroot.output}/rootCA.pem"`,
        );
        if (!add.ok) return { ok: false, output: 'TRUST_DECLINED' };
        const recheck = await runUserShell(
            `security verify-cert -c "${leafCert}" >/dev/null 2>&1`,
        );
        return recheck.ok
            ? { ok: true, output: '' }
            : { ok: false, output: 'TRUST_DECLINED' };
    }
    // Linux: the system trust store needs root (update-ca-certificates) and
    // webkit2gtk only reads the system bundle — try, and hand over a manual
    // step when it fails. Pre-existing certs are assumed already trusted.
    const inst = await runMkcert(['-install']);
    return inst.ok ? inst : { ok: false, output: 'LINUX_MANUAL_TRUST' };
}

// generate + trust a local certificate using the bundled mkcert — fully
// automatic; at most one OS-native trust dialog on first enable.
export async function ensureLocalTlsCert(): Promise<SidecarResult> {
    if (!isTauri) return { ok: false, output: '桌面版限定' };
    const p = await tlsPaths();
    const had = await localTlsCertExists();
    if (!had) {
        const { mkdir } = await import('@tauri-apps/plugin-fs');
        await mkdir(p.dir, { recursive: true });
        // first run also creates the local CA in mkcert's default CAROOT —
        // shared with any pre-existing user mkcert install
        const gen = await runMkcert([
            '-cert-file', p.cert,
            '-key-file', p.key,
            'localhost', '127.0.0.1', '::1',
        ]);
        if (!gen.ok) return gen;
        if (!(await localTlsCertExists())) return { ok: false, output: gen.output };
    }
    // always re-check trust: cert files alone don't prove the CA is trusted,
    // and an untrusted CA is exactly what causes enable-then-restart loops
    if (!IS_WINDOWS && !IS_MAC && had) return { ok: true, output: '' };
    return ensureCaTrusted(p.cert);
}

// The CLI's `server status` only knows daemonized servers — a foreground
// `server start` (which is how this app spawns it) never appears there, and
// its state file goes stale. Ground truth is therefore an HTTP probe of the
// candidate ports; the CLI registry is only consulted as a last resort for
// daemons living on some other port.
export async function serverStatus(): Promise<ServerStatus | null> {
    if (!isTauri) return null;
    const ports = candidatePorts();
    const infos = await Promise.all(ports.map((p) => probeInfoEither(p)));
    for (const [i, port] of ports.entries()) {
        const hit = infos[i];
        if (!hit) continue;
        return {
            running: true,
            port,
            healthy: await probeHealthy(port, hit.scheme),
            simulation: hit.info.simulation,
            version: hit.info.version,
            scheme: hit.scheme,
            agentHarnessEnabled: hit.info.agentHarnessEnabled,
            // only claim a pid for the server we spawned — an attached
            // external server has an unknown pid, and showing our stale
            // record for it is misleading
            pid:
                getSpawnPort() === port
                    ? (getServerPid() ?? undefined)
                    : undefined,
        };
    }
    try {
        const res = await sidecar(['server', 'status', '--format', 'json']);
        const jsonStart = res.output.indexOf('{');
        if (jsonStart >= 0) {
            const st = JSON.parse(
                res.output.slice(jsonStart),
            ) as ServerStatus;
            if (st.running && st.port && !ports.includes(st.port)) {
                const hit = await probeInfoEither(st.port);
                if (hit) {
                    return {
                        running: true,
                        port: st.port,
                        healthy: await probeHealthy(st.port, hit.scheme),
                        simulation: hit.info.simulation,
                        version: hit.info.version,
                        scheme: hit.scheme,
                        agentHarnessEnabled: hit.info.agentHarnessEnabled,
                        pid: st.pid,
                    };
                }
            }
        }
    } catch {
        // sidecar missing / failed
    }
    return { running: false };
}

// all probes go through plugin-http; its reqwest is built with
// rustls-tls-native-roots so 本機 HTTPS (mkcert, trust chain in the OS
// keychain/cert store) validates the same way the webview does. If the
// Rust side still rejects the certificate (e.g. a CA that only lives in
// the login keychain), fall back to the webview's own fetch, which uses
// the OS networking stack.
async function probeFetch(
    url: string,
    timeoutMs: number,
): Promise<Response> {
    try {
        return await tauriFetchWithTimeout(url, timeoutMs);
    } catch (err) {
        if (url.startsWith('https://')) {
            const controller = new AbortController();
            const timer = window.setTimeout(
                () => controller.abort(),
                timeoutMs,
            );
            try {
                return await fetch(url, {
                    signal: controller.signal,
                });
            } catch (err2) {
                throw err2;
            } finally {
                window.clearTimeout(timer);
            }
        }
        throw err;
    }
}

// is a shioaji HTTP server answering on this port? (null = no / not shioaji)
async function probeInfo(
    port: number,
    scheme: ApiScheme = getApiScheme(),
): Promise<{
    version: string;
    simulation: boolean;
    agentHarnessEnabled: boolean;
} | null> {
    try {
        // generous timeout: at boot the plugin-http queue is congested and
        // a tight 1.5s deadline cancelled probes against LIVE servers —
        // "Request cancelled" read as 未運行 and the watchdog restarted a
        // perfectly healthy daemon (2026-08-07 盤中實錄)
        const res = await probeFetch(
            `${scheme}://127.0.0.1:${port}/api/v1/info`,
            5000,
        );
        if (!res.ok) return null;
        const info = (await res.json()) as {
            version?: string;
            simulation?: boolean;
            agent_harness?: { enabled?: boolean };
        };
        if (
            typeof info.version === 'string' &&
            typeof info.simulation === 'boolean'
        ) {
            return {
                version: info.version,
                simulation: info.simulation,
                agentHarnessEnabled: info.agent_harness?.enabled === true,
            };
        }
    } catch {
        // not answering
    }
    return null;
}

// probe both schemes (preferred first) — the listener is either plaintext or
// TLS, and around 本機 HTTPS transitions the persisted scheme can lag what
// the running server actually speaks
async function probeInfoEither(
    port: number,
    preferred: ApiScheme = getApiScheme(),
): Promise<{
    info: {
        version: string;
        simulation: boolean;
        agentHarnessEnabled: boolean;
    };
    scheme: ApiScheme;
} | null> {
    const other: ApiScheme = preferred === 'https' ? 'http' : 'https';
    for (const scheme of [preferred, other]) {
        const info = await probeInfo(port, scheme);
        if (info) return { info, scheme };
    }
    return null;
}

async function probeHealthy(
    port: number,
    scheme: ApiScheme = getApiScheme(),
): Promise<boolean> {
    try {
        const res = await probeFetch(
            `${scheme}://127.0.0.1:${port}/api/v1/health`,
            5000,
        );
        if (!res.ok) return false;
        // the server answers 200 even when its upstream session is dead
        // (status "unhealthy", token expired — Shioaji#215); trust the body.
        // "degraded" (token renewal due) still counts as healthy — it's a
        // transient state, and restarting on it would cause churn.
        const body = (await res.json()) as { status?: string };
        return body.status !== 'unhealthy';
    } catch {
        return false;
    }
}

// is CA active on this daemon? production orders 400 without it. We only
// attach to / keep a daemon for production if its CA is live — otherwise the
// user sets CA in the app but the running daemon never had it (issue #1).
async function caActive(
    port: number,
    scheme: ApiScheme = getApiScheme(),
): Promise<boolean> {
    try {
        const accRes = await probeFetch(
            `${scheme}://127.0.0.1:${port}/api/v1/auth/accounts`,
            2000,
        );
        if (!accRes.ok) return false;
        const accts = (await accRes.json()) as { person_id?: string }[];
        const pid = accts[0]?.person_id;
        if (!pid) return false;
        const caRes = await probeFetch(
            `${scheme}://127.0.0.1:${port}/api/v1/auth/ca_expiretime?person_id=${encodeURIComponent(pid)}`,
            2000,
        );
        if (!caRes.ok) return false; // 400 "CA not activated"
        const ca = (await caRes.json()) as { expire_time?: string };
        return !!ca.expire_time && new Date(ca.expire_time).getTime() > Date.now();
    } catch {
        return false;
    }
}

// AbortSignal.timeout() cannot be cancelled after a request settles. With the
// Tauri HTTP plugin, its later abort event attempts to close an already-freed
// Rust resource and surfaces as an unhandled "resource id ... is invalid"
// rejection. Own the timer so successful probes clear it immediately.
async function tauriFetchWithTimeout(url: string, timeoutMs: number) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await tauriFetch(url, { signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
}

export interface StartResult extends SidecarResult {
    port: number;
    attached: boolean; // an existing shioaji server was reused
    portChanged: boolean; // the app's API base moved — caller should reload
}

export async function serverStart(opts: {
    apiKey: string;
    secretKey: string;
    production: boolean;
    caPath?: string;
    caPasswd?: string;
    httpsEnabled?: boolean;
    agentHarnessEnabled?: boolean;
}): Promise<StartResult> {
    // when production+CA is requested, a daemon is only good enough to reuse
    // if its CA is actually active — otherwise orders 400 (issue #1)
    const needsCa = !!opts.production && !!opts.caPath;
    // 本機 HTTPS is only honored when the mkcert certificate is in place —
    // otherwise fall back to plaintext with a warning instead of a dead TLS
    // listener the webview can't trust
    const tlsReady = !!opts.httpsEnabled && (await localTlsCertExists());
    const wantScheme: ApiScheme = tlsReady ? 'https' : 'http';

    // a shioaji server already answering (ours from a previous run, or the
    // user's own CLI daemon on :8080)? Attach only if it can actually trade
    // in the requested mode — a CA-less daemon here is exactly why
    // "加了 CA 還是 400" on the installed app.
    let st = await serverStatus();
    // a child we spawned may still be inside its login window: the 1.7.2
    // server binds its listener only AFTER login (~5-8s blind spot). Any
    // reload landing in that window used to see "not running", then the
    // pre-spawn reclaim killed the warming child by remembered pid — the
    // restart loop. Wait for the remembered spawn to surface instead.
    if (!st?.running && getServerPid() && getSpawnPort()) {
        const spawnPort = getSpawnPort()!;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            const hit = await probeInfoEither(spawnPort);
            if (hit) {
                st = {
                    running: true,
                    port: spawnPort,
                    healthy: await probeHealthy(spawnPort, hit.scheme),
                    simulation: hit.info.simulation,
                    version: hit.info.version,
                    scheme: hit.scheme,
                    agentHarnessEnabled: hit.info.agentHarnessEnabled,
                    pid: getServerPid() ?? undefined,
                };
                break;
            }
            await new Promise((r) => setTimeout(r, 1500));
        }
    }
    if (!st?.running) {
        // an orphan of ours can sit on a fallback port with its record lost
        // (cleared web storage) — sweep the find_free_port windows (current
        // default + the pre-21322 legacy one) before piling yet another
        // server on top of it
        const win = [
            ...Array.from({ length: 9 }, (_, i) => DEFAULT_PORT + 1 + i),
            ...Array.from({ length: 5 }, (_, i) => LEGACY_PORT + 1 + i),
        ];
        const hits = await Promise.all(win.map((p) => probeInfoEither(p)));
        const hit = win.findIndex((_, i) => hits[i]);
        if (hit >= 0) {
            const port = win[hit] as number;
            const found = hits[hit]!;
            st = {
                running: true,
                port,
                healthy: await probeHealthy(port, found.scheme),
                simulation: found.info.simulation,
                // without this the versionMismatch check below sees
                // undefined and adopts an old-version orphan
                version: found.info.version,
                scheme: found.scheme,
                agentHarnessEnabled: found.info.agentHarnessEnabled,
                pid: getServerPid() ?? undefined,
            };
        }
    }
    if (st?.running && st.port) {
        const stScheme: ApiScheme = st.scheme ?? 'http';
        const modeMismatch =
            st.simulation !== undefined &&
            st.simulation === opts.production;
        // the listener speaks either plaintext or TLS — attaching across a
        // 本機 HTTPS toggle needs a restart to apply the new listener.
        // A running https listener while HTTPS is enabled is always right
        // (it serving TLS proves the cert exists — never re-check the cert
        // file for a live server, transient fs failures caused kill loops);
        // http while enabled only mismatches when the cert is ready to
        // switch to.
        const schemeMismatch = opts.httpsEnabled
            ? stScheme === 'http' && tlsReady
            : stScheme !== 'http';
        // version handshake: only attach to a server matching the bundled
        // sidecar version — API/UI 版本必須一致
        const versionMismatch =
            EXPECTED_SERVER_VERSION !== '' &&
            st.version !== undefined &&
            st.version !== EXPECTED_SERVER_VERSION;
        const nativeHarnessOwned = await nativeOwnsHarnessSidecar(st.port);
        const harnessMismatch = !harnessOwnershipCompatible(
            opts.agentHarnessEnabled === true,
            nativeHarnessOwned,
        );
        const external = getSpawnPort() !== st.port || harnessMismatch;
        // Harness authority belongs to one native App process and one
        // sidecar generation. Never adopt a healthy daemon from a previous
        // App instance: it verifies a different signing key.
        // 金鑰 hash 領養檢查 (issue #16): our OWN spawn may still be logged
        // into the credentials it was STARTED with — after a re-login with a
        // different API key, adopting it shows the old account's data. Only
        // our own server is checked (external servers are never ours to
        // judge), and shouldForceRespawn is deliberately one-sided: a missing
        // hash (upgrade user, cleared storage, no crypto.subtle) reads as
        // compatible so adoption proceeds exactly as before — never a new
        // restart loop. A forced respawn lands the new hash below, so the
        // check converges after a single restart.
        const currentKeyHash = await hashCredentials(
            opts.apiKey,
            opts.secretKey,
        );
        const keyMismatch =
            !external &&
            shouldForceRespawn(getStoredSpawnKeyHash(), currentKeyHash);
        const caOk = !needsCa || (await caActive(st.port, stScheme));
        if (
            st.healthy &&
            !modeMismatch &&
            !schemeMismatch &&
            caOk &&
            !versionMismatch &&
            !harnessMismatch &&
            !keyMismatch
        ) {
            // healthy, right mode, right version, CA live — just use it
            const schemeChanged = setApiScheme(stScheme);
            return {
                ok: true,
                output: `伺服器已在運行（port ${st.port}）`,
                port: st.port,
                attached: true,
                portChanged: setApiPort(st.port) || schemeChanged,
            };
        }
        if (versionMismatch && external) {
            // 使用者自己的 server 版本不符（例如 8080 上的舊 CLI）——
            // 絕不動它，直接往下走：在別的 port 起自帶 binary
        } else {
            // unhealthy, wrong mode/version, or CA not active — stop it and
            // start fresh with the requested settings instead of attaching
            // to a daemon that can't serve this build (v0.1.13
            // stuck-at-連線中 + the CA-less attach bug). serverStop kills
            // our remembered pid, so this also works for the foreground
            // servers the CLI daemon registry never sees.
            const stopped = await serverStop();
            if (!stopped.ok && (await probeInfo(st.port))) {
                // still answering — an external server we can't kill; tell
                // the user instead of piling a second server onto another
                // port
                const why = modeMismatch
                    ? '模式與設定不符'
                    : schemeMismatch
                      ? `連線協定不符（server ${stScheme}，需 ${wantScheme}）`
                      : harnessMismatch
                        ? 'Agent Harness 金鑰不屬於此 App instance'
                      : versionMismatch
                        ? `版本不符（server ${st.version}，需 ${EXPECTED_SERVER_VERSION}）`
                        : keyMismatch
                          ? 'API 金鑰已更換，需要重新登入'
                          : !caOk
                            ? 'CA 未啟用，正式環境無法下單'
                            : '狀態不健康';
                return {
                    ok: false,
                    output:
                        `:${st.port} 已有一個 shioaji server（${why}），且無法自動停止。\n` +
                        `${stopped.output}\n停止後再用本 App 啟動以套用設定。`.trim(),
                    port: st.port,
                    attached: false,
                    portChanged: false,
                };
            }
        }
    }

    // preferred port occupied by something else → first free port after it
    let port = DEFAULT_PORT;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        // nothing usable is answering, so any listener still bound on our
        // ports is a zombie orphan (SIGKILLed app → dead pipe → HTTP dead) —
        // reclaim our own before picking a port; foreign listeners refuse
        // the ownership check and find_free_port dodges them below
        for (const p of new Set([getApiPort(), DEFAULT_PORT])) {
            await invoke('kill_shioaji', {
                port: p,
                pid: getServerPid(),
            }).catch(() => undefined);
        }
        setServerPid(null);
        const free = await invoke<number>('find_free_port', {
            preferred: DEFAULT_PORT,
        });
        if (free > 0) port = free;
    } catch {
        // command unavailable — try the default and let the server error
        // surface
    }

    const env: Record<string, string> = {
        SJ_API_KEY: opts.apiKey,
        SJ_SEC_KEY: opts.secretKey,
        SJ_HTTP_ADDR: `127.0.0.1:${port}`,
        // per-request logs are unbounded (the spawn log file would grow
        // ~100MB/day). SJ_HTTP_LOG=false and its documented fallbacks are
        // all ineffective in 1.7.2 (upstream bug) — RUST_LOG=warn is what
        // actually silences salvo request logging while keeping WARN+
        // (e.g. CA activation failures) for error surfacing.
        SJ_HTTP_LOG: 'false',
        RUST_LOG: 'warn',
    };
    // CA certificate — required for production orders, ignored in simulation
    if (opts.caPath) {
        env.SJ_CA_PATH = opts.caPath;
        if (opts.caPasswd) env.SJ_CA_PASSWD = opts.caPasswd;
    }
    // 本機 HTTPS：static TLS turns the listener into https + HTTP/2
    if (tlsReady) {
        const tls = await tlsPaths();
        env.SJ_HTTP_TLS_CERT = tls.cert;
        env.SJ_HTTP_TLS_KEY = tls.key;
    }
    const args = ['server', 'start', '--no-open'];
    if (opts.production) args.push('--production');
    // spawn (don't await to completion) — the start runs in foreground
    const res = await spawnServer(
        args,
        env,
        port,
        wantScheme,
        opts.agentHarnessEnabled,
    );
    if (res.ok) {
        // remember which credentials THIS spawn was started with (issue #16)
        // — null (no crypto.subtle) clears the record so a stale hash never
        // outlives the server it described
        setStoredSpawnKeyHash(
            await hashCredentials(opts.apiKey, opts.secretKey),
        );
    }
    const schemeChanged = res.ok ? setApiScheme(wantScheme) : false;
    const portChanged = (res.ok ? setApiPort(port) : false) || schemeChanged;
    // the server starts even when CA activation fails (login still works) —
    // catch that warning from the log so the user knows production orders
    // will 400 (e.g. expired certificate) instead of finding out at order time
    const caFail = /Failed to activate CA[^\n]*/i.exec(res.output);
    let note =
        res.ok && port !== DEFAULT_PORT
            ? `\n⚠ ${DEFAULT_PORT} 被占用，伺服器改用 port ${port}`
            : '';
    if (opts.httpsEnabled && !tlsReady) {
        note +=
            '\n⚠ 找不到本機 TLS 憑證，已改以 HTTP 啟動 — 請在伺服器管理重新啟用本機 HTTPS';
    }
    if (res.ok && tlsReady) {
        note += `\n🔒 本機 HTTPS 已啟用 — https://localhost:${port}`;
    }
    if (res.ok && opts.production && caFail) {
        const reason = /expired/i.test(caFail[0])
            ? '憑證已過期，請至 API 管理頁重新下載 Sinopac.pfx'
            : caFail[0].replace(/.*Failed to activate CA certificate:\s*/i, '');
        note += `\n⚠ CA 未啟用（${reason}）— 正式環境下單會被拒`;
    }
    return {
        ...res,
        output: `${res.output}${note}`,
        port,
        attached: false,
        portChanged,
    };
}

// Stop the running server. Our own spawn is killed by pid/path proof; an
// EXTERNAL server (the user's own CLI) is only stopped when the call carries
// explicit user intent (`allowExternal` — the 停止/重啟 buttons), via the
// CLI's own `server stop`. Automatic flows (boot restart on mode mismatch)
// must never take the user's server down behind their back.
export async function serverStop(opts?: {
    allowExternal?: boolean;
}): Promise<SidecarResult> {
    if (!isTauri) return { ok: false, output: '' };
    const st = await serverStatus();
    let killNote = '';
    let killErr = '';
    const pid = getServerPid();
    // resolve the victim by port (survives lost pid records from older app
    // versions); the remembered pid is only a fallback for a server that is
    // up but not listening yet. Nothing running and no pid → nothing to kill.
    const port = (st?.running && st.port) || getApiPort();
    if (st?.running || pid) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const killed = await invoke<boolean>('kill_shioaji', {
                port,
                pid,
            });
            setServerPid(null);
            setSpawnPort(null);
            if (killed) killNote = `已終止伺服器（:${port}）`;
        } catch (e) {
            // ownership refused (external shioaji / foreign service) — keep
            // the explanation; the pid record stays in case it referred to a
            // not-yet-listening child
            killErr = String(e);
        }
    }
    // the CLI can stop servers it registered itself (its daemon file tracks
    // the last `server start`, including external foreground ones on ≥1.5.5)
    // — explicit user intent only
    if (opts?.allowExternal) {
        await sidecar(['server', 'stop']);
    }
    if (st?.running && st.port) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (!(await probeInfo(st.port))) {
                return {
                    ok: true,
                    output: killNote || `伺服器已停止（:${st.port}）`,
                };
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        return {
            ok: false,
            output: [
                killNote,
                killErr,
                `:${st.port} 上的伺服器仍在運行${opts?.allowExternal ? '，請手動停止（終端機 Ctrl+C）' : ''}`,
            ]
                .filter(Boolean)
                .join('\n'),
        };
    }
    return { ok: true, output: killNote || '伺服器未在運行' };
}

// ---- settings store (API keys live in the app-data dir, not the repo) ----

export interface DesktopSettings {
    apiKey: string;
    secretKey: string;
    production: boolean;
    autoStart: boolean; // start the shioaji server when the app launches
    caPath: string; // Sinopac.pfx — required for production orders
    caPasswd: string;
    httpsEnabled: boolean; // serve the sidecar over local HTTPS (mkcert)
    agentHarnessEnabled: boolean; // runtime-toggleable; no server restart
}

const EMPTY_SETTINGS: DesktopSettings = {
    apiKey: '',
    secretKey: '',
    production: false,
    autoStart: true,
    caPath: '',
    caPasswd: '',
    httpsEnabled: false,
    agentHarnessEnabled: true,
};

export async function loadDesktopSettings(): Promise<DesktopSettings> {
    if (!isTauri) return { ...EMPTY_SETTINGS };
    const { LazyStore } = await import('@tauri-apps/plugin-store');
    const store = new LazyStore('settings.json');
    const safeDefaultMigrated =
        (await store.get<boolean>('agentHarnessSafeDefaultV1')) ?? false;
    const storedAgentHarnessEnabled = await store.get<boolean>(
        'agentHarnessEnabled',
    );
    const agentHarnessEnabled = resolveAgentHarnessSetting(
        storedAgentHarnessEnabled,
        safeDefaultMigrated,
    );
    if (!safeDefaultMigrated) {
        await store.set('agentHarnessEnabled', agentHarnessEnabled);
        await store.set('agentHarnessSafeDefaultV1', true);
        await store.save();
    }
    const settings = {
        apiKey: (await store.get<string>('apiKey')) ?? '',
        secretKey: (await store.get<string>('secretKey')) ?? '',
        production: (await store.get<boolean>('production')) ?? false,
        autoStart: (await store.get<boolean>('autoStart')) ?? true,
        caPath: (await store.get<string>('caPath')) ?? '',
        caPasswd: (await store.get<string>('caPasswd')) ?? '',
        httpsEnabled: (await store.get<boolean>('httpsEnabled')) ?? false,
        agentHarnessEnabled,
    };
    cacheAgentHarnessEnabled(settings.agentHarnessEnabled);
    return settings;
}

export async function saveDesktopSettings(s: DesktopSettings) {
    if (!isTauri) return;
    const { LazyStore } = await import('@tauri-apps/plugin-store');
    const store = new LazyStore('settings.json');
    await store.set('apiKey', s.apiKey);
    await store.set('secretKey', s.secretKey);
    await store.set('production', s.production);
    await store.set('autoStart', s.autoStart);
    await store.set('caPath', s.caPath);
    await store.set('caPasswd', s.caPasswd);
    await store.set('httpsEnabled', s.httpsEnabled);
    await store.set('agentHarnessEnabled', s.agentHarnessEnabled);
    cacheAgentHarnessEnabled(s.agentHarnessEnabled);
    await store.save();
}

export interface SetAgentHarnessResult {
    // ownership recovery respawned the sidecar (adopted orphan → owned)
    restarted: boolean;
    // the API base moved with the respawn — caller should reload the page
    portChanged: boolean;
}

export async function setAgentHarnessEnabled(
    enabled: boolean,
): Promise<SetAgentHarnessResult> {
    if (!isTauri) throw new Error('Agent Harness 只能由 Desktop native host 切換');
    // Enabling against an ADOPTED sidecar (crash/force-quit orphan) used to
    // dead-end on the native ownership check with no way out of the settings
    // dialog — recover by respawning natively first. Disable is left as-is:
    // an unowned sidecar cannot be signed for either way, and the existing
    // error already points at the server restart.
    const recovered = enabled ? await ensureHarnessOwnedServer() : null;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_harness_set_enabled', {
        origin: new URL(getApiBase()).origin,
        enabled,
    });
    const settings = await loadDesktopSettings();
    await saveDesktopSettings({ ...settings, agentHarnessEnabled: enabled });
    return {
        restarted: recovered !== null,
        portChanged: recovered?.portChanged ?? false,
    };
}

// native file picker for the Sinopac.pfx certificate
export async function pickCaFile(): Promise<string | null> {
    if (!isTauri) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const file = await open({
        multiple: false,
        directory: false,
        title: '選擇 Sinopac.pfx 憑證',
        filters: [{ name: '憑證', extensions: ['pfx', 'p12'] }],
    });
    return typeof file === 'string' ? file : null;
}

// parses simple KEY=value / KEY="value" / export KEY=value lines — good
// enough for a hand-written .env, doesn't need full dotenv semantics
// (multiline values, ${VAR} expansion) for just pulling out two keys
function parseEnvKeys(
    text: string,
): { apiKey?: string; secretKey?: string } {
    const out: { apiKey?: string; secretKey?: string } = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
            line,
        );
        if (!m) continue;
        const key = m[1];
        let val = (m[2] ?? '').trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (key === 'SJ_API_KEY') out.apiKey = val;
        if (key === 'SJ_SEC_KEY') out.secretKey = val;
    }
    return out;
}

// lets the user pick a project FOLDER (not the .env file itself) and pulls
// SJ_API_KEY/SJ_SEC_KEY out of the first matching file found inside it.
// Native open-file dialogs hide dotfiles by default (macOS/Windows/Linux
// file pickers all do this — there's no cross-platform API flag to force
// them visible, only an undiscoverable OS-level shortcut on macOS), so
// ".env" itself is invisible if picked directly. A directory listing via
// the fs plugin isn't subject to that UI-level filtering, so picking the
// containing folder and reading its entries sidesteps the problem entirely.
export async function pickEnvFile(): Promise<{
    apiKey?: string;
    secretKey?: string;
    error?: string;
} | null> {
    if (!isTauri) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({
        directory: true,
        title: '選擇專案資料夾（自動尋找裡面的 .env*）',
    });
    if (typeof dir !== 'string') return null; // dialog cancelled
    const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dir).catch(() => []);
    // any file starting with ".env" — .env, .env.local, .env.production,
    // .env.whatever-custom-name a project happens to use. Exact ".env"
    // first (most common), then the rest alphabetically for determinism.
    const candidates = entries
        .filter((e) => e.isFile && e.name.startsWith('.env'))
        .map((e) => e.name)
        .sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)));
    for (const candidate of candidates) {
        const text = await readTextFile(`${dir}/${candidate}`).catch(
            () => '',
        );
        const found = parseEnvKeys(text);
        if (found.apiKey || found.secretKey) return found;
    }
    return {
        error:
            candidates.length > 0
                ? `找到 ${candidates.join('、')} 但裡面沒有 SJ_API_KEY / SJ_SEC_KEY`
                : '這個資料夾裡沒有任何 .env 開頭的檔案',
    };
}

// ---- popout windows ----

let popoutCounter = 0;

export async function openPopout(type: string, code: string | null) {
    const qs = new URLSearchParams({ popout: type, code: code ?? '' });
    if (!isTauri) {
        window.open(
            `${window.location.pathname}?${qs}`,
            `sj-popout-${type}-${code ?? 'x'}`,
            'width=900,height=620,menubar=no,toolbar=no',
        );
        return;
    }
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    popoutCounter += 1;
    new WebviewWindow(`popout-${type}-${popoutCounter}`, {
        url: `index.html?${qs}`,
        // Tauri's drag-drop interception eats in-page HTML5 drag on
        // WKWebView (watchlist reorder) — no file-drop feature needs it
        dragDropEnabled: false,
        title: `Shioaji Pro — ${type}${code ? ` · ${code}` : ''}`,
        width: 900,
        height: 620,
        minWidth: 420,
        minHeight: 300,
    });
}

// 閃電全開: pop a flash-order window per code, arranged by the chosen
// layout — full-screen grids, a right-side column, or a bottom row.
export interface FlashTileLayout {
    cols: number;
    rows: number;
    region: 'full' | 'right' | 'bottom';
}

export async function openFlashTiles(
    codes: string[],
    layout: FlashTileLayout = { cols: 3, rows: 3, region: 'full' },
) {
    const count = Math.min(codes.length, layout.cols * layout.rows);
    if (count === 0) return;
    const use = codes.slice(0, count);
    const availW = window.screen.availWidth;
    const availH = window.screen.availHeight;
    let originX = 0;
    let originY = 0;
    let gridW = availW;
    let gridH = availH;
    if (layout.region === 'right') {
        gridW = Math.max(360, Math.floor(availW / 4));
        originX = availW - gridW;
    } else if (layout.region === 'bottom') {
        gridH = Math.max(320, Math.floor(availH / 3));
        originY = availH - gridH;
    }
    const w = Math.floor(gridW / layout.cols);
    const h = Math.floor(gridH / layout.rows);
    const posOf = (i: number) => ({
        x: originX + (i % layout.cols) * w,
        y: originY + Math.floor(i / layout.cols) * h,
    });
    if (!isTauri) {
        use.forEach((code, i) => {
            const { x, y } = posOf(i);
            const qs = new URLSearchParams({ popout: 'flash', code });
            window.open(
                `${window.location.pathname}?${qs}`,
                `sj-flash-tile-${code}`,
                `left=${x},top=${y},width=${w},height=${h},menubar=no,toolbar=no`,
            );
        });
        return;
    }
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    use.forEach((code, i) => {
        const { x, y } = posOf(i);
        const qs = new URLSearchParams({ popout: 'flash', code });
        popoutCounter += 1;
        new WebviewWindow(`popout-flashtile-${popoutCounter}`, {
            url: `index.html?${qs}`,
            dragDropEnabled: false,
            title: `⚡ ${code}`,
            x,
            y,
            width: w,
            height: h,
            // 8 strips on a 1920px screen are 240px each — keep the
            // minimum below the strip width so tiles never overlap
            minWidth: 210,
            minHeight: 280,
        });
    });
}

// ---- app version (for support: shown in the server panel & debug) ----

let cachedVersion: string | null = null;

export async function appVersion(): Promise<string> {
    if (cachedVersion) return cachedVersion;
    if (isTauri) {
        try {
            const { getVersion } = await import('@tauri-apps/api/app');
            cachedVersion = await getVersion();
            return cachedVersion;
        } catch {
            // fall through
        }
    }
    cachedVersion = 'dev';
    return cachedVersion;
}

// ---- auto-update ----

export type AppUpdatePhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'external'
    | 'error';

export interface AppUpdateState {
    phase: AppUpdatePhase;
    version?: string;
    downloadedBytes?: number;
    totalBytes?: number;
    error?: string;
}

const APP_RELEASE_URL =
    'https://github.com/Sinotrade/shioaji-pro-app/releases/latest';

let appUpdateState: AppUpdateState = { phase: 'idle' };
const appUpdateListeners = new Set<() => void>();
let pendingUpdate: Update | null = null;
let updateInFlight = false;

export function getAppUpdateState(): AppUpdateState {
    return appUpdateState;
}

export function subscribeAppUpdateState(listener: () => void): () => void {
    appUpdateListeners.add(listener);
    return () => {
        appUpdateListeners.delete(listener);
    };
}

function setAppUpdateState(state: AppUpdateState) {
    appUpdateState = state;
    appUpdateListeners.forEach((listener) => listener());
}

function updateDownloadProgress(event: DownloadEvent) {
    if (appUpdateState.phase !== 'downloading') return;
    if (event.event === 'Started') {
        setAppUpdateState({
            ...appUpdateState,
            downloadedBytes: 0,
            totalBytes: event.data.contentLength,
        });
        return;
    }
    if (event.event === 'Progress') {
        setAppUpdateState({
            ...appUpdateState,
            downloadedBytes:
                (appUpdateState.downloadedBytes ?? 0) +
                event.data.chunkLength,
        });
    }
}

export async function checkForUpdates(silent: boolean) {
    if (!isTauri || updateInFlight) return;
    // dev build（vite dev / target/debug）不檢查更新 — 否則 dev 環境會
    // 下載正式版並在重啟時把 debug app 換掉
    if (import.meta.env.DEV) {
        if (!silent) {
            notify({
                kind: 'info',
                title: 'Dev build 不檢查更新',
                body: '開發模式跳過自動更新，避免被正式版取代',
            });
        }
        return;
    }
    if (appUpdateState.phase === 'ready') {
        if (!silent) {
            notify({
                kind: 'info',
                title: `更新 v${appUpdateState.version} 已下載`,
                body: '請按「重新啟動並更新」完成安裝',
            });
        }
        return;
    }
    if (appUpdateState.phase === 'external') {
        if (!silent) {
            notify({
                kind: 'info',
                title: `有新版 v${appUpdateState.version}`,
                body: 'RPM／DEB 安裝版請從下載頁或系統套件管理器更新',
            });
        }
        return;
    }
    updateInFlight = true;
    setAppUpdateState({ phase: 'checking' });
    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) {
            setAppUpdateState({ phase: 'idle' });
            if (!silent) {
                notify({
                    kind: 'info',
                    title: '已是最新版本',
                    body: '目前沒有可用更新',
                });
            }
            return;
        }
        setAppUpdateState({ phase: 'available', version: update.version });
        const { invoke } = await import('@tauri-apps/api/core');
        const canInstall = await invoke<boolean>(
            'supports_in_app_update',
        ).catch(() => !/Linux/i.test(navigator.userAgent));
        if (!canInstall) {
            await update.close().catch(() => undefined);
            setAppUpdateState({
                phase: 'external',
                version: update.version,
            });
            notify({
                kind: 'info',
                title: `有新版 v${update.version}`,
                body: 'RPM／DEB 安裝版請從下載頁或系統套件管理器更新',
            });
            return;
        }
        pendingUpdate = update;
        setAppUpdateState({
            phase: 'downloading',
            version: update.version,
            downloadedBytes: 0,
        });
        await update.download(updateDownloadProgress);
        setAppUpdateState({ phase: 'ready', version: update.version });
        notify({
            kind: 'info',
            title: `更新 v${update.version} 已下載`,
            body: '可在方便時重新啟動並完成更新',
        });
    } catch (e) {
        await pendingUpdate?.close().catch(() => undefined);
        pendingUpdate = null;
        const message = e instanceof Error ? e.message : String(e);
        setAppUpdateState({ phase: 'error', error: message });
        if (!silent) {
            notify({
                kind: 'err',
                title: '更新檢查失敗',
                body: message,
            });
        }
    } finally {
        updateInFlight = false;
    }
}

export async function restartAndInstallUpdate() {
    if (
        !isTauri ||
        updateInFlight ||
        appUpdateState.phase !== 'ready' ||
        !pendingUpdate
    ) {
        return;
    }
    updateInFlight = true;
    const update = pendingUpdate;
    setAppUpdateState({ phase: 'installing', version: update.version });
    try {
        await update.install();
        pendingUpdate = null;
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
    } catch (e) {
        await update.close().catch(() => undefined);
        pendingUpdate = null;
        const message = e instanceof Error ? e.message : String(e);
        setAppUpdateState({
            phase: 'error',
            version: update.version,
            error: message,
        });
        notify({
            kind: 'err',
            title: '更新安裝失敗',
            body: message,
        });
    } finally {
        updateInFlight = false;
    }
}

export async function openLatestRelease() {
    try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(APP_RELEASE_URL);
    } catch (e) {
        notify({
            kind: 'err',
            title: '無法開啟下載頁',
            body: e instanceof Error ? e.message : String(e),
        });
    }
}

// ---- tray events ----

export async function listenTrayEvents(onOpenServerManager: () => void) {
    if (!isTauri) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    const un1 = await listen('open-server-manager', onOpenServerManager);
    const un2 = await listen('check-updates', () => checkForUpdates(false));
    return () => {
        un1();
        un2();
    };
}
