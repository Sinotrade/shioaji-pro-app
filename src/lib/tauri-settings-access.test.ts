import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ child: false, invoke: vi.fn() }));
vi.mock('./runtime', async original => ({ ...await original<object>(), isTauri: true }));
vi.mock('./window-role', () => ({ isChildWindow: () => mocks.child }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { EMPTY_DESKTOP_SETTINGS, loadDesktopSettings, saveDesktopSettings, saveCredentialProfile, selectCredentialProfile, deleteCredentialProfile, logoutCredentialProfile, type DesktopSettings } from './desktop-credentials';
let settings: DesktopSettings;
beforeEach(() => {
    mocks.child = false; mocks.invoke.mockReset();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('window', new EventTarget());
    settings = { ...EMPTY_DESKTOP_SETTINGS, configured: true, activeProfileId: 'one', credentialRevision: 'revision' };
    mocks.invoke.mockImplementation(async () => settings);
});
describe('native credential settings boundary', () => {
    it('refuses every credential operation from child windows before IPC', async () => {
        mocks.child = true;
        for (const run of [() => loadDesktopSettings(), () => saveDesktopSettings(settings), () => saveCredentialProfile({ name: 'test', environment: 'simulation', caPath: '' }), () => selectCredentialProfile('one'), () => deleteCredentialProfile('one'), () => logoutCredentialProfile()]) {
            await expect(run()).rejects.toThrow('只能在主視窗');
        }
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
    it('shares concurrent boot/gate reads and publishes only non-secret setup state', async () => {
        const [a, b] = await Promise.all([loadDesktopSettings(), loadDesktopSettings()]);
        expect(a).toBe(b); expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_status', undefined);
        expect(localStorage.setItem).toHaveBeenCalledWith('sj-desktop-configured', 'true');
        expect(a).not.toHaveProperty('apiKey'); expect(a).not.toHaveProperty('secretKey'); expect(a).not.toHaveProperty('caPassword');
    });
    it('receives successful migration only as a non-secret profile index', async () => {
        settings.profiles = [{ id: 'one', name: '預設帳戶', environment: 'production', caPath: '/fixture/ca.pfx', createdAt: '2026-10-20', hasCA: true, apiKeyMasked: '••••1234', secretState: 'stored', credentialBackend: 'system', revision: 'native-digest' }];
        const result = await loadDesktopSettings();
        expect(result.configured).toBe(true); expect(result.profiles[0]?.name).toBe('預設帳戶');
        expect(result.migrationError).toBeNull();
    });
    it('preserves failed migration status and does not mark desktop configured', async () => {
        settings = { ...settings, configured: false, migrationError: '舊版憑證遷移未完成；明文設定已保留' };
        expect((await loadDesktopSettings()).migrationError).toContain('明文設定已保留');
        expect(localStorage.setItem).toHaveBeenCalledWith('sj-desktop-configured', 'false');
    });
    it('returns Linux fallback warning and path without plaintext', async () => {
        settings = { ...settings, credentialBackend: 'plaintext-fallback', fallbackPath: '/fixture/credentials.json' };
        expect(await loadDesktopSettings()).toMatchObject({ credentialBackend: 'plaintext-fallback', fallbackPath: '/fixture/credentials.json' });
    });
    it('writes only preferences even if passed a runtime object with obsolete secrets', async () => {
        await saveDesktopSettings({ ...settings, ...{ apiKey: 'NEVER-SAVE', secretKey: 'NEVER-SAVE', caPasswd: 'NEVER-SAVE' } });
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_preferences', { preferences: { autoStart: true, httpsEnabled: false, agentHarnessEnabled: true } });
    });
    it('sends new secrets once and wipes the caller payload after success or failure', async () => {
        for (const fail of [false, true]) {
            let sent: unknown;
            mocks.invoke.mockImplementationOnce(async (_command, args) => { sent = structuredClone(args); if (fail) throw new Error('storage unavailable'); return settings; });
            const draft = { name: 'test', environment: 'simulation' as const, caPath: '/fixture/ca', apiKey: 'canary-api', secretKey: 'canary-secret', caPassword: 'canary-password' };
            const result = saveCredentialProfile(draft);
            if (fail) await expect(result).rejects.toThrow(); else await result;
            expect(sent).toMatchObject({ profile: { apiKey: 'canary-api', secretKey: 'canary-secret', caPassword: 'canary-password' } });
            expect(draft).not.toHaveProperty('apiKey'); expect(draft).not.toHaveProperty('secretKey'); expect(draft).not.toHaveProperty('caPassword');
        }
    });
    it('switches, deletes and logs out through explicit native commands', async () => {
        await selectCredentialProfile('two'); await deleteCredentialProfile('one');
        settings = { ...settings, configured: false, activeProfileId: null };
        await logoutCredentialProfile();
        expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['credentials_select', 'credentials_delete', 'credentials_logout']);
        expect(localStorage.setItem).toHaveBeenLastCalledWith('sj-desktop-configured', 'false');
    });
    it('a stale read cannot republish configured state after logout', async () => {
        let finish!: (value: DesktopSettings) => void;
        mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const stale = loadDesktopSettings();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        settings = { ...settings, configured: false, activeProfileId: null };
        await logoutCredentialProfile();
        finish({ ...settings, configured: true }); await stale;
        expect(localStorage.setItem).toHaveBeenLastCalledWith('sj-desktop-configured', 'false');
        expect((await loadDesktopSettings()).configured).toBe(false);
    });
    it('an earlier preferences response cannot undo a later logout flag', async () => {
        let finish!: (value: DesktopSettings) => void;
        mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const oldSave = saveDesktopSettings(settings);
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        settings = { ...settings, configured: false, activeProfileId: null };
        await logoutCredentialProfile();
        finish({ ...settings, configured: true }); await oldSave;
        expect(localStorage.setItem).toHaveBeenLastCalledWith('sj-desktop-configured', 'false');
    });
});
