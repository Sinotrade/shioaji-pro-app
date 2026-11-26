// src/lib/apply-guide-native.ts — 與原生申請視窗（label `sinopac-apply`）的橋接。
//
// 申請視窗是原生殼開的獨立視窗，載入永豐官網、沒有任何 IPC 權限；
// 官網登入與憑證存在申請視窗自己的資料區（與主視窗分開、關掉後保留），
// clearApplySiteData 會關掉申請視窗並清掉這個資料區。
// 這裡只從主視窗呼叫 apply_window_* 指令，並接收原生殼送來的事件：
// 步驟（step；簽署頁另帶讀到的簽署狀態）、.env 已載入（只帶帳號 id 與金鑰名稱，不含金鑰）、
// 載入失敗、其他下載、視窗關閉、網頁說明卡上的按鈕（nav：只有 next／prev／hide 三種）、
// CA 憑證已存到帳號（只帶帳號 id、名稱、檔名與是否已有憑證密碼，不含憑證內容）或沒存成。
// 舊版原生殼沒有這些指令時退回系統瀏覽器。
//
// 網頁說明卡的按鈕是官網頁面上的東西，官網自己的程式也能假造這個回報，
// 所以收到 nav 只能移動導覽步驟或關掉說明卡，不能做別的事。

import { SIGNING_URLS, type SigningMarket } from './account-signing';
import {
    APPLY_PAGE_RULES, APPLY_URL, isApplyPageStep, isSignState, signMarketOf, type ApplyGuideCard, type ApplyPageStep, type SignState,
} from './apply-guide-config';
import { isTauri } from './runtime';
import type { CredentialEnvironment } from './desktop-credentials';
import { openExternalUrlOrThrow } from './tauri';

export type ApplyGuideEvent =
    | { kind: 'step'; step: ApplyPageStep; sign?: SignState }
    | { kind: 'imported'; profileId: string; name: string; duplicate: boolean; environment?: CredentialEnvironment }
    | { kind: 'ca-attached'; profileId: string; name: string; fileName: string; hasCaPassword: boolean }
    | { kind: 'ca-failed'; message: string }
    | { kind: 'import-failed'; message: string }
    | { kind: 'downloaded'; fileName: string; status: DownloadStatus }
    | { kind: 'closed' }
    | { kind: 'nav'; action: ApplyGuideNavAction };

/** 網頁說明卡的按鈕：下一步、上一步、關掉說明卡。 */
export type ApplyGuideNavAction = 'next' | 'prev' | 'hide';
const NAV_ACTIONS: readonly unknown[] = ['next', 'prev', 'hide'];

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
/**
 * 申請視窗切到該市場的 API 約定書簽署頁（網址由原生殼固定，只傳市場代號）。
 * 失敗（例如視窗剛好關掉）時丟出原因，讓側欄顯示並重試；舊版原生殼沒有這個指令就改用瀏覽器開。
 */
export async function showApplySignPage(market: SigningMarket) {
    if (!isTauri) return;
    try {
        const { invoke } = await core();
        await invoke('apply_window_show_sign_page', { market });
    } catch (error) {
        if (isUnknownCommand(error)) { await openExternalUrlOrThrow(SIGNING_URLS[market].url); return; }
        const reason = errorText(error);
        throw new Error(reason ? `無法打開簽署頁：${reason}` : '無法打開簽署頁');
    }
}
export const focusApplyTarget = (target: string) => call('apply_window_focus', { target });
/** 在官網上顯示（或 null 移除）導覽這一步的說明卡；舊版原生殼沒有這個指令：只有 App 裡的導覽。 */
export const setApplyGuideCard = (card: ApplyGuideCard | null) => call('apply_window_set_card', { card });
/** 「下載 .env」時是否同時把檔案存到下載資料夾（預設不存，只匯入 App）。舊版原生殼沒有這個指令：照舊只匯入。 */
export const setApplySaveEnv = (save: boolean) => call('apply_window_set_save_env', { save });
/** 「下載憑證」時是否同時把 Sinopac.pfx 存到下載資料夾（預設不存，只設定到帳號）。 */
export const setApplySaveCa = (save: boolean) => call('apply_window_set_save_ca', { save });

/** 原生殼的指令一定要成功（例如存成正式帳號）：失敗或舊版沒有這個指令時丟出原因。 */
async function require(command: string, args: Record<string, unknown>, missing: string): Promise<unknown> {
    if (!isTauri) throw new Error(missing);
    try {
        const { invoke } = await core();
        return await invoke(command, args);
    } catch (error) {
        if (isUnknownCommand(error)) throw new Error(missing);
        const reason = errorText(error);
        throw new Error(reason || missing);
    }
}

/**
 * 「下載 .env」存成哪個環境的帳號。首次設定一律模擬；舊版原生殼沒有這個指令時只能存模擬，
 * 所以要求正式環境時丟出原因（不能讓正式金鑰被默默存成模擬帳號）。申請視窗關掉後原生端回到模擬。
 */
export async function setApplyImportEnvironment(environment: CredentialEnvironment): Promise<void> {
    if (environment === 'simulation') { await call('apply_window_set_import_environment', { environment }); return; }
    await require('apply_window_set_import_environment', { environment }, '這個版本無法把金鑰存成正式帳號，請更新 App');
}

/**
 * 「下載憑證」收到的 Sinopac.pfx 要設定到哪個正式帳號（null：不攔截，照一般下載）。
 * 回傳帳號名稱；帳號不存在、不是正式環境或舊版原生殼時丟出原因。申請視窗關掉後原生端清除。
 */
export async function setApplyCaTarget(profileId: string | null): Promise<string | null> {
    if (profileId === null) { await call('apply_window_set_ca_target', { profileId: null }); return null; }
    const name = await require('apply_window_set_ca_target', { profileId }, '這個版本無法直接收下憑證，請更新 App，或下載後到帳號設定選擇憑證檔');
    return typeof name === 'string' ? name : null;
}

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
        case 'apply-guide:imported': {
            if (typeof record.profileId !== 'string' || typeof record.name !== 'string') return null;
            const event: ApplyGuideEvent = { kind: 'imported', profileId: record.profileId, name: record.name, duplicate: record.duplicate === true };
            // 舊版原生殼不帶環境（一律模擬）；帶了就一定要是認得的值
            if (record.environment === undefined) return event;
            return record.environment === 'simulation' || record.environment === 'production' ? { ...event, environment: record.environment } : null;
        }
        case 'apply-guide:ca-attached':
            return typeof record.profileId === 'string' && typeof record.name === 'string'
                && typeof record.fileName === 'string' && typeof record.hasCaPassword === 'boolean'
                ? { kind: 'ca-attached', profileId: record.profileId, name: record.name, fileName: record.fileName, hasCaPassword: record.hasCaPassword }
                : null;
        case 'apply-guide:ca-failed':
            return typeof record.message === 'string' ? { kind: 'ca-failed', message: record.message } : null;
        case 'apply-guide:import-failed':
            return typeof record.message === 'string' ? { kind: 'import-failed', message: record.message } : null;
        case 'apply-guide:downloaded':
            return typeof record.fileName === 'string' && DOWNLOAD_STATUSES.includes(record.status)
                ? { kind: 'downloaded', fileName: record.fileName, status: record.status as DownloadStatus }
                : null;
        case 'apply-guide:closed':
            return { kind: 'closed' };
        case 'apply-guide:nav':
            return NAV_ACTIONS.includes(record.action) ? { kind: 'nav', action: record.action as ApplyGuideNavAction } : null;
        default:
            return null;
    }
}

const EVENTS = [
    'apply-guide:step', 'apply-guide:imported', 'apply-guide:import-failed', 'apply-guide:downloaded', 'apply-guide:closed', 'apply-guide:nav',
    'apply-guide:ca-attached', 'apply-guide:ca-failed',
];

export async function listenApplyGuide(handler: (event: ApplyGuideEvent) => void): Promise<() => void> {
    if (!isTauri) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    const offs = await Promise.all(EVENTS.map(name => listen(name, event => {
        const parsed = parseApplyGuideEvent(name, event.payload);
        if (parsed) handler(parsed);
    })));
    return () => offs.forEach(off => off());
}
