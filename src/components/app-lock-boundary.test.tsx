// 應用程式鎖遮蔽層的元件測試。專案沒有 DOM 環境（node + react-test-renderer）：body、
// MutationObserver 用最小的假物件；鎖定狀態接真的 lib/app-lock（localStorage 用 Map）。
// 每個案例 vi.resetModules() 後重新 import，狀態不會帶到下一個案例。
import { createElement, useEffect, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ store: new Map<string, string>(), invoke: vi.fn(), notify: vi.fn() }));
// react-test-renderer 沒有 portal：直接把內容畫在原地
vi.mock('react-dom', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-dom')>(),
    createPortal: (children: unknown) => children,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
// 核可視窗也載入遮蔽層：直接或間接引用圖示庫都會讓它多拉約 225 KB，載入就失敗
vi.mock('lucide-react', () => { throw new Error('核可視窗不可載入 lucide-react'); });
vi.mock('../lib/trade', () => ({ notify: m.notify }));
// 這裡當成子視窗：第 10 次輸錯不在這個視窗登出，畫面停在「正在登出」（網頁版是登不出去的說明）
vi.mock('../lib/window-role', () => ({ isChildWindow: () => true }));

// 雜湊照樣用真的 WebCrypto，只把次數降到 1,000：600,000 次在全套平行跑、機器忙時會讓案例逾時
const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
const fastDeriveBits: typeof crypto.subtle.deriveBits = (alg, key, len) =>
    realDeriveBits({ ...(alg as Pbkdf2Params), iterations: 1_000 }, key, len);

const PASSWORD = 'correct horse';

// 最小的 DOM 元素：只有遮蔽層會碰到的屬性操作
class FakeElement {
    readonly nodeType = 1;
    attrs = new Map<string, string>();
    constructor(attrs: Record<string, string> = {}) { Object.entries(attrs).forEach(([k, v]) => this.attrs.set(k, v)); }
    hasAttribute(name: string) { return this.attrs.has(name); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    snapshot() { return Object.fromEntries(this.attrs); }
}
class FakeObserver {
    static all: FakeObserver[] = [];
    active = false;
    constructor(readonly callback: (records: { addedNodes: FakeElement[]; removedNodes: FakeElement[] }[]) => void) { FakeObserver.all.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
}

let lib: typeof import('../lib/app-lock');
let AppLockBoundary: typeof import('./app-lock-boundary').AppLockBoundary;
let body: { children: FakeElement[] };
let doc: { body: typeof body; activeElement: unknown };
let view: ReactTestRenderer | undefined;
let focused: string[];
// 鎖定期間 React 在 body 底下掛上新的 portal（委託確認框等）
const appendToBody = (el: FakeElement) => {
    body.children.push(el);
    FakeObserver.all.filter((o) => o.active).forEach((o) => o.callback([{ addedNodes: [el], removedNodes: [] }]));
};
const surfaceNode = { focus: () => { doc.activeElement = surfaceNode; focused.push('surface'); } };
const inputNode = { focus: () => { doc.activeElement = inputNode; focused.push('password'); } };

const render = async (inner: ReactElement = createElement('div', null, '底層 App')) => {
    await act(async () => {
        view = create(createElement(AppLockBoundary, null, inner), {
            createNodeMock: (el) => el.type === 'input' ? inputNode
                : 'data-app-lock-surface' in (el.props as object) ? surfaceNode : null,
        });
    });
};
const run = (fn: () => unknown) => act(async () => { await fn(); });
const surface = () => view!.root.findAll((n) => typeof n.type === 'string' && 'data-app-lock-surface' in n.props)[0];
const text = () => JSON.stringify(view!.toJSON());
const buttons = () => view!.root.findAllByType('button');
const buttonByText = (label: string) => buttons().find((b) => b.children.join('') === label);
const typePassword = (value: string) => act(async () => { view!.root.findByType('input').props.onChange({ target: { value } }); });
// 送出後等真的雜湊比對跑完、畫面更新
const submit = async () => {
    await act(async () => { view!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }); });
    await vi.waitFor(() => expect(view!.root.findAllByType('button').every((b) => !b.props.disabled)).toBe(true));
};
const tryPassword = async (value: string) => { await typePassword(value); await submit(); };
const lockWith = async (patch: Record<string, unknown> = {}) => {
    await lib.enableAppLock(PASSWORD);
    // 測試設定：直接改存檔再重新載入模組，等於「上次關 App 時的狀態」
    const saved = JSON.parse(m.store.get('sj-pro-app-lock')!);
    m.store.set('sj-pro-app-lock', JSON.stringify({ ...saved, locked: true, ...patch }));
    await load();
};
async function load() {
    vi.resetModules();
    lib = await import('../lib/app-lock');
    ({ AppLockBoundary } = await import('./app-lock-boundary'));
}

beforeEach(async () => {
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(fastDeriveBits);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.store.clear();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => m.store.get(k) ?? null,
        setItem: (k: string, v: string) => void m.store.set(k, String(v)),
        removeItem: (k: string) => void m.store.delete(k),
    });
    body = { children: [] };
    doc = { body, activeElement: null };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    vi.stubGlobal('MutationObserver', FakeObserver);
    FakeObserver.all = [];
    focused = [];
    await load();
});
afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('沒鎖的時候', () => {
    it.each([['沒啟用', false], ['已啟用、沒鎖', true]])('%s：沒有遮蔽層，body 子元素原封不動', async (_name, enabled) => {
        if (enabled) await lib.enableAppLock(PASSWORD);
        const root = new FakeElement({ id: 'root' });
        body.children.push(root);
        await render();
        expect(surface()).toBeUndefined();
        expect(text()).toContain('底層 App');
        expect(root.snapshot()).toEqual({ id: 'root' });
    });
});

describe('遮蔽期間 body 底下的其他內容不可操作', () => {
    it('上鎖立刻 inert＋aria-hidden，期間新掛上的 portal 也處理，解鎖後精確還原', async () => {
        const root = new FakeElement({ id: 'root' });
        // 原本就有的屬性：aria-hidden="false" 與已經 inert 的元素，還原時不能被拿掉或改掉
        const hiddenFalse = new FakeElement({ 'aria-hidden': 'false' });
        const alreadyInert = new FakeElement({ inert: '' });
        body.children.push(root, hiddenFalse, alreadyInert);
        await lib.enableAppLock(PASSWORD);
        await render();
        await run(() => lib.lockApp());
        for (const el of [root, hiddenFalse, alreadyInert]) {
            expect(el.getAttribute('inert')).toBe('');
            expect(el.getAttribute('aria-hidden')).toBe('true');
        }
        // 鎖著的時候委託確認框（portal 掛在 body 底下）才掛上
        const orderDialog = new FakeElement({ role: 'dialog' });
        appendToBody(orderDialog);
        expect(orderDialog.snapshot()).toEqual({ role: 'dialog', inert: '', 'aria-hidden': 'true' });

        await tryPassword(PASSWORD);
        expect(surface()).toBeUndefined();
        expect(root.snapshot()).toEqual({ id: 'root' });
        expect(hiddenFalse.snapshot()).toEqual({ 'aria-hidden': 'false' });
        expect(alreadyInert.snapshot()).toEqual({ inert: '' });
        expect(orderDialog.snapshot()).toEqual({ role: 'dialog' });
        // 解除後不再觀察，之後掛上的東西不受影響
        const later = new FakeElement();
        appendToBody(later);
        expect(later.snapshot()).toEqual({});
    });

    it('遮蔽層自己不會被加上 inert 與 aria-hidden（原本就在 body 底下的、鎖定期間新掛上的都一樣）', async () => {
        const surfaceLike = new FakeElement({ 'data-app-lock-surface': '' });
        body.children.push(surfaceLike);
        await lib.enableAppLock(PASSWORD);
        await render();
        await run(() => lib.lockApp());
        expect(surfaceLike.snapshot()).toEqual({ 'data-app-lock-surface': '' });
        const late = new FakeElement({ 'data-app-lock-surface': '' });
        appendToBody(late);
        expect(late.snapshot()).toEqual({ 'data-app-lock-surface': '' });
    });

    it('底層 App 全程保持掛載，不因為鎖定被重建', async () => {
        const mounted = vi.fn(), unmounted = vi.fn();
        const Probe = () => { useEffect(() => { mounted(); return unmounted; }, []); return createElement('i'); };
        await lib.enableAppLock(PASSWORD);
        await render(createElement(Probe));
        await run(() => lib.lockApp());
        await tryPassword(PASSWORD);
        expect(mounted).toHaveBeenCalledTimes(1);
        expect(unmounted).not.toHaveBeenCalled();
    });
});

describe('鎖定畫面', () => {
    it('標題、密碼欄、解鎖鈕；沒開系統驗證就沒有系統解鎖鈕；焦點落在密碼欄', async () => {
        await lockWith();
        await render();
        expect(text()).toContain('Shioaji Pro 已鎖定');
        expect(view!.root.findByType('input').props.type).toBe('password');
        expect(buttons().map((b) => b.children.join(''))).toEqual(['忘記密碼？', '解鎖']); // 沒設提示就沒有「密碼提示」
        expect(focused.at(-1)).toBe('password');
        expect(surface()!.props.role).toBe('dialog');
    });

    it('有設密碼提示：按「密碼提示」才顯示內容，焦點回密碼欄', async () => {
        await lockWith({ hint: '老家門牌' });
        await render();
        expect(text()).not.toContain('老家門牌');
        await run(() => buttonByText('密碼提示')!.props.onClick());
        expect(text()).toContain('提示：老家門牌');
        expect(buttonByText('密碼提示')).toBeUndefined();
        expect(focused.at(-1)).toBe('password');
    });

    it('忘記密碼要按兩次：第一下焦點移到遮蔽層、展開說明，取消就收起；確認後和第 10 次一樣登出', async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        await lockWith({ failures: 3 });
        await render();
        await run(() => buttonByText('忘記密碼？')!.props.onClick());
        expect(focused.at(-1)).toBe('surface'); // 按住 Enter 的重複按鍵不會接著按到確認
        expect(text()).toContain('停損停利、觸價也會停');
        expect(lib.getAppLock()!.failures).toBe(3);
        await run(() => buttonByText('取消')!.props.onClick());
        expect(buttonByText('確認登出並清除')).toBeUndefined();
        expect(focused.at(-1)).toBe('password');
        await run(() => buttonByText('忘記密碼？')!.props.onClick());
        focused.length = 0;
        await run(() => buttonByText('確認登出並清除')!.props.onClick());
        expect(focused).toEqual(['surface']); // 確認鈕被拿掉之前焦點先移到遮蔽層
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 10, forgot: true });
        expect(text()).toContain('正在登出並清除這台電腦的 API 金鑰…');
        expect(view!.root.findAllByType('input')).toHaveLength(0);
    });

    it('網頁版按忘記密碼確認：說明登不出去、要清除網站資料，不提「錯 10 次」', async () => {
        await lockWith();
        await render();
        await run(() => buttonByText('忘記密碼？')!.props.onClick());
        await run(() => buttonByText('確認登出並清除')!.props.onClick());
        expect(text()).toContain('網頁版無法自動登出');
        expect(text()).not.toContain('連續錯 10 次');
    });

    it('點到鎖定畫面的空白處：焦點給密碼欄；點在輸入欄或按鈕上照常（外框是 tabIndex=-1，會吃掉之後打的字）', async () => {
        await lockWith();
        await render();
        focused.length = 0;
        const blank = vi.fn();
        await run(() => surface()!.props.onMouseDown({ target: { closest: () => null }, preventDefault: blank }));
        expect(blank).toHaveBeenCalled();
        expect(focused).toEqual(['password']);
        const control = vi.fn();
        await run(() => surface()!.props.onMouseDown({ target: { closest: () => ({}) }, preventDefault: control }));
        expect(control).not.toHaveBeenCalled();
    });

    it('有開系統驗證時多一顆系統解鎖鈕', async () => {
        await lockWith({ system: true });
        await render();
        expect(buttonByText('使用 Touch ID 或 Mac 登入密碼 解鎖')).toBeDefined();
    });

    it('解鎖後不把焦點還給上鎖前的按鈕：按住 Enter 解鎖時，重複的按鍵不會再觸發它', async () => {
        const lockButton = { focus: vi.fn(), isConnected: true };
        doc.activeElement = lockButton;
        await lib.enableAppLock(PASSWORD);
        await render();
        await run(() => lib.lockApp());
        await tryPassword(PASSWORD);
        expect(surface()).toBeUndefined();
        expect(lockButton.focus).not.toHaveBeenCalled();
    });

    it('重開時已錯滿 10 次：沒有密碼欄，焦點落在遮蔽層本身（鍵盤不會掉到底下）', async () => {
        await lockWith({ failures: 10 });
        await render();
        expect(view!.root.findAllByType('input')).toHaveLength(0);
        expect(focused.at(-1)).toBe('surface');
    });

    it('打錯：清空欄位、焦點回密碼欄；第 5 次起提醒剩幾次，第 8 次「再錯 2 次」', async () => {
        await lockWith();
        await render();
        await tryPassword('wrong-password');
        expect(text()).toContain('解鎖密碼不正確。');
        expect(text()).not.toContain('將會登出');
        expect(view!.root.findByType('input').props.value).toBe('');
        expect(focused.at(-1)).toBe('password');
        for (let i = 0; i < 4; i++) await tryPassword('wrong-password');
        expect(text()).toContain('解鎖密碼不正確。再錯 5 次將會登出。');
        for (let i = 0; i < 3; i++) await tryPassword('wrong-password');
        expect(text()).toContain('解鎖密碼不正確。再錯 2 次將會登出。');
        expect(lib.getAppLock()!.failures).toBe(8);
    });

    it('沒填就送出：不計次，提示輸入', async () => {
        await lockWith();
        await render();
        await submit();
        expect(text()).toContain('請輸入解鎖密碼。');
        expect(lib.getAppLock()!.failures).toBe(0);
    });

    it('重開時已錯 5 次以上：還沒打字就顯示提醒', async () => {
        await lockWith({ failures: 6 });
        await render();
        expect(text()).toContain('解鎖密碼不正確。再錯 4 次將會登出。');
    });

    it('錯到第 10 次：顯示「正在登出」，不再有密碼欄', async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        await lockWith({ failures: 9 });
        await render();
        await tryPassword('wrong-password');
        expect(text()).toContain('解鎖密碼連續錯 10 次，正在登出…');
        expect(view!.root.findAllByType('input')).toHaveLength(0);
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('網頁版錯到第 10 次：說明登不出去、要清除網站資料，不再有密碼欄', async () => {
        await lockWith({ failures: 9 });
        await render();
        await tryPassword('wrong-password');
        expect(text()).toContain('網頁版無法自動登出');
        expect(view!.root.findAllByType('input')).toHaveLength(0);
    });

    it('系統解鎖：取消時顯示原因、不算輸錯；通過就解開', async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        await lockWith({ system: true, failures: 1 });
        await render();
        const systemButton = () => buttonByText('使用 Touch ID 或 Mac 登入密碼 解鎖') as ReactTestInstance;
        m.invoke.mockResolvedValueOnce('cancelled');
        await run(() => systemButton().props.onClick());
        await vi.waitFor(() => expect(text()).toContain('系統驗證已取消'));
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 1 });
        m.invoke.mockResolvedValueOnce('ok');
        await run(() => systemButton().props.onClick());
        await vi.waitFor(() => expect(surface()).toBeUndefined());
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0 });
    });
});
