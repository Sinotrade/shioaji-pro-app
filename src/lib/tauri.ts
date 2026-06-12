// src/lib/tauri.ts — desktop bridge: sidecar server management, popout
// windows, auto-updates. Every entry point is a no-op in the browser.

import { getApiPort, isTauri, setApiPort } from './runtime';
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
    try {
        await cmd.spawn();
    } catch (e) {
        return { ok: false, output: `啟動失敗：${String(e)}` };
    }
    // poll until the server answers, or it dies, or we give up (~45s covers a
    // production login + CA activation + contract load)
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if (await probeShioaji(port)) {
            return { ok: true, output: buf.replace(ANSI_RE, '').trim() };
        }
        if (exitCode !== null && exitCode !== 0) {
            // process exited before serving — a real start failure
            return { ok: false, output: buf.replace(ANSI_RE, '').trim() };
        }
    }
    return {
        ok: false,
        output:
            `${buf.replace(ANSI_RE, '').trim()}\n啟動逾時（45 秒未就緒）`.trim(),
    };
}

export async function serverStatus(): Promise<ServerStatus | null> {
    if (!isTauri) return null;
    try {
        const res = await sidecar(['server', 'status', '--format', 'json']);
        const jsonStart = res.output.indexOf('{');
        if (jsonStart >= 0) {
            return JSON.parse(res.output.slice(jsonStart)) as ServerStatus;
        }
    } catch {
        // sidecar missing / failed
    }
    return null;
}

// is a shioaji HTTP server already answering on this port?
async function probeShioaji(port: number): Promise<boolean> {
    try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const res = await tauriFetch(
            `http://127.0.0.1:${port}/api/v1/info`,
            { signal: AbortSignal.timeout(1500) },
        );
        if (!res.ok) return false;
        const info = (await res.json()) as {
            version?: string;
            simulation?: boolean;
        };
        return (
            typeof info.version === 'string' &&
            typeof info.simulation === 'boolean'
        );
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

    // our own daemon already running (possibly on a non-default port)?
    const st = await serverStatus();
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
        // unhealthy, wrong mode, or CA not active — restart with the
        // requested settings instead of attaching to a daemon that can't
        // place orders (v0.1.13 stuck-at-連線中 + the CA-less attach bug)
        await sidecar(['server', 'stop']);
        await new Promise((r) => setTimeout(r, 1200));
    }

    // a shioaji server already on 8080 (e.g. the user's own CLI daemon)?
    // attach only if it can actually trade in the requested mode — a CA-less
    // daemon here is exactly why "加了 CA 還是 400" on the installed app
    if (await probeShioaji(8080)) {
        if (!needsCa || (await caActive(8080))) {
            return {
                ok: true,
                output: '偵測到既有 shioaji server（:8080），直接連接',
                port: 8080,
                attached: true,
                portChanged: setApiPort(8080),
            };
        }
        // external daemon on 8080 without active CA — we can't restart it
        // (not ours); tell the user instead of silently 400-ing every order
        return {
            ok: false,
            output:
                ':8080 已有一個 shioaji server，但它的 CA 未啟用，正式環境無法下單。' +
                '請先停掉那個伺服器（如自行用 CLI 啟動的），再用本 App 啟動以套用憑證。',
            port: 8080,
            attached: false,
            portChanged: false,
        };
    }

    // 8080 occupied by something else → bind the first free port instead
    let port = 8080;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const free = await invoke<number>('find_free_port', {
            preferred: 8080,
        });
        if (free > 0) port = free;
    } catch {
        // command unavailable — try 8080 and let the server error surface
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
        res.ok && port !== 8080
            ? `\n⚠ 8080 被占用，伺服器改用 port ${port}`
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

export async function serverStop(): Promise<SidecarResult> {
    return sidecar(['server', 'stop']);
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
