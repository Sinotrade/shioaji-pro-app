import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ panel: vi.fn(() => null), defaults: vi.fn(), env: vi.fn(), envCandidate: vi.fn() }));
const wizard = vi.hoisted(() => ({ props: undefined as { onKeysReady(keys: { apiKey: string; secretKey: string } | null, info: { saveFailed: boolean }): Promise<void>; onUseApiKey(): void; onLockedChange(locked: boolean): void } | undefined, tauri: true }));
vi.mock('../lib/features', () => ({
    agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults },
    useFeature: () => ({ enabled: true }),
    FEATURES: [],
}));
vi.mock('../lib/tauri', () => ({
    get isTauri() { return wizard.tauri; }, pickCaFile: vi.fn(), pickEnvFile: mocks.env, importEnvCandidate: mocks.envCandidate, reloadWhenHealthy: vi.fn(),
    saveDesktopSettings: vi.fn(), serverStart: vi.fn(),
}));
vi.mock('./onboarding/sinopac-wizard', () => ({ SinopacWizard: (props: typeof wizard.props) => { wizard.props = props; return null; } }));

import { reloadWhenHealthy, saveDesktopSettings, serverStart } from '../lib/tauri';
import { OnboardingSetup } from './onboarding-setup';
import './onboarding/dev-login'; // warm the lazy chunk so it resolves within act
import * as backdropStyles from './onboarding/ambient-backdrop.css';
import * as glassStyles from './onboarding/login-glass.css';
import * as modeStyles from './onboarding/mode-switch.css';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

// the DEV login screen is a lazy chunk: let the import and the Suspense retry land inside act
async function settle() {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setImmediate(done)); });
}

describe('first-run guide runtime scope', () => {
    it('explicitly opts only the embedded guide into onboarding', () => {
        vi.stubEnv('DEV', false);
        const html = renderToStaticMarkup(createElement(OnboardingSetup));
        expect(html).toContain('引導申請 API Key');
        expect(mocks.panel).toHaveBeenCalledWith({
            onboarding: true,
            initialPrompt: '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？',
            visibleTabs: ['chat', 'settings'],
        }, undefined);
        expect(mocks.defaults).toHaveBeenCalledWith('codex');
    });
});

describe('first-run .env import', () => {
    it('uses the same file and folder choices and reports the chosen file', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', new EventTarget());
        const selection = { directory: '/tmp/fixture', candidates: ['.env', 's_multi.env'] };
        mocks.env.mockResolvedValue({ kind: 'choose', selection });
        mocks.envCandidate.mockResolvedValue({ kind: 'imported', fileName: 's_multi.env', apiKey: 'fixture-api' });
        let view!: ReturnType<typeof create>;
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await settle();
        const button = (label: string) => view.root.findAllByType('button').find(node => node.children.filter(x => typeof x === 'string').join('').includes(label))!;
        expect(JSON.stringify(view.toJSON())).toContain('支援 name.env、.env、.env.local；隱藏檔請選資料夾。');
        await act(async () => button('選擇資料夾').props.onClick());
        expect(mocks.env).toHaveBeenCalledWith('directory');
        expect(JSON.stringify(view.toJSON())).toContain('資料夾裡有 2 個 .env 檔案');
        await act(async () => button('s_multi.env').props.onClick());
        expect(mocks.envCandidate).toHaveBeenCalledExactlyOnceWith(selection, 's_multi.env');
        expect(JSON.stringify(view.toJSON())).toContain('已從 s_multi.env 匯入');
        await act(async () => view.unmount());
    });
});

describe('first-run account/password section', () => {
    const keys = { apiKey: 'fixture-api', secretKey: 'fixture-sec' };
    const mount = async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { assign: vi.fn(), pathname: '/' } }));
        let view!: ReturnType<typeof create>;
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await settle();
        return view;
    };
    const saved = { saveFailed: false };
    afterEach(() => { wizard.tauri = true; });

    const tab = (view: ReturnType<typeof create>, mode: string) => view.root.findByProps({ id: `login-tab-${mode}` });
    const panel = (view: ReturnType<typeof create>, mode: string) => view.root.findByProps({ id: `login-panel-${mode}` });

    it('opens on the account tab in dev, with the original form behind the other tab', async () => {
        const view = await mount();
        expect(tab(view, 'account').props['aria-selected']).toBe(true);
        expect(panel(view, 'account').props.hidden).toBe(false);
        expect(panel(view, 'apikey').props.hidden).toBe(true);
        expect(wizard.props?.onKeysReady).toBeTypeOf('function');
        await act(async () => view.unmount());
    });

    it('shows the original form when the API Key tab is chosen', async () => {
        const view = await mount();
        await act(async () => tab(view, 'apikey').props.onClick());
        expect(tab(view, 'apikey').props['aria-selected']).toBe(true);
        expect(panel(view, 'account').props.hidden).toBe(true);
        expect(panel(view, 'apikey').props.hidden).toBe(false);
        expect(view.root.findByProps({ placeholder: 'SJ_API_KEY' })).toBeTruthy();
        expect(JSON.stringify(view.toJSON())).toContain('啟動並開始使用');
        await act(async () => view.unmount());
    });

    it('switches to the API Key tab when the wizard gives up on the account flow', async () => {
        const view = await mount();
        await act(async () => wizard.props!.onUseApiKey());
        expect(tab(view, 'apikey').props['aria-selected']).toBe(true);
        expect(panel(view, 'apikey').props.hidden).toBe(false);
        await act(async () => view.unmount());
    });

    it('moves the selection with the arrow keys', async () => {
        const view = await mount();
        await act(async () => tab(view, 'account').props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }));
        expect(panel(view, 'apikey').props.hidden).toBe(false);
        await act(async () => tab(view, 'apikey').props.onKeyDown({ key: 'ArrowLeft', preventDefault: vi.fn() }));
        expect(panel(view, 'account').props.hidden).toBe(false);
        await act(async () => view.unmount());
    });

    it('renders the upstream form alone in packaged builds, which have no dev middleware behind it', () => {
        vi.stubEnv('DEV', false);
        const html = renderToStaticMarkup(createElement(OnboardingSetup));
        vi.unstubAllEnvs();
        expect(html).toContain('填入永豐 API 金鑰以啟動交易伺服器');
        expect(html).toContain('還沒有 API Key？請至永豐 API 管理頁申請。');
        expect(html).toContain('啟動並開始使用');
        expect(html).not.toContain('tablist');
        expect(html).not.toContain('tabpanel');
        expect(html).not.toContain('帳號密碼登入');
        expect(html).not.toContain(glassStyles.card);
        expect(html).not.toContain(glassStyles.shell);
        expect(html).not.toContain(backdropStyles.root);
        expect(html).not.toContain(modeStyles.pane);
    });

    it('saves and starts the server with the minted keys', async () => {
        vi.mocked(serverStart).mockResolvedValue({ ok: true } as never);
        const view = await mount();
        await act(async () => wizard.props!.onKeysReady(keys, saved));
        const expected = expect.objectContaining({ ...keys, production: false });
        expect(saveDesktopSettings).toHaveBeenCalledWith(expected);
        expect(serverStart).toHaveBeenCalledWith(expected);
        expect(reloadWhenHealthy).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });

    it('fills the original fields, shows the error on the API Key tab and rejects so the wizard keeps the keys', async () => {
        vi.mocked(serverStart).mockResolvedValue({ ok: false, output: 'fixture failure' } as never);
        const view = await mount();
        await act(async () => { await expect(wizard.props!.onKeysReady(keys, saved)).rejects.toThrow('START_FAILED'); });
        expect(tab(view, 'apikey').props['aria-selected']).toBe(true);
        expect(panel(view, 'apikey').props.hidden).toBe(false);
        expect(view.root.findByProps({ placeholder: 'SJ_API_KEY' }).props.value).toBe(keys.apiKey);
        expect(view.root.findByProps({ placeholder: 'SJ_SEC_KEY' }).props.value).toBe(keys.secretKey);
        expect(JSON.stringify(view.toJSON())).toContain('fixture failure');
        expect(JSON.stringify(view.toJSON())).toContain('啟動並開始使用');
        await act(async () => view.unmount());
    });

    it('rejects a second call while the server is starting, so the wizard keeps the secret', async () => {
        vi.mocked(serverStart).mockReturnValue(new Promise(() => {}));
        const view = await mount();
        await act(async () => { void wizard.props!.onKeysReady(keys, saved); });
        await act(async () => { await expect(wizard.props!.onKeysReady(keys, saved)).rejects.toThrow('BUSY'); });
        expect(serverStart).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });

    it('only leaves the preview in a plain browser: no sidecar to start', async () => {
        wizard.tauri = false;
        const view = await mount();
        await act(async () => wizard.props!.onKeysReady(null, saved));
        expect(window.location.assign).toHaveBeenCalledExactlyOnceWith('/');
        expect(serverStart).not.toHaveBeenCalled();
        expect(saveDesktopSettings).not.toHaveBeenCalled();
        await act(async () => view.unmount());
    });

    it('stays put in a plain browser when .env was not written, with the keys in the API Key form', async () => {
        wizard.tauri = false;
        const view = await mount();
        await act(async () => wizard.props!.onKeysReady(keys, { saveFailed: true }));
        expect(window.location.assign).not.toHaveBeenCalled();
        expect(serverStart).not.toHaveBeenCalled();
        expect(tab(view, 'apikey').props['aria-selected']).toBe(true);
        expect(view.root.findByProps({ placeholder: 'SJ_API_KEY' }).props.value).toBe(keys.apiKey);
        expect(view.root.findByProps({ placeholder: 'SJ_SEC_KEY' }).props.value).toBe(keys.secretKey);
        await act(async () => view.unmount());
    });

    it('locks the tabs while the wizard holds a one-time secret on screen', async () => {
        const view = await mount();
        await act(async () => wizard.props!.onLockedChange(true));
        expect(tab(view, 'apikey').props['aria-disabled']).toBe(true);
        await act(async () => tab(view, 'apikey').props.onClick());
        await act(async () => tab(view, 'account').props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }));
        expect(panel(view, 'account').props.hidden).toBe(false);
        await act(async () => wizard.props!.onLockedChange(false));
        expect(tab(view, 'apikey').props['aria-disabled']).toBeUndefined();
        await act(async () => tab(view, 'apikey').props.onClick());
        expect(panel(view, 'apikey').props.hidden).toBe(false);
        await act(async () => view.unmount());
    });
});
