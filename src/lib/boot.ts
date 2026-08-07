// src/lib/boot.ts — startup orchestration:
// 1. Desktop: auto-start the bundled shioaji server when keys are saved.
// 2. If the app booted while the server was unreachable, watch /health and
//    reload once it comes up so every panel bootstraps cleanly. Transient
//    outages after a healthy boot are handled by the SSE self-heal instead.

import {
    fetchAccounts,
    fetchHealth,
    fetchInfo,
    subscribeTradeEvents,
} from './shioaji';
import { agentModule } from './features';
import { describeOrderReport } from './order-report';
import {
    EXPECTED_SERVER_VERSION,
    isTauri,
    setApiPort,
    setApiScheme,
} from './runtime';
import { onOrderEvent } from './stream';
import {
    loadDesktopSettings,
    localTlsCertExists,
    serverStart,
    serverStatus,
} from './tauri';
import { logNotice, notify } from './trade';

let booted = false;

// Windows/WebView2 keyboard-focus self-heal. The native window can be
// ACTIVE while the webview holds no keyboard focus — mouse keeps working
// but every keystroke is dropped (對話框打不了字，重啟才會好). Whenever
// the window reports focus (or the user clicks into the page), check
// shortly after whether the document really took focus, and hand it back
// to the webview if not. The hasFocus() guard is what keeps this safe:
// re-focusing UNCONDITIONALLY on every focus event creates a native
// focus ping-pong storm that itself kills keyboard input.
function installKeyboardFocusHeal() {
    if (!isTauri) return;
    let pending = 0;
    const healSoon = () => {
        if (pending) return;
        pending = window.setTimeout(() => {
            pending = 0;
            if (document.hasFocus()) return;
            void import('@tauri-apps/api/webview')
                .then(({ getCurrentWebview }) =>
                    getCurrentWebview().setFocus(),
                )
                .catch(() => undefined);
        }, 150);
    };
    void import('@tauri-apps/api/webviewWindow')
        .then(({ getCurrentWebviewWindow }) =>
            getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
                if (payload) healSoon();
            }),
        )
        .catch(() => undefined);
    window.addEventListener('pointerdown', healSoon, true);
}

export function bootstrap() {
    if (booted) return;
    booted = true;
    installKeyboardFocusHeal();
    // agent scheduled/triggered tasks run for the app's lifetime
    agentModule?.ensureScheduler();
    // every order event lands in the 通知中心 log (toasts stay separate)
    onOrderEvent((ev) => {
        const d = describeOrderReport(ev);
        logNotice({
            kind: d.kind === 'err' ? 'err' : 'info',
            title: d.title,
            body: d.lines.map((l) => l.text).join(' ｜ '),
        });
    });
    void run();
}

async function run() {
    // only the main window may auto-start the server — the tray panel,
    // popouts and flash tiles each run their own bootstrap(), and concurrent
    // serverStarts race for the same port and clobber the pid record. They
    // still get the health watchdog below.
    const isPopout = new URLSearchParams(window.location.search).has(
        'popout',
    );
    if (isTauri && !isPopout) {
        try {
            const settings = await loadDesktopSettings();
            if (settings.autoStart && settings.apiKey && settings.secretKey) {
                const status = await serverStatus();
                // 本機 HTTPS：the desired listener scheme also has to match
                // — an http daemon while HTTPS is enabled (or vice versa)
                // needs a restart to swap the listener. Judge a RUNNING
                // https listener by its scheme alone: it serving TLS proves
                // the certificate exists, and probing the cert file here
                // (plugin-fs right at boot) can transiently fail — which
                // used to misread "cert missing → want http", kill the
                // healthy https server, and loop forever.
                const scheme = status?.scheme ?? 'http';
                const schemeOk = settings.httpsEnabled
                    ? scheme === 'https' ||
                      !(await localTlsCertExists().catch(() => false))
                    : scheme === 'http';
                // identity match: right mode, right listener scheme, right
                // version — health is judged separately so a server that is
                // merely WARMING UP (login + contract load, /health not yet
                // 200) is never killed. Restart-kill during warmup was a
                // reload loop: each reload landed inside the next server's
                // warmup window and killed it again.
                const matches =
                    status?.running &&
                    status.simulation === !settings.production &&
                    schemeOk &&
                    // version handshake — 不接版本不符的 server（例如
                    // 使用者 8080 上的舊 CLI），改起自帶 sidecar
                    (EXPECTED_SERVER_VERSION === '' ||
                        status.version === undefined ||
                        status.version === EXPECTED_SERVER_VERSION);
                if (matches && status.healthy) {
                    // daemon survived from a previous run (possibly on a
                    // non-default port) — make sure the API base follows it
                    const schemeChanged = status.scheme
                        ? setApiScheme(status.scheme)
                        : false;
                    if (
                        (status.port && setApiPort(status.port)) ||
                        schemeChanged
                    ) {
                        window.location.reload();
                        return;
                    }
                } else if (matches) {
                    // the right server is starting up — adopt its address
                    // and fall through to the bootstrap watchdog below,
                    // which reloads once /health answers
                    if (status.port) setApiPort(status.port);
                    if (status.scheme) setApiScheme(status.scheme);
                } else {
                    // not running, unhealthy, or wrong mode — serverStart
                    // stops a broken daemon and starts fresh
                    if (status?.running) {
                        notify({
                            kind: 'info',
                            title: '♻️ 伺服器狀態異常，自動重啟…',
                            body: `模式：${settings.production ? '⚠ 正式環境' : '模擬環境'}`,
                        });
                    } else {
                        notify({
                            kind: 'info',
                            title: '🚀 自動啟動 shioaji server…',
                            body: `模式：${settings.production ? '⚠ 正式環境' : '模擬環境'}`,
                        });
                    }
                    const res = await serverStart(settings);
                    if (!res.ok) {
                        notify({
                            kind: 'err',
                            title: '伺服器自動啟動失敗',
                            body: res.output.slice(0, 120),
                        });
                    } else if (!res.attached || res.portChanged) {
                        // the daemon (re)started while panels were already
                        // firing their one-shot requests into the gap —
                        // reload once healthy so everything boots cleanly
                        notify({
                            kind: 'info',
                            title: '⏳ 伺服器啟動中…',
                            body: '就緒後畫面將自動重新載入',
                        });
                        const deadline = Date.now() + 90_000;
                        let ticking = false; // overlapping ticks pile probes
                        const timer = setInterval(async () => {
                            if (ticking) return;
                            if (Date.now() > deadline) {
                                clearInterval(timer);
                                return;
                            }
                            ticking = true;
                            try {
                                await fetchHealth();
                                clearInterval(timer);
                                window.location.reload();
                            } catch {
                                // not up yet
                            } finally {
                                ticking = false;
                            }
                        }, 2000);
                        return;
                    }
                }
            }
        } catch {
            // sidecar unavailable — fall through to the health watchdog
        }
    }

    // bootstrap watchdog: reload once the server becomes reachable. Uses
    // the scheme-agnostic status probe (NOT fetchHealth, which is locked to
    // the persisted scheme) so it still finds the server after a 本機 HTTPS
    // toggle left localStorage pointing at the other listener type.
    try {
        await fetchHealth();
        if (await serverVersionOk()) {
            void subscribeProductionTradeEvents();
            return; // server was up at boot — components loaded normally
        }
        // wrong-version server answering on the persisted port — fall
        // through to the watchdog: adopt it only after it's replaced
    } catch {
        notify({
            kind: 'info',
            title: '等待 shioaji server…',
            body: '伺服器就緒後將自動載入畫面',
        });
    }
    let ticking = false; // async ticks must not overlap — probe pile-ups
    // congest plugin-http until even live-server probes time out
    const timer = setInterval(async () => {
        if (ticking) return;
        ticking = true;
        try {
            const st = isTauri ? await serverStatus() : null;
            if (st) {
                if (!st.running || !st.healthy) return;
                if (
                    EXPECTED_SERVER_VERSION !== '' &&
                    st.version !== undefined &&
                    st.version !== EXPECTED_SERVER_VERSION
                ) {
                    return; // wrong-version server — keep waiting
                }
                if (st.port) setApiPort(st.port);
                if (st.scheme) setApiScheme(st.scheme);
            } else {
                await fetchHealth();
                if (!(await serverVersionOk())) return; // warned; keep waiting
            }
            clearInterval(timer);
            window.location.reload();
        } catch {
            // keep waiting
        } finally {
            ticking = false;
        }
    }, 4000);
}

// Health alone must not adopt a server: the persisted port key can be stale,
// and whatever answers there (e.g. an old CLI daemon someone started on 8080)
// would silently hijack every panel — the serverStart/autoStart version
// handshakes never run on this passive path. Desktop-only: the web build is
// served by the very server it talks to, so there's nothing to cross-check.
let versionWarned = false;
async function serverVersionOk(): Promise<boolean> {
    if (!isTauri || EXPECTED_SERVER_VERSION === '') return true;
    try {
        const info = await fetchInfo();
        if (!info.version || info.version === EXPECTED_SERVER_VERSION) {
            return true;
        }
        if (!versionWarned) {
            versionWarned = true;
            notify({
                kind: 'err',
                title: '伺服器版本不符，未採用',
                body: `port 上的 server 是 ${info.version}，本版需要 ${EXPECTED_SERVER_VERSION}——請停掉它，或到「伺服器」面板重新啟動`,
            });
        }
        return false;
    } catch {
        return false; // /info unreachable — transient; keep waiting
    }
}

// In production the order_event SSE stream only emits heartbeats until
// each account is explicitly subscribed (no-op in simulation).
async function subscribeProductionTradeEvents() {
    try {
        const info = await fetchInfo();
        if (info.simulation) return;
        const accounts = await fetchAccounts();
        await Promise.allSettled(
            accounts
                .filter((a) => a.signed)
                .map((a) => subscribeTradeEvents(a)),
        );
    } catch {
        // best-effort — order events fall back to trade polling
    }
}
