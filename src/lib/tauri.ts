// src/lib/tauri.ts — desktop bridge: sidecar server management, popout
// windows, auto-updates. Every entry point is a no-op in the browser.

import {
    DEFAULT_PORT,
    LEGACY_PORT,
    getApiPort,
    getServerPid,
    isTauri,
    setApiPort,
    setServerPid,
} from './runtime';
import { notify } from './trade';

export { isTauri } from './runtime';

// ---- shioaji server sidecar ----

export interface ServerStatus {
    running: boolean;
    pid?: number;
    port?: number;
    healthy?: boolean;
    simulation?: boolean;
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
async function spawnServer(
    args: string[],
    env: Record<string, string>,
    port: number,
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
    // remember the child pid — a foreground `server start` never registers
    // with the CLI daemon state, so stop/restart (even after an app relaunch)
    // must kill this pid ourselves
    if (child?.pid) setServerPid(child.pid);
    // poll until the server answers, or it dies, or we give up (~45s covers a
    // production login + CA activation + contract load)
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await probeInfo(port)) {
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

// The CLI's `server status` only knows daemonized servers — a foreground
// `server start` (which is how this app spawns it) never appears there, and
// its state file goes stale. Ground truth is therefore an HTTP probe of the
// candidate ports; the CLI registry is only consulted as a last resort for
// daemons living on some other port.
export async function serverStatus(): Promise<ServerStatus | null> {
    if (!isTauri) return null;
    const ports = candidatePorts();
    const infos = await Promise.all(ports.map((p) => probeInfo(p)));
    for (const [i, port] of ports.entries()) {
        const info = infos[i];
        if (!info) continue;
        return {
            running: true,
            port,
            healthy: await probeHealthy(port),
            simulation: info.simulation,
            pid: getServerPid() ?? undefined,
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
                const info = await probeInfo(st.port);
                if (info) {
                    return {
                        running: true,
                        port: st.port,
                        healthy: await probeHealthy(st.port),
                        simulation: info.simulation,
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

// is a shioaji HTTP server answering on this port? (null = no / not shioaji)
async function probeInfo(
    port: number,
): Promise<{ version: string; simulation: boolean } | null> {
    try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const res = await tauriFetch(
            `http://127.0.0.1:${port}/api/v1/info`,
            { signal: AbortSignal.timeout(1500) },
        );
        if (!res.ok) return null;
        const info = (await res.json()) as {
            version?: string;
            simulation?: boolean;
        };
        if (
            typeof info.version === 'string' &&
            typeof info.simulation === 'boolean'
        ) {
            return { version: info.version, simulation: info.simulation };
        }
    } catch {
        // not answering
    }
    return null;
}

async function probeHealthy(port: number): Promise<boolean> {
    try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const res = await tauriFetch(
            `http://127.0.0.1:${port}/api/v1/health`,
            { signal: AbortSignal.timeout(2000) },
        );
        return res.ok;
    } catch {
        return false;
    }
}

// is CA active on this daemon? production orders 400 without it. We only
// attach to / keep a daemon for production if its CA is live — otherwise the
// user sets CA in the app but the running daemon never had it (issue #1).
async function caActive(port: number): Promise<boolean> {
    try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const accRes = await tauriFetch(
            `http://127.0.0.1:${port}/api/v1/auth/accounts`,
            { signal: AbortSignal.timeout(2000) },
        );
        if (!accRes.ok) return false;
        const accts = (await accRes.json()) as { person_id?: string }[];
        const pid = accts[0]?.person_id;
        if (!pid) return false;
        const caRes = await tauriFetch(
            `http://127.0.0.1:${port}/api/v1/auth/ca_expiretime?person_id=${encodeURIComponent(pid)}`,
            { signal: AbortSignal.timeout(2000) },
        );
        if (!caRes.ok) return false; // 400 "CA not activated"
        const ca = (await caRes.json()) as { expire_time?: string };
        return !!ca.expire_time && new Date(ca.expire_time).getTime() > Date.now();
    } catch {
        return false;
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
}): Promise<StartResult> {
    // when production+CA is requested, a daemon is only good enough to reuse
    // if its CA is actually active — otherwise orders 400 (issue #1)
    const needsCa = !!opts.production && !!opts.caPath;

    // a shioaji server already answering (ours from a previous run, or the
    // user's own CLI daemon on :8080)? Attach only if it can actually trade
    // in the requested mode — a CA-less daemon here is exactly why
    // "加了 CA 還是 400" on the installed app.
    let st = await serverStatus();
    if (!st?.running) {
        // an orphan of ours can sit on a fallback port with its record lost
        // (cleared web storage) — sweep the find_free_port windows (current
        // default + the pre-21322 legacy one) before piling yet another
        // server on top of it
        const win = [
            ...Array.from({ length: 9 }, (_, i) => DEFAULT_PORT + 1 + i),
            ...Array.from({ length: 5 }, (_, i) => LEGACY_PORT + 1 + i),
        ];
        const infos = await Promise.all(win.map((p) => probeInfo(p)));
        const hit = win.findIndex((_, i) => infos[i]);
        if (hit >= 0) {
            const port = win[hit] as number;
            st = {
                running: true,
                port,
                healthy: await probeHealthy(port),
                simulation: infos[hit]?.simulation,
                pid: getServerPid() ?? undefined,
            };
        }
    }
    if (st?.running && st.port) {
        const modeMismatch =
            st.simulation !== undefined &&
            st.simulation === opts.production;
        const caOk = !needsCa || (await caActive(st.port));
        if (st.healthy && !modeMismatch && caOk) {
            // healthy, right mode, CA live (if needed) — just use it
            return {
                ok: true,
                output: `伺服器已在運行（port ${st.port}）`,
                port: st.port,
                attached: true,
                portChanged: setApiPort(st.port),
            };
        }
        // unhealthy, wrong mode, or CA not active — stop it and start fresh
        // with the requested settings instead of attaching to a daemon that
        // can't place orders (v0.1.13 stuck-at-連線中 + the CA-less attach
        // bug). serverStop kills our remembered pid, so this also works for
        // the foreground servers the CLI daemon registry never sees.
        const stopped = await serverStop();
        if (!stopped.ok && (await probeInfo(st.port))) {
            // still answering — an external server we can't kill; tell the
            // user instead of piling a second server onto another port
            const why = modeMismatch
                ? '模式與設定不符'
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

    // preferred port occupied by something else → first free port after it
    let port = DEFAULT_PORT;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
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
    };
    // CA certificate — required for production orders, ignored in simulation
    if (opts.caPath) {
        env.SJ_CA_PATH = opts.caPath;
        if (opts.caPasswd) env.SJ_CA_PASSWD = opts.caPasswd;
    }
    const args = ['server', 'start', '--no-open'];
    if (opts.production) args.push('--production');
    // spawn (don't await to completion) — the start runs in foreground
    const res = await spawnServer(args, env, port);
    const portChanged = res.ok ? setApiPort(port) : false;
    // the server starts even when CA activation fails (login still works) —
    // catch that warning from the log so the user knows production orders
    // will 400 (e.g. expired certificate) instead of finding out at order time
    const caFail = /Failed to activate CA[^\n]*/i.exec(res.output);
    let note =
        res.ok && port !== DEFAULT_PORT
            ? `\n⚠ ${DEFAULT_PORT} 被占用，伺服器改用 port ${port}`
            : '';
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

// Stop whatever server is serving: kill the pid we spawned (foreground
// servers never appear in the CLI daemon registry, so `server stop` alone
// can't touch them), then let the CLI stop any daemonized one, and finally
// verify the port actually went quiet.
export async function serverStop(): Promise<SidecarResult> {
    if (!isTauri) return { ok: false, output: '' };
    const st = await serverStatus();
    const notes: string[] = [];
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
            if (killed) notes.push(`已終止伺服器（:${port}）`);
        } catch (e) {
            // ownership refused (external shioaji / foreign service) — keep
            // the explanation for the caller; the pid record stays in case
            // it referred to a not-yet-listening child
            notes.push(String(e));
        }
    }
    // a user-run daemon (started via the CLI/dashboard) is stopped here
    const cli = await sidecar(['server', 'stop']);
    if (cli.ok && cli.output) notes.push(cli.output);
    if (st?.running && st.port) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (!(await probeInfo(st.port))) {
                return {
                    ok: true,
                    output: notes.join('\n') || '伺服器已停止',
                };
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        return {
            ok: false,
            output: [
                ...notes,
                `:${st.port} 上的伺服器仍在運行 — 可能不是本 App 啟動的，請手動停止`,
            ]
                .join('\n')
                .trim(),
        };
    }
    return { ok: true, output: notes.join('\n') || '伺服器未在運行' };
}

// ---- settings store (API keys live in the app-data dir, not the repo) ----

export interface DesktopSettings {
    apiKey: string;
    secretKey: string;
    production: boolean;
    autoStart: boolean; // start the shioaji server when the app launches
    caPath: string; // Sinopac.pfx — required for production orders
    caPasswd: string;
}

const EMPTY_SETTINGS: DesktopSettings = {
    apiKey: '',
    secretKey: '',
    production: false,
    autoStart: true,
    caPath: '',
    caPasswd: '',
};

export async function loadDesktopSettings(): Promise<DesktopSettings> {
    if (!isTauri) return { ...EMPTY_SETTINGS };
    const { LazyStore } = await import('@tauri-apps/plugin-store');
    const store = new LazyStore('settings.json');
    return {
        apiKey: (await store.get<string>('apiKey')) ?? '',
        secretKey: (await store.get<string>('secretKey')) ?? '',
        production: (await store.get<boolean>('production')) ?? false,
        autoStart: (await store.get<boolean>('autoStart')) ?? true,
        caPath: (await store.get<string>('caPath')) ?? '',
        caPasswd: (await store.get<string>('caPasswd')) ?? '',
    };
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
    await store.save();
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

let updateInFlight = false;

export async function checkForUpdates(silent: boolean) {
    if (!isTauri || updateInFlight) return;
    updateInFlight = true;
    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) {
            if (!silent) {
                notify({
                    kind: 'info',
                    title: '已是最新版本',
                    body: '目前沒有可用更新',
                });
            }
            return;
        }
        notify({
            kind: 'info',
            title: `⬇️ 下載更新 v${update.version}`,
            body: '更新完成後將自動重新啟動',
        });
        await update.downloadAndInstall();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
    } catch (e) {
        if (!silent) {
            notify({
                kind: 'err',
                title: '更新檢查失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        }
    } finally {
        updateInFlight = false;
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
