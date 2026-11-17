// 設定 → 應用程式鎖。接真的 lib/app-lock（localStorage 用 Map）；每個案例重新 import。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ store: new Map<string, string>(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));

// 雜湊照樣用真的 WebCrypto，只把次數降到 1,000：600,000 次在全套平行跑、機器忙時會讓案例逾時
const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
const fastDeriveBits: typeof crypto.subtle.deriveBits = (alg, key, len) =>
    realDeriveBits({ ...(alg as Pbkdf2Params), iterations: 1_000 }, key, len);

const PASSWORD = 'correct horse';
let lib: typeof import('../lib/app-lock');
let view: ReactTestRenderer | undefined;

async function render({ tauri = false } = {}) {
    vi.stubGlobal('window', tauri ? { __TAURI_INTERNALS__: {} } : {});
    // 是不是桌面版在 import 時就決定（runtime.ts）：重新載入，等於在這個環境開 App
    vi.resetModules();
    lib = await import('../lib/app-lock');
    const { AppLockSettings } = await import('./app-lock-settings');
    await act(async () => { view = create(createElement(AppLockSettings)); });
}
const text = () => JSON.stringify(view!.toJSON());
const switches = () => view!.root.findAll((n) => n.type === 'button' && n.props.role === 'switch');
const mainSwitch = () => switches()[0]!;
const systemSwitch = () => switches()[1]!;
const button = (label: string) => view!.root.findAll((n) => n.type === 'button' && n.children.join('').startsWith(label))[0]!;
const click = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });
// 密碼表單的欄位（不含「密碼提示」）
const inputs = () => view!.root.findAll((n) => n.type === 'input' && n.props.type === 'password');
const hintInput = () => view!.root.find((n) => n.type === 'input' && n.props.id?.endsWith('-hint'));
async function fill(...values: string[]) {
    for (const [i, value] of values.entries()) {
        await act(async () => { inputs()[i]!.props.onChange({ target: { value } }); });
    }
}
const submit = async () => {
    await act(async () => { view!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }); });
    await vi.waitFor(() => expect(view!.root.findAll((n) => n.type === 'button' && n.props.disabled === true && n.props.type === 'submit')).toHaveLength(0));
};

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(fastDeriveBits);
    vi.resetModules();
    m.store.clear();
    m.invoke.mockReset();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => m.store.get(k) ?? null,
        setItem: (k: string, v: string) => void m.store.set(k, String(v)),
        removeItem: (k: string) => void m.store.delete(k),
    });
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    lib = await import('../lib/app-lock');
});
afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('啟用', () => {
    it('預設關閉；啟用要輸入兩次、至少 6 個字元', async () => {
        await render();
        expect(mainSwitch().props['aria-checked']).toBe(false);
        expect(switches()).toHaveLength(1); // 沒啟用時沒有其他選項
        await click(mainSwitch());
        expect(inputs()).toHaveLength(2);
        await fill('12345', '12345');
        await submit();
        expect(text()).toContain('請使用至少 6 個字元的解鎖密碼。');
        await fill('abcdef', 'abcdeg');
        await submit();
        expect(text()).toContain('兩次輸入的解鎖密碼不同');
        expect(lib.getAppLock()).toBeNull();
        await fill(PASSWORD, PASSWORD);
        await submit();
        expect(lib.getAppLock()).toMatchObject({ locked: false, system: false });
        expect(mainSwitch().props['aria-checked']).toBe(true);
        expect(text()).toContain('應用程式鎖已啟用。按 ⇧⌘L 或頂部列的「螢幕鎖」就能鎖定。');
    });
});

describe('已啟用', () => {
    beforeEach(async () => { await lib.enableAppLock(PASSWORD); });

    it('「立即鎖定」馬上鎖上', async () => {
        await render();
        await click(button('立即鎖定'));
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('密碼提示：選填、打字就存，不必輸入密碼；最多 10 個字；說明旁人也看得到', async () => {
        await render();
        expect(hintInput().props.defaultValue).toBe('');
        expect(hintInput().props.maxLength).toBe(10);
        expect(text()).toContain('旁人也看得到');
        const change = (value: string, isComposing = false) => act(async () => { hintInput().props.onChange({ target: { value }, nativeEvent: { isComposing } }); });
        await change('老家ㄇ', true); // 注音組字中：不存
        expect(lib.getAppLock()!.hint).toBe('');
        await act(async () => { hintInput().props.onCompositionEnd({ currentTarget: { value: '老家門' } }); });
        expect(lib.getAppLock()!.hint).toBe('老家門');
        await change('老家門牌');
        expect(lib.getAppLock()!.hint).toBe('老家門牌');
        expect(inputs()).toHaveLength(0);
    });

    it('有設提示時，改完密碼提醒確認提示', async () => {
        lib.setAppLockHint('老家門牌');
        await render();
        await click(button('修改解鎖密碼'));
        await fill(PASSWORD, 'new-password', 'new-password');
        await submit();
        expect(text()).toContain('記得確認密碼提示還對得上');
    });

    it('睡眠多久才鎖：預設 90 秒，改成 15 分鐘馬上存下，不必輸入密碼', async () => {
        await render();
        const select = () => view!.root.findByType('select');
        expect(select().props.value).toBe(90_000);
        expect(select().findAllByType('option').map((o) => o.children.join(''))).toEqual(['90 秒', '5 分鐘', '15 分鐘', '30 分鐘', '1 小時']);
        await act(async () => { select().props.onChange({ target: { value: '900000' } }); });
        expect(lib.getAppLock()!.wakeMs).toBe(900_000);
        expect(select().props.value).toBe(900_000);
        expect(inputs()).toHaveLength(0);
    });

    it('修改密碼要目前的密碼；錯了顯示不正確、不改', async () => {
        await render();
        await click(button('修改解鎖密碼'));
        await fill('wrong-password', 'new-password', 'new-password');
        await submit();
        expect(text()).toContain('解鎖密碼不正確。');
        await fill(PASSWORD, 'new-password', 'new-password');
        await submit();
        expect(text()).toContain('解鎖密碼已更新。');
        expect(await lib.disableAppLock(PASSWORD)).toBe(false);
        expect(await lib.disableAppLock('new-password')).toBe(true);
    });

    it('關閉要輸入解鎖密碼', async () => {
        await render();
        await click(mainSwitch());
        expect(inputs()).toHaveLength(1);
        await fill('wrong-password');
        await submit();
        expect(lib.getAppLock()).not.toBeNull();
        await fill(PASSWORD);
        await submit();
        expect(lib.getAppLock()).toBeNull();
        expect(text()).toContain('應用程式鎖已關閉');
    });
});

describe('Touch ID／Windows Hello（預設關閉）', () => {
    beforeEach(async () => { await lib.enableAppLock(PASSWORD); });

    it('網頁版：選項停用，顯示「這個版本還不能使用」', async () => {
        await render();
        expect(systemSwitch().props['aria-checked']).toBe(false);
        expect(systemSwitch().props.disabled).toBe(true);
        expect(text()).toContain('這個版本還不能使用。');
    });

    it('桌面版：先輸入解鎖密碼，再通過一次系統驗證才開啟；再按一下關閉', async () => {
        await render({ tauri: true });
        expect(systemSwitch().props.disabled).toBe(false);
        await click(systemSwitch());
        m.invoke.mockResolvedValueOnce('ok');
        await fill(PASSWORD);
        await submit();
        expect(m.invoke).toHaveBeenCalledWith('app_lock_system_auth');
        expect(lib.getAppLock()!.system).toBe(true);
        expect(systemSwitch().props['aria-checked']).toBe(true);
        await click(systemSwitch());
        expect(lib.getAppLock()!.system).toBe(false);
    });

    it('原生還沒有 app_lock_system_auth：顯示「這個版本還不能使用」並停用選項', async () => {
        await render({ tauri: true });
        await click(systemSwitch());
        m.invoke.mockRejectedValueOnce('Command app_lock_system_auth not found');
        await fill(PASSWORD);
        await submit();
        expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toBe('這個版本還不能使用。');
        expect(lib.getAppLock()!.system).toBe(false);
        await act(async () => { view!.root.findAll((n) => n.type === 'button' && n.children.join('') === '取消')[0]!.props.onClick(); });
        expect(systemSwitch().props.disabled).toBe(true);
    });
});
