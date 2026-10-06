// scripts/sinopac-onboarding/driver.ts
//
// 申請精靈的 driver 介面、錯誤類別與共用型別。本機只有一個長駐的 Chrome（見 gateway.ts），
// 每個流程各用一個 BrowserContext。
//
// PageLike／BrowserLike 定義在 sinopac-driver.ts（不是這個檔案）。
import type {
  OnboardingErrorCode,
  OnboardingOtpChannel,
  OnboardingOtpPurpose,
  OnboardingOtpTarget,
  OnboardingPlan,
} from "../../src/lib/sinopac-onboarding/types";

/** 所有可預期的失敗都用這個錯誤表達；訊息固定，不得夾帶頁面文字、帳密、OTP 或金鑰。 */
export class OnboardingDriverError extends Error {
  /**
   * 診斷資訊，只由真實 driver 的錯誤邊界填入（步驟名稱、固定訊息與已過濾的 hint），
   * 由 service 記進一行 log；不含頁面文字、帳密、OTP 或金鑰。
   */
  diag?: { step: string; reason: string; hint?: string };

  constructor(
    readonly code: OnboardingErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OnboardingDriverError";
  }
}

/** 登入送出後頁面的結果。被擋、勾選式檢核、密碼錯誤一律丟 OnboardingDriverError。 */
export type OnboardingLoginOutcome = "webca_birthday" | "logged_in";

/**
 * 對永豐金證券官網的一連串頁面操作。每個方法只做一步，不自動重試登入。
 * 所有收碼選項、條款、帳戶標籤都從真實頁面讀取，並在回傳前遮罩個資。
 */
export interface OnboardingDriver {
  login(input: {
    idNumber: string;
    password: string;
  }): Promise<OnboardingLoginOutcome>;
  submitBirthday(birthday: string): Promise<void>;
  readOtpTargets(purpose: OnboardingOtpPurpose): Promise<OnboardingOtpTarget[]>;
  sendOtp(
    purpose: OnboardingOtpPurpose,
    channel: OnboardingOtpChannel,
    targetIndex: number,
  ): Promise<{ expiresInSeconds: number }>;
  submitOtp(purpose: OnboardingOtpPurpose, code: string): Promise<void>;
  readTerms(): Promise<string>;
  /** 使用者已在我們的畫面本人勾選後，才呼叫。完成憑證安裝，彈出視窗關閉。 */
  acceptTerms(): Promise<void>;
  /** 憑證安裝後主分頁的登入框是空的，需要使用者再輸入一次。 */
  relogin(input: { idNumber: string; password: string }): Promise<void>;
  /** 開啟「新增 API Key」並停在身份驗證對話方塊。 */
  openKeyIdentityDialog(): Promise<void>;
  /** 第二次 OTP 通過後：依方案填表、按確定、擷取一次性視窗。 */
  createKey(plan: OnboardingPlan): Promise<{
    apiKey: string;
    secretKey: string;
    accountLabels: string[];
  }>;
}

export interface OnboardingSession {
  readonly sessionId: string;
  readonly driver: OnboardingDriver;
  /** 本機版：釋放這次租用，讓 gateway 重新倒數閒置逾時計時器（不斷線、不關瀏覽器）。 */
  detach(): Promise<void>;
  /** 本機版：關閉這個 flow 專屬的 BrowserContext（相當於原本的 browser.close()）。 */
  close(): Promise<void>;
}

export interface OnboardingBrowserGateway {
  launch(options: { keepAliveMs: number }): Promise<OnboardingSession>;
  /** 找不到或已逾時的 session 丟 ONBOARDING_SESSION_EXPIRED。 */
  connect(sessionId: string): Promise<OnboardingSession>;
  /** DEV 播放窗：最上層分頁目前的畫面（JPEG）。不續期、不建 driver；沒有畫面回 null。 */
  capture?(sessionId: string): Promise<Uint8Array | null>;
}
