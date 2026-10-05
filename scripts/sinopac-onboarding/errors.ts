import { OnboardingDriverError } from "./driver";

/** 建立固定訊息的 driver 錯誤。訊息一律寫死，不得夾帶頁面文字、帳密、OTP 或金鑰。 */
export function fail(
  code: OnboardingDriverError["code"],
  message: string,
  retryAfterSeconds?: number,
): never {
  throw new OnboardingDriverError(code, message, retryAfterSeconds);
}

/** 單次頁面腳本逾時（例如頁面被原生對話方塊卡住）。輪詢中視為「還沒好」，由外層期限把關。 */
export class DomCallTimeout extends Error {
  constructor() {
    super("dom call timeout");
    this.name = "DomCallTimeout";
  }
}

/** Puppeteer 在頁面換頁時會丟出的暫時性錯誤；輪詢時視為「還沒好」。 */
export function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /execution context was destroyed|cannot find context|inspected target navigated|frame was detached/i.test(
    message,
  );
}

/**
 * 錯誤邊界：只用原始訊息「分類」，絕不複製進新錯誤。
 * Puppeteer 的 "Evaluation failed" 之類錯誤可能夾帶頁面文字，所以一律換成固定訊息。
 */
export function toDriverError(error: unknown): OnboardingDriverError {
  if (error instanceof OnboardingDriverError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "BrowserRunCapacityError") {
    const retry = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return new OnboardingDriverError(
      "ONBOARDING_QUOTA_EXHAUSTED",
      "Cloudflare 瀏覽器額度或啟動頻率已達上限，請稍後再試。",
      typeof retry === "number" ? retry : undefined,
    );
  }
  if (
    /target closed|session closed|connection closed|browser has disconnected|browser disconnected|websocket|protocol error/i.test(
      message,
    )
  ) {
    return new OnboardingDriverError(
      "ONBOARDING_SESSION_EXPIRED",
      "瀏覽器工作階段已中斷，請重新開始。",
    );
  }
  if (name === "TimeoutError" || /timeout|timed out/i.test(message)) {
    return new OnboardingDriverError(
      "ONBOARDING_BLOCKED_BY_SITE",
      "永豐金證券頁面沒有在時限內回應，已停止。",
    );
  }
  return new OnboardingDriverError(
    "ONBOARDING_SITE_CHANGED",
    "與永豐金證券頁面互動時發生非預期的狀況，已停止。",
  );
}

/**
 * 診斷用：非預期錯誤只回報「名稱」與少數已知、不含頁面內容的 Puppeteer 訊息開頭，
 * 其餘一律不記錄（原始訊息可能夾帶頁面文字）。driver 自己丟的錯誤訊息本來就是固定的，不需要 hint。
 */
export function errorHint(error: unknown): string | undefined {
  if (error instanceof OnboardingDriverError) return undefined;
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : "";
  const known =
    /^(Protocol error \([\w.]+\)|Execution context was destroyed|Node is detached from document|No target with given id found|Target closed|Session closed|Navigating frame was detached)/i.exec(
      message,
    );
  return known ? `${name}: ${known[0]}` : name;
}
