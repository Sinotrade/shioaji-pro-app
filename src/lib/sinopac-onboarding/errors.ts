import { OnboardingApiError } from './api';
import { ONBOARDING_ERROR_CODES, type OnboardingErrorCode } from './types';

/**
 * 精靈自己多出來的停止原因：使用者選擇引導方式、無法確認金鑰是否建立，
 * 以及伺服器回報停止卻沒有給錯誤碼。
 */
export type OnboardingStopCode = OnboardingErrorCode | 'MANUAL' | 'KEY_UNSURE' | 'GENERIC';

export interface OnboardingErrorCopy {
    title: string;
    message: string;
    /**
     * inline：留在目前畫面顯示橫幅，使用者可再試；
     * stop：流程結束，顯示停止畫面；
     * resync：畫面與伺服器進度不同步，重新讀取進度。
     */
    kind: 'inline' | 'stop' | 'resync';
    /** 停止畫面是否提供「在永豐金證券官網自己完成」的引導清單。 */
    fallback: boolean;
    /** 金鑰可能已在永豐金證券建立：提示到官網刪除同名金鑰。 */
    deleteKeyHint?: boolean;
}

// 所有文字都是固定的中文；絕不顯示伺服器回傳的 message，也不顯示 Error 的原文。
export const ERROR_COPY: Record<OnboardingStopCode, OnboardingErrorCopy> = {
    ONBOARDING_BAD_CREDENTIALS: {
        title: '帳號或密碼不正確',
        message:
            '永豐金證券回應帳號或密碼錯誤。連續輸入錯誤 3 次會鎖定帳戶，所以我們已經停止，不會自動重試。請先到永豐金證券官網確認帳號密碼，再重新開始。',
        kind: 'inline',
        fallback: false,
    },
    ONBOARDING_ACCOUNT_LOCKED: {
        title: '永豐金證券帳戶暫時無法登入',
        message:
            '永豐金證券帳戶可能已被鎖定，或剛剛輸入錯誤次數過多，所以我們已經停止。請到永豐金證券官網或聯絡永豐金證券客服確認帳戶狀態，解鎖後再試。',
        kind: 'stop',
        fallback: false,
    },
    ONBOARDING_OTP_INVALID: {
        title: '驗證碼不正確',
        message:
            '驗證碼不正確。永豐金證券在倒數期間不允許重新寄送，請確認後重新輸入；倒數結束後可以再寄一組。',
        kind: 'inline',
        fallback: false,
    },
    ONBOARDING_OTP_EXPIRED: {
        title: '驗證碼已過期',
        message: '驗證碼已過期，請重新寄送一組新的驗證碼。',
        kind: 'inline',
        fallback: false,
    },
    ONBOARDING_SESSION_EXPIRED: {
        title: '連線逾時了',
        message: '瀏覽器工作階段已中斷，請重新開始。',
        kind: 'stop',
        fallback: false,
    },
    ONBOARDING_BROWSER_BUSY: {
        title: '瀏覽器忙碌中',
        message: '瀏覽器目前忙碌中，可能有另一次申請正在進行。請等一分鐘後再試。',
        kind: 'inline',
        fallback: false,
    },
    ONBOARDING_BLOCKED_BY_SITE: {
        title: '永豐金證券網站暫時不讓我們代為登入',
        message:
            '永豐金證券網站沒有在時限內回應，或暫時不讓我們代為操作，常見原因是網站的防機器人機制或頁面卡住。我們不會嘗試規避網站的防護。若剛才已送出登入，請先到永豐金證券官網確認帳號狀態；之後可以重新開始，或改在永豐金證券官網自己完成。',
        kind: 'stop',
        fallback: true,
    },
    ONBOARDING_RECAPTCHA_CHALLENGE: {
        title: '永豐金證券網站要求勾選檢核框',
        message:
            '永豐金證券網站要求先勾選檢核框（reCAPTCHA），這一步必須由人本人完成，我們不會嘗試代為通過。請改在永豐金證券官網自己完成。',
        kind: 'stop',
        fallback: true,
    },
    ONBOARDING_QUOTA_EXHAUSTED: {
        title: '無法啟動 Chrome',
        message:
            '無法啟動本機 Chrome。請確認已安裝 Google Chrome，或用環境變數 SINOPAC_CHROME_PATH 指定瀏覽器路徑後再試。',
        kind: 'stop',
        fallback: true,
    },
    // UNVERIFIED: 達到 30 組上限時永豐金證券頁面的行為未實際觀察過，這裡依官方「最多可建立 30 個 API Key」安全地停下。
    ONBOARDING_KEY_LIMIT_REACHED: {
        title: 'API Key 已達上限',
        message:
            '永豐金證券帳戶最多可建立 30 個 API Key。請到永豐金證券 API 管理頁刪除不再使用的金鑰後，再重新開始。',
        kind: 'stop',
        fallback: true,
    },
    ONBOARDING_SITE_CHANGED: {
        title: '永豐金證券網站畫面和預期不同',
        message: '為了避免誤操作，我們已經停止。請改在永豐金證券官網自己完成，並通知維護者更新程式。',
        kind: 'stop',
        fallback: true,
    },
    ONBOARDING_KEY_CAPTURE_FAILED: {
        title: '沒有取得 Secret Key',
        message:
            '金鑰可能已在永豐金證券建立，但我們沒有成功取得 Secret Key。Secret Key 只顯示一次，無法補抓；請到永豐金證券 API 管理頁刪除這組金鑰，再重新申請。',
        kind: 'stop',
        fallback: true,
        deleteKeyHint: true,
    },
    ONBOARDING_INVALID_REQUEST: {
        title: '輸入內容有誤',
        message: '輸入內容的格式不正確，請檢查後再送出。',
        kind: 'inline',
        fallback: false,
    },
    // 金鑰送出前就停下（還沒建立），所以不需要刪除提示，重新開始即可。
    ONBOARDING_NO_ACCOUNT_TYPE: {
        title: '這個帳號沒有你選的帳戶類型',
        message: '永豐金證券的表單上沒有你勾選的任何帳戶類型。請重新開始，只勾選你實際擁有的帳戶。',
        kind: 'stop',
        fallback: false,
    },
    ONBOARDING_INVALID_STATE: {
        title: '進度不同步',
        message: '畫面和伺服器的進度不一致，已重新讀取目前進度，請確認後再繼續。',
        kind: 'resync',
        fallback: false,
    },
    // 只有跨站送來的請求會拿到；正常從本機畫面操作不會出現。
    ONBOARDING_FORBIDDEN_ORIGIN: {
        title: '請求來源不正確',
        message: '這個請求不是從 Shioaji Pro 畫面送出，已被拒絕。請重新整理頁面後再試。',
        kind: 'stop',
        fallback: false,
    },
    MANUAL: {
        title: '改在永豐金證券官網完成',
        message:
            '帳號密碼與驗證碼都只輸入在永豐金證券官網，我們不會經手。照下面的清單操作，取得金鑰後填進「API Key 登入」分頁即可。',
        kind: 'stop',
        fallback: true,
    },
    GENERIC: {
        title: '流程已停止',
        message: '流程已經停止。請重新開始；如果一再發生，請改在永豐金證券官網自己完成。',
        kind: 'stop',
        fallback: true,
    },
    KEY_UNSURE: {
        title: '無法確認金鑰是否已建立',
        message:
            '連線中斷，我們沒有收到結果。請先到永豐金證券 API 管理頁確認有沒有多出一組同名的金鑰；有的話，它的 Secret Key 已經無法取回，請刪除後再重新申請。',
        kind: 'stop',
        fallback: true,
        deleteKeyHint: true,
    },
};

/** 沒有對應錯誤碼（網路中斷、非 JSON 回應等）時的橫幅文字。 */
export const NOTICE_OFFLINE =
    '無法連線到伺服器，請稍後再試。已送出的動作可能已經生效，請先確認畫面上的進度。';
export const NOTICE_LOGIN_UNSURE =
    '連線中斷，無法確認登入是否已送出。為避免帳戶被鎖定，我們不會自動重試；請等一分鐘後再按一次。';
export const NOTICE_RESYNCED = '與伺服器的連線曾經中斷，已重新讀取目前進度，請確認後再繼續。';
// 後端在驗證碼錯誤時為了安全會結束整個連線（永豐金證券頁面是否允許重輸尚未實測）。
export const NOTICE_OTP_INVALID_ENDED =
    '驗證碼不正確，為了安全這次連線已經結束。請重新開始，並重新輸入密碼。';
export const NOTICE_ENDED = '這次連線已經結束。請重新開始，並重新輸入密碼。';
export const NOTICE_CREATE_ENDED =
    '先前的建立程序已經結束。請確認本機設定是否已儲存金鑰；沒有的話請重新開始，並到永豐金證券 API 管理頁確認有沒有多出一組金鑰。';

const KNOWN_CODES: readonly string[] = ONBOARDING_ERROR_CODES;

export function isOnboardingErrorCode(value: unknown): value is OnboardingErrorCode {
    return typeof value === 'string' && KNOWN_CODES.includes(value);
}

/** 從 api.ts 丟出的錯誤取出已知的 ONBOARDING_* 錯誤碼；其他錯誤（含 NETWORK_ERROR）一律回 null。 */
export function onboardingErrorCode(error: unknown): OnboardingErrorCode | null {
    return error instanceof OnboardingApiError && isOnboardingErrorCode(error.code)
        ? error.code
        : null;
}
