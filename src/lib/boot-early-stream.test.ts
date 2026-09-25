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
    fetchHealth: vi.fn(async () => ({})),
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
    harnessOwnershipCompatible: () => true,
}));

const store = new Map<string, string>();

async function boot(lastStage: 'reload' | 'wait-health' | null) {
    vi.resetModules();
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '', reload: vi.fn() } }));
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: m.navType }], timeOrigin: Date.now(), now: () => 0 });
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
    m.child = false;
    m.navType = 'reload';
    m.ensureStream.mockClear();
    m.startTrading.mockClear();
    m.holdStream.mockClear();
    m.releaseStream.mockClear();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
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
});
