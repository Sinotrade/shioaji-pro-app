// src/lib/boot-early-stream.test.ts — bootstrap opens the quote/order stream
// early only in the main window, only on the reload a timing run triggered
// after the server was healthy (#142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    child: false,
    navType: 'reload' as string,
    ensureStream: vi.fn(),
    holdStream: vi.fn(),
    releaseStream: vi.fn(),
    startTrading: vi.fn(),
}));
vi.mock('./runtime', async (orig) => ({ ...(await orig<object>()), isTauri: true }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));
vi.mock('./features', () => ({ agentModule: undefined }));
vi.mock('./stream', () => ({ ensureStream: m.ensureStream, holdStream: m.holdStream, releaseStream: m.releaseStream, onOrderEvent: vi.fn() }));
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
    loadDesktopSettings: vi.fn(async () => ({ autoStart: false, apiKey: '', secretKey: '' })),
    serverStatus: vi.fn(async () => ({ running: false })),
    serverStart: vi.fn(),
    reloadWhenHealthy: vi.fn(),
    localTlsCertExists: vi.fn(async () => false),
    nativeOwnsHarnessSidecar: vi.fn(async () => false),
    caActive: vi.fn(async () => false),
    harnessOwnershipCompatible: () => true,
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
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
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
                autoStart: true, apiKey: 'k', secretKey: 's', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus)
                .mockResolvedValueOnce({ running: false })
                .mockResolvedValueOnce({ running: true, healthy: true, port: 21322,
                    simulation: true, version: '1.7.6', scheme: 'http' });
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
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
                caPath: '/qa/cert.pfx',
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: false,
                version: '1.7.6', scheme: 'http',
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
});
