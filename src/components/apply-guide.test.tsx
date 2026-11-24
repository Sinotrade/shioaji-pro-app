import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyGuideEvent } from '../lib/apply-guide-native';

const mocks = vi.hoisted(() => ({
    panel: vi.fn(() => null), defaults: vi.fn(), load: vi.fn(), save: vi.fn(), select: vi.fn(), start: vi.fn(),
    reload: vi.fn(), stop: vi.fn(), logout: vi.fn(), openLogs: vi.fn(), external: vi.fn(),
    open: vi.fn(), close: vi.fn(), apiPage: vi.fn(), focus: vi.fn(),
    handler: null as ((event: ApplyGuideEvent) => void) | null,
}));
vi.mock('../lib/spawn-keys', () => ({ clearStoredSpawnKeyHash: vi.fn() }));
vi.mock('../lib/features', () => ({ agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults }, useFeature: () => ({ enabled: true }), FEATURES: [] }));
vi.mock('../lib/tauri', async () => ({
    ...await import('../lib/desktop-credentials'), isTauri: true,
    loadDesktopSettings: mocks.load, saveCredentialProfile: mocks.save, selectCredentialProfile: mocks.select,
    pickCaFile: vi.fn(), pickEnvFile: vi.fn(), importEnvCandidate: vi.fn(), reloadWhenHealthy: mocks.reload, serverStart: mocks.start,
    serverStop: mocks.stop, logoutCredentialProfile: mocks.logout, openServerLogFolder: mocks.openLogs, openExternalUrl: mocks.external,
}));
vi.mock('../lib/apply-guide-native', () => ({
    openApplyWindow: mocks.open, closeApplyWindow: mocks.close, showApplyApiPage: mocks.apiPage, focusApplyTarget: mocks.focus,
    listenApplyGuide: async (handler: (event: ApplyGuideEvent) => void) => { mocks.handler = handler; return () => { mocks.handler = null; }; },
}));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { OnboardingSetup } from './onboarding-setup';
import { CredentialProfiles } from './credential-profiles';
import { ApplyGuide } from './apply-guide';

let view: ReactTestRenderer | undefined;
const label = (node: ReactTestInstance) => node.children.filter(x => typeof x === 'string').join('');
const button = (text: string) => view!.root.findAllByType('button').find(b => label(b) === text);
const json = () => JSON.stringify(view!.toJSON());
const emit = async (event: ApplyGuideEvent) => act(async () => mocks.handler!(event));
const profile = { id: 'p1', name: 'ShioajiPro', environment: 'simulation', hasCA: false, caPath: '', createdAt: '', apiKeyMasked: '••••6789', secretState: 'stored', credentialBackend: 'system', revision: 'native' } as const;

beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('window', new EventTarget());
    mocks.load.mockResolvedValue(EMPTY_DESKTOP_SETTINGS);
    mocks.stop.mockResolvedValue({ ok: true });
    mocks.open.mockResolvedValue('window');
});
afterEach(async () => { if (view) { await act(async () => view!.unmount()); view = undefined; } vi.unstubAllGlobals(); });

const mount = async () => { await act(async () => { view = create(createElement(OnboardingSetup)); }); };

describe('first-run apply guide', () => {
    it('is the default page without accounts and keeps the manual and AI fallbacks', async () => {
        await mount();
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(1);
        expect(view!.root.findAllByType(CredentialProfiles)).toHaveLength(0);
        expect(json()).toContain('申請你的 Shioaji API Key');
        expect(mocks.panel).toHaveBeenCalled();
        await act(async () => button('我已經有 API Key')!.props.onClick());
        expect(view!.root.findAllByType(CredentialProfiles)).toHaveLength(1);
        await act(async () => button('還沒有 API Key？跟著導覽申請')!.props.onClick());
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(1);
    });

    it('opens the account list instead when profiles already exist', async () => {
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await mount();
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(0);
        expect(view!.root.findAllByType(CredentialProfiles)).toHaveLength(1);
    });

    it('opens the apply window, follows the page and highlights fields on request', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(mocks.open).toHaveBeenCalledOnce();
        expect(json()).toContain('登入永豐金證券網站');
        await act(async () => button('回到 API 管理頁')!.props.onClick());
        expect(mocks.apiPage).toHaveBeenCalledOnce();
        await emit({ kind: 'step', step: 'form' });
        expect(json()).toContain('填寫「新增 API KEY」');
        expect(json()).toContain('已同步官網畫面');
        // AI 助理在申請視窗開著時收起，讓導覽貼齊左側
        mocks.panel.mockClear();
        await emit({ kind: 'step', step: 'form' });
        expect(mocks.panel).not.toHaveBeenCalled();
        const locate = view!.root.findAllByProps({ 'aria-label': '在網頁上標示「API 權限：正式環境」' })[0]!;
        await act(async () => locate.props.onClick());
        expect(mocks.focus).toHaveBeenCalledWith('perm-prod');
        await act(async () => button('上一步')!.props.onClick());
        expect(json()).toContain('收驗證碼完成身份驗證');
    });

    it('falls back to the system browser and points to .env import', async () => {
        mocks.open.mockResolvedValue('browser');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(json()).toContain('已在瀏覽器開啟官網');
        const locate = view!.root.findAllByProps({ 'aria-label': '在網頁上標示「客戶登入」' })[0]!;
        expect(locate.props.disabled).toBe(true);
    });

    it('shows why the window could not open', async () => {
        mocks.open.mockRejectedValue(new Error('無法建立申請視窗'));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(json()).toContain('無法建立申請視窗');
        expect(json()).toContain('申請你的 Shioaji API Key');
    });

    it('offers to reopen a closed window', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'closed' });
        expect(json()).toContain('申請視窗已關閉');
        await act(async () => button('重新開啟')!.props.onClick());
        expect(mocks.open).toHaveBeenCalledTimes(2);
    });

    it('keeps the manual fallback visible when the import fails', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        await emit({ kind: 'import-failed', message: '無法存取系統憑證庫' });
        expect(json()).toContain('無法存取系統憑證庫');
        await act(async () => button('改用手動設定')!.props.onClick());
        expect(view!.root.findAllByType(CredentialProfiles)).toHaveLength(1);
    });

    it('starts the imported simulation profile after the .env arrives', async () => {
        const imported: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, configured: true, activeProfileId: 'p1', credentialRevision: 'native', profiles: [profile] };
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        mocks.load.mockResolvedValue(imported);
        mocks.start.mockResolvedValue({ ok: true });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        expect(json()).toContain('金鑰已載入');
        expect(json()).toContain('••••6789');
        expect(json()).toContain('簽署 API 約定書');
        // 之後的步驟事件不會把畫面拉回官網步驟
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('金鑰已載入');
        await act(async () => button('啟動模擬環境')!.props.onClick());
        expect(mocks.select).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalled();
        expect(mocks.start).toHaveBeenCalledWith(imported);
        expect(mocks.reload).toHaveBeenCalledOnce();
    });

    it('selects the imported profile first when another one is active', async () => {
        const other = { ...profile, id: 'old', name: '舊帳號' };
        const before: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'old', profiles: [other, profile] };
        const selected: DesktopSettings = { ...before, activeProfileId: 'p1', configured: true, credentialRevision: 'native' };
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue(before);
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        mocks.select.mockResolvedValue(selected); mocks.start.mockResolvedValue({ ok: true });
        await act(async () => button('啟動模擬環境')!.props.onClick());
        expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true, ownedOnly: true });
        expect(mocks.select).toHaveBeenCalledWith('p1');
        expect(mocks.start).toHaveBeenCalledWith(selected);
    });

    it('opens the real-money prerequisites in the system browser', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        await act(async () => button('證券 API 約定書')!.props.onClick());
        expect(mocks.external).toHaveBeenCalledWith('https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/');
    });
});

describe('apply guide review fixes', () => {
    it('keeps the launch page reachable after going back from it', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        const progress = () => view!.root.findAllByProps({ 'aria-label': '申請進度' })[0]!.findAllByType('button');
        const success = () => progress().find(b => b.findAllByType('span').some(span => span.children.includes('下載 .env')))!;
        await act(async () => success().props.onClick());
        expect(json()).not.toContain('啟動模擬環境');
        expect(button('下一步')!.props.disabled).toBe(false);
        await act(async () => button('下一步')!.props.onClick());
        expect(json()).toContain('啟動模擬環境');
        await act(async () => success().props.onClick());
        expect(json()).not.toContain('啟動模擬環境');
        expect(progress().at(-1)!.props.disabled).toBe(false);
        await act(async () => progress().at(-1)!.props.onClick());
        expect(json()).toContain('啟動模擬環境');
    });

    it('keeps 完成 locked and the download step final before an import', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        const progress = view!.root.findAllByProps({ 'aria-label': '申請進度' })[0]!.findAllByType('button');
        expect(progress.at(-1)!.props.disabled).toBe(true);
        expect(button('下一步')!.props.disabled).toBe(true);
    });

    it('opens the AI assistant in the guide column while the apply window is docked', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'form' });
        mocks.panel.mockClear();
        await act(async () => button('問 AI 助理')!.props.onClick());
        expect(mocks.panel).toHaveBeenCalled();
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(0);
        await act(async () => button('回到導覽')!.props.onClick());
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(1);
    });

    it('shows a failed reopen on the step the user is on', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'form' });
        await emit({ kind: 'closed' });
        mocks.open.mockRejectedValueOnce(new Error('無法建立申請視窗'));
        await act(async () => button('重新開啟')!.props.onClick());
        expect(json()).toContain('填寫「新增 API KEY」');
        expect(json()).toContain('無法建立申請視窗');
    });

    it('reports other downloads only when they actually finished', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        await emit({ kind: 'downloaded', fileName: 'qrcode.png', status: 'failed' });
        expect(json()).toContain('下載失敗');
        expect(json()).not.toContain('已存到下載資料夾');
        await emit({ kind: 'downloaded', fileName: 'qrcode.png', status: 'unknown' });
        expect(json()).toContain('已交給系統下載');
        expect(json()).not.toContain('下載失敗');
        await emit({ kind: 'downloaded', fileName: 'qrcode.png', status: 'saved' });
        expect(json()).toContain('已存到下載資料夾');
    });

    it('never claims the .env was saved when its import fails', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        await emit({ kind: 'import-failed', message: '無法存取系統憑證庫' });
        expect(json()).toContain('無法存取系統憑證庫');
        expect(json()).not.toContain('已存到下載資料夾');
        expect(json()).toContain('再按一次「下載 .env」');
    });
});

describe('apply guide review round 2', () => {
    const importWith = async (settings: DesktopSettings) => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue(settings);
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: true });
    };

    it('will not launch a profile that was switched to production', async () => {
        await importWith({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [{ ...profile, environment: 'production' }] });
        expect(json()).toContain('已改成正式環境');
        expect(json()).not.toContain('開始使用');
        expect(button('啟動模擬環境')!.props.disabled).toBe(true);
    });

    it('re-checks the environment when 啟動模擬環境 is pressed', async () => {
        await importWith({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', configured: true, credentialRevision: 'native', production: true, profiles: [{ ...profile, environment: 'production' }] });
        await act(async () => button('啟動模擬環境')!.props.onClick());
        expect(mocks.start).not.toHaveBeenCalled();
        expect(mocks.select).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(json()).toContain('已改成正式環境');
    });

    it('says where the key is really stored', async () => {
        await importWith({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', credentialBackend: 'plaintext-fallback', fallbackPath: '/fake/app/credentials.json', profiles: [{ ...profile, credentialBackend: 'plaintext-fallback' }] });
        expect(json()).toContain('金鑰以檔案保存');
        expect(json()).toContain('/fake/app/credentials.json');
        expect(json()).not.toContain('已存進這台電腦的系統憑證庫');
    });

    it('mentions the system credential store only when it is used', async () => {
        await importWith({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        expect(json()).toContain('已存進這台電腦的系統憑證庫');
        expect(json()).not.toContain('金鑰以檔案保存');
    });
});

describe('apply guide review round 3', () => {
    const other = { ...profile, id: 'p2', name: 'SecondKey', apiKeyMasked: '••••4321' };
    const toDone = async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        expect(json()).toContain('金鑰已載入');
    };

    it('shows a later import failure on the 完成 page', async () => {
        await toDone();
        await emit({ kind: 'import-failed', message: '無法存取系統憑證庫' });
        expect(json()).toContain('無法載入下載的 .env');
        expect(json()).toContain('無法存取系統憑證庫');
        expect(json()).toContain('ShioajiPro');
    });

    it('replaces the completion page with a later imported key', async () => {
        await toDone();
        await emit({ kind: 'import-failed', message: '無法存取系統憑證庫' });
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile, other] });
        await emit({ kind: 'imported', profileId: 'p2', name: 'SecondKey', duplicate: false });
        expect(json()).toContain('SecondKey');
        expect(json()).toContain('••••4321');
        expect(json()).not.toContain('無法存取系統憑證庫');
        mocks.select.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p2', configured: true, credentialRevision: 'native', profiles: [profile, other] });
        mocks.start.mockResolvedValue({ ok: true });
        await act(async () => button('啟動模擬環境')!.props.onClick());
        expect(mocks.select).toHaveBeenCalledWith('p2');
    });

    it('follows the site when another key is being created', async () => {
        await toDone();
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('金鑰已載入');
        await emit({ kind: 'step', step: 'verify' });
        expect(json()).toContain('收驗證碼完成身份驗證');
        // 完成頁仍可從進度列回去
        const progress = view!.root.findAllByProps({ 'aria-label': '申請進度' })[0]!.findAllByType('button');
        expect(progress.at(-1)!.props.disabled).toBe(false);
    });
});
