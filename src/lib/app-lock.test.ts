// src/lib/app-lock.test.ts — 應用程式鎖（純前端隱私遮罩）的行為。
// 每個案例 vi.resetModules() 後重新 import 一次，等於「重開 App」；localStorage 用同一個
// Map，所以存下來的狀態跨重開還在。雜湊用真的 WebCrypto（Node 內建）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    store: new Map<string, string>(),
    session: new Map<string, string>(), // sessionStorage：重新載入還在，重開 App 才清空
    listeners: new Map<string, Set<(e: unknown) => void>>(),
    child: false,
    logout: vi.fn(),
    reload: vi.fn(),
    invoke: vi.fn(),
    resetArm: vi.fn(),
}));
vi.mock('./logout', () => ({ logoutAndReload: m.logout }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));
vi.mock('./esc-cancel-arm', () => ({ resetEscCancelArm: m.resetArm }));

// 雜湊照樣用真的 WebCrypto，只把次數降到 1,000：600,000 次在全套平行跑、機器忙時會讓案例逾時
const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
const fastDeriveBits: typeof crypto.subtle.deriveBits = (alg, key, len) =>
    realDeriveBits({ ...(alg as Pbkdf2Params), iterations: 1_000 }, key, len);

const KEY = 'sj-pro-app-lock';
const PASSWORD = 'correct horse';
let lib: typeof import('./app-lock');

// 重開 App：重新載入模組並裝好攔截（每個入口都會呼叫 initializeAppLock）
async function boot({ tauri = false, child = false, platform = 'MacIntel' } = {}) {
    vi.resetModules();
    m.listeners.clear();
    m.child = child;
    vi.stubGlobal('window', {
        ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
        location: { reload: m.reload },
        addEventListener: (type: string, fn: (e: unknown) => void) =>
            void m.listeners.set(type, (m.listeners.get(type) ?? new Set()).add(fn)),
    });
    vi.stubGlobal('navigator', { platform, userAgent: '' });
    lib = await import('./app-lock');
    lib.initializeAppLock();
    return lib;
}
const dispatch = <T extends { type: string }>(event: T) => {
    m.listeners.get(event.type)?.forEach((fn) => fn(event));
    return event;
};
function ev(type: string, init: Record<string, unknown> = {}) {
    return {
        type, key: '', code: '', target: null as unknown, repeat: false,
        shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
        defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...init,
    };
}
const outside = { closest: () => null };
const inside = () => ({ closest: () => ({}), tagName: 'INPUT', type: 'password' });
const enableAndLock = async () => { await lib.enableAppLock(PASSWORD); lib.lockApp(); };
const failTimes = async (n: number) => { let last: number | null = null; for (let i = 0; i < n; i++) last = await lib.unlockWithPassword('wrong-password'); return last; };

const mapStorage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
});
beforeEach(async () => {
    vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(fastDeriveBits);
    m.store.clear();
    m.session.clear();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', mapStorage(m.store));
    vi.stubGlobal('sessionStorage', mapStorage(m.session));
    vi.stubGlobal('document', { querySelector: () => null });
    await boot();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('啟用與解鎖密碼', () => {
    it('預設關閉：沒有狀態、不遮蔽；啟用後也不會自己鎖上', async () => {
        expect(lib.getAppLock()).toBeNull();
        expect(lib.isAppAccessBlocked()).toBe(false);
        await lib.enableAppLock(PASSWORD);
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0, system: false });
        expect(lib.isAppAccessBlocked()).toBe(false);
    });

    it('至少 6 個字元（以字元計，不是 UTF-16 長度）', async () => {
        await expect(lib.enableAppLock('12345')).rejects.toThrow();
        // 5 個 emoji 的 .length 是 10，仍然太短
        expect(lib.passwordTooShort('😀😀😀😀😀')).toBe(true);
        await expect(lib.enableAppLock('😀😀😀😀😀')).rejects.toThrow();
        expect(lib.getAppLock()).toBeNull();
        await lib.enableAppLock('😀😀😀😀😀😀');
        expect(lib.getAppLock()).not.toBeNull();
    });

    it('只存 PBKDF2-SHA256 雜湊：沒有密碼原文、隨機 salt、至少 600,000 次', async () => {
        vi.mocked(crypto.subtle.deriveBits).mockImplementation(realDeriveBits); // 這個案例驗證真的次數
        await lib.enableAppLock(PASSWORD);
        const raw = m.store.get(KEY)!;
        expect(raw).not.toContain(PASSWORD);
        const first = JSON.parse(raw) as { salt: string; hash: string; iterations: number };
        expect(first.iterations).toBeGreaterThanOrEqual(600_000);
        // 自己用 WebCrypto 重算一次，確定存的就是這個雜湊
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: first.iterations,
            salt: Buffer.from(first.salt, 'base64') }, key, 256);
        expect(Buffer.from(bits).toString('base64')).toBe(first.hash);
        // 同一個密碼再設一次：salt 與雜湊都不同
        await lib.enableAppLock(PASSWORD);
        const second = JSON.parse(m.store.get(KEY)!) as typeof first;
        expect(second.salt).not.toBe(first.salt);
        expect(second.hash).not.toBe(first.hash);
    });

    it('修改密碼、關閉都要目前的密碼；在設定頁輸錯不動狀態、不計次', async () => {
        await lib.enableAppLock(PASSWORD);
        expect(await lib.changeAppLockPassword('wrong-password', 'new-password')).toBe(false);
        expect(await lib.disableAppLock('wrong-password')).toBe(false);
        expect(lib.getAppLock()!.failures).toBe(0);
        expect(await lib.changeAppLockPassword(PASSWORD, 'new-password')).toBe(true);
        lib.lockApp();
        expect(await lib.unlockWithPassword(PASSWORD)).toBe(1); // 舊密碼不能用了
        expect(await lib.unlockWithPassword('new-password')).toBeNull();
        expect(await lib.disableAppLock('new-password')).toBe(true);
        expect(lib.getAppLock()).toBeNull();
        expect(m.store.has(KEY)).toBe(false);
    });
});

describe('上鎖入口', () => {
    it('立即鎖定（設定頁、頂部列膠囊）：同步生效、清掉 Esc 第一下；沒啟用時不動作', async () => {
        lib.lockApp();
        expect(lib.getAppLock()).toBeNull();
        await lib.enableAppLock(PASSWORD);
        lib.lockApp();
        expect(lib.isAppAccessBlocked()).toBe(true);
        expect(m.resetArm).toHaveBeenCalled();
    });

    it('快捷鍵 Mac ⇧⌘L：code 或 key 符合即可；Ctrl 版、少了 Shift 都不算；沒啟用時不攔', async () => {
        const chord = (init: Record<string, unknown>) => dispatch(ev('keydown', { shiftKey: true, metaKey: true, key: 'L', ...init }));
        expect(chord({}).defaultPrevented).toBe(false); // 沒啟用：這組按鍵照常給別人
        await lib.enableAppLock(PASSWORD);
        dispatch(ev('keydown', { shiftKey: true, ctrlKey: true, key: 'L' }));
        dispatch(ev('keydown', { metaKey: true, key: 'l' }));
        expect(lib.isAppAccessBlocked()).toBe(false);
        expect(chord({ key: 'ㄠ', code: 'KeyL' }).defaultPrevented).toBe(true); // 注音輸入法作用中
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('快捷鍵 Windows Ctrl+Shift+L；按住不放（repeat）不會再觸發', async () => {
        await boot({ platform: 'Win32' });
        await lib.enableAppLock(PASSWORD);
        expect(dispatch(ev('keydown', { shiftKey: true, ctrlKey: true, key: 'L', repeat: true })).defaultPrevented).toBe(true);
        expect(lib.isAppAccessBlocked()).toBe(false);
        dispatch(ev('keydown', { shiftKey: true, metaKey: true, key: 'L' }));
        expect(lib.isAppAccessBlocked()).toBe(false);
        dispatch(ev('keydown', { shiftKey: true, ctrlKey: true, key: 'L' }));
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('睡眠喚醒：計時器落差超過 90 秒就上鎖，正常計時不鎖', async () => {
        vi.useFakeTimers();
        await boot();
        await lib.enableAppLock(PASSWORD);
        vi.advanceTimersByTime(60_000);
        expect(lib.isAppAccessBlocked()).toBe(false);
        vi.setSystemTime(Date.now() + lib.WAKE_GAP_MS + 1_000); // 睡著：時鐘往前跳，計時器沒跑
        vi.advanceTimersByTime(5_000);
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('睡眠多久才鎖可以調：設成 5 分鐘後睡 2 分鐘不鎖、超過 5 分鐘才鎖；重開仍記得，存檔裡不認得的值回到 90 秒', async () => {
        vi.useFakeTimers();
        await boot();
        await lib.enableAppLock(PASSWORD);
        expect(lib.getAppLock()!.wakeMs).toBe(lib.WAKE_GAP_MS);
        lib.setWakeGap(300_000);
        vi.setSystemTime(Date.now() + 120_000);
        vi.advanceTimersByTime(5_000);
        expect(lib.isAppAccessBlocked()).toBe(false);
        vi.setSystemTime(Date.now() + 301_000);
        vi.advanceTimersByTime(5_000);
        expect(lib.isAppAccessBlocked()).toBe(true);
        await boot();
        expect(lib.getAppLock()!.wakeMs).toBe(300_000);
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), wakeMs: 1 }));
        await boot();
        expect(lib.getAppLock()!.wakeMs).toBe(lib.WAKE_GAP_MS);
    });

    it('子視窗（系統匣、popout）不跑睡眠偵測：平常隱藏被節流也不會誤鎖', async () => {
        vi.useFakeTimers();
        await boot({ child: true });
        await lib.enableAppLock(PASSWORD);
        vi.setSystemTime(Date.now() + lib.WAKE_GAP_MS * 2);
        vi.advanceTimersByTime(5_000);
        expect(lib.isAppAccessBlocked()).toBe(false);
    });
});

describe('重開 App', () => {
    it('鎖著時關掉，重開仍鎖著；沒鎖時重開不會上鎖', async () => {
        await enableAndLock();
        await boot();
        expect(lib.isAppAccessBlocked()).toBe(true);
        expect(await lib.unlockWithPassword(PASSWORD)).toBeNull();
        await boot();
        expect(lib.isAppAccessBlocked()).toBe(false);
        expect(lib.getAppLock()).not.toBeNull();
    });

    it('錯誤次數和鎖定狀態存在一起，重開不歸零；成功解鎖才歸零', async () => {
        await enableAndLock();
        await failTimes(3);
        await boot();
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 3 });
        expect(await lib.unlockWithPassword('wrong-password')).toBe(4);
        expect(await lib.unlockWithPassword(PASSWORD)).toBeNull();
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0 });
    });
});

describe('錯誤次數提醒與第 10 次登出', () => {
    it('第 1～4 次只說不正確；第 5 次「再錯 5 次將會登出」、第 8 次「再錯 2 次將會登出」', async () => {
        await enableAndLock();
        expect(await failTimes(4)).toBe(4);
        expect(lib.failureText(4)).toBe('解鎖密碼不正確。');
        expect(await failTimes(1)).toBe(5);
        expect(lib.failureText(5)).toBe('解鎖密碼不正確。再錯 5 次將會登出。');
        expect(await failTimes(3)).toBe(8);
        expect(lib.failureText(8)).toBe('解鎖密碼不正確。再錯 2 次將會登出。');
        expect(m.logout).not.toHaveBeenCalled();
    });

    it('桌面主視窗第 10 次：呼叫共用登出；清掉存檔、留下登入畫面的說明，但這個視窗遮到重新載入為止', async () => {
        await boot({ tauri: true });
        await enableAndLock();
        let lockedWhileLoggingOut: boolean | undefined;
        m.logout.mockImplementation(async (beforeReload: () => void) => {
            lockedWhileLoggingOut = lib.isAppAccessBlocked();
            beforeReload();
        });
        await failTimes(9);
        expect(m.logout).not.toHaveBeenCalled();
        await failTimes(1);
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledOnce());
        // 第二個參數：所有已儲存的帳號都清掉，登入畫面不能選另一組帳號進去
        expect(m.logout).toHaveBeenCalledWith(expect.any(Function), true);
        expect(lockedWhileLoggingOut).toBe(true);
        expect(m.store.has(KEY)).toBe(false);
        expect(m.store.get(lib.LOGGED_OUT_KEY)).toBe('1');
        // 清鎖時不通知畫面：遮蔽層不會在 reload 接手前被拆掉、閃出底下的畫面
        expect(lib.isAppAccessBlocked()).toBe(true);
        await boot({ tauri: true }); // 重新載入後才真的沒鎖
        expect(lib.getAppLock()).toBeNull();
    });

    it('登出沒完成（伺服器停不下來）：保持鎖住，正確密碼也解不開；重新載入不再自動重試，重開 App 才再試', async () => {
        await boot({ tauri: true });
        await enableAndLock();
        m.logout.mockRejectedValue(new Error('無法停止本機伺服器'));
        await failTimes(10);
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledOnce());
        expect(lib.isAppAccessBlocked()).toBe(true);
        expect(await lib.unlockWithPassword(PASSWORD)).toBe(10);
        expect(lib.isAppAccessBlocked()).toBe(true);
        // logoutAndReload 停不下伺服器時會重新載入：同一個工作階段開機不再試，避免無限重新載入
        await boot({ tauri: true });
        await boot({ tauri: true });
        await Promise.resolve();
        expect(m.logout).toHaveBeenCalledOnce();
        // 執行中收到 storage 事件（例如子視窗寫入）仍會登出，不受開機只試一次影響
        dispatch({ type: 'storage', key: KEY });
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledTimes(2));
        m.session.clear(); // 重開 App：新的工作階段
        await boot({ tauri: true });
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledTimes(3));
        // 開機那次也算這個工作階段唯一的一次：失敗後重新載入不再試
        await boot({ tauri: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(m.logout).toHaveBeenCalledTimes(3);
    });

    it('子視窗錯到第 10 次不自己登出（沒有權限），主視窗從 storage 事件接手', async () => {
        await boot({ tauri: true });
        await enableAndLock();
        const mainStorage = [...m.listeners.get('storage')!][0]!;
        await boot({ tauri: true, child: true });
        await failTimes(10);
        expect(m.logout).not.toHaveBeenCalled();
        expect(lib.isAppAccessBlocked()).toBe(true);
        // 回到主視窗：收到子視窗寫入的 storage 事件
        m.child = false;
        mainStorage({ key: KEY });
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledOnce());
    });

    it('主視窗登出清掉鎖時，其他視窗不拆遮蔽、直接重新載入（不露出登出前的畫面）', async () => {
        await boot({ tauri: true, child: true });
        await enableAndLock();
        await failTimes(10);
        m.store.delete(KEY); // 主視窗 logoutAndReload 的 beforeReload
        dispatch({ type: 'storage', key: KEY });
        expect(m.reload).toHaveBeenCalledOnce();
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('忘記密碼：和第 10 次走同一條路（全部帳號登出），登入畫面說明是 forgot；沒鎖時按了沒作用', async () => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        lib.forgetAppLockPassword();
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0, forgot: false });
        lib.lockApp();
        m.logout.mockImplementation(async (beforeReload: () => void) => beforeReload());
        lib.forgetAppLockPassword();
        await vi.waitFor(() => expect(m.logout).toHaveBeenCalledWith(expect.any(Function), true));
        expect(m.store.get(lib.LOGGED_OUT_KEY)).toBe('forgot');
        expect(m.store.has(KEY)).toBe(false);
        expect(lib.isAppAccessBlocked()).toBe(true); // 遮到重新載入為止
    });

    it('解鎖時一併清掉 forgot：別的視窗剛按了忘記密碼、這個視窗密碼剛好驗過，之後錯滿 10 次仍說是錯 10 次', async () => {
        await enableAndLock();
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), forgot: true }));
        expect(await lib.unlockWithPassword(PASSWORD)).toBeNull();
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0, forgot: false });
    });

    it('驗證密碼的期間別的視窗錯滿 10 次：密碼對也不解開', async () => {
        await enableAndLock();
        const pending = lib.unlockWithPassword(PASSWORD); // 雜湊還在算
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), failures: 10 }));
        expect(await pending).toBe(10);
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('網頁版按忘記密碼：登不出去，維持鎖住，正確密碼也解不開', async () => {
        await enableAndLock();
        lib.forgetAppLockPassword();
        await boot();
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 10, forgot: true });
        expect(await lib.unlockWithPassword(PASSWORD)).toBe(10);
        expect(m.logout).not.toHaveBeenCalled();
    });

    it('網頁版第 10 次：沒有伺服器可停、登不出去，維持鎖住，正確密碼也解不開', async () => {
        await enableAndLock();
        await failTimes(10);
        await boot();
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 10 });
        expect(await lib.unlockWithPassword(PASSWORD)).toBe(10);
        expect(lib.isAppAccessBlocked()).toBe(true);
        expect(m.logout).not.toHaveBeenCalled();
    });
});

describe('密碼提示', () => {
    it('最多 10 個字（以字元計）、重開還在；舊紀錄沒有提示就是空字串', async () => {
        await lib.enableAppLock(PASSWORD);
        expect(lib.getAppLock()!.hint).toBe('');
        lib.setAppLockHint('老家門牌加生日再加兩碼');
        expect(lib.getAppLock()!.hint).toBe('老家門牌加生日再加兩');
        lib.setAppLockHint('😀'.repeat(12));
        expect(Array.from(lib.getAppLock()!.hint)).toHaveLength(10);
        await boot();
        expect(Array.from(lib.getAppLock()!.hint)).toHaveLength(10);
        const { hint: _hint, ...old } = JSON.parse(m.store.get(KEY)!);
        m.store.set(KEY, JSON.stringify(old));
        await boot();
        expect(lib.getAppLock()!.hint).toBe('');
    });
});

describe('跨視窗同步（storage 事件）', () => {
    it('別的視窗上鎖、解鎖、關閉都會同步；不相干的 key 不理會', async () => {
        await lib.enableAppLock(PASSWORD);
        const saved = JSON.parse(m.store.get(KEY)!);
        const fromOtherWindow = (value: unknown, key = KEY) => {
            if (value === null) m.store.delete(key); else m.store.set(key, JSON.stringify(value));
            dispatch({ type: 'storage', key });
        };
        fromOtherWindow({ ...saved, locked: true });
        expect(lib.isAppAccessBlocked()).toBe(true);
        m.store.set(KEY, JSON.stringify({ ...saved, locked: false }));
        dispatch({ type: 'storage', key: 'sj-pro-risk' });
        expect(lib.isAppAccessBlocked()).toBe(true);
        fromOtherWindow({ ...saved, locked: false });
        expect(lib.isAppAccessBlocked()).toBe(false);
        fromOtherWindow(null);
        expect(lib.getAppLock()).toBeNull();
    });

    it('別的視窗剛上鎖、storage 事件還沒送到：這個視窗寫入時不會把它蓋回沒鎖', async () => {
        await lib.enableAppLock(PASSWORD);
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), locked: true }));
        lib.disableSystemAuth();
        expect(JSON.parse(m.store.get(KEY)!)).toMatchObject({ locked: true, system: false });
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('這個視窗上鎖時存檔寫不進去：之後輸錯一次，不會被存檔裡的舊紀錄蓋回沒鎖', async () => {
        await lib.enableAppLock(PASSWORD);
        const setItem = localStorage.setItem;
        localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
        lib.lockApp();
        localStorage.setItem = setItem;
        expect(JSON.parse(m.store.get(KEY)!).locked).toBe(false); // 存檔沒鎖，只有記憶體鎖著
        expect(await lib.unlockWithPassword('wrong-password')).toBe(1);
        expect(lib.isAppAccessBlocked()).toBe(true);
        expect(JSON.parse(m.store.get(KEY)!)).toMatchObject({ locked: true, failures: 1 });
    });

    it('別的視窗剛輸錯、storage 事件還沒送到：這個視窗輸錯接著算，次數不會變少', async () => {
        await enableAndLock();
        await failTimes(2);
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), failures: 6 }));
        expect(await lib.unlockWithPassword('wrong-password')).toBe(7);
        lib.disableSystemAuth(); // 其他寫入也不會把次數蓋回去
        expect(JSON.parse(m.store.get(KEY)!).failures).toBe(7);
    });

    it('initializeAppLock 重複呼叫只裝一次攔截', () => {
        lib.initializeAppLock();
        expect(m.listeners.get('keydown')!.size).toBe(1);
        expect(m.listeners.get('storage')!.size).toBe(1);
    });
});

describe('Touch ID／Windows Hello（可選）', () => {
    it('網頁版不能用，也不會呼叫原生', async () => {
        await lib.enableAppLock(PASSWORD);
        expect(lib.systemAuthSupported()).toBe(false);
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('missing');
        expect(lib.getAppLock()!.system).toBe(false);
        expect(m.invoke).not.toHaveBeenCalled();
    });

    it('開啟：先驗解鎖密碼（錯了不跳系統驗證），再實際通過一次系統驗證', async () => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        expect(lib.systemAuthSupported()).toBe(true);
        expect(await lib.enableSystemAuth('wrong-password')).toBe('wrong-password');
        expect(m.invoke).not.toHaveBeenCalled();
        m.invoke.mockResolvedValueOnce('cancelled');
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('cancelled');
        expect(lib.getAppLock()!.system).toBe(false);
        m.invoke.mockResolvedValueOnce('ok');
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('ok');
        expect(m.invoke).toHaveBeenLastCalledWith('app_lock_system_auth');
        expect(lib.getAppLock()!.system).toBe(true);
        lib.disableSystemAuth();
        expect(lib.getAppLock()!.system).toBe(false);
    });

    it.each([
        ['字串', 'Command app_lock_system_auth not found'],
        ['Error', new Error('Command app_lock_system_auth not found')],
    ])('原生還沒有這個指令（%s）：回 missing，之後停用、不再呼叫', async (_kind, error) => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        m.invoke.mockRejectedValueOnce(error);
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('missing');
        expect(lib.systemAuthSupported()).toBe(false);
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('missing');
        expect(m.invoke).toHaveBeenCalledOnce();
        // 重開 App：同一版記得不能用，不必再試一次
        await boot({ tauri: true });
        expect(lib.systemAuthSupported()).toBe(false);
        expect(await lib.enableSystemAuth(PASSWORD)).toBe('missing');
        expect(m.invoke).toHaveBeenCalledOnce();
        // 換了版本（原生可能已經補上）：可以再試
        vi.stubGlobal('__SHIOAJI_BUILD_VERSION__', 'v9.9.9');
        await boot({ tauri: true });
        expect(lib.systemAuthSupported()).toBe(true);
    });

    it('系統驗證解鎖：成功就解開並歸零；取消、出錯都不算輸錯', async () => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        m.invoke.mockResolvedValueOnce('ok');
        await lib.enableSystemAuth(PASSWORD);
        lib.lockApp();
        await failTimes(2);
        m.invoke.mockResolvedValueOnce('cancelled');
        expect(await lib.unlockWithSystem()).toBe('cancelled');
        m.invoke.mockRejectedValueOnce(new Error('LAError -6'));
        expect(await lib.unlockWithSystem()).toBe('unavailable');
        expect(lib.getAppLock()).toMatchObject({ locked: true, failures: 2 });
        m.invoke.mockResolvedValueOnce('ok');
        expect(await lib.unlockWithSystem()).toBe('ok');
        expect(lib.getAppLock()).toMatchObject({ locked: false, failures: 0 });
    });

    it('錯滿 10 次（登出進行中或失敗）後，系統驗證也不能解鎖，連原生都不呼叫', async () => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        m.invoke.mockResolvedValueOnce('ok');
        await lib.enableSystemAuth(PASSWORD);
        lib.lockApp();
        m.logout.mockRejectedValue(new Error('無法停止本機伺服器'));
        await failTimes(10);
        m.invoke.mockClear();
        m.invoke.mockResolvedValue('ok');
        expect(await lib.unlockWithSystem()).toBe('unavailable');
        expect(m.invoke).not.toHaveBeenCalled();
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('系統驗證進行期間別的視窗錯滿 10 次：驗證通過也不解開', async () => {
        await boot({ tauri: true });
        await lib.enableAppLock(PASSWORD);
        m.invoke.mockResolvedValueOnce('ok');
        await lib.enableSystemAuth(PASSWORD);
        lib.lockApp();
        let release!: (value: string) => void;
        m.invoke.mockReturnValueOnce(new Promise<string>((resolve) => { release = resolve; }));
        const pending = lib.unlockWithSystem();
        m.store.set(KEY, JSON.stringify({ ...JSON.parse(m.store.get(KEY)!), failures: 10 }));
        release('ok');
        expect(await pending).toBe('unavailable');
        expect(lib.isAppAccessBlocked()).toBe(true);
    });

    it('沒開系統驗證時，系統解鎖一律不能用', async () => {
        await boot({ tauri: true });
        await enableAndLock();
        expect(await lib.unlockWithSystem()).toBe('unavailable');
        expect(m.invoke).not.toHaveBeenCalled();
        expect(lib.isAppAccessBlocked()).toBe(true);
    });
});

describe('攔截層（fence）', () => {
    it('沒鎖時什麼都不擋', async () => {
        await lib.enableAppLock(PASSWORD);
        for (const type of ['pointerdown', 'click', 'contextmenu', 'dragstart']) {
            expect(dispatch(ev(type, { target: outside })).stopped).toBe(false);
        }
        expect(dispatch(ev('keydown', { key: 'Escape', target: outside })).stopped).toBe(false);
    });

    it('鎖著：遮蔽層外的鍵盤、滑鼠、拖曳、右鍵、複製貼上全部吞掉；遮蔽層內照常輸入', async () => {
        await enableAndLock();
        for (const type of ['keydown', 'pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'copy', 'cut', 'paste', 'dragstart', 'drop']) {
            const e = dispatch(ev(type, { key: 'b', target: outside }));
            expect([type, e.stopped, e.defaultPrevented]).toEqual([type, true, true]);
        }
        // 遮蔽層內的按鍵：照常輸入（不 preventDefault），但不再往下傳給 App 其他的快捷鍵 listener
        const typed = dispatch(ev('keydown', { key: 'a', target: inside() }));
        expect([typed.defaultPrevented, typed.stopped]).toEqual([false, true]);
        expect(dispatch(ev('pointerdown', { target: inside() })).stopped).toBe(false);
        // 右鍵選單有「重新載入」：遮蔽層內也吞掉（貼上用 ⌘V／Ctrl+V）
        expect(dispatch(ev('contextmenu', { target: inside() })).stopped).toBe(true);
    });

    it('Escape 不論在哪都吞掉，並清掉 Esc×2 的第一下', async () => {
        await enableAndLock();
        m.resetArm.mockClear();
        expect(dispatch(ev('keydown', { key: 'Escape', target: inside() })).stopped).toBe(true);
        expect(m.resetArm).toHaveBeenCalled();
    });

    it('遮蔽層內也擋瀏覽器快捷鍵（⌘R、⌘P、F5），編輯組合鍵、整段刪除、游標移動與 AltGr 打字照常', async () => {
        await enableAndLock();
        const key = (init: Record<string, unknown>) => dispatch(ev('keydown', { target: inside(), ...init })).defaultPrevented;
        expect(key({ metaKey: true, key: 'r' })).toBe(true);
        expect(key({ metaKey: true, key: 'p' })).toBe(true);
        expect(key({ key: 'F5' })).toBe(true);
        expect(key({ metaKey: true, key: 'v' })).toBe(false);
        expect(key({ ctrlKey: true, key: 'a' })).toBe(false);
        expect(key({ ctrlKey: true, altKey: true, key: '@' })).toBe(false);
        // 密碼欄的整段刪除與游標移動
        expect(key({ metaKey: true, key: 'Backspace' })).toBe(false);
        expect(key({ metaKey: true, shiftKey: true, key: 'ArrowLeft' })).toBe(false);
        expect(key({ ctrlKey: true, key: 'Delete' })).toBe(false);
        // 焦點在解鎖鈕上：⌘←／→ 是上一頁／下一頁，照擋
        const onButton = { closest: () => ({}), tagName: 'BUTTON' };
        expect(key({ metaKey: true, key: 'ArrowLeft', target: onButton })).toBe(true);
        expect(key({ metaKey: true, key: 'ArrowRight', target: onButton })).toBe(true);
    });

    it('Tab 在遮蔽層裡循環：最後一個再 Tab 回第一個、第一個或遮蔽層本身 Shift+Tab 到最後一個，中間不干涉', async () => {
        await enableAndLock();
        const input = { focus: vi.fn() }, button = { focus: vi.fn() };
        const surface: { querySelectorAll: () => unknown[] } = { querySelectorAll: () => [input, button] };
        const tab = (from: unknown, shiftKey = false) => {
            vi.stubGlobal('document', { activeElement: from, querySelector: () => null });
            return dispatch(ev('keydown', { key: 'Tab', shiftKey, target: { closest: () => surface } })).defaultPrevented;
        };
        expect(tab(input)).toBe(false); // 密碼欄 → 解鎖鈕：瀏覽器自己走
        expect(tab(button, true)).toBe(false);
        expect(tab(button)).toBe(true);
        expect(input.focus).toHaveBeenCalledOnce();
        expect(tab(input, true)).toBe(true);
        expect(tab(surface, true)).toBe(true);
        expect(button.focus).toHaveBeenCalledTimes(2);
        // 錯滿 10 次：沒有可以停的地方，焦點留在遮蔽層
        surface.querySelectorAll = () => [];
        expect(tab(surface)).toBe(true);
        expect(tab(surface, true)).toBe(true);
    });

    it('遮蔽層外按鍵時把焦點拉回密碼欄；沒有密碼欄（錯滿 10 次）才給遮蔽層本身', async () => {
        await enableAndLock();
        const input = { focus: vi.fn() };
        const surface = { focus: vi.fn(), querySelector: vi.fn(() => input as unknown) };
        vi.stubGlobal('document', { querySelector: (selector: string) => selector === '[data-app-lock-surface]' ? surface : null });
        dispatch(ev('keydown', { key: 'a', target: outside }));
        expect(input.focus).toHaveBeenCalledOnce();
        expect(surface.focus).not.toHaveBeenCalled();
        surface.querySelector.mockReturnValue(null);
        dispatch(ev('keydown', { key: 'a', target: outside }));
        expect(surface.focus).toHaveBeenCalledOnce();
    });

    it('鎖著時事件目標不是元素（null、沒有 closest 的物件）也一律吞掉', async () => {
        await enableAndLock();
        for (const target of [null, {}, { closest: undefined }]) {
            const e = dispatch(ev('click', { target }));
            expect([e.stopped, e.defaultPrevented]).toEqual([true, true]);
        }
    });
});
