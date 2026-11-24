// src/lib/apply-guide-native.ts — 與原生申請視窗（label `sinopac-apply`）的橋接。
//
// 申請視窗是原生殼開的獨立視窗，載入永豐官網、沒有任何 IPC 權限；
// 這裡只從主視窗呼叫 apply_window_* 指令，並接收原生殼送來的事件：
// 步驟（step）、.env 已載入（只帶帳號 id 與金鑰名稱，不含金鑰）、
// 載入失敗、其他下載、視窗關閉。舊版原生殼沒有這些指令時退回系統瀏覽器。

import { APPLY_PAGE_RULES, APPLY_URL, isApplyPageStep, type ApplyPageStep } from './apply-guide-config';
import { isTauri } from './runtime';
import { openExternalUrlOrThrow } from './tauri';

export type ApplyGuideEvent =
    | { kind: 'step'; step: ApplyPageStep }
    | { kind: 'imported'; profileId: string; name: string; duplicate: boolean }
    | { kind: 'import-failed'; message: string }
    | { kind: 'downloaded'; fileName: string; status: DownloadStatus }
    | { kind: 'closed' };

export type ApplyWindowOpenResult = 'window' | 'browser';
/** unknown：平台無法判斷結果（Linux），檔案已交給系統下載。 */
export type DownloadStatus = 'saved' | 'failed' | 'unknown';
const DOWNLOAD_STATUSES: readonly unknown[] = ['saved', 'failed', 'unknown'];

const core = () => import('@tauri-apps/api/core');

/** 開啟（或帶到前面）申請視窗；不支援時改用系統瀏覽器開官網。 */
export async function openApplyWindow(): Promise<ApplyWindowOpenResult> {
    if (isTauri) {
        try {
            const { invoke } = await core();
            await invoke('apply_window_open', { config: APPLY_PAGE_RULES });
            return 'window';
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

function isMissingCommand(error: unknown) {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    return /not found|unknown command|not allowed/i.test(text);
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
export const focusApplyTarget = (target: string) => call('apply_window_focus', { target });

/** 解析原生事件；格式不符就丟掉。 */
export function parseApplyGuideEvent(name: string, payload: unknown): ApplyGuideEvent | null {
    const record = (payload ?? {}) as Record<string, unknown>;
    switch (name) {
        case 'apply-guide:step':
            return isApplyPageStep(record.step) ? { kind: 'step', step: record.step } : null;
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
