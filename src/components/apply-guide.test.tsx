import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyGuideEvent } from '../lib/apply-guide-native';

const mocks = vi.hoisted(() => ({
    panel: vi.fn(() => null), defaults: vi.fn(), load: vi.fn(), save: vi.fn(), select: vi.fn(), start: vi.fn(),
    reload: vi.fn(), stop: vi.fn(), logout: vi.fn(), openLogs: vi.fn(), external: vi.fn(),
    open: vi.fn(), close: vi.fn(), apiPage: vi.fn(), signPage: vi.fn(), focus: vi.fn(), clearSite: vi.fn(), saveEnv: vi.fn(), card: vi.fn(),
    saveCa: vi.fn(), importEnvironment: vi.fn(), caTarget: vi.fn(),
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
    openApplyWindow: mocks.open, closeApplyWindow: mocks.close, clearApplySiteData: mocks.clearSite, setApplySaveEnv: mocks.saveEnv, setApplySaveCa: mocks.saveCa, setApplyImportEnvironment: mocks.importEnvironment, setApplyCaTarget: mocks.caTarget, showApplyApiPage: mocks.apiPage, showApplySignPage: mocks.signPage, focusApplyTarget: mocks.focus, setApplyGuideCard: mocks.card,
    listenApplyGuide: async (handler: (event: ApplyGuideEvent) => void) => { mocks.handler = handler; return () => { mocks.handler = null; }; },
}));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { OnboardingSetup } from './onboarding-setup';
import { CredentialProfiles } from './credential-profiles';
import { ApplyGuide, followSiteStep, pageNavStep } from './apply-guide';
import { AssistantFab } from './assistant-fab';

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
    mocks.open.mockResolvedValue('overlay');
});
afterEach(async () => { if (view) { await act(async () => view!.unmount()); view = undefined; } vi.unstubAllGlobals(); });

const mount = async () => { await act(async () => { view = create(createElement(OnboardingSetup)); }); };

describe('first-run apply guide', () => {
    it('only imports the .env by default and remembers the opt-in to also save the file', async () => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(mocks.saveEnv).toHaveBeenLastCalledWith(false);
        await emit({ kind: 'step', step: 'success' });
        const box = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')[0]!;
        expect(box().props.checked).toBe(false);
        expect(json()).toContain('會直接匯入 App，不會另存檔案');
        await act(async () => box().props.onChange({ currentTarget: { checked: true } }));
        expect(mocks.saveEnv).toHaveBeenLastCalledWith(true);
        expect(store.get('sjpro.applyGuide.saveEnvFile')).toBe('1');
        expect(json()).toContain('檔案內含 Secret Key，請妥善保管');
        await emit({ kind: 'downloaded', fileName: 'ShioajiPro (1).env', status: 'saved' });
        expect(json()).toContain('ShioajiPro (1).env');
        // 重新開 App：選擇記住，開窗時帶給原生端
        await act(async () => view!.unmount()); view = undefined; mocks.saveEnv.mockClear();
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(mocks.saveEnv).toHaveBeenLastCalledWith(true);
        await emit({ kind: 'step', step: 'success' });
        expect(box().props.checked).toBe(true);
        await act(async () => box().props.onChange({ currentTarget: { checked: false } }));
        expect(store.has('sjpro.applyGuide.saveEnvFile')).toBe(false);
        expect(mocks.saveEnv).toHaveBeenLastCalledWith(false);
    });

    it('logs out of the site only after confirming, and says the login is kept until then', async () => {
        mocks.clearSite.mockResolvedValue('cleared');
        await mount();
        expect(json()).toContain('關掉再打開通常不用重新登入');
        expect(json()).not.toContain('自動登出');
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('登出並清除官網資料')!.props.onClick());
        expect(mocks.clearSite).not.toHaveBeenCalled();
        await act(async () => button('取消')!.props.onClick());
        expect(button('確認登出並清除')).toBeUndefined();
        await act(async () => button('登出並清除官網資料')!.props.onClick());
        await act(async () => button('確認登出並清除')!.props.onClick());
        expect(mocks.clearSite).toHaveBeenCalledOnce();
        expect(json()).toContain('已登出官網');
        expect(json()).toContain('官網視窗已關閉');
        // 重新打開官網後回到一般狀態
        await act(async () => button('重新打開官網')!.props.onClick());
        expect(json()).not.toContain('已登出官網');
        expect(button('登出並清除官網資料')).toBeDefined();
    });

    it('shows why the site data could not be cleared and lets the user retry', async () => {
        mocks.clearSite.mockRejectedValueOnce(new Error('清除官網資料逾時，請再試一次'));
        await mount();
        await act(async () => button('登出並清除官網資料')!.props.onClick());
        await act(async () => button('確認登出並清除')!.props.onClick());
        expect(json()).toContain('清除官網資料逾時，請再試一次');
        expect(button('登出並清除官網資料')).toBeDefined();
    });

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
        // AI 助理面板一直掛著（收成浮鈕時只是 hidden），換步驟不會卸載
        mocks.panel.mockClear();
        await emit({ kind: 'step', step: 'form' });
        expect(json()).toContain('填寫「新增 API KEY」');
        expect(json()).toContain('已連動官網');
        expect(mocks.panel).toHaveBeenCalled();
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(1);
        const locate = view!.root.findAllByProps({ 'aria-label': '在網頁上標示：API 權限：正式環境' })[0]!;
        await act(async () => locate.props.onClick());
        expect(mocks.focus).toHaveBeenCalledWith('perm-prod');
        await act(async () => button('上一步')!.props.onClick());
        expect(json()).toContain('收驗證碼完成身份驗證');
    });

    it('falls back to the system browser and points to .env import', async () => {
        mocks.open.mockResolvedValue('browser');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(json()).toContain('已改用瀏覽器打開官網');
        const locate = view!.root.findAllByProps({ 'aria-label': '在網頁上標示：按「客戶登入」' })[0]!;
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
        expect(json()).toContain('官網視窗已關閉');
        await act(async () => button('重新打開官網')!.props.onClick());
        expect(mocks.open).toHaveBeenCalledTimes(2);
    });

    it('keeps the manual fallback visible when the import fails', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'success' });
        await emit({ kind: 'import-failed', message: '無法存取系統憑證庫' });
        expect(json()).toContain('無法存取系統憑證庫');
        await act(async () => button('改用手動輸入')!.props.onClick());
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

    it('keeps the guide centred when the apply window opens beside the main window', async () => {
        const docked = () => view!.root.findByType(ApplyGuide).props.docked;
        mocks.open.mockResolvedValue('beside');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'form' });
        expect(docked()).toBe(false);
        expect(view!.root.findByType(AssistantFab).props.docked).toBe(false);
        // 重新開啟時若改成蓋住主視窗，就靠左，AI 浮鈕跟著停到導覽卡內
        await emit({ kind: 'closed' });
        mocks.open.mockResolvedValue('overlay');
        await act(async () => button('重新打開官網')!.props.onClick());
        await emit({ kind: 'step', step: 'form' });
        expect(docked()).toBe(true);
        expect(view!.root.findByType(AssistantFab).props.docked).toBe(true);
    });

    it('collapses the AI assistant into a round button by default and keeps its chat mounted', async () => {
        const fab = (label: string) => view!.root.findAllByProps({ 'aria-label': label }).find(n => n.type === 'button');
        const panel = () => view!.root.findAllByProps({ role: 'dialog', 'aria-label': 'AI 助理' })[0]!;
        await mount();
        // 預設收合：面板掛著但隱藏，浮鈕旁顯示提示
        expect(mocks.panel).toHaveBeenCalled();
        expect(panel().props.hidden).toBe(true);
        expect(fab('打開 AI 助理')!.props['aria-expanded']).toBe(false);
        expect(json()).toContain('有問題？問 AI 助理');
        await act(async () => fab('打開 AI 助理')!.props.onClick());
        expect(panel().props.hidden).toBe(false);
        expect(json()).not.toContain('有問題？問 AI 助理');
        await act(async () => button('收合')!.props.onClick());
        expect(panel().props.hidden).toBe(true);
        // 換步驟仍掛著同一個面板，導覽照常顯示
        await act(async () => button('開始申請')!.props.onClick());
        mocks.panel.mockClear();
        await emit({ kind: 'step', step: 'verify' });
        expect(mocks.panel).toHaveBeenCalled();
        expect(view!.root.findAllByType(ApplyGuide)).toHaveLength(1);
    });

    it('shows a failed reopen on the step the user is on', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'form' });
        await emit({ kind: 'closed' });
        mocks.open.mockRejectedValueOnce(new Error('無法建立申請視窗'));
        await act(async () => button('重新打開官網')!.props.onClick());
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
        expect(json()).toContain('金鑰存成檔案');
        expect(json()).toContain('/fake/app/credentials.json');
        expect(json()).not.toContain('這台電腦的系統憑證庫');
    });

    it('mentions the system credential store only when it is used', async () => {
        await importWith({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        expect(json()).toContain('這台電腦的系統憑證庫');
        expect(json()).not.toContain('金鑰存成檔案');
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
        expect(json()).toContain('App 沒有收到 .env 檔');
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

describe('signing the API agreements', () => {
    const store = new Map<string, string>();
    beforeEach(() => {
        store.clear();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
    });
    const byLabel = (text: string) => view!.root.findAllByProps({ 'aria-label': text }).find(n => n.type === 'button');
    const marketBox = (title: string) => view!.root.findAll(n => n.type === 'label' && JSON.stringify(n.children.map(c => typeof c === 'string' ? c : (c as ReactTestInstance).props?.children)).includes(title))[0]!
        .findByType('input');
    const rows = () => view!.root.findAllByProps({ 'aria-label': 'API 約定書簽署狀態' })[0]?.findAllByType('li') ?? [];

    it('comes right after login, asks which markets to trade and shows only those (all three the first time)', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('下一步')!.props.onClick());
        expect(json()).toContain('簽署 API 約定書');
        expect(json()).toContain('順序不限');
        expect(json()).toContain('第 2 步，共 6 步');
        for (const title of ['證券（台股）', '期貨／選擇權', '美股（複委託）']) expect(marketBox(title).props.checked).toBe(true);
        expect(rows()).toHaveLength(3);
        expect(json()).toContain('未確認');
        // 取消美股：少一列，選擇記住
        await act(async () => marketBox('美股（複委託）').props.onChange({ currentTarget: { checked: false } }));
        expect(rows()).toHaveLength(2);
        expect(JSON.parse(store.get('sjpro.applyGuide.markets')!)).toEqual(['S', 'F']);
        await act(async () => byLabel('打開期貨／選擇權簽署頁')!.props.onClick());
        expect(mocks.signPage).toHaveBeenCalledWith('F');
        expect(byLabel('打開美股（複委託）簽署頁')).toBeUndefined();
        // 不擋：隨時可以去申請金鑰
        await act(async () => button('前往 API 管理頁申請金鑰')!.props.onClick());
        expect(mocks.apiPage).toHaveBeenCalled();
        expect(json()).toContain('按「新增 API Key」');
    });

    it('follows the signing page, shows what it read and keeps a known state over a later unknown', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['S', 'H']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-h', sign: 'unknown' });
        expect(json()).toContain('簽署 API 約定書');
        expect(json()).toContain('官網目前在這個簽署頁');
        expect(json()).toContain('在簽署頁上照順序做');
        await emit({ kind: 'step', step: 'sign-h', sign: 'unsigned' });
        expect(json()).toContain('未簽署');
        const locate = view!.root.findAllByProps({ 'aria-label': '在網頁上標示：下載約定書副本' })[0]!;
        await act(async () => locate.props.onClick());
        expect(mocks.focus).toHaveBeenCalledWith('sign-h-download');
        await emit({ kind: 'step', step: 'sign-h', sign: 'signed' });
        await emit({ kind: 'step', step: 'sign-h', sign: 'unknown' });
        expect(json()).toContain('已簽署');
        expect(rows()).toHaveLength(2);
        // 已簽署的市場仍可再打開簽署頁查看；官網回到 API 管理列表時導覽仍停在簽署
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('簽署 API 約定書');
        expect(byLabel('打開美股（複委託）簽署頁')).toBeDefined();
        expect(byLabel('打開證券（台股）簽署頁')).toBeDefined();
    });

    it('keeps a stored choice, including none', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['F']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('下一步')!.props.onClick());
        expect(marketBox('證券（台股）').props.checked).toBe(false);
        expect(marketBox('期貨／選擇權').props.checked).toBe(true);
        expect(rows()).toHaveLength(1);
        await act(async () => view!.unmount()); view = undefined;
        store.set('sjpro.applyGuide.markets', '[]');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('下一步')!.props.onClick());
        expect(rows()).toHaveLength(0);
        expect(json()).toContain('還沒選市場');
    });

    it('checks 簽署 in the progress bar only when every chosen market reads signed, and never blocks', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['S', 'F']));
        const signStep = () => view!.root.findAllByProps({ 'aria-label': '申請進度' })[0]!.findAllByType('button')
            .find(b => String(b.props['aria-label']).startsWith('簽署，'))!;
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        expect(signStep().props['aria-label']).toBe('簽署，還沒開始');
        // 登入後官網直接進 API 管理列表：導覽先停在簽署
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('簽署 API 約定書');
        // 跳過簽署直接到 API 管理：不擋，簽署不打勾也不是錯誤
        await act(async () => button('下一步')!.props.onClick());
        expect(json()).toContain('按「新增 API Key」');
        expect(signStep().props['aria-label']).toBe('簽署，勾選的市場還沒全部確認已簽署');
        expect(button('下一步')!.props.disabled).toBe(false);
        expect(button('上一步')!.props.disabled).toBe(false);
        await emit({ kind: 'step', step: 'sign-s', sign: 'signed' });
        await emit({ kind: 'step', step: 'sign-f', sign: 'pending' });
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('前往 API 管理頁申請金鑰')!.props.onClick());
        expect(signStep().props['aria-label']).toBe('簽署，勾選的市場還沒全部確認已簽署');
        await emit({ kind: 'step', step: 'sign-f', sign: 'signed' });
        expect(signStep().props['aria-label']).toBe('簽署，目前在這一步');
        await emit({ kind: 'step', step: 'verify' });
        expect(signStep().props['aria-label']).toBe('簽署，已完成');
        // 多勾一個還沒確認的市場：又變回未打勾
        await act(async () => signStep().props.onClick());
        await act(async () => marketBox('美股（複委託）').props.onChange({ currentTarget: { checked: true } }));
        await act(async () => button('下一步')!.props.onClick());
        expect(signStep().props['aria-label']).toBe('簽署，勾選的市場還沒全部確認已簽署');
        expect(button('前往 API 管理頁申請金鑰')).toBeUndefined(); // 已在 API 管理步驟
    });

    it('forgets what it read after logging out of the site, since another identity may log in', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['S']));
        mocks.clearSite.mockResolvedValue('cleared');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-s', sign: 'signed' });
        expect(json()).toContain('已簽署');
        await act(async () => button('登出並清除官網資料')!.props.onClick());
        await act(async () => button('確認登出並清除')!.props.onClick());
        expect(json()).not.toContain('已簽署');
        expect(byLabel('打開證券（台股）簽署頁')).toBeDefined();
    });

    it('forgets what it read when the site is back at its login page (logout or session timeout)', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['S']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-s', sign: 'signed' });
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('下一步')!.props.onClick());
        const signStep = () => view!.root.findAllByProps({ 'aria-label': '申請進度' })[0]!.findAllByType('button')
            .find(b => String(b.props['aria-label']).startsWith('簽署，'))!;
        expect(signStep().props['aria-label']).toBe('簽署，已完成');
        await emit({ kind: 'step', step: 'login' });
        await emit({ kind: 'step', step: 'list' });
        // 重新登入後回到簽署步驟，先前讀到的狀態不沿用
        expect(json()).toContain('簽署 API 約定書');
        expect(json()).not.toContain('已簽署');
        expect(json()).toContain('未確認');
        await act(async () => button('下一步')!.props.onClick());
        expect(signStep().props['aria-label']).toBe('簽署，勾選的市場還沒全部確認已簽署');
    });

    it('switches the site back to the API page before pointing at 新增 API Key from a signing page', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-s', sign: 'unknown' });
        await act(async () => button('前往 API 管理頁申請金鑰')!.props.onClick());
        mocks.apiPage.mockClear(); mocks.focus.mockClear();
        await act(async () => byLabel('在網頁上標示：按「新增 API Key」')!.props.onClick());
        expect(mocks.apiPage).toHaveBeenCalledTimes(1);
        expect(mocks.focus).not.toHaveBeenCalled();
        await emit({ kind: 'step', step: 'list' });
        expect(mocks.focus).toHaveBeenCalledWith('add-key');
        // 已在 API 管理頁：直接標示，不再切頁
        mocks.apiPage.mockClear(); mocks.focus.mockClear();
        await act(async () => byLabel('在網頁上標示：按「新增 API Key」')!.props.onClick());
        expect(mocks.apiPage).not.toHaveBeenCalled();
        expect(mocks.focus).toHaveBeenCalledWith('add-key');
    });

    it('switches the site back to the API page when 下一步 leaves the signing step', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-h', sign: 'unknown' });
        mocks.apiPage.mockClear();
        await act(async () => button('下一步')!.props.onClick());
        expect(mocks.apiPage).toHaveBeenCalledTimes(1);
        expect(json()).toContain('按「新增 API Key」');
        // 官網已在 API 管理頁時不必再切
        await act(async () => button('上一步')!.props.onClick());
        await emit({ kind: 'step', step: 'list' });
        mocks.apiPage.mockClear();
        await act(async () => button('下一步')!.props.onClick());
        expect(mocks.apiPage).not.toHaveBeenCalled();
    });

    it('drops a pending highlight when the site falls back to its login page', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-f', sign: 'unknown' });
        await act(async () => button('前往 API 管理頁申請金鑰')!.props.onClick());
        mocks.focus.mockClear();
        await act(async () => byLabel('在網頁上標示：按「新增 API Key」')!.props.onClick());
        await emit({ kind: 'step', step: 'login' });
        await emit({ kind: 'step', step: 'list' });
        expect(mocks.focus).not.toHaveBeenCalled();
    });

    it('shows why the signing page could not open and lets the user press again', async () => {
        mocks.signPage.mockRejectedValueOnce(new Error('無法打開簽署頁：apply window is gone'));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('下一步')!.props.onClick());
        await act(async () => byLabel('打開證券（台股）簽署頁')!.props.onClick());
        expect(json()).toContain('打不開簽署頁');
        expect(json()).toContain('apply window is gone');
        await act(async () => byLabel('打開證券（台股）簽署頁')!.props.onClick());
        expect(json()).not.toContain('打不開簽署頁');
    });

    it('announces each market status politely with the market name', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['H']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-h', sign: 'pending' });
        const live = view!.root.findAllByProps({ 'aria-live': 'polite' }).filter(n => n.type === 'span');
        expect(live).toHaveLength(1);
        expect(JSON.stringify(live[0]!.children.map(c => typeof c === 'string' ? c : (c as ReactTestInstance).props?.children))).toContain('美股（複委託）');
        expect(JSON.stringify(live[0]!.children.map(c => typeof c === 'string' ? c : (c as ReactTestInstance).props?.children))).toContain('審核中');
    });

    it('opens the signing page in the browser when the app could only use the browser', async () => {
        mocks.open.mockResolvedValue('browser');
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await act(async () => button('下一步')!.props.onClick());
        await act(async () => byLabel('打開證券（台股）簽署頁')!.props.onClick());
        expect(mocks.signPage).not.toHaveBeenCalled();
        expect(mocks.external).toHaveBeenCalledWith('https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/');
    });

    it('reopens a closed window before opening the signing page', async () => {
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'closed' });
        await act(async () => button('下一步')!.props.onClick());
        mocks.open.mockClear();
        await act(async () => byLabel('打開證券（台股）簽署頁')!.props.onClick());
        expect(mocks.open).toHaveBeenCalledOnce();
        expect(mocks.signPage).toHaveBeenCalledWith('S');
    });

    it('shows a failed reopen from the 完成 page next to its signing buttons', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['F']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        await emit({ kind: 'closed' });
        mocks.open.mockRejectedValueOnce(new Error('建立視窗失敗'));
        await act(async () => byLabel('打開期貨／選擇權簽署頁')!.props.onClick());
        expect(json()).toContain('金鑰已載入');
        expect(json()).toContain('建立視窗失敗');
        expect(mocks.signPage).not.toHaveBeenCalled();
        await act(async () => button('重新打開官網')!.props.onClick());
        expect(json()).not.toContain('建立視窗失敗');
    });

    it('lists the chosen markets that still need signing on the 完成 page and stays there while signing', async () => {
        store.set('sjpro.applyGuide.markets', JSON.stringify(['S', 'F']));
        await mount();
        await act(async () => button('開始申請')!.props.onClick());
        await emit({ kind: 'step', step: 'sign-s', sign: 'signed' });
        mocks.load.mockResolvedValue({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', profiles: [profile] });
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
        expect(json()).toContain('金鑰已載入');
        expect(json()).toContain('還有約定書沒簽或還沒確認');
        expect(rows()).toHaveLength(2);
        // 官網還停在證券簽署頁：該列顯示所在位置，不重複放按鈕
        expect(byLabel('打開證券（台股）簽署頁')).toBeUndefined();
        expect(json()).toContain('官網目前在這個簽署頁');
        await act(async () => byLabel('打開期貨／選擇權簽署頁')!.props.onClick());
        expect(mocks.signPage).toHaveBeenCalledWith('F');
        await emit({ kind: 'step', step: 'sign-f', sign: 'signed' });
        expect(json()).toContain('金鑰已載入');
        expect(json()).toContain('你選的市場都已簽署');
        expect(rows()).toHaveLength(2);
        expect(byLabel('打開美股（複委託）簽署頁')).toBeUndefined();
    });
});

describe('followSiteStep', () => {
    it('stops at the signing step after login even though the site lands on the API list', () => {
        expect(followSiteStep('login', 'list')).toBe('sign');
        expect(followSiteStep('start', 'list')).toBe('sign');
        expect(followSiteStep('sign', 'list')).toBe('sign');
    });
    it('follows the site once the user moved on from signing', () => {
        expect(followSiteStep('list', 'list')).toBe('list');
        expect(followSiteStep('sign', 'verify')).toBe('verify');
        expect(followSiteStep('list', 'verify')).toBe('verify');
        expect(followSiteStep('form', 'list')).toBe('list');
        expect(followSiteStep('list', 'sign-h')).toBe('sign');
        expect(followSiteStep('sign', 'login')).toBe('login');
    });
    it('keeps the finished page for list, login and signing pages', () => {
        expect(followSiteStep('imported', 'list')).toBe('imported');
        expect(followSiteStep('imported', 'login')).toBe('imported');
        expect(followSiteStep('imported', 'sign-s')).toBe('imported');
        expect(followSiteStep('imported', 'verify')).toBe('verify');
    });
});

describe('the guide card on the page', () => {
    const store = new Map<string, string>();
    beforeEach(() => {
        store.clear();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
    });
    const lastCard = () => mocks.card.mock.calls.at(-1)?.[0] as { title: string; progress: string; canPrev: boolean; canNext: boolean } | null | undefined;
    const open = async () => { await mount(); await act(async () => button('開始申請')!.props.onClick()); };
    const nav = (action: 'next' | 'prev' | 'hide') => emit({ kind: 'nav', action });

    it('is sent once the window is open and follows the guide step', async () => {
        await mount();
        expect(mocks.card).not.toHaveBeenCalled();
        await act(async () => button('開始申請')!.props.onClick());
        expect(lastCard()).toMatchObject({ title: '登入永豐金證券網站', progress: '第 1 步，共 6 步：登入', canPrev: false, canNext: true });
        await emit({ kind: 'step', step: 'verify' });
        expect(lastCard()).toMatchObject({ title: '收驗證碼完成身份驗證', canPrev: true });
        await emit({ kind: 'step', step: 'success' });
        // 載入金鑰前「下載 .env」是最後一步
        expect(lastCard()).toMatchObject({ canNext: false });
        // 視窗關掉就不再送
        await emit({ kind: 'closed' });
        mocks.card.mockClear();
        await act(async () => button('上一步')!.props.onClick());
        expect(mocks.card).not.toHaveBeenCalled();
    });

    it('moves the guide on 上一步／下一步 from the page, within the same limits as the app buttons', async () => {
        await open();
        await nav('prev'); // 第一步沒有上一步
        expect(json()).toContain('登入永豐金證券網站');
        await nav('next');
        expect(json()).toContain('簽署 API 約定書');
        expect(lastCard()).toMatchObject({ title: '簽署 API 約定書' });
        await nav('prev');
        expect(json()).toContain('登入永豐金證券網站');
        await emit({ kind: 'step', step: 'success' });
        await nav('next'); // 還沒載入金鑰：不能跳到完成
        expect(json()).toContain('按「下載 .env」交給 App');
        expect(mocks.apiPage).not.toHaveBeenCalled();
        expect(mocks.signPage).not.toHaveBeenCalled();
        expect(mocks.focus).not.toHaveBeenCalled();
    });

    it('leaving a signing page with 下一步 on the page card also switches the site to the API page, like the app button', async () => {
        await open();
        await emit({ kind: 'step', step: 'sign-f', sign: 'unknown' });
        mocks.apiPage.mockClear();
        await nav('next');
        expect(json()).toContain('按「新增 API Key」');
        expect(mocks.apiPage).toHaveBeenCalledOnce();
        expect(mocks.signPage).not.toHaveBeenCalled();
        // 官網已在 API 管理頁時，卡片的上一步／下一步不動官網
        await emit({ kind: 'step', step: 'list' });
        mocks.apiPage.mockClear();
        await nav('prev');
        await nav('next');
        await nav('next');
        expect(mocks.apiPage).not.toHaveBeenCalled();
    });

    it('can be switched off in the guide header or from the page, and remembers it', async () => {
        await open();
        expect(lastCard()).not.toBeNull();
        await act(async () => button('網頁說明')!.props.onClick());
        expect(lastCard()).toBeNull();
        expect(store.get('sjpro.applyGuide.pageCard')).toBe('0');
        expect(button('網頁說明')!.props['aria-pressed']).toBe(false);
        // 關掉時頁面上的按鈕（或假造的回報）不移動導覽
        await nav('next');
        expect(json()).toContain('登入永豐金證券網站');
        await act(async () => button('網頁說明')!.props.onClick());
        expect(lastCard()).toMatchObject({ title: '登入永豐金證券網站' });
        expect(store.has('sjpro.applyGuide.pageCard')).toBe(false);
        await nav('hide');
        expect(lastCard()).toBeNull();
        expect(store.get('sjpro.applyGuide.pageCard')).toBe('0');
        // 重新開 App：記住關掉
        await act(async () => view!.unmount()); view = undefined; mocks.card.mockClear();
        await open();
        expect(mocks.card).toHaveBeenLastCalledWith(null);
        expect(button('網頁說明')!.props['aria-pressed']).toBe(false);
    });

    it('moves from the latest step when several page presses arrive before a redraw', async () => {
        await open();
        await act(async () => { mocks.handler!({ kind: 'nav', action: 'next' }); mocks.handler!({ kind: 'nav', action: 'next' }); });
        expect(json()).toContain('按「新增 API Key」');
        await emit({ kind: 'step', step: 'success' });
        // 金鑰剛載入、同一批又來一個「上一步」：完成頁不被蓋掉
        await act(async () => {
            mocks.handler!({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false });
            mocks.handler!({ kind: 'nav', action: 'prev' });
        });
        expect(json()).toContain('金鑰已載入');
    });

    it('adds up page and app presses that arrive in the same batch', async () => {
        await open();
        // 從登入：網頁「下一步」＋ App「下一步」＝前進兩步
        await act(async () => { mocks.handler!({ kind: 'nav', action: 'next' }); button('下一步')!.props.onClick(); });
        expect(json()).toContain('按「新增 API Key」');
        // 網頁「下一步」＋ App「上一步」＝留在原地
        await act(async () => { mocks.handler!({ kind: 'nav', action: 'next' }); button('上一步')!.props.onClick(); });
        expect(json()).toContain('按「新增 API Key」');
    });

    it('ignores page presses that arrive after the card was closed in the same batch', async () => {
        await open();
        await act(async () => { mocks.handler!({ kind: 'nav', action: 'hide' }); mocks.handler!({ kind: 'nav', action: 'next' }); });
        expect(json()).toContain('登入永豐金證券網站');
        expect(lastCard()).toBeNull();
    });

    it('keeps the same limits as the app buttons', () => {
        expect(pageNavStep('login', 'prev', false)).toBe('login');
        expect(pageNavStep('login', 'next', false)).toBe('sign');
        expect(pageNavStep('success', 'next', false)).toBe('success');
        expect(pageNavStep('success', 'next', true)).toBe('imported');
        expect(pageNavStep('imported', 'prev', true)).toBe('imported');
        expect(pageNavStep('start', 'next', false)).toBe('start');
        expect(pageNavStep('form', 'prev', false)).toBe('verify');
    });

    it('carries the app theme and text size', async () => {
        await open();
        // 預設：深色、標準字級
        expect(lastCard()).toMatchObject({ theme: 'dark', large: false });
    });
});
