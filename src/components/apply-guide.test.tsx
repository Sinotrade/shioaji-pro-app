import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyGuideEvent } from '../lib/apply-guide-native';

const mocks = vi.hoisted(() => ({
    panel: vi.fn(() => null), defaults: vi.fn(), load: vi.fn(), save: vi.fn(), select: vi.fn(), start: vi.fn(),
    reload: vi.fn(), stop: vi.fn(), logout: vi.fn(), openLogs: vi.fn(), external: vi.fn(),
    open: vi.fn(), close: vi.fn(), apiPage: vi.fn(), signPage: vi.fn(), focus: vi.fn(), clearSite: vi.fn(), saveEnv: vi.fn(),
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
    openApplyWindow: mocks.open, closeApplyWindow: mocks.close, clearApplySiteData: mocks.clearSite, setApplySaveEnv: mocks.saveEnv, showApplyApiPage: mocks.apiPage, showApplySignPage: mocks.signPage, focusApplyTarget: mocks.focus,
    listenApplyGuide: async (handler: (event: ApplyGuideEvent) => void) => { mocks.handler = handler; return () => { mocks.handler = null; }; },
}));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { OnboardingSetup } from './onboarding-setup';
import { CredentialProfiles } from './credential-profiles';
import { ApplyGuide } from './apply-guide';
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
        // 已簽署的市場不再出現「打開簽署頁」
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('上一步')!.props.onClick());
        expect(byLabel('打開美股（複委託）簽署頁')).toBeUndefined();
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
        // 跳過簽署直接到 API 管理：不擋，簽署不打勾也不是錯誤
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('按「新增 API Key」');
        expect(signStep().props['aria-label']).toBe('簽署，勾選的市場還沒全部確認已簽署');
        expect(button('下一步')!.props.disabled).toBe(false);
        expect(button('上一步')!.props.disabled).toBe(false);
        await emit({ kind: 'step', step: 'sign-s', sign: 'signed' });
        await emit({ kind: 'step', step: 'sign-f', sign: 'pending' });
        await emit({ kind: 'step', step: 'list' });
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
        expect(byLabel('打開證券（台股）簽署頁')).toBeUndefined();
        await act(async () => byLabel('打開期貨／選擇權簽署頁')!.props.onClick());
        expect(mocks.signPage).toHaveBeenCalledWith('F');
        await emit({ kind: 'step', step: 'sign-f', sign: 'signed' });
        expect(json()).toContain('金鑰已載入');
        expect(json()).toContain('你選的市場都已簽署');
        expect(rows()).toHaveLength(2);
        expect(byLabel('打開美股（複委託）簽署頁')).toBeUndefined();
    });
});
