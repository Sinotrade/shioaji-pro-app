/**
 * 永豐金證券 Shioaji API Key 申請與登入流程型別契約與檢核工具。
 */

export const ONBOARDING_STEPS = [
  'login',
  'birthday',
  'cert_otp',
  'terms',
  'relogin',
  'plan',
  'key_otp',
  'creating',
  'done',
  'stopped',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingOtpChannel = 'sms' | 'email';
export type OnboardingOtpPurpose = 'cert' | 'key';
export type OnboardingAccountType = 'stock' | 'futures' | 'overseas';
export type OnboardingPermission = 'quote' | 'account' | 'trade' | 'prod';

export const ONBOARDING_ERROR_CODES = [
  'ONBOARDING_BAD_CREDENTIALS',
  'ONBOARDING_ACCOUNT_LOCKED',
  'ONBOARDING_OTP_INVALID',
  'ONBOARDING_OTP_EXPIRED',
  'ONBOARDING_SESSION_EXPIRED',
  'ONBOARDING_BROWSER_BUSY',
  'ONBOARDING_BLOCKED_BY_SITE',
  'ONBOARDING_RECAPTCHA_CHALLENGE',
  'ONBOARDING_QUOTA_EXHAUSTED',
  'ONBOARDING_KEY_LIMIT_REACHED',
  'ONBOARDING_SITE_CHANGED',
  'ONBOARDING_KEY_CAPTURE_FAILED',
  'ONBOARDING_INVALID_REQUEST',
  'ONBOARDING_INVALID_STATE',
  'ONBOARDING_FORBIDDEN_ORIGIN',
  'ONBOARDING_NO_ACCOUNT_TYPE',
] as const;
export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

/** 收碼管道選項（已遮罩） */
export interface OnboardingOtpTarget {
  channel: OnboardingOtpChannel;
  index: number;
  masked: string;
}

export interface OnboardingPlan {
  name: string;
  /** YYYY-MM-DD */
  expiresOn: string;
  permissions: Record<OnboardingPermission, boolean>;
  accountTypes: OnboardingAccountType[];
  ip: { mode: 'unlimited' | 'restricted'; addresses: string[] };
}

export interface OnboardingResult {
  apiKeyLast4: string;
  expiresOn: string;
  permissions: OnboardingPermission[];
  accountLabels: string[];
}

export interface OnboardingStatus {
  step: OnboardingStep;
  expiresAt: string | null;
  otp: {
    purpose: OnboardingOtpPurpose;
    channel: OnboardingOtpChannel;
    targetIndex: number;
    expiresAt: string;
  } | null;
  otpTargets: OnboardingOtpTarget[];
  termsText: string | null;
  result: OnboardingResult | null;
  revealed?: { apiKey: string; secretKey: string } | null;
  error: { code: OnboardingErrorCode; message: string } | null;
  /** 只在 creating 時帶：建立金鑰的請求是否已送達伺服器（false 表示從未送出，舊版後端不帶）。 */
  keyRequested?: boolean;
}

export interface OnboardingStartRequest {
  idNumber: string;
  password: string;
}

export interface OnboardingBirthdayRequest {
  /** YYYYMMDD */
  birthday: string;
}

export interface OnboardingOtpSendRequest {
  purpose: OnboardingOtpPurpose;
  channel: OnboardingOtpChannel;
  targetIndex: number;
}

export interface OnboardingOtpVerifyRequest {
  purpose: OnboardingOtpPurpose;
  code: string;
}

export interface OnboardingTermsRequest {
  accepted: true;
}
export type OnboardingReloginRequest = OnboardingStartRequest;
export type OnboardingPlanRequest = OnboardingPlan;
export interface OnboardingKeyRequest {
  /** true 時，回應會一次性帶回 API Key 與 Secret Key，讓使用者複製到同步程式。伺服器不保留這份回應。 */
  revealSecret: boolean;
}

export interface OnboardingKeyResponse {
  result: OnboardingResult;
  revealed: { apiKey: string; secretKey: string } | null;
}

export type OnboardingPlanErrors = Partial<
  Record<
    | 'permissions'
    | 'accountTypes'
    | 'name'
    | 'expiresOn'
    | 'ip',
    string
  >
>;

export const ONBOARDING_NAME_MAX = 15;
export const ONBOARDING_MAX_IPS = 5;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIpv4(value: string): boolean {
  return IPV4.test(value.trim());
}

/** 台灣身分證字號格式檢核（英文字母 + 9 碼數字） */
export function isTaiwanIdFormat(value: string): boolean {
  return /^[A-Za-z][1289]\d{8}$/.test(value.trim());
}

/** 8 碼西元年生日檢核（YYYYMMDD） */
export function isBirthday8(value: string, now: Date = new Date()): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(year, month - 1, day);
  return (
    year >= 1900 &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getTime() <= now.getTime()
  );
}

function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function defaultExpiryDate(years = 1): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return dateKey(d);
}

/** YYYY-MM-DD 且是日曆上真實存在的日期（例如 2027-02-30 不算）。 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 方案欄位檢查。交易可以搭配無限制 IP（動態 IP 的使用者只能這樣設定）。 */
export function validateOnboardingPlan(
  plan: OnboardingPlan,
  now: Date = new Date(),
): OnboardingPlanErrors {
  const errors: OnboardingPlanErrors = {};
  const permissions = Object.values(plan.permissions);
  if (!permissions.some(Boolean)) errors.permissions = '至少選一項權限。';
  if (plan.accountTypes.length === 0) errors.accountTypes = '至少綁定一種帳戶。';
  const name = plan.name.trim();
  if (!name) errors.name = '請輸入名稱。';
  else if (name.length > ONBOARDING_NAME_MAX)
    errors.name = `名稱最多 ${ONBOARDING_NAME_MAX} 個字元。`;
  else if (/[\u0000-\u001f\u007f]/.test(name))
    errors.name = '名稱不能包含換行或其他控制字元。';
  if (!isCalendarDate(plan.expiresOn)) errors.expiresOn = '請選擇有效的到期日。';
  else if (plan.expiresOn <= dateKey(now))
    errors.expiresOn = '到期日要晚於今天。';
  if (plan.ip.mode === 'restricted') {
    if (
      plan.ip.addresses.length === 0 ||
      plan.ip.addresses.length > ONBOARDING_MAX_IPS ||
      plan.ip.addresses.some((address) => !isIpv4(address))
    ) {
      errors.ip = '請輸入正確的 IPv4 位址，例如 203.0.113.42。';
    }
  }
  return errors;
}

