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
import { ensureAgentScheduler } from '@agent';
import { isTauri, setApiPort } from './runtime';
import { onOrderEvent } from './stream';
import { loadDesktopSettings, serverStart, serverStatus } from './tauri';
import { logNotice, notify } from './trade';

let booted = false;

export function bootstrap() {
    if (booted) return;
    booted = true;
    // agent scheduled/triggered tasks run for the app's lifetime
    ensureAgentScheduler();
    // every order event lands in the 通知中心 log (toasts stay separate)
    onOrderEvent((ev) => {
        const deal = ev.code && ev.price !== undefined;
        logNotice({
            kind: 'info',
            title: deal
                ? `成交 ${ev.code}`
                : `委託回報 ${ev.contract?.code ?? ''}`,
            body: deal
                ? `${ev.action === 'Buy' ? '買' : '賣'} ${ev.quantity} @ ${ev.price}`
                : `${ev.operation?.op_type ?? ''} ${ev.operation?.op_msg || ev.order?.id?.slice(0, 12) || ''}`,
        });
    });
    void run();
}

async function run() {
    if (isTauri) {
        try {
            const settings = await loadDesktopSettings();
            if (settings.autoStart && settings.apiKey && settings.secretKey) {
                const status = await serverStatus();
                const healthyMatch =
                    status?.running &&
                    status.healthy &&
                    status.simulation === !settings.production;
                if (healthyMatch) {
                    // daemon survived from a previous run (possibly on a
                    // non-default port) — make sure the API base follows it
                    if (status.port && setApiPort(status.port)) {
                        window.location.reload();
                        return;
                    }
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
                        const timer = setInterval(async () => {
                            if (Date.now() > deadline) {
                                clearInterval(timer);
                                return;
                            }
                            try {
                                await fetchHealth();
                                clearInterval(timer);
                                window.location.reload();
                            } catch {
                                // not up yet
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

    // bootstrap watchdog: reload once the server becomes reachable
    try {
        await fetchHealth();
        void subscribeProductionTradeEvents();
        return; // server was up at boot — components loaded normally
    } catch {
        notify({
            kind: 'info',
            title: '等待 shioaji server…',
            body: '伺服器就緒後將自動載入畫面',
        });
    }
    const timer = setInterval(async () => {
        try {
            await fetchHealth();
            clearInterval(timer);
            window.location.reload();
        } catch {
            // keep waiting
        }
    }, 4000);
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
