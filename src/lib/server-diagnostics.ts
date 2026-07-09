// src/lib/server-diagnostics.ts — human-readable translations for shioaji
// server start/stop output and pre-flight validation, shared by the header
// ServerManager panel and the first-run onboarding setup screen.

import type { DesktopSettings } from './tauri';

// translate known server-start failures into something a user can act on
// (the raw log buries the ERROR line below INFO noise — see the
// "msg receiver error: Closed" support case)
export function diagnoseOutput(output: string): string | null {
    if (/not exist/i.test(output))
        return 'API Key 不存在或已失效 — 請至永豐「API 管理頁」確認或重建金鑰後重新填入';
    if (/invalid (secret_key|api_key)|base58/i.test(output))
        return '金鑰格式錯誤 — 請確認 API Key／Secret Key 完整貼上（沒有多餘空白或漏字）';
    if (/ca.*(password|passwd)|pfx/i.test(output))
        return '憑證載入失敗 — 請確認 Sinopac.pfx 與憑證密碼';
    if (/Authentication failed|login validation error|LOGINING/i.test(output))
        return '登入失敗 — 請檢查金鑰是否正確、API 約定書是否已完成簽署、同帳號連線是否已達上限（5 條）';
    return null;
}

export function errorLines(output: string): string {
    return [
        ...new Set(
            output
                .split('\n')
                .filter((l) => /\bERROR\b|^Error:/i.test(l))
                .map((l) =>
                    l.replace(/^.*\bERROR\b\S*\s*/, '').replace(/^Error:\s*/, ''),
                )
                .filter(Boolean),
        ),
    ]
        .slice(0, 2)
        .join('\n');
}

// pre-flight check before calling serverStart — surfaces the exact same
// missing-field errors doStart() used to inline, now shared with onboarding
export function validateDesktopSettings(
    settings: DesktopSettings,
): { title: string; body: string } | null {
    if (!settings.apiKey || !settings.secretKey) {
        return { title: '缺少 API 金鑰', body: '請先填入 SJ_API_KEY / SJ_SEC_KEY' };
    }
    if (settings.production && !settings.caPath) {
        return {
            title: '缺少憑證',
            body: '正式環境下單需要 Sinopac.pfx 憑證，請先選擇憑證檔',
        };
    }
    // 選了憑證卻沒填密碼 → 伺服器照樣啟動但 CA 啟用失敗，下單全部
    // 400（issue #1 的真因之一）— 啟動前就擋下
    if (settings.production && settings.caPath && !settings.caPasswd) {
        return {
            title: '憑證密碼空白',
            body: '已選擇憑證檔但未填密碼 — CA 會啟用失敗導致下單 400，請先填入憑證密碼',
        };
    }
    return null;
}
