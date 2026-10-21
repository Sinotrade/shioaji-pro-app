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
    // 主機回「Sign data is timeout」：token 服務驗證時的時間與登入簽章時間相差
    // 超過 receive_window（sidecar 1.7.9 預設 30000ms，可由啟動設定覆寫）。電腦時間不準、
    // 網路延遲、主機端時鐘偏差或處理較慢都會觸發；要在網路類之前判，否則 "timeout"
    // 會被當成連不到主機（#326）
    if (/sign data is timeout/i.test(output))
        return '登入簽章逾時（與金鑰設定無關）— 主機驗證時，登入簽章的時間已超過允許範圍（預設 30 秒）。常見原因是電腦時間不準，也可能是網路延遲，或主機端時間偏差、處理較慢。請先開啟「自動設定時間」並立即同步、時區選台北（UTC+8），確認誤差在 1～2 秒內再按啟動；時間正確仍發生時請稍後重試，持續失敗請複製錯誤訊息回報';
    // 網路類要先判 — 上游把 Solace 連線逾時也包成
    // "Authentication failed: Shioaji connect error"，若先比對登入失敗
    // 會在斷網時誤導使用者去檢查金鑰/簽署（實際只是連不到主機）
    if (
        /timed? ?out|connection (refused|reset)|network is unreachable|failed to (lookup|resolve)|dns error/i.test(
            output,
        )
    ) {
        return '無法連線至永豐主機（網路連線逾時，與金鑰設定無關）— 請檢查網路（Wi-Fi/熱點訊號、VPN、防火牆），恢復後再按啟動';
    }
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
    if (!settings.configured) {
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
    if (settings.production && settings.caPath && !settings.hasCaPassword) {
        return {
            title: '憑證密碼空白',
            body: '已選擇憑證檔但未填密碼 — CA 會啟用失敗導致下單 400，請先填入憑證密碼',
        };
    }
    return null;
}
