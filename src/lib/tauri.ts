// src/lib/tauri.ts — desktop bridge helpers for KGI Pro.

import { isTauri } from './runtime';
import { notify } from './trade';

export { isTauri } from './runtime';

let popoutCounter = 0;

export async function openPopout(type: string, code: string | null) {
    const qs = new URLSearchParams({ popout: type, code: code ?? '' });
    if (!isTauri) {
        window.open(
            `${window.location.pathname}?${qs}`,
            `kgi-popout-${type}-${code ?? 'x'}`,
            'width=900,height=620,menubar=no,toolbar=no',
        );
        return;
    }
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    popoutCounter += 1;
    new WebviewWindow(`popout-${type}-${popoutCounter}`, {
        url: `index.html?${qs}`,
        dragDropEnabled: false,
        title: `KGI Pro — ${type}${code ? ` · ${code}` : ''}`,
        width: 900,
        height: 620,
        minWidth: 420,
        minHeight: 300,
    });
}

export interface FlashTileLayout {
    cols: number;
    rows: number;
    region: 'full' | 'right' | 'bottom';
}

export async function openFlashTiles(
    codes: string[],
    layout: FlashTileLayout = { cols: 3, rows: 3, region: 'full' },
) {
    const count = Math.min(codes.length, layout.cols * layout.rows);
    if (count === 0) return;
    const use = codes.slice(0, count);
    const availW = window.screen.availWidth;
    const availH = window.screen.availHeight;
    let originX = 0;
    let originY = 0;
    let gridW = availW;
    let gridH = availH;
    if (layout.region === 'right') {
        gridW = Math.max(360, Math.floor(availW / 4));
        originX = availW - gridW;
    } else if (layout.region === 'bottom') {
        gridH = Math.max(320, Math.floor(availH / 3));
        originY = availH - gridH;
    }
    const w = Math.floor(gridW / layout.cols);
    const h = Math.floor(gridH / layout.rows);
    const posOf = (i: number) => ({
        x: originX + (i % layout.cols) * w,
        y: originY + Math.floor(i / layout.cols) * h,
    });
    if (!isTauri) {
        use.forEach((code, i) => {
            const { x, y } = posOf(i);
            const qs = new URLSearchParams({ popout: 'flash', code });
            window.open(
                `${window.location.pathname}?${qs}`,
                `kgi-flash-tile-${code}`,
                `left=${x},top=${y},width=${w},height=${h},menubar=no,toolbar=no`,
            );
        });
        return;
    }
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    use.forEach((code, i) => {
        const { x, y } = posOf(i);
        const qs = new URLSearchParams({ popout: 'flash', code });
        popoutCounter += 1;
        new WebviewWindow(`popout-flashtile-${popoutCounter}`, {
            url: `index.html?${qs}`,
            dragDropEnabled: false,
            title: `⚡ ${code}`,
            x,
            y,
            width: w,
            height: h,
            minWidth: 210,
            minHeight: 280,
        });
    });
}

let cachedVersion: string | null = null;

export async function appVersion(): Promise<string> {
    if (cachedVersion) return cachedVersion;
    if (isTauri) {
        try {
            const { getVersion } = await import('@tauri-apps/api/app');
            cachedVersion = await getVersion();
            return cachedVersion;
        } catch {
            // Fall through to dev.
        }
    }
    cachedVersion = 'dev';
    return cachedVersion;
}

let updateInFlight = false;

export type AppUpdatePhase =
    | 'idle'
    | 'checking'
    | 'available'
    | 'ready'
    | 'none'
    | 'error';

export interface AppUpdateState {
    phase: AppUpdatePhase;
    version?: string;
    message?: string;
}

let updateState: AppUpdateState = { phase: 'idle' };
const updateListeners = new Set<() => void>();

function setUpdateState(next: AppUpdateState) {
    updateState = next;
    updateListeners.forEach((listener) => listener());
}

export function getAppUpdateState() {
    return updateState;
}

export function subscribeAppUpdateState(listener: () => void) {
    updateListeners.add(listener);
    return () => {
        updateListeners.delete(listener);
    };
}

export async function checkForUpdates(silent: boolean) {
    if (!isTauri || updateInFlight) return;
    updateInFlight = true;
    setUpdateState({ phase: 'checking' });
    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) {
            setUpdateState({ phase: 'none' });
            if (!silent) {
                notify({
                    kind: 'info',
                    title: '已是最新版本',
                    body: '目前沒有可用更新',
                });
            }
            return;
        }
        setUpdateState({ phase: 'available', version: update.version });
        notify({
            kind: 'info',
            title: `有新版 v${update.version}`,
            body: '請依桌面安裝包設定完成更新',
        });
        await update.close().catch(() => undefined);
        setUpdateState({ phase: 'ready', version: update.version });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setUpdateState({ phase: 'error', message });
        if (!silent) {
            notify({
                kind: 'err',
                title: '更新檢查失敗',
                body: message,
            });
        }
    } finally {
        updateInFlight = false;
    }
}

export async function restartAndInstallUpdate() {
    if (!isTauri) return;
    notify({
        kind: 'info',
        title: '更新已準備',
        body: '請依桌面安裝包設定完成重啟更新',
    });
}

export async function openLatestRelease() {
    const url = 'https://github.com/YongYi-123/shioaji-pro-app/releases/latest';
    window.open(url, '_blank', 'noopener,noreferrer');
}
