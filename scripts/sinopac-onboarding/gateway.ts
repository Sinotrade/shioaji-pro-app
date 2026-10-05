// 本機 gateway：一顆長駐的 Chrome，每個申請流程用自己的 BrowserContext。
import { randomUUID } from "node:crypto";
// 只匯入型別：puppeteer-core 在 launch 時才動態載入，vite.config／vitest／vite build 不會載入它。
import type {
  Browser,
  BrowserContext,
  HTTPRequest,
  LaunchOptions,
  Page,
} from "puppeteer-core";
import {
  OnboardingDriverError,
  type OnboardingBrowserGateway,
  type OnboardingSession,
} from "./driver";
import { createSinopacOnboardingDriver } from "./sinopac-driver";

// 單一 CDP 指令上限，避免頁面失去回應時悶等 Puppeteer 預設的 180 秒。
const PROTOCOL_TIMEOUT_MS = 45_000;

// 固定訊息：service 只用 code 查自己的文案表，這裡的文字不會原樣轉給使用者。
const MSG = {
  expired: "本機瀏覽器工作階段已逾時，請重新開始。",
  noChrome:
    "找不到 Google Chrome。請安裝 Google Chrome，或以環境變數 SINOPAC_CHROME_PATH 指定瀏覽器執行檔路徑。",
  launchFailed: "本機瀏覽器無法啟動，請稍後再試。",
};

interface Entry {
  context: BrowserContext;
  keepAliveMs: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

interface GatewayState {
  browser?: Promise<Browser>;
  contexts?: Map<string, Entry>;
}

// 掛 globalThis：Vite 在同一個 process 內重建 server 時模組會重新載入，module 變數會忘掉活著的 Chrome。
// ponytail: 整個 `pnpm dev` 行程被關掉重開不會延續；Chrome 隨舊行程結束（Puppeteer 的 exit／signal 處理）。
const g = globalThis as typeof globalThis & {
  __sinopacOnboardingGateway?: GatewayState;
};
const state = () => (g.__sinopacOnboardingGateway ??= {});
const contexts = () => (state().contexts ??= new Map<string, Entry>());

function launchOptions(): LaunchOptions {
  const executablePath = process.env.SINOPAC_CHROME_PATH?.trim();
  return {
    headless: process.env.SINOPAC_HEADLESS !== "0",
    // 用本機已安裝的 Chrome（puppeteer-core 不下載 Chromium）。
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    // 用 stdio pipe 走 CDP，不開本機 TCP 除錯埠（其他本機程式連不進這顆 Chrome）。
    pipe: true,
    // 行程結束（含 Ctrl+C／SIGTERM）時 Puppeteer 會殺掉整個 Chrome，所有 context 隨之消失；明列以免被誤關。
    handleSIGINT: true,
    handleSIGTERM: true,
    handleSIGHUP: true,
  };
}

// UNVERIFIED（未對真實網站驗證）：頂層分頁只允許導向這些網域（含子網域）。
// 只擋頂層 document 導向；子資源與 iframe（例如 reCAPTCHA）放行。憑證彈窗（webcaDepEx.html）也是頂層導向，同樣受這份清單限制。
const NAVIGATION_ALLOWLIST = [
  "sinotrade.com.tw",
  "sinopac.com",
  "sinopac.com.tw",
  "spf.com.tw",
  "twca.com.tw",
];

/** 只比對 http(s) 網址；about:／data:／blob: 等不是對外導向，放行。 */
export function isAllowedNavigation(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const host = parsed.hostname.toLowerCase();
  return NAVIGATION_ALLOWLIST.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** 每個分頁開啟攔截：頂層導向到清單外的網域就中止，其餘請求原樣放行。 */
async function guardNavigation(page: Page): Promise<void> {
  page.on("request", (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return;
    const blocked =
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      request.frame() === page.mainFrame() &&
      !isAllowedNavigation(request.url());
    void (blocked ? request.abort("blockedbyclient") : request.continue()).catch(
      () => undefined,
    );
  });
  await page.setRequestInterception(true);
}

// 只用 Puppeteer 的訊息分類，不轉述；找不到 Chrome 與其他啟動失敗各用一則固定訊息。
const CHROME_MISSING =
  /Could not find|was not found at the configured|no executable was found|ENOENT/i;

function launchFailure(error: unknown): OnboardingDriverError {
  const missing = CHROME_MISSING.test(
    error instanceof Error ? error.message : "",
  );
  console.warn(
    JSON.stringify({
      event: "sinopac_onboarding_launch_failed",
      reason: missing ? "chrome-not-found" : "launch-failed",
      // service 只轉出自己的固定文案，這則指引至少讓開發者的終端機看得到。
      hint: missing ? MSG.noChrome : undefined,
    }),
  );
  return new OnboardingDriverError(
    "ONBOARDING_QUOTA_EXHAUSTED",
    missing ? MSG.noChrome : MSG.launchFailed,
  );
}

async function startBrowser(): Promise<Browser> {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch(launchOptions());
  // Chrome 掛掉或被關掉：所有 context 一起失效，下次 launch 重開一顆；舊 sessionId 自然回 SESSION_EXPIRED。
  browser.once("disconnected", () => {
    state().browser = undefined;
    for (const entry of contexts().values()) {
      clearTimeout(entry.timer);
      entry.closing = Promise.resolve();
    }
    contexts().clear();
  });
  return browser;
}

function getBrowser(): Promise<Browser> {
  const s = state();
  s.browser ??= startBrowser().catch((error: unknown) => {
    s.browser = undefined;
    throw launchFailure(error);
  });
  return s.browser;
}

/** 關掉 context 並移出追蹤；可重複呼叫，失敗不外洩（不得蓋掉呼叫端原本的錯誤）。 */
function dispose(sessionId: string, entry: Entry): Promise<void> {
  clearTimeout(entry.timer);
  if (contexts().get(sessionId) === entry) contexts().delete(sessionId);
  return (entry.closing ??= entry.context.close().catch(() => undefined));
}

/** 從現在起算 keepAliveMs 沒有任何動靜（launch／connect／detach）就關掉，是 service 逾時之外的第二層保險。 */
function arm(sessionId: string, entry: Entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => void dispose(sessionId, entry),
    entry.keepAliveMs,
  );
  entry.timer.unref();
}

function wrap(sessionId: string, entry: Entry): OnboardingSession {
  return {
    sessionId,
    // 每次租用都建新 driver：它會累積攔到的 alert 文字，跨步驟沿用會讓舊文字混進之後的 readText。
    driver: createSinopacOnboardingDriver(entry.context),
    async detach() {
      if (!entry.closing) arm(sessionId, entry);
    },
    close: () => dispose(sessionId, entry),
  };
}

/** 關掉所有追蹤中的 flow context（保留 Chrome）；僅供明確收尾與測試，不要掛在 Vite server close／重建上（會殺掉進行中的流程）。 */
export async function closeAllOnboardingSessions(): Promise<void> {
  await Promise.all(
    [...contexts()].map(([sessionId, entry]) => dispose(sessionId, entry)),
  );
}

export const localOnboardingGateway: OnboardingBrowserGateway = {
  async launch({ keepAliveMs }) {
    // service 同一時間只允許一個流程，所以此時還在的 context 是上一輪沒收乾淨的孤兒（例如 Vite 重建後 service 狀態已遺失）。
    await closeAllOnboardingSessions();
    const browser = await getBrowser();
    let context: BrowserContext;
    try {
      context = await browser.createBrowserContext();
    } catch (error) {
      throw launchFailure(error);
    }
    // 新分頁（含官網彈出的憑證視窗）一建立就掛上導向限制；分頁已關閉等失敗不影響流程。
    context.on("targetcreated", (target) => {
      void target
        .page()
        .then((page) => (page ? guardNavigation(page) : undefined))
        .catch(() => undefined);
    });
    const sessionId = randomUUID();
    const entry: Entry = { context, keepAliveMs };
    contexts().set(sessionId, entry);
    arm(sessionId, entry);
    return wrap(sessionId, entry);
  },

  async connect(sessionId) {
    const entry = contexts().get(sessionId);
    if (!entry || entry.closing) {
      throw new OnboardingDriverError(
        "ONBOARDING_SESSION_EXPIRED",
        MSG.expired,
      );
    }
    arm(sessionId, entry);
    return wrap(sessionId, entry);
  },
};
