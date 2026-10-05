/**
 * /api/sinopac-onboarding/* 的 fetch 客戶端（不依賴 TanStack Query）。
 * 移植自 all-set-tw queries.ts：每一步都是一次性請求，不重試、不快取、不記錄請求內容。
 * 帳密、生日、OTP 只放在 POST 本文，絕不進 URL。
 */

import {
  ONBOARDING_STEPS,
  type OnboardingBirthdayRequest,
  type OnboardingKeyRequest,
  type OnboardingKeyResponse,
  type OnboardingOtpSendRequest,
  type OnboardingOtpVerifyRequest,
  type OnboardingPlanRequest,
  type OnboardingReloginRequest,
  type OnboardingStartRequest,
  type OnboardingStatus,
  type OnboardingTermsRequest,
} from './types';

export const ONBOARDING_API_BASE = '/api/sinopac-onboarding';

/** 可注入的 fetch（測試用）；預設在呼叫當下才讀 globalThis.fetch。 */
export type OnboardingFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 所有失敗都正規化成這個錯誤。code 是伺服器的 ONBOARDING_* 錯誤碼；
 * 沒有可用錯誤碼時為 NETWORK_ERROR（連線中斷，status 0）或 REQUEST_FAILED（非預期回應）。
 * message 只是 code：絕不帶伺服器或 fetch 的原文。
 * salvage 只有 createKey 會填：後端在「金鑰已建立但儲存失敗」時一次性帶回的結果。
 */
export class OnboardingApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly salvage: OnboardingKeyResponse | null = null,
  ) {
    super(code);
    this.name = 'OnboardingApiError';
  }
}

/** createKey 的成功回應。envPath 是後端寫入金鑰的 .env 絕對路徑；舊版後端不會帶。 */
export type OnboardingKeyCreated = OnboardingKeyResponse & { envPath?: string };

export type OnboardingStepAction =
  | { kind: 'start'; body: OnboardingStartRequest }
  | { kind: 'birthday'; body: OnboardingBirthdayRequest }
  | { kind: 'otpSend'; body: OnboardingOtpSendRequest }
  | { kind: 'otpVerify'; body: OnboardingOtpVerifyRequest }
  | { kind: 'terms'; body: OnboardingTermsRequest }
  | { kind: 'relogin'; body: OnboardingReloginRequest }
  | { kind: 'plan'; body: OnboardingPlanRequest };

const STEP_PATHS: Record<OnboardingStepAction['kind'], string> = {
  start: 'start',
  birthday: 'birthday',
  otpSend: 'otp/send',
  otpVerify: 'otp/verify',
  terms: 'terms',
  relogin: 'relogin',
  plan: 'plan',
};

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isStatus(data: unknown): data is OnboardingStatus {
  const step = asRecord(data)?.step;
  return typeof step === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(step);
}

function revealedFrom(value: unknown): OnboardingKeyResponse['revealed'] {
  const revealed = asRecord(value);
  return revealed && typeof revealed.apiKey === 'string' && typeof revealed.secretKey === 'string'
    ? { apiKey: revealed.apiKey, secretKey: revealed.secretKey }
    : null;
}

function salvageFrom(error: Record<string, unknown> | null): OnboardingKeyResponse | null {
  const result = asRecord(error?.result);
  const revealed = revealedFrom(error?.revealed);
  if (
    !result ||
    !revealed ||
    typeof result.apiKeyLast4 !== 'string' ||
    typeof result.expiresOn !== 'string' ||
    !Array.isArray(result.permissions) ||
    !Array.isArray(result.accountLabels)
  )
    return null;
  return { result: result as unknown as OnboardingKeyResponse['result'], revealed };
}

/** 伺服器錯誤格式：{ success:false, error:{ code, message, ... } }；message 一律丟棄。 */
function failure(status: number, data: unknown, withSalvage = false): OnboardingApiError {
  const error = asRecord(asRecord(data)?.error);
  const code = typeof error?.code === 'string' && CODE_SHAPE.test(error.code) ? error.code : 'REQUEST_FAILED';
  return new OnboardingApiError(code, status, withSalvage ? salvageFrom(error) : null);
}

export function createOnboardingApi(
  fetchImpl: OnboardingFetch = (input, init) => fetch(input, init),
) {
  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetchImpl(`${ONBOARDING_API_BASE}/${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new OnboardingApiError('NETWORK_ERROR', 0);
    }
    let data: unknown = null;
    try {
      data = JSON.parse(await response.text());
    } catch {
      // 非 JSON：當成沒有錯誤碼的泛用失敗。
    }
    return { response, data };
  }

  async function status(method: 'GET' | 'POST', path: string, body?: unknown): Promise<OnboardingStatus> {
    const { response, data } = await request(method, path, body);
    if (response.ok && isStatus(data)) return data;
    throw failure(response.status, data);
  }

  const post = (path: string, body: unknown) => status('POST', path, body);

  /**
   * 建立金鑰的請求獨立處理：存檔失敗（ONBOARDING_KEY_CAPTURE_FAILED）時後端一律把唯一一份 result 與 revealed
   * 放在錯誤本體裡，這裡必須保留到 OnboardingApiError.salvage；成功時只有 revealSecret（桌面版）才回傳 revealed。
   * 成功與救援內容都可能含 Secret Key：呼叫端用完要立刻丟棄，不要放進長期狀態。
   */
  async function createKey(body: OnboardingKeyRequest): Promise<OnboardingKeyCreated> {
    const { response, data } = await request('POST', 'key', body);
    const result = asRecord(asRecord(data)?.result);
    const envPath = asRecord(data)?.envPath;
    if (response.ok && result)
      return {
        result: result as unknown as OnboardingKeyResponse['result'],
        revealed: revealedFrom(asRecord(data)?.revealed),
        ...(typeof envPath === 'string' && envPath !== '' ? { envPath } : {}),
      };
    throw failure(response.status, data, true);
  }

  async function cancel(): Promise<void> {
    const { response, data } = await request('POST', 'cancel', {});
    if (!response.ok) throw failure(response.status, data);
  }

  return {
    /** 只讀伺服器進度，不重送任何動作。沒有進行中的流程時回 step: 'login'。 */
    status: () => status('GET', 'status'),
    start: (body: OnboardingStartRequest) => post('start', body),
    birthday: (body: OnboardingBirthdayRequest) => post('birthday', body),
    sendOtp: (body: OnboardingOtpSendRequest) => post('otp/send', body),
    verifyOtp: (body: OnboardingOtpVerifyRequest) => post('otp/verify', body),
    acceptTerms: () => post('terms', { accepted: true } satisfies OnboardingTermsRequest),
    relogin: (body: OnboardingReloginRequest) => post('relogin', body),
    submitPlan: (body: OnboardingPlanRequest) => post('plan', body),
    /** 依 kind 分派到對應的步驟請求（等同上面的具名方法）。 */
    step: (action: OnboardingStepAction) => post(STEP_PATHS[action.kind], action.body),
    createKey,
    cancel,
    /** 離開時盡力通知伺服器關閉遠端瀏覽器；失敗（含建立中的 BROWSER_BUSY）不影響使用者。 */
    cancelQuietly: () => {
      void cancel().catch(() => undefined);
    },
  };
}

export type OnboardingApi = ReturnType<typeof createOnboardingApi>;

export const onboardingApi: OnboardingApi = createOnboardingApi();
