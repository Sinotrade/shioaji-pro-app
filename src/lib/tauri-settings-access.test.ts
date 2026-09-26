import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    child: false,
    values: new Map<string, unknown>(),
    lazyStore: vi.fn(),
}));

vi.mock('./runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./runtime')>()),
    isTauri: true,
}));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('./window-role', () => ({
    isChildWindow: () => mocks.child,
    focusMainWindow: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    LazyStore: class {
        constructor(path: string) {
            mocks.lazyStore(path);
        }
        async get(key: string) { return mocks.values.get(key); }
        async set(key: string, value: unknown) { mocks.values.set(key, value); }
        async save() {}
    },
}));

class MemoryStorage {
    private data = new Map<string, string>();
    getItem(key: string) { return this.data.get(key) ?? null; }
    setItem(key: string, value: string) { this.data.set(key, value); }
    removeItem(key: string) { this.data.delete(key); }
}

import { loadDesktopSettings, saveDesktopSettings } from './tauri';

describe('settings.json access is main-window only', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', new MemoryStorage());
        vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
        mocks.values = new Map<string, unknown>([
            ['apiKey', 'API-KEY-FIXTURE'],
            ['secretKey', 'SECRET-FIXTURE'],
            ['caPasswd', 'CA-PASS-FIXTURE'],
            ['agentHarnessSafeDefaultV1', true],
        ]);
        mocks.lazyStore.mockClear();
    });

    it('refuses to open the store from a child window', async () => {
        mocks.child = true;
        await expect(loadDesktopSettings()).rejects.toThrow('只能在主視窗');
        await expect(saveDesktopSettings({} as never)).rejects.toThrow('只能在主視窗');
        expect(mocks.lazyStore).not.toHaveBeenCalled();
    });

    it('main window loads settings and publishes only the configured boolean', async () => {
        mocks.child = false;
        const settings = await loadDesktopSettings();
        expect(settings.apiKey).toBe('API-KEY-FIXTURE');
        expect(mocks.lazyStore).toHaveBeenCalledWith('settings.json');
        expect(localStorage.getItem('sj-desktop-configured')).toBe('true');
        const shared = JSON.stringify(Object.fromEntries(
            ['sj-desktop-configured', 'sj-agent-harness-enabled'].map((k) => [k, localStorage.getItem(k)]),
        ));
        for (const secret of ['API-KEY-FIXTURE', 'SECRET-FIXTURE', 'CA-PASS-FIXTURE']) {
            expect(shared).not.toContain(secret);
        }

        await saveDesktopSettings({ ...settings, apiKey: '', secretKey: '' });
        expect(localStorage.getItem('sj-desktop-configured')).toBe('false');
    });
});

describe('shared settings read at page start (#142)', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', new MemoryStorage());
        vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
        mocks.child = false;
        mocks.values = new Map<string, unknown>([['apiKey', 'A'], ['secretKey', 'S'], ['agentHarnessSafeDefaultV1', true]]);
        mocks.lazyStore.mockClear();
    });

    it('concurrent callers (boot + main-window gate) join one in-flight read', async () => {
        const [a, b] = await Promise.all([loadDesktopSettings(), loadDesktopSettings()]);
        expect(a).toBe(b);
        expect(mocks.lazyStore).toHaveBeenCalledTimes(1);
    });

    it('a later call reads fresh values', async () => {
        await loadDesktopSettings();
        mocks.values.set('apiKey', 'B');
        expect((await loadDesktopSettings()).apiKey).toBe('B');
        expect(mocks.lazyStore).toHaveBeenCalledTimes(2);
    });

    it('a save drops a read still in flight, so the next load sees the save', async () => {
        const stale = loadDesktopSettings(); // in flight, would return 'A'
        const current = await stale;
        await saveDesktopSettings({ ...current, apiKey: 'SAVED' });
        const pending = loadDesktopSettings();
        expect(pending).not.toBe(stale);
        expect((await pending).apiKey).toBe('SAVED');
    });

    it('a save during an in-flight read: loads after it do not reuse that read', async () => {
        const inFlight = loadDesktopSettings();
        const save = saveDesktopSettings({ apiKey: 'X', secretKey: 'S', production: false, autoStart: true, caPath: '', caPasswd: '', httpsEnabled: false, agentHarnessEnabled: true });
        const after = loadDesktopSettings();
        expect(after).not.toBe(inFlight);
        await save;
        await inFlight;
        expect((await loadDesktopSettings()).apiKey).toBe('X');
    });
});
