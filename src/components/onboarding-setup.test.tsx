import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ panel: vi.fn(() => null), defaults: vi.fn(), load: vi.fn(), save: vi.fn(), select: vi.fn(), start: vi.fn(), reload: vi.fn(), stop: vi.fn(), logout: vi.fn(), clearHash: vi.fn() }));
vi.mock('../lib/spawn-keys', () => ({ clearStoredSpawnKeyHash: mocks.clearHash }));
vi.mock('../lib/features', () => ({ agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults }, useFeature: () => ({ enabled: true }), FEATURES: [] }));
vi.mock('../lib/tauri', async () => ({
    ...await import('../lib/desktop-credentials'), isTauri: true,
    loadDesktopSettings: mocks.load, saveCredentialProfile: mocks.save, selectCredentialProfile: mocks.select,
    pickCaFile: vi.fn(), pickEnvFile: vi.fn(), importEnvCandidate: vi.fn(), reloadWhenHealthy: mocks.reload, serverStart: mocks.start,
    serverStop: mocks.stop, logoutCredentialProfile: mocks.logout,
}));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { OnboardingSetup } from './onboarding-setup';
import { CredentialProfiles } from './credential-profiles';
let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('window', new EventTarget());
    mocks.load.mockResolvedValue(EMPTY_DESKTOP_SETTINGS);
    mocks.stop.mockResolvedValue({ ok: true }); mocks.logout.mockResolvedValue(EMPTY_DESKTOP_SETTINGS);
});
afterEach(async () => { if (view) { await act(async () => view!.unmount()); view = undefined; } vi.unstubAllGlobals(); });
describe('first-run credential profiles', () => {
    it('opts only the embedded guide into onboarding', () => {
        expect(renderToStaticMarkup(createElement(OnboardingSetup))).toContain('引導申請 API Key');
        expect(mocks.panel).toHaveBeenCalledWith({ onboarding: true, initialPrompt: '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？', visibleTabs: ['chat', 'settings'] }, undefined);
    });
    it('starts with the native non-secret read model after saving a new account', async () => {
        const settings: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, configured: true, activeProfileId: 'new', credentialRevision: 'native', profiles: [{ id: 'new', name: '新帳號', environment: 'simulation', hasCA: false, caPath: '', createdAt: '', apiKeyMasked: '••••1234', secretState: 'stored', credentialBackend: 'system', revision: 'native' }] };
        mocks.save.mockResolvedValue(settings); mocks.start.mockResolvedValue({ ok: true });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await act(async () => view!.root.findByType(CredentialProfiles).props.onSave({ name: '新帳號', environment: 'simulation', caPath: '', apiKey: 'test', secretKey: 'test' }, true));
        expect(mocks.start).toHaveBeenCalledWith(settings);
        expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true, ownedOnly: true });
        expect(mocks.start.mock.calls[0]![0]).not.toHaveProperty('apiKey'); expect(mocks.start.mock.calls[0]![0]).not.toHaveProperty('caPassword');
        expect(mocks.reload).toHaveBeenCalledOnce();
    });
    it('does not start when secret storage fails', async () => {
        mocks.save.mockRejectedValue(new Error('storage unavailable'));
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await expect(view!.root.findByType(CredentialProfiles).props.onSave({ name: 'test', environment: 'simulation', caPath: '' }, true)).rejects.toThrow();
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('retries migration through native settings and refreshes the current view', async () => {
        mocks.load.mockResolvedValueOnce({ ...EMPTY_DESKTOP_SETTINGS, migrationError: '暫時無法存取' });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        const retry = view!.root.findAllByType('button').find(b => b.children.filter(x => typeof x === 'string').join('') === '重試遷移')!;
        await act(async () => retry.props.onClick());
        expect(mocks.load).toHaveBeenCalledTimes(2);
        expect(view!.root.findByType(CredentialProfiles).props.settings.migrationError).toBeNull();
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('stops the owned server and Agents before selecting from onboarding', async () => {
        mocks.select.mockImplementation(async () => { expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true, ownedOnly: true }); return EMPTY_DESKTOP_SETTINGS; });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await act(async () => view!.root.findByType(CredentialProfiles).props.onAction('select', 'two'));
        expect(mocks.select).toHaveBeenCalledWith('two');
    });
    it('does not select or start when the owned server or an Agent cannot stop', async () => {
        mocks.stop.mockResolvedValue({ ok: false, output: 'Agent 尚未停止' });
        const next = { ...EMPTY_DESKTOP_SETTINGS, profiles: [{ id: 'two', secretState: 'stored', environment: 'simulation' }] };
        mocks.save.mockResolvedValue(next);
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await expect(view!.root.findByType(CredentialProfiles).props.onSave({ name: 'two', environment: 'simulation', caPath: '' }, true)).rejects.toThrow('Agent 尚未停止');
        expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    });
    it('saves and validates the target before stopping, selecting, and starting', async () => {
        const target = { id: 'two', name: 'two', secretState: 'stored', environment: 'simulation', caPath: '', hasCA: false, createdAt: '', apiKeyMasked: '••••1234', credentialBackend: 'system', revision: 'native' } as const;
        const saved: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'old', profiles: [target] };
        const selected = { ...saved, activeProfileId: 'two', configured: true };
        mocks.save.mockResolvedValue(saved);
        mocks.stop.mockImplementation(async () => { expect(mocks.save).toHaveBeenCalledOnce(); return { ok: true }; });
        mocks.select.mockImplementation(async () => { expect(mocks.stop).toHaveBeenCalledOnce(); return selected; });
        mocks.start.mockImplementation(async () => { expect(mocks.select).toHaveBeenCalledWith('two'); return { ok: true }; });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await act(async () => view!.root.findByType(CredentialProfiles).props.onSave({ id: 'two', name: 'two', environment: 'simulation', caPath: '' }, true));
        expect(mocks.start).toHaveBeenCalledWith(selected);
    });
    it('leaves a running server untouched when the saved production target has no CA', async () => {
        mocks.save.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, profiles: [{ id: 'two', secretState: 'stored', environment: 'production' }] });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await act(async () => {
            await expect(view!.root.findByType(CredentialProfiles).props.onSave({ name: 'two', environment: 'production', caPath: '' }, true)).rejects.toThrow();
        });
        expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    });
    it('keeps a start action after saving the first account without starting', async () => {
        const profile = { id: 'new', name: '新帳號', environment: 'simulation', hasCA: false, caPath: '', createdAt: '', apiKeyMasked: '••••1234', secretState: 'stored', credentialBackend: 'system', revision: 'native' } as const;
        const saved: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, configured: true, activeProfileId: 'new', credentialRevision: 'native', profiles: [profile] };
        mocks.save.mockResolvedValue(saved); mocks.start.mockResolvedValue({ ok: true });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        const label = (b: { children: unknown[] }) => b.children.filter(x => typeof x === 'string').join('');
        const button = (text: string) => view!.root.findAllByType('button').find(b => label(b) === text)!;
        const inputs = () => view!.root.findByType(CredentialProfiles).findAllByType('input');
        for (const [i, value] of ['新帳號', 'key', 'secret'].entries()) await act(async () => inputs()[i]!.props.onChange({ target: { value } }));
        await act(async () => button('僅儲存').props.onClick());
        await act(async () => button('確認新增帳號').props.onClick());
        expect(mocks.save).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
        // 回到列表後仍有啟動鈕，用使用中的帳號啟動
        expect(inputs()).toHaveLength(0);
        expect(button('啟動').props.disabled).toBe(false);
        await act(async () => button('啟動').props.onClick());
        expect(mocks.start).toHaveBeenCalledWith(saved); expect(mocks.reload).toHaveBeenCalledOnce();
    });
    it('offers two-click logout after migration failure and stops before clearing', async () => {
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, migrationError: '遷移失敗；原有資料已保留' });
        mocks.logout.mockImplementation(async () => { expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true, ownedOnly: true }); return EMPTY_DESKTOP_SETTINGS; });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        const button = () => view!.root.findAllByType('button').find(b => b.children.join('').includes('登出並清除'))!;
        expect(button()).toBeDefined();
        await act(async () => button().props.onClick());
        expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.logout).not.toHaveBeenCalled();
        await act(async () => button().props.onClick());
        expect(mocks.logout).toHaveBeenCalledOnce(); expect(mocks.clearHash).toHaveBeenCalledOnce();
        expect(view!.root.findByType(CredentialProfiles).props.settings.migrationError).toBeNull();
    });
    it('keeps migration data when stopping fails during logout', async () => {
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, migrationError: '遷移失敗' });
        mocks.stop.mockResolvedValue({ ok: false, output: '外部伺服器不是本 App 啟動的' });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        const button = () => view!.root.findAllByType('button').find(b => b.children.join('').includes('登出並清除'))!;
        await act(async () => button().props.onClick()); await act(async () => button().props.onClick());
        expect(mocks.logout).not.toHaveBeenCalled(); expect(mocks.clearHash).not.toHaveBeenCalled();
        expect(JSON.stringify(view!.toJSON())).toContain('外部伺服器不是本 App 啟動的');
    });
});
