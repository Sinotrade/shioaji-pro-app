// src/lib/apply-guide-native.ts — 與原生申請視窗（label `sinopac-apply`）的橋接。
//
// 申請視窗是原生殼開的獨立視窗，載入永豐官網、沒有任何 IPC 權限；
// 官網登入與憑證存在申請視窗自己的資料區（與主視窗分開、關掉後保留），
// clearApplySiteData 會關掉申請視窗並清掉這個資料區。
// 這裡只從主視窗呼叫 apply_window_* 指令，並接收原生殼送來的事件：
// 步驟（step；簽署頁另帶讀到的簽署狀態）、.env 已載入（只帶帳號 id 與金鑰名稱，不含金鑰）、
// 載入失敗、其他下載、視窗關閉。舊版原生殼沒有這些指令時退回系統瀏覽器。

import type { SigningMarket } from './account-signing';
import { APPLY_PAGE_RULES, APPLY_URL, isApplyPageStep, isSignState, signMarketOf, type ApplyPageStep, type SignState } from './apply-guide-config';
import { isTauri } from './runtime';
import { openExternalUrlOrThrow } from './tauri';

export type ApplyGuideEvent =
    | { kind: 'step'; step: ApplyPageStep; sign?: SignState }
    | { kind: 'imported'; profileId: string; name: string; duplicate: boolean }
    | { kind: 'import-failed'; message: string }
    | { kind: 'downloaded'; fileName: string; status: DownloadStatus }
    | { kind: 'closed' };

/** beside：申請視窗放在主視窗旁邊（不重疊）；overlay：蓋住主視窗右側，導覽要靠左。 */
export type ApplyWindowPlacement = 'beside' | 'overlay';
export type ApplyWindowOpenResult = ApplyWindowPlacement | 'browser';
/** unknown：平台無法判斷結果（Linux），檔案已交給系統下載。 */
export type DownloadStatus = 'saved' | 'failed' | 'unknown';
const DOWNLOAD_STATUSES: readonly unknown[] = ['saved', 'failed', 'unknown'];

const core = () => import('@tauri-apps/api/core');

/** 開啟（或帶到前面）申請視窗；不支援時改用系統瀏覽器開官網。 */
export async function openApplyWindow(): Promise<ApplyWindowOpenResult> {
    if (isTauri) {
        try {
            const { invoke } = await core();
            const placement = await invoke<unknown>('apply_window_open', { config: APPLY_PAGE_RULES });
            // 舊版原生端沒有回傳位置：照舊靠左，確保導覽不被蓋住
            return placement === 'beside' ? 'beside' : 'overlay';
        } catch (error) {
            // 指令存在但失敗（例如建立視窗失敗）時把原因交給呼叫端
            if (!isMissingCommand(error)) throw new Error(typeof error === 'string' ? error : '無法開啟申請視窗');
        }
    }
    // 開不了瀏覽器就交給呼叫端顯示原因與重試，不要當成已經開啟
    try {
        await openExternalUrlOrThrow(APPLY_URL);
    } catch (error) {
        const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
        throw new Error(reason ? `無法用瀏覽器開啟申請頁：${reason}` : '無法用瀏覽器開啟申請頁');
    }
    return 'browser';
}

const errorText = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : '';

function isMissingCommand(error: unknown) {
    return /not found|unknown command|not allowed/i.test(errorText(error));
}

/** 只有「沒有這個指令」（舊版原生殼）；不含權限被擋（not allowed） */
function isUnknownCommand(error: unknown) {
    return /not found|unknown command/i.test(errorText(error));
}

async function call(command: string, args?: Record<string, unknown>) {
    if (!isTauri) return;
    try {
        const { invoke } = await core();
        await invoke(command, args);
    } catch {
        // 視窗已關閉或舊版原生殼：側欄照樣有文字說明
    }
}

export const closeApplyWindow = () => call('apply_window_close');
export const showApplyApiPage = () => call('apply_window_show_api_page');
/** 申請視窗切到該市場的 API 約定書簽署頁（網址由原生殼固定，只傳市場代號）。 */
export const showApplySignPage = (market: SigningMarket) => call('apply_window_show_sign_page', { market });
export const focusApplyTarget = (target: string) => call('apply_window_focus', { target });
/** 「下載 .env」時是否同時把檔案存到下載資料夾（預設不存，只匯入 App）。舊版原生殼沒有這個指令：照舊只匯入。 */
export const setApplySaveEnv = (save: boolean) => call('apply_window_set_save_env', { save });

/**
 * 登出官網：關掉申請視窗與它的彈出視窗，清除申請視窗保存的官網資料
 * （cookie、localStorage 裡的憑證、快取）。舊版原生殼沒有這個指令，
 * 那時申請視窗本來就不保存資料，回傳 'unsupported'。
 */
export async function clearApplySiteData(): Promise<'cleared' | 'unsupported'> {
    if (!isTauri) return 'unsupported';
    try {
        const { invoke } = await core();
        await invoke('apply_window_clear_site_data');
        return 'cleared';
    } catch (error) {
        // 權限被擋時資料沒清：要讓呼叫端顯示失敗，不能回報已登出
        if (isUnknownCommand(error)) return 'unsupported';
        throw new Error(typeof error === 'string' ? error : error instanceof Error ? error.message : '無法清除官網資料');
    }
}

/** 解析原生事件；格式不符就丟掉。 */
export function parseApplyGuideEvent(name: string, payload: unknown): ApplyGuideEvent | null {
    const record = (payload ?? {}) as Record<string, unknown>;
    switch (name) {
        case 'apply-guide:step': {
            if (!isApplyPageStep(record.step)) return null;
            if (record.sign === undefined) return { kind: 'step', step: record.step };
            // 簽署狀態只會出現在簽署頁；其他組合當成格式錯誤
            return signMarketOf(record.step) && isSignState(record.sign) ? { kind: 'step', step: record.step, sign: record.sign } : null;
        }
        case 'apply-guide:imported':
            return typeof record.profileId === 'string' && typeof record.name === 'string'
                ? { kind: 'imported', profileId: record.profileId, name: record.name, duplicate: record.duplicate === true }
                : null;
        case 'apply-guide:import-failed':
            return typeof record.message === 'string' ? { kind: 'import-failed', message: record.message } : null;
        case 'apply-guide:downloaded':
            return typeof record.fileName === 'string' && DOWNLOAD_STATUSES.includes(record.status)
                ? { kind: 'downloaded', fileName: record.fileName, status: record.status as DownloadStatus }
                : null;
        case 'apply-guide:closed':
            return { kind: 'closed' };
        default:
            return null;
    }
}

const EVENTS = ['apply-guide:step', 'apply-guide:imported', 'apply-guide:import-failed', 'apply-guide:downloaded', 'apply-guide:closed'];

export async function listenApplyGuide(handler: (event: ApplyGuideEvent) => void): Promise<() => void> {
    if (!isTauri) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    const offs = await Promise.all(EVENTS.map(name => listen(name, event => {
        const parsed = parseApplyGuideEvent(name, event.payload);
        if (parsed) handler(parsed);
    })));
    return () => offs.forEach(off => off());
}
