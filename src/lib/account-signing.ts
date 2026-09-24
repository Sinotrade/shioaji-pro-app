// src/lib/account-signing.ts — 帳戶 `signed=false` 的使用者文案與處理連結。
// signed=false 代表該商品「API 約定書未簽署」或「模擬環境登入／下單測試
// 尚未通過」其中之一（Shioaji skill PREPARE.md Step 3），伺服器不區分，
// 所以文案不能只說「未簽署」。

export const UNSIGNED_LABEL = '未簽署或未測試';
export const UNSIGNED_BLOCKED_LABEL = `${UNSIGNED_LABEL}（無法下單）`;
export const UNSIGNED_TITLE = '尚未完成 API 約定書簽署或模擬測試，無法下單';

// 永豐 API 管理頁：查看各帳戶簽署／測試狀態與原因。
export const API_MANAGEMENT_URL =
    'https://www.sinotrade.com.tw/newweb/PythonAPIKey/';

// 依商品別的 API 約定書簽署頁。
export const SIGNING_URLS: Record<'S' | 'F', { label: string; url: string }> = {
    S: {
        label: '證券 API 約定書',
        url: 'https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/',
    },
    F: {
        label: '期貨／選擇權 API 約定書',
        url: 'https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/',
    },
};
