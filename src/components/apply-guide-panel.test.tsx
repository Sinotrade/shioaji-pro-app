import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyGuideEvent } from '../lib/apply-guide-native';

const mocks = vi.hoisted(() => ({
    open: vi.fn(), close: vi.fn(), apiPage: vi.fn(), signPage: vi.fn(), focus: vi.fn(), clearSite: vi.fn(), saveEnv: vi.fn(), card: vi.fn(),
    saveCa: vi.fn(), importEnvironment: vi.fn(), caTarget: vi.fn(), external: vi.fn(),
    handler: null as ((event: ApplyGuideEvent) => void) | null,
}));
vi.mock('../lib/tauri', async () => ({ ...await import('../lib/desktop-credentials'), isTauri: true, openExternalUrl: mocks.external }));
vi.mock('../lib/apply-guide-native', () => ({
    openApplyWindow: mocks.open, closeApplyWindow: mocks.close, clearApplySiteData: mocks.clearSite, setApplySaveEnv: mocks.saveEnv,
    setApplySaveCa: mocks.saveCa, setApplyImportEnvironment: mocks.importEnvironment, setApplyCaTarget: mocks.caTarget,
    showApplyApiPage: mocks.apiPage, showApplySignPage: mocks.signPage, focusApplyTarget: mocks.focus, setApplyGuideCard: mocks.card,
    listenApplyGuide: async (handler: (event: ApplyGuideEvent) => void) => { mocks.handler = handler; return () => { mocks.handler = null; }; },
}));
import { EMPTY_DESKTOP_SETTINGS, type CredentialProfile, type DesktopSettings } from '../lib/desktop-credentials';
import { ApplyGuidePanel } from './apply-guide-panel';
import { canGoNext, followSiteStep, pageNavStep } from './apply-guide';

// fixture 帳號：沒有真實金鑰
const sim: CredentialProfile = { id: 'p1', name: 'ShioajiPro', environment: 'simulation', hasCA: false, caPath: '', createdAt: '', apiKeyMasked: '••••6789', secretState: 'stored', credentialBackend: 'system', revision: 'r1' };
const prod: CredentialProfile = { ...sim, id: 'p2', name: 'ShioajiProProd', environment: 'production', apiKeyMasked: '••••4321', revision: 'r2' };
const withProfiles = (...profiles: CredentialProfile[]): DesktopSettings => ({ ...EMPTY_DESKTOP_SETTINGS, activeProfileId: 'p1', configured: true, profiles });

let view: ReactTestRenderer | undefined;
const label = (node: ReactTestInstance): string => node.children.map(x => typeof x === 'string' ? x : label(x)).join('');
const button = (text: string) => view!.root.findAllByType('button').find(b => label(b).startsWith(text));
const json = () => JSON.stringify(view!.toJSON());
const emit = async (event: ApplyGuideEvent) => act(async () => mocks.handler!(event));
const props = { onClose: vi.fn(), onChanged: vi.fn(), onOpenAccount: vi.fn() };
let seq = 0;
let request: { task: 'production' | 'ca' | 'sign' | null; seq: number } = { task: null, seq: 0 };
const mount = async (settings: DesktopSettings, task: 'production' | 'ca' | 'sign' | null = null) => {
    request = { task, seq: ++seq };
    await act(async () => { view = create(createElement(ApplyGuidePanel, { settings, request, ...props })); });
};
/** 同一個要求、只換帳號資料；ask：送出一次新的要求 */
const rerender = async (settings: DesktopSettings, ask?: { task: 'production' | 'ca' | 'sign' | null }) => {
    if (ask) request = { task: ask.task, seq: ++seq };
    await act(async () => { view!.update(createElement(ApplyGuidePanel, { settings, request, ...props })); });
};

beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    mocks.open.mockResolvedValue('overlay');
    mocks.caTarget.mockImplementation(async (id: string | null) => id && 'ShioajiProProd');
});
afterEach(async () => { if (view) { await act(async () => view!.unmount()); view = undefined; } vi.unstubAllGlobals(); });

describe('in-app apply guide', () => {
    it('asks which task first, then opens the same apply window', async () => {
        await mount(withProfiles(sim));
        expect(json()).toContain('要在官網上做什麼？');
        for (const title of ['申請正式 API Key', '下載 CA 憑證', '簽署 API 約定書']) expect(button(title)).toBeDefined();
        expect(mocks.open).not.toHaveBeenCalled();
        // 沒有正式帳號時提醒下載憑證要先有正式帳號
        expect(json()).toContain('還沒有正式帳號');
        await act(async () => button('申請正式 API Key')!.props.onClick());
        expect(mocks.open).toHaveBeenCalledOnce();
        expect(mocks.importEnvironment).toHaveBeenCalledWith('production');
        expect(json()).toContain('登入永豐金證券網站');
        // 關閉：連申請視窗一起關
        await act(async () => view!.root.findByProps({ 'aria-label': '關閉導覽' }).props.onClick());
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(props.onClose).toHaveBeenCalledOnce();
    });

    it('applies for a production key: recommends 正式環境, saves a production profile and continues to the CA step', async () => {
        await mount(withProfiles(sim), 'production');
        expect(mocks.importEnvironment).toHaveBeenCalledWith('production');
        await emit({ kind: 'step', step: 'form' });
        expect(json()).toContain('這次要申請正式環境用的金鑰，請勾選');
        expect(json()).toContain('ShioajiProProd');
        await emit({ kind: 'step', step: 'success' });
        expect(json()).toContain('存成正式帳號');
        await rerender(withProfiles(sim, prod));
        await emit({ kind: 'imported', profileId: 'p2', name: 'ShioajiProProd', duplicate: false, environment: 'production' });
        expect(json()).toContain('正式金鑰已載入');
        expect(json()).toContain('正式環境');
        expect(json()).not.toContain('啟動模擬環境');
        expect(props.onChanged).toHaveBeenCalled();
        // 憑證預設設定到剛存的正式帳號
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        await act(async () => button('下一步：下載 CA 憑證')!.props.onClick());
        expect(json()).toContain('按「下載憑證」交給 App');
        const radio = view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        expect(radio).toHaveLength(1);
        expect(radio[0]!.props.checked).toBe(true);
    });

    it('warns when the shell saved the production key as simulation', async () => {
        await mount(withProfiles(sim), 'production');
        await emit({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: false, environment: 'simulation' });
        expect(json()).toContain('這把金鑰存成了模擬帳號');
        await act(async () => button('到帳號設定改成正式環境')!.props.onClick());
        expect(props.onOpenAccount).toHaveBeenCalledWith('p1');
    });

    it('does not continue a production application when the shell cannot save production profiles', async () => {
        mocks.importEnvironment.mockRejectedValue(new Error('這個版本無法把金鑰存成正式帳號，請更新 App'));
        await mount(withProfiles(sim));
        await act(async () => button('申請正式 API Key')!.props.onClick());
        expect(json()).toContain('這個版本無法把金鑰存成正式帳號');
        expect(json()).toContain('要在官網上做什麼？');
    });

    it('downloads the CA straight to the API page, attaches it to the chosen production profile and leaves the password to account settings', async () => {
        const other: CredentialProfile = { ...prod, id: 'p3', name: '第二正式', hasCA: true, caPath: '/fixture/old.pfx' };
        await mount(withProfiles(sim, prod, other));
        await act(async () => button('申請正式 API Key')!.props.onClick()); // 先開視窗、官網已登入
        await emit({ kind: 'step', step: 'list' });
        mocks.focus.mockClear();
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => button('下載 CA 憑證')!.props.onClick());
        // 已登入：不必重新登入，直接到 CA 這一步並標示「下載憑證」
        expect(json()).toContain('按「下載憑證」交給 App');
        expect(mocks.focus).toHaveBeenCalledWith('download-ca');
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('simulation');
        // 兩個正式帳號：要使用者選，選了才標示、才攔截
        const radios = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        expect(radios().map(r => r.props.checked)).toEqual([false, false]);
        expect(view!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')).toHaveLength(0);
        await act(async () => radios()[1]!.props.onChange());
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p3');
        // 「同時存一份到『下載』資料夾」：預設關、記住選擇
        const box = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox')[0]!;
        expect(box().props.checked).toBe(false);
        await act(async () => box().props.onChange({ currentTarget: { checked: true } }));
        expect(mocks.saveCa).toHaveBeenLastCalledWith(true);
        expect(localStorage.getItem('sjpro.applyGuide.saveCaFile')).toBe('1');
        await emit({ kind: 'ca-failed', message: '收到的檔案不是有效的 CA 憑證（Sinopac.pfx），沒有儲存' });
        expect(json()).toContain('不是有效的 CA 憑證');
        await emit({ kind: 'ca-attached', profileId: 'p3', name: '第二正式', fileName: 'Sinopac.pfx', hasCaPassword: false });
        expect(json()).not.toContain('不是有效的 CA 憑證');
        expect(label(view!.root)).toContain('「Sinopac.pfx」已存到這台電腦，設定給「第二正式」');
        expect(json()).toContain('還要輸入憑證密碼');
        expect(props.onChanged).toHaveBeenCalled();
        await act(async () => button('到帳號設定輸入憑證密碼')!.props.onClick());
        expect(props.onOpenAccount).toHaveBeenCalledWith('p3');
    });

    it('sends the remembered save-CA choice and the chosen profile when the window opens', async () => {
        localStorage.setItem('sjpro.applyGuide.saveCaFile', '1');
        await mount(withProfiles(sim, prod), 'ca');
        expect(mocks.saveCa).toHaveBeenCalledWith(true);
        // 還在登入：尚未指定帳號，下載照一般處理
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('按「下載憑證」交給 App');
        // 只有一個正式帳號：直接選它
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        await emit({ kind: 'closed' });
        expect(json()).toContain('官網視窗已關閉');
        await act(async () => button('重新打開官網')!.props.onClick());
        // 重新打開：原生端已重設，再送一次
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('simulation');
    });

    it('shows why a CA target was refused and offers the production key without a production profile', async () => {
        await mount(withProfiles(sim), 'ca');
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('還沒有正式帳號');
        expect(view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio')).toHaveLength(0);
        await act(async () => view!.root.findAllByType('button').find(b => label(b) === '申請正式 API Key')!.props.onClick());
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('production');
    });

    it('tries the only production profile once when the shell refuses it', async () => {
        await mount(withProfiles(sim, prod), 'ca');
        mocks.caTarget.mockImplementation(async (id: string | null) => {
            if (id) throw new Error('CA 憑證只能存到正式環境的帳號');
            return null;
        });
        await emit({ kind: 'step', step: 'list' });
        await emit({ kind: 'step', step: 'list' });
        expect(mocks.caTarget.mock.calls.filter(([id]) => id === 'p2')).toHaveLength(1);
        expect(json()).toContain('憑證沒有存成');
        // 使用者自己再選一次才重送
        const radio = view!.root.find(n => n.type === 'input' && n.props.type === 'radio');
        await act(async () => radio.props.onChange());
        expect(mocks.caTarget.mock.calls.filter(([id]) => id === 'p2')).toHaveLength(2);
    });

    it('ignores a refusal for a profile the user already switched away from', async () => {
        const other: CredentialProfile = { ...prod, id: 'p3', name: '第二正式' };
        await mount(withProfiles(sim, prod, other), 'ca');
        await emit({ kind: 'step', step: 'list' });
        let refuse!: (error: Error) => void;
        mocks.caTarget.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
        const radios = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        await act(async () => { void radios()[0]!.props.onChange(); });
        await act(async () => radios()[1]!.props.onChange());
        await act(async () => refuse(new Error('憑證要設定的帳號已經改變，請重新選擇')));
        expect(json()).not.toContain('憑證沒有存成');
        expect(radios().map(r => r.props.checked)).toEqual([false, true]);
    });

    it('stays on the task list while the site changes pages, with native back to first-run defaults', async () => {
        await mount(withProfiles(sim), 'production');
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('simulation');
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
        await emit({ kind: 'step', step: 'form' });
        expect(json()).toContain('要在官網上做什麼？');
    });

    it('follows every new request while the panel stays open', async () => {
        await mount(withProfiles(sim, prod), 'production');
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => button('下載 CA 憑證')!.props.onClick());
        expect(json()).toContain('按「下載憑證」交給 App');
        // 再按一次「申請正式 API Key」捷徑：同一件事也要切過去
        await rerender(withProfiles(sim, prod), { task: 'production' });
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('production');
        expect(json()).not.toContain('按「下載憑證」交給 App');
        // 設定裡的導覽按鈕：回到選擇
        await rerender(withProfiles(sim, prod), { task: null });
        expect(json()).toContain('要在官網上做什麼？');
    });

    it('closes the apply window before handing over to account settings', async () => {
        await mount(withProfiles(sim, prod), 'ca');
        await emit({ kind: 'step', step: 'list' });
        await emit({ kind: 'ca-attached', profileId: 'p2', name: 'ShioajiProProd', fileName: 'Sinopac.pfx', hasCaPassword: false });
        await act(async () => button('到帳號設定輸入憑證密碼')!.props.onClick());
        expect(mocks.close).toHaveBeenCalledOnce();
        expect(props.onOpenAccount).toHaveBeenCalledWith('p2');
    });

    it('keeps the just-imported production profile as the CA target while the profile list refreshes', async () => {
        const older: CredentialProfile = { ...prod, id: 'p0', name: '舊正式帳號' };
        await mount(withProfiles(sim, older), 'production');
        await emit({ kind: 'step', step: 'success' });
        // 清單還沒讀進新帳號就到 CA 這一步
        await emit({ kind: 'imported', profileId: 'p2', name: 'ShioajiProProd', duplicate: false, environment: 'production' });
        await act(async () => button('下一步：下載 CA 憑證')!.props.onClick());
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        expect(mocks.caTarget).not.toHaveBeenCalledWith('p0');
        await rerender(withProfiles(sim, older, prod));
        const radios = view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        expect(radios.map(r => r.props.checked)).toEqual([false, true]);
        // 列過的帳號被刪掉：取消選擇
        await rerender(withProfiles(sim, older));
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
    });

    it('does not let a late production import take over the CA task', async () => {
        await mount(withProfiles(sim, prod), 'production');
        await emit({ kind: 'step', step: 'success' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => button('下載 CA 憑證')!.props.onClick());
        await emit({ kind: 'imported', profileId: 'p2', name: 'ShioajiProProd', duplicate: false, environment: 'production' });
        expect(props.onChanged).toHaveBeenCalled();
        expect(json()).not.toContain('啟動模擬環境');
        expect(json()).not.toContain('正式金鑰已載入');
    });

    it('starts each task without the previous certificate recipient', async () => {
        await mount(withProfiles(sim, prod), 'ca');
        await emit({ kind: 'step', step: 'list' });
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        await act(async () => button('換一件要做的事')!.props.onClick());
        await rerender(withProfiles(sim));
        await act(async () => button('申請正式 API Key')!.props.onClick());
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('production');
        expect(json()).not.toContain('要在官網上做什麼？');
    });

    it('keeps a newer selection when the reopened window refuses the previous one', async () => {
        const other: CredentialProfile = { ...prod, id: 'p3', name: '第二正式' };
        await mount(withProfiles(sim, prod, other), 'ca');
        await emit({ kind: 'step', step: 'list' });
        const radios = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        await act(async () => radios()[0]!.props.onChange());
        await emit({ kind: 'closed' });
        let refuse!: (error: Error) => void;
        mocks.caTarget.mockImplementation(async (id: string | null) => {
            if (id === 'p2') return new Promise<string>((_resolve, reject) => { refuse = reject; });
            return id && '第二正式';
        });
        await act(async () => { void button('重新打開官網')!.props.onClick(); });
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        await act(async () => radios()[1]!.props.onChange());
        await act(async () => refuse(new Error('憑證要設定的帳號已經改變，請重新選擇')));
        expect(json()).not.toContain('憑證沒有存成');
        expect(radios().map(r => r.props.checked)).toEqual([false, true]);
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p3');
    });

    it('does not reopen the apply window after the panel closed during a task switch', async () => {
        await mount(withProfiles(sim, prod), 'ca');
        await emit({ kind: 'step', step: 'list' });
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => { void button('簽署 API 約定書')!.props.onClick(); });
        const opens = mocks.open.mock.calls.length;
        await act(async () => view!.root.findByProps({ 'aria-label': '關閉導覽' }).props.onClick());
        await act(async () => view!.unmount());
        view = undefined;
        await act(async () => finish());
        expect(mocks.open.mock.calls.length).toBe(opens);
    });

    it('does not let a reset still waiting on the shell clear the CA recipient of the next task', async () => {
        const other: CredentialProfile = { ...prod, id: 'p3', name: '第二正式' };
        await mount(withProfiles(sim, prod, other), 'ca');
        await emit({ kind: 'step', step: 'list' });
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        // 回到選擇畫面的重設還在等原生端，使用者就開始下載憑證並選好帳號
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => button('下載 CA 憑證')!.props.onClick());
        const radios = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        await act(async () => radios()[0]!.props.onChange());
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        const calls = mocks.caTarget.mock.calls.length;
        await act(async () => finish());
        // 舊的重設不再送「不攔截」：畫面選著的帳號和原生端一致
        expect(mocks.caTarget.mock.calls.length).toBe(calls);
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
        expect(radios().map(r => r.props.checked)).toEqual([true, false]);
    });

    it('does not show a refused production task after the user moved on to another task', async () => {
        await mount(withProfiles(sim, prod), 'sign');
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        let refuse!: (error: Error) => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
        await act(async () => { void button('申請正式 API Key')!.props.onClick(); });
        await act(async () => button('換一件要做的事')!.props.onClick());
        await act(async () => button('下載 CA 憑證')!.props.onClick());
        await act(async () => refuse(new Error('這個版本無法把金鑰存成正式帳號，請更新 App')));
        expect(json()).toContain('按「下載憑證」交給 App');
        expect(json()).not.toContain('這個版本無法把金鑰存成正式帳號');
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
    });

    it('does not reopen the apply window when the user closed it during a task switch', async () => {
        await mount(withProfiles(sim, prod), 'ca');
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => { void button('簽署 API 約定書')!.props.onClick(); });
        const opens = mocks.open.mock.calls.length;
        // 原生視窗被使用者關掉（原生端已回到模擬、不攔截憑證），面板還開著
        await emit({ kind: 'closed' });
        await act(async () => finish());
        expect(mocks.open.mock.calls.length).toBe(opens);
        expect(json()).toContain('官網視窗已關閉');
        // 使用者自己按才重開，而且走完整的開窗同步
        mocks.importEnvironment.mockClear(); mocks.caTarget.mockClear();
        await act(async () => button('重新打開官網')!.props.onClick());
        expect(mocks.open.mock.calls.length).toBe(opens + 1);
        expect(mocks.importEnvironment).toHaveBeenCalledWith('simulation');
        expect(mocks.caTarget).toHaveBeenCalledWith(null);
    });

    it('does not show the window as open when it was closed while the task was being handed over', async () => {
        await mount(withProfiles(sim, prod));
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => { void button('簽署 API 約定書')!.props.onClick(); });
        await emit({ kind: 'closed' });
        await act(async () => finish());
        expect(json()).toContain('官網視窗已關閉');
        expect(mocks.caTarget).not.toHaveBeenCalled();
    });

    it('does not let a hand-over from a closed panel clear the CA recipient chosen in the reopened one', async () => {
        const other: CredentialProfile = { ...prod, id: 'p3', name: '第二正式' };
        await mount(withProfiles(sim, prod, other), 'ca');
        await emit({ kind: 'step', step: 'list' });
        await act(async () => button('換一件要做的事')!.props.onClick());
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => { void button('簽署 API 約定書')!.props.onClick(); });
        await act(async () => view!.unmount());
        // 導覽再叫出來、選好憑證帳號以後，舊面板等的那一次才回來
        await mount(withProfiles(sim, prod, other), 'ca');
        await emit({ kind: 'step', step: 'list' });
        const radios = () => view!.root.findAll(n => n.type === 'input' && n.props.type === 'radio');
        await act(async () => radios()[0]!.props.onChange());
        const calls = mocks.caTarget.mock.calls.length;
        await act(async () => finish());
        expect(mocks.caTarget.mock.calls.length).toBe(calls);
        expect(mocks.caTarget).toHaveBeenLastCalledWith('p2');
    });

    it('stays on the task list when the user went back while the window was still opening', async () => {
        await mount(withProfiles(sim, prod));
        let finish!: () => void;
        mocks.importEnvironment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        await act(async () => { void button('下載 CA 憑證')!.props.onClick(); });
        await act(async () => button('換一件要做的事')!.props.onClick());
        expect(json()).toContain('要在官網上做什麼？');
        await act(async () => finish());
        expect(json()).toContain('要在官網上做什麼？');
        // 原生端照選擇畫面：模擬、不攔截憑證
        expect(mocks.importEnvironment).toHaveBeenLastCalledWith('simulation');
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
    });

    it('discloses plaintext storage for a production key like first-run setup', async () => {
        await mount({ ...withProfiles(sim), credentialBackend: 'plaintext-fallback', fallbackPath: '/fixture/credentials.json' }, 'production');
        await emit({ kind: 'imported', profileId: 'p2', name: 'ShioajiProProd', duplicate: false, environment: 'production' });
        expect(json()).toContain('金鑰存成檔案');
        expect(json()).toContain('/fixture/credentials.json');
    });

    it('only signs in the signing task', async () => {
        await mount(withProfiles(sim), 'sign');
        expect(mocks.importEnvironment).toHaveBeenCalledWith('simulation');
        expect(mocks.caTarget).toHaveBeenLastCalledWith(null);
        await emit({ kind: 'step', step: 'list' });
        expect(json()).toContain('簽署 API 約定書');
        expect(button('前往 API 管理頁申請金鑰')).toBeUndefined();
        // 跟著官網走也停在簽署
        await emit({ kind: 'step', step: 'verify' });
        expect(json()).toContain('簽署 API 約定書');
        await act(async () => button('完成')!.props.onClick());
        expect(props.onClose).toHaveBeenCalled();
    });
});

describe('task-aware guide navigation', () => {
    it('keeps the CA and signing tasks on their one step after login', () => {
        for (const site of ['list', 'verify', 'form', 'success', 'sign-s'] as const) {
            expect(followSiteStep('login', site, 'ca')).toBe('ca');
            expect(followSiteStep('ca', site, 'ca')).toBe('ca');
            expect(followSiteStep('login', site, 'sign')).toBe('sign');
        }
        expect(followSiteStep('ca', 'login', 'ca')).toBe('login');
        expect(followSiteStep('sign', 'login', 'sign')).toBe('login');
    });
    it('keeps the production task on the CA step unless another application starts', () => {
        expect(followSiteStep('ca', 'list', 'production')).toBe('ca');
        expect(followSiteStep('ca', 'sign-s', 'production')).toBe('ca');
        expect(followSiteStep('ca', 'verify', 'production')).toBe('verify');
        expect(followSiteStep('login', 'list', 'production')).toBe('sign');
        // 首次設定不受影響
        expect(followSiteStep('login', 'list')).toBe('sign');
        expect(followSiteStep('ca', 'list')).toBe('list');
    });
    it('steps through the production order and never past the end of a task', () => {
        expect(pageNavStep('imported', 'next', true, 'production')).toBe('ca');
        expect(pageNavStep('imported', 'next', false, 'production')).toBe('imported');
        expect(pageNavStep('ca', 'next', true, 'production')).toBe('ca');
        expect(pageNavStep('ca', 'prev', true, 'production')).toBe('imported'); // 回到「存入 App」看載入結果
        expect(pageNavStep('ca', 'next', false, 'ca')).toBe('ca');
        expect(pageNavStep('ca', 'prev', false, 'ca')).toBe('login');
        expect(pageNavStep('sign', 'next', false, 'sign')).toBe('sign');
        expect(canGoNext('sign', false, 'apply')).toBe(true);
        expect(pageNavStep('success', 'next', false, 'production')).toBe('success');
    });
});
