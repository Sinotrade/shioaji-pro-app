// src/lib/boot-early-stream.test.ts — bootstrap opens the quote/order stream
// early only in the main window, only on the reload a timing run triggered
// after the server was healthy (#142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_SERVER_VERSION } from './runtime';

const m = vi.hoisted(() => ({
    child: false,
    navType: 'reload' as string,
    ensureStream: vi.fn(),
    holdStream: vi.fn(),
    releaseStream: vi.fn(),
    startTrading: vi.fn(),
    // the persisted foreign-port block each time boot released reads
    blockedAtRelease: [] as (string | null)[],
}));
vi.mock('./server-read-gate', async (orig) => {
    const real = await orig<typeof import('./server-read-gate')>();
    return { ...real, releaseServerReads: () => {
        m.blockedAtRelease.push(localStorage.getItem('sj-pro-foreign-port'));
        real.releaseServerReads();
    } };
});
vi.mock('./runtime', async (orig) => ({ ...(await orig<object>()), isTauri: true }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));
vi.mock('./features', () => ({ agentModule: undefined }));
vi.mock('./stream', () => ({ ensureStream: m.ensureStream, holdStream: m.holdStream, releaseStream: m.releaseStream, onOrderEvent: vi.fn(), getStreamStatus: () => 'disconnected', subscribeStatusStore: vi.fn() }));
vi.mock('./trade', () => ({ notify: vi.fn(), logNotice: vi.fn() }));
vi.mock('./frontend-ready', () => ({ appReadySignals: () => [], watchFrontendReady: vi.fn(), startStallProbe: vi.fn() }));
vi.mock('./trading-state', () => ({ startTradingState: m.startTrading }));
vi.mock('./account-store', () => ({ ensureAccounts: vi.fn(), loadAccountsShared: vi.fn() }));
vi.mock('./shioaji', () => ({
    fetchHealth: vi.fn(async () => ({ status: 'healthy' })),
    fetchInfo: vi.fn(async () => ({ version: '' })),
    subscribeTradeEvents: vi.fn(),
}));
vi.mock('./tauri', () => ({
    // autostart off: run() goes straight to its health check
    loadDesktopSettings: vi.fn(async () => ({ autoStart: false, configured: true, credentialRevision: 'revision' })),
    serverStatus: vi.fn(async () => ({ running: false })),
    serverStart: vi.fn(),
    reloadWhenHealthy: vi.fn(),
    localTlsCertExists: vi.fn(async () => false),
    nativeOwnsHarnessSidecar: vi.fn(async () => false),
    caActive: vi.fn(async () => false),
    // the real rule: Harness on needs a sidecar the native shell owns
    harnessOwnershipCompatible: (enabled?: boolean, owned?: boolean) => !enabled || !!owned,
    // #285: by default the server is this App's own spawn
    foreignServerCheck: vi.fn(async () => null),
    ownsServer: vi.fn(async () => true),
    learnOwnIdentity: vi.fn(async () => undefined),
    consumeTrayReadyOnReload: () => false,
    markTrayReadyOnReload: vi.fn(),
    setTrayStatus: vi.fn(),
}));

const store = new Map<string, string>();
const bootTimers = new Set<ReturnType<typeof setTimeout>>();

async function boot(lastStage: 'reload' | 'wait-health' | null, configure?: () => Promise<void>) {
    vi.resetModules();
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
        setTimeout: (fn: (...args: unknown[]) => void, ms: number) => {
            const timer = setTimeout(fn, ms);
            bootTimers.add(timer);
            return timer;
        },
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
            clearTimeout(timer);
            bootTimers.delete(timer);
        },
        setInterval, clearInterval,
        matchMedia: () => ({ addEventListener: vi.fn() }),
        location: { search: '', reload: vi.fn() },
    }));
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: m.navType }], timeOrigin: Date.now(), now: () => 0 });
    await configure?.();
    const timing = await import('./startup-timing');
    if (lastStage) {
        timing.beginTiming('restart');
        timing.markStage('healthy');
        timing.markStage(lastStage);
    }
    const { bootstrap } = await import('./boot');
    bootstrap();
}

beforeEach(() => {
    vi.clearAllMocks();
    m.child = false;
    m.navType = 'reload';
    m.ensureStream.mockClear();
    m.startTrading.mockClear();
    m.blockedAtRelease = [];
    m.holdStream.mockClear();
    m.releaseStream.mockClear();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    for (const timer of bootTimers) clearTimeout(timer);
    bootTimers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('early stream at bootstrap', () => {
    it('opens it synchronously on the post-health reload in the main window', async () => {
        await boot('reload');
        expect(m.ensureStream).toHaveBeenCalledTimes(1);
        // the trading snapshot starts at page load too, not after React mounts
        expect(m.startTrading).toHaveBeenCalledTimes(1);
        const timing = await import('./startup-timing');
        expect(timing.getActiveTiming()?.marks.filter(mark => mark.stage === 'trading-start')).toHaveLength(1);
    });

    it('records trading-start when a cold launch attaches to a healthy server', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322,
                simulation: true, version: EXPECTED_SERVER_VERSION, scheme: 'http',
            });
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const timing = await import('./startup-timing');
        expect(timing.getActiveTiming()?.marks.filter(mark => mark.stage === 'trading-start')).toHaveLength(1);
    });

    it('ends the continued timing run if desktop settings cannot be read', async () => {
        await boot('reload', async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockRejectedValueOnce(new Error('settings unavailable'));
        });
        const timing = await import('./startup-timing');
        await vi.waitFor(() => expect(timing.getTimingHistory()[0]?.outcome).toBe('failed'));
        expect(timing.getActiveTiming()).toBeNull();
    });

    it('never in a child window', async () => {
        m.child = true;
        await boot('reload');
        expect(m.ensureStream).not.toHaveBeenCalled();
        expect(m.startTrading).not.toHaveBeenCalled();
    });

    it('a child window cannot clear the main window trade block', async () => {
        m.child = true;
        await boot(null, async () => {
            store.set('sj-pro-server-identity-verified', '0');
        });
        const shioaji = await import('./shioaji');
        await vi.waitFor(() => expect(shioaji.fetchHealth).toHaveBeenCalled());
        expect(store.get('sj-pro-server-identity-verified')).toBe('0');
    });

    it('not on an app launch, without a run, or before the server was healthy', async () => {
        m.navType = 'navigate';
        await boot('reload');
        expect(m.ensureStream).not.toHaveBeenCalled();
        m.navType = 'reload';
        await boot(null);
        expect(m.ensureStream).not.toHaveBeenCalled();
        await boot('wait-health');
        expect(m.ensureStream).not.toHaveBeenCalled();
    });

    it('an App launch holds the stream until boot keeps the page', async () => {
        m.navType = 'navigate';
        await boot(null);
        expect(m.holdStream).toHaveBeenCalledTimes(1);
        // autostart off in this fixture → boot keeps the page → released
        await vi.waitFor(() => expect(m.releaseStream).toHaveBeenCalled());
    });

    it('no hold on a reload or in a child window', async () => {
        await boot('reload');
        expect(m.holdStream).not.toHaveBeenCalled();
        m.navType = 'navigate';
        m.child = true;
        await boot(null);
        expect(m.holdStream).not.toHaveBeenCalled();
    });

    it('does not adopt an incompatible server after autostart refuses it', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: true,
                version: '1.7.6', scheme: 'http',
            });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'foreign server', port: 21322,
                attached: false, portChanged: false,
            });
        });
        const tauri = await import('./tauri');
        const shioaji = await import('./shioaji');
        const timing = await import('./startup-timing');
        await vi.waitFor(() => expect(timing.getTimingHistory()[0]?.outcome).toBe('failed'));
        expect(tauri.serverStart).toHaveBeenCalledTimes(1);
        expect(shioaji.fetchHealth).not.toHaveBeenCalled();
        expect(m.releaseStream).toHaveBeenCalledWith('boot kept page');
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(window.location.reload).not.toHaveBeenCalled();
    });

    it('keeps watching after a spawn failure and adopts only a compatible healthy server', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus)
                .mockResolvedValueOnce({ running: false })
                .mockResolvedValueOnce({ running: true, healthy: true, port: 21322,
                    simulation: true, version: EXPECTED_SERVER_VERSION, scheme: 'http' });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'spawn failed', port: 21322,
                attached: false, portChanged: false,
            });
        });
        await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(1));
        expect(m.releaseStream).toHaveBeenCalledWith('boot kept page');
    });

    it('refuses a production listener whose configured CA is inactive', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: true,
                caPath: '/qa/cert.pfx',
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: false,
                version: EXPECTED_SERVER_VERSION, scheme: 'http',
            });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'CA inactive', port: 21322,
                attached: false, portChanged: false,
            });
        });
        const tauri = await import('./tauri');
        await vi.waitFor(() => expect(tauri.caActive).toHaveBeenCalledWith(21322, 'http'));
        expect(tauri.serverStart).not.toHaveBeenCalled();
        expect(m.startTrading).not.toHaveBeenCalled();
    });

    // #285 — another program's server is used only in the right environment
    // and on the same account; otherwise never adopted, never read
    const prodElsewhere = { running: true, healthy: true, port: 21322, simulation: false, version: EXPECTED_SERVER_VERSION, scheme: 'http' as const };
    const refusal = { reason: 'mode' as const, text: ':21322 上另一個程式啟動的正式伺服器與本 App 設定（模擬）不符，未連上' };

    it('autostart: another App\'s production server is not adopted; this App starts its own elsewhere', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.ownsServer).mockResolvedValueOnce(false);
            vi.mocked(tauri.foreignServerCheck).mockResolvedValueOnce(refusal);
            vi.mocked(tauri.serverStart).mockReset().mockResolvedValueOnce({
                ok: true, output: '', port: 21323, attached: false, portChanged: true,
                foreign: { port: 21322, simulation: false, text: refusal.text },
            });
        });
        const tauri = await import('./tauri');
        const trade = await import('./trade');
        await vi.waitFor(() => expect(tauri.serverStart).toHaveBeenCalledTimes(1));
        expect(vi.mocked(tauri.serverStart).mock.calls[0]![0]).toMatchObject({ knownStatus: prodElsewhere });
        await vi.waitFor(() => expect(trade.notify).toHaveBeenCalledWith(expect.objectContaining({
            title: '未使用另一個程式的伺服器', body: expect.stringContaining('port 21323') })));
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(tauri.learnOwnIdentity).not.toHaveBeenCalled();
    });

    it('autostart off: a refused foreign server is never read and the header offers this App\'s own', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: false, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.ownsServer).mockResolvedValueOnce(false);
            vi.mocked(tauri.foreignServerCheck).mockResolvedValueOnce(refusal);
        });
        const adoption = await import('./server-adoption');
        const runtime = await import('./runtime');
        await vi.waitFor(() => expect(adoption.getServerAttachment()).toMatchObject({ kind: 'refused', port: 21322, simulation: false }));
        expect(runtime.foreignServerPortBlocked()).toBe(21322);
        const tauri = await import('./tauri');
        expect(tauri.serverStart).not.toHaveBeenCalled(); // offered, not forced
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(window.location.reload).not.toHaveBeenCalled();
    });

    it('a server another program started, checked and adopted, is labelled as such', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.ownsServer).mockResolvedValueOnce(false);
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const adoption = await import('./server-adoption');
        expect(adoption.getServerAttachment()).toEqual({ kind: 'external', port: 21322, simulation: false });
        const tauri = await import('./tauri');
        expect(tauri.learnOwnIdentity).not.toHaveBeenCalled();
    });

    it('this App\'s own server: its account is learned for later comparisons', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const adoption = await import('./server-adoption');
        expect(adoption.getServerAttachment()).toEqual({ kind: 'own', port: 21322 });
        const tauri = await import('./tauri');
        expect(tauri.learnOwnIdentity).toHaveBeenCalledWith(prodElsewhere);
    });
    it('a changed native credential revision cannot adopt the old healthy spawn after reload', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            store.set('sj-pro-spawn-keys', 'old-native-revision');
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'new-native-revision', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({ ok: true, output: '', port: 21322, attached: false, portChanged: false });
        });
        const tauri = await import('./tauri');
        await vi.waitFor(() => expect(tauri.serverStart).toHaveBeenCalledOnce());
        expect(tauri.learnOwnIdentity).not.toHaveBeenCalled();
        expect(m.startTrading).not.toHaveBeenCalled();
    });
    // #285 regression (QA build, Agent Harness on): a block persisted by an
    // earlier run must never outlive this boot's decision — with it, every
    // read went to a dead address (watchlist names, positions, rankings)
    it('a foreign-port block left by an earlier run is dropped before any read is released', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            store.set('sj-pro-foreign-port', '21322');
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: true, version: EXPECTED_SERVER_VERSION, scheme: 'http',
            });
        });
        const runtime = await import('./runtime');
        const gate = await import('./server-read-gate');
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        // the moment reads were released, the stale block was already gone
        expect(m.blockedAtRelease.length).toBeGreaterThan(0);
        expect(m.blockedAtRelease[0]).toBeNull();
        expect(gate.serverReadsHeld()).toBeNull();
        expect(runtime.foreignServerPortBlocked()).toBeNull();
    });

    it('this App\'s own server is never blocked, even when its identity does not match', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false, agentHarnessEnabled: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            // own orphan from the previous launch: Harness mismatch → restarted
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: true, version: EXPECTED_SERVER_VERSION, scheme: 'http',
            });
            vi.mocked(tauri.serverStart).mockReset().mockResolvedValueOnce({
                ok: true, output: '', port: 21322, attached: false, portChanged: false,
            });
        });
        const tauri = await import('./tauri');
        await vi.waitFor(() => expect(tauri.serverStart).toHaveBeenCalledTimes(1));
        const runtime = await import('./runtime');
        expect(runtime.foreignServerPortBlocked()).toBeNull();
    });

    it('another program\'s server still on the App\'s port stays blocked when reads are released', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            store.set('sj-pro-foreign-port', '21322');
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: false, configured: true, credentialRevision: 'revision', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.ownsServer).mockResolvedValueOnce(false);
            vi.mocked(tauri.foreignServerCheck).mockResolvedValueOnce(refusal);
        });
        const runtime = await import('./runtime');
        expect(runtime.foreignServerPortBlocked()).toBe(21322); // never dropped in between
        const adoption = await import('./server-adoption');
        await vi.waitFor(() => expect(adoption.getServerAttachment()).toMatchObject({ kind: 'refused', port: 21322 }));
        expect(runtime.foreignServerPortBlocked()).toBe(21322);
    });

    // #285 customer report (v0.1.53): the user's own same-version CLI server
    // on 8080 while Agent Harness is on
    it('customer: CLI server on 8080 + Harness on → this App starts its own on 21322 and says so', async () => {
        m.navType = 'navigate';
        const cli = { running: true, healthy: true, port: 8080, simulation: true, version: EXPECTED_SERVER_VERSION, scheme: 'http' as const };
        const text = ':8080 上另一個程式啟動的伺服器（已開啟 Agent Harness，本 App 只使用自己啟動的伺服器），未連上，也不會停止它';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, configured: true, credentialRevision: 'revision', production: false, agentHarnessEnabled: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(cli);
            vi.mocked(tauri.ownsServer).mockResolvedValue(false);
            vi.mocked(tauri.serverStart).mockReset().mockResolvedValueOnce({
                ok: true, output: '', port: 21322, attached: false, portChanged: false,
                foreign: { port: 8080, simulation: true, text },
            });
            vi.mocked(tauri.reloadWhenHealthy).mockResolvedValueOnce(true);
        });
        const tauri = await import('./tauri');
        const trade = await import('./trade');
        await vi.waitFor(() => expect(tauri.serverStart).toHaveBeenCalledTimes(1));
        expect(vi.mocked(tauri.serverStart).mock.calls[0]![0]).toMatchObject({ knownStatus: cli, agentHarnessEnabled: true });
        await vi.waitFor(() => expect(trade.notify).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'info', title: '未使用另一個程式的伺服器', body: `${text}；本 App 的伺服器改在 port 21322 啟動` })));
        for (const [n] of vi.mocked(trade.notify).mock.calls) {
            expect(`${n.title} ${n.body ?? ''}`).not.toMatch(/claude|codex|openai|anthropic/i);
        }
        // the App's own port stays readable; the reload lands on its own server
        const runtime = await import('./runtime');
        expect(runtime.foreignServerPortBlocked()).toBeNull();
        await vi.waitFor(() => expect(tauri.reloadWhenHealthy).toHaveBeenCalled());
        vi.mocked(tauri.ownsServer).mockResolvedValue(true);
    });
});
