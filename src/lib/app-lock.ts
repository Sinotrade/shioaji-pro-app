// src/lib/app-lock.ts — 應用程式鎖：純前端的隱私遮罩（docs/design/app-lock.md）。
// 狀態存 localStorage，各視窗靠 storage 事件同步（寫法同 risk.ts）；券商連線、停損停利、
// 觸價與背景監控照跑。只 import 不註冊任何東西，每個入口在 render 前呼叫 initializeAppLock()。

import { isTauri } from './runtime';
import { isChildWindow } from './window-role';
import { KEY, LOGGED_OUT_KEY, LOGOUT_AFTER, WAKE_GAP_MS, clampHint, getAppLock, load, lockApp, save, syncState, update, type SystemAuthResult } from './app-lock-state';
import { hashed, verify } from './app-lock-crypto';
import { systemAuth } from './app-lock-system-auth';
import { installFence } from './app-lock-fence';

export type { AppLockState, SystemAuthResult } from './app-lock-state';
export { APP_LOCKED_MESSAGE, HINT_MAX, LOGGED_OUT_KEY, LOGOUT_AFTER, MIN_PASSWORD_LENGTH, WAKE_GAP_MS, WAKE_OPTIONS,
    failureText, getAppLock, isAppAccessBlocked, isMac, lockApp, lockShortcutLabel, passwordTooShort, systemAuthLabel, useAppLock } from './app-lock-state';
export { systemAuthSupported } from './app-lock-system-auth';

export async function enableAppLock(password: string) {
    save({ ...(await hashed(password)), locked: false, failures: 0, system: false, wakeMs: WAKE_GAP_MS, hint: '', forgot: false });
}
// 設定頁的密碼確認不計入錯誤次數（沒鎖時本來就能操作 App）
export async function changeAppLockPassword(current: string, password: string): Promise<boolean> {
    if (!(await verify(getAppLock(), current))) return false;
    update(await hashed(password));
    return true;
}
export async function disableAppLock(current: string): Promise<boolean> {
    if (!(await verify(getAppLock(), current))) return false;
    save(null);
    return true;
}
// 先驗解鎖密碼，再實際通過一次系統驗證
export async function enableSystemAuth(current: string): Promise<SystemAuthResult | 'wrong-password'> {
    if (!(await verify(getAppLock(), current))) return 'wrong-password';
    const result = await systemAuth();
    if (result === 'ok') update({ system: true });
    return result;
}
export const disableSystemAuth = () => update({ system: false });
// 沒鎖時本來就能操作 App，改門檻不必再輸入解鎖密碼
export const setWakeGap = (wakeMs: number) => update({ wakeMs });
export const setAppLockHint = (hint: string) => update({ hint: clampHint(hint) });

// null＝解開了；數字＝目前連續輸錯次數
export async function unlockWithPassword(password: string): Promise<number | null> {
    const s = getAppLock();
    if (!s?.locked) return null;
    if (s.failures >= LOGOUT_AFTER) return s.failures;
    if (await verify(s, password)) {
        // 驗證的這段時間別的視窗可能已經錯滿 10 次（正在登出）：這邊不能解開
        const latest = load()?.failures ?? 0;
        if (latest >= LOGOUT_AFTER) return latest;
        update({ locked: false, failures: 0, forgot: false });
        return null;
    }
    const failures = Math.max(load()?.failures ?? 0, getAppLock()?.failures ?? s.failures) + 1;
    update({ failures });
    void logoutIfTooManyFailures();
    return failures;
}
// 鎖定畫面「忘記密碼」：和錯滿 10 次走同一條路（登出、清掉所有帳號的金鑰；子視窗交給主視窗；
// 網頁版登不出去就維持鎖住）
export function forgetAppLockPassword() {
    const state = getAppLock();
    if (!state?.locked || state.failures >= LOGOUT_AFTER) return;
    update({ failures: LOGOUT_AFTER, forgot: true });
    void logoutIfTooManyFailures();
}
// 取消、不能用都不算輸錯
export async function unlockWithSystem(): Promise<SystemAuthResult> {
    const state = getAppLock();
    if (!state?.system || state.failures >= LOGOUT_AFTER) return 'unavailable';
    const result = await systemAuth();
    if (result !== 'ok') return result;
    if ((load()?.failures ?? 0) >= LOGOUT_AFTER) return 'unavailable'; // 同上
    update({ locked: false, failures: 0, forgot: false });
    return result;
}

// 第 10 次輸錯（或按了忘記密碼）：完全登出，所有已儲存帳號的金鑰都清掉。只有主視窗有權限停伺服器、清金鑰；子視窗只寫下次數，由主視窗
// 從 storage 事件或下次啟動接手。等登出成功才清掉鎖（fail-closed）。網頁版沒有 serverStop、
// 登不出去：維持鎖住，清除網站資料才解得開（清鎖不登出等於錯 10 次就解鎖）。
const TRIED_KEY = 'sj-pro-app-lock-logout-tried';
let loggingOut = false;
async function logoutIfTooManyFailures(atBoot = false) {
    if (loggingOut || !isTauri || (getAppLock()?.failures ?? 0) < LOGOUT_AFTER || isChildWindow()) return;
    // 伺服器停不下來時 logoutAndReload 會重新載入：開機這條路同一個工作階段只自動試一次（輸錯第 10 次
    // 當下或開機時，先到的那次），否則會無限重新載入、反覆重啟觸價與括號單執行者。別的視窗寫入
    // （storage 事件）時仍會再試；重開 App 才重置
    try {
        if (atBoot && sessionStorage.getItem(TRIED_KEY)) return;
        sessionStorage.setItem(TRIED_KEY, '1');
    } catch { /* 沒有 sessionStorage：照試 */ }
    loggingOut = true;
    try {
        // 只改存檔、不 emit：這個視窗保持遮住直到重新載入完成，不閃出底下的畫面
        await (await import('./logout')).logoutAndReload(() => {
            try { localStorage.removeItem(KEY); localStorage.setItem(LOGGED_OUT_KEY, getAppLock()?.forgot ? 'forgot' : '1'); } catch { /* 存不了：載入後再試 */ }
        }, true);
    } catch { loggingOut = false; }
}

let installed = false;
export function initializeAppLock() {
    if (installed) return;
    installed = true;
    installFence();
    window.addEventListener('storage', (e) => {
        if (e.key !== KEY && e.key !== null) return;
        const next = load();
        // 主視窗第 10 次登出後清掉鎖：這個視窗不拆遮蔽，直接重新載入，丟掉登出前的畫面
        if (!next && (getAppLock()?.failures ?? 0) >= LOGOUT_AFTER) { window.location.reload(); return; }
        syncState(next);
        void logoutIfTooManyFailures();
    });
    void logoutIfTooManyFailures(true); // 上次登出沒完成，或子視窗錯到第 10 次時主視窗不在
    if (isChildWindow()) return; // 偵測一個視窗就夠；系統匣面板平常隱藏、被節流，不能拿來判斷
    let last = Date.now();
    setInterval(() => {
        if (Date.now() - last > (getAppLock()?.wakeMs ?? WAKE_GAP_MS)) lockApp();
        last = Date.now();
    }, 5_000);
}
