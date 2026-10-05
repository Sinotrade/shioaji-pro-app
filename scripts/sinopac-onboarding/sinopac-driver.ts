import {
  isBirthday8,
  validateOnboardingPlan,
  type OnboardingAccountType,
  type OnboardingOtpChannel,
  type OnboardingOtpPurpose,
  type OnboardingOtpTarget,
  type OnboardingPermission,
  type OnboardingPlan,
} from "../../src/lib/sinopac-onboarding/types";
import {
  OnboardingDriverError,
  type OnboardingDriver,
  type OnboardingLoginOutcome,
} from "./driver";
import {
  buildDomScript,
  type DomHit,
  type DomList,
  type DomOp,
  type DomOptions,
  type DomRole,
  type DomText,
  type DomValue,
} from "./dom-kit";
import {
  DomCallTimeout,
  fail,
  isNavigationRace,
  errorHint,
  toDriverError,
} from "./errors";
import { maskAccountLabel, maskOtpTarget, scrubText } from "./masking";
import {
  accountTypeOf,
  loose,
  newLines,
  normalizeDate,
  parseCountdownSeconds,
  parseKeySuccessDialog,
  pattern,
  tidyLines,
  type Pattern,
} from "./parsing";

/**
 * 永豐金證券官網（www / ca / osu.sinotrade.com.tw）的 OnboardingDriver。
 *
 * 只依賴下面的 PageLike／BrowserLike，gateway 用本機 Chrome 的 Puppeteer Page／Browser 直接滿足，
 * 測試則用腳本化的假頁面。每個方法只做一步；登入絕不自動重試，整個流程最多按兩次「登 入」。
 * 這個 driver 不跨請求保存狀態：每次重新接回遠端瀏覽器後，一律以網址重新找出目標頁面。
 *
 * 所有失敗都丟 OnboardingDriverError，訊息固定，不夾帶頁面文字、帳密、OTP 或金鑰。
 * 帳密與 OTP 只經由 keyboard.type 輸入，不會出現在任何 evaluate 的腳本內。
 * 標記 UNVERIFIED 的地方是沒有在真實頁面觀察過的行為，首次真實執行後請依實況調整。
 */

export interface DialogLike {
  type(): string;
  message(): string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
}

export interface PageLike {
  url(): string;
  isClosed(): boolean;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  /** Puppeteer 接回 session 時會把分頁套回預設的 800x600，driver 自己統一大小。 */
  setViewport?(viewport: { width: number; height: number }): Promise<void>;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    /** 以輸入法方式直接插入文字（不送 keydown／keyup）。 */
    sendCharacter?(text: string): Promise<void>;
  };
  /** 官網若用原生 alert 顯示錯誤，不處理的話 evaluate 會一直卡住。 */
  on?(event: "dialog", handler: (dialog: DialogLike) => void): unknown;
}

export interface BrowserLike {
  pages(): Promise<PageLike[]>;
  newPage(): Promise<PageLike>;
}

export interface DriverClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DriverTimeouts {
  pollMs: number;
  /** page.goto */
  navigationMs: number;
  /** 按下「登 入」之後等結果 */
  loginMs: number;
  /** 等 ca.sinotrade.com.tw 彈出視窗出現 */
  popupMs: number;
  /** 一般畫面轉場 */
  stepMs: number;
  /** 點選後等狀態更新 */
  settleMs: number;
  /** 憑證安裝到彈出視窗自行關閉 */
  certInstallMs: number;
  /** 按下「確 定」後等「新增成功」視窗 */
  successMs: number;
  /** 單次頁面腳本的上限，避免被原生對話方塊卡住 */
  domCallMs: number;
}

export const DEFAULT_TIMEOUTS: DriverTimeouts = {
  pollMs: 500,
  navigationMs: 30_000,
  // 實測再登入：按下「登 入」後頁面會先轉到管理頁、被彈回登入頁、再轉進管理頁，約 15 到 20 秒，偶爾超過 30 秒。
  loginMs: 60_000,
  popupMs: 15_000,
  stepMs: 15_000,
  settleMs: 3_000,
  certInstallMs: 45_000,
  successMs: 30_000,
  domCallMs: 10_000,
};

export interface DriverOptions {
  clock?: DriverClock;
  timeouts?: Partial<DriverTimeouts>;
}

const API_KEY_URL = "https://www.sinotrade.com.tw/newweb/PythonAPIKey/";
const WWW_HOST = "www.sinotrade.com.tw";
const CA_HOST = "ca.sinotrade.com.tw";
const OSU_HOST = "osu.sinotrade.com.tw";
const CERT_HOSTS = new Set([CA_HOST, OSU_HOST]);
const MAX_TERMS_LENGTH = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

// 元件定位樣式：名稱以寬鬆正規表示式比對，容許官網按鈕文字中的多餘空白。
const ID_FIELD = pattern("身[份分]證字號");
const PASSWORD_FIELD = pattern("密碼");
const LOGIN_BUTTON = loose("登入");
const CONFIRM_BUTTON = loose("確定");
const BIRTHDAY_FIELD = pattern("8\\s*碼西元年生日");
// 寄出之後欄位提示可能變成「請輸入簡訊驗證碼」之類，所以只比對「驗證碼」。
const CODE_FIELD = pattern("驗證碼");
const SEND_CERT = loose("取得驗證碼");
const SEND_KEY = loose("發送驗證碼");
const CONFIRM_KEY_OTP = loose("確認驗證");
const COUNTDOWN_BUTTON = pattern("倒數|\\d+\\s*分\\s*\\d+\\s*秒");
const RADIO_SMS = pattern("^(手機|簡訊)");
const RADIO_EMAIL = pattern("^(e-?mail|電子(信箱|郵件))");
const TERMS_CHECKBOX = pattern("我已閱讀並同意憑證作業條款");
const ADD_KEY_BUTTON = pattern("^\\+?\\s*新增\\s*API\\s*Key$");
const KEY_NAME_FIELD = pattern("API\\s*Key\\s*名稱");
const EXPIRY_FIELD = pattern("到期時間");
const IP_RESTRICTED = pattern("^限制\\s*IP");
const IP_UNLIMITED = pattern("^無限制\\s*IP");
const IP_FIELD = pattern("請輸入\\s*IP\\s*位置");
const ADD_IP = pattern("新增另一組\\s*IP");
const ACCOUNT_BOX = pattern("^(證券|期權|海外)");

const PERMISSION_KEYS: OnboardingPermission[] = [
  "quote",
  "account",
  "trade",
  "prod",
];
const PERMISSION_FIELDS: Record<
  OnboardingPermission,
  { pattern: Pattern; label: string }
> = {
  quote: { pattern: pattern("^行情\\s*[／/]\\s*資料$"), label: "行情／資料" },
  account: { pattern: loose("帳務"), label: "帳務" },
  trade: { pattern: loose("交易"), label: "交易" },
  prod: { pattern: loose("正式環境"), label: "正式環境" },
};

// UNVERIFIED: 以下提示文字的實際措辭都沒有觀察過，只比對「按下按鈕之後新出現」的行。
const RECAPTCHA_TEXT = /請勾選檢核框/;
// 登入結果只看明確指向帳號／密碼的字句：首頁有輪播公告（例如含「失敗」「停用」「異常」的公告），
// 太寬鬆的字樣會把公告誤判成登入失敗，白白啟動 10 分鐘冷卻。
const LOCKED_TEXT =
  /(帳戶|帳號|密碼|身[份分]證).{0,10}(鎖定|凍結|停用)|已被鎖|已鎖定/;
const LOGIN_ERROR_TEXT =
  /(帳戶|帳號|密碼|身[份分]證).{0,12}(錯誤|有誤|不正確|不符)|登入失敗|無法登入|登入異常/;
const OTP_EXPIRED_TEXT = /逾時|過期|失效|超過.{0,6}時間/;
const OTP_INVALID_TEXT = /錯誤|不正確|有誤|不符|失敗|無效/;
const SEND_FAILED_TEXT = /失敗|錯誤|無法|超過|頻繁|次數/;
const BIRTHDAY_ERROR_TEXT = /錯誤|不正確|有誤|不符|失敗|不一致/;
const LOADING_TEXT = /資料加載中/;
const KEY_LIMIT_TEXT = /上限|已達|已滿|無法新增|超過/;
const SUBMIT_ERROR_TEXT = /失敗|錯誤|重複|不符/;

const MSG = {
  missing: (label: string) =>
    `找不到永豐金證券頁面上的「${label}」，頁面可能已改版，已停止。`,
  disabled: (label: string) => `永豐金證券頁面上的「${label}」目前無法操作，已停止。`,
  notFilled: (label: string) =>
    `永豐金證券頁面的「${label}」欄位沒有正確填入，已停止，尚未送出。`,
  badInput: "送出的資料格式不正確。",
  mainGone: "瀏覽器裡找不到永豐金證券的主頁面，請重新開始。",
  popupMissing: "找不到永豐金證券的憑證驗證視窗，已停止。",
  loginSurface: "永豐金證券登入頁沒有如預期載入，已停止，尚未送出登入。",
  loginNoResponse: "按下登入後永豐金證券沒有回應，可能被網站擋下，已停止。",
  recaptcha: "永豐金證券要求勾選檢核框（reCAPTCHA），系統無法代為處理，已停止。",
  badCredentials:
    "永豐金證券回報登入失敗，已停止，不會重試。請先到永豐金證券官網確認帳號密碼，避免連續錯誤導致鎖定。",
  locked: "永豐金證券回報帳號已鎖定，已停止。請先到永豐金證券官網解鎖後再試。",
  secondCert: "重新登入後永豐金證券又要求申請憑證，已停止，系統不會申請第二張憑證。",
  birthday: "永豐金證券沒有接受這個生日，請確認 8 碼西元生日後再送出一次。",
  noProgress: "永豐金證券頁面沒有如預期前進，已停止。",
  noTargets: "讀不到永豐金證券提供的收碼方式，已停止。",
  noTarget: "選擇的收碼目標不存在，請重新整理後再選。",
  sendFailed: "永豐金證券沒有寄出驗證碼，已停止。",
  otpExpired: "驗證碼已過期，請重新取得驗證碼。",
  otpInvalid: "驗證碼不正確，或永豐金證券沒有接受。",
  terms: "讀不到永豐金證券的憑證作業條款，已停止。",
  certNotClosed: "憑證安裝後永豐金證券的彈出視窗沒有自行關閉，已停止。",
  sessionLost: "永豐金證券登入已失效，請重新開始。",
  keyLimit: "永豐金證券 API Key 已達上限，請先到永豐金證券刪除不用的金鑰。",
  noAccountType: "這個帳號沒有你選的任何帳戶類型。",
  formMismatch: "永豐金證券表單狀態與申請方案不一致，已停止，尚未建立金鑰。",
  invalidPlan: "申請方案不符合規則。",
  ambiguousConfirm:
    "永豐金證券頁面上有多個「確 定」按鈕，無法確定該按哪一個，已停止，尚未建立金鑰。",
  // 按下「確 定」之後的失敗：金鑰可能已建立，必須請使用者到官網確認。
  captureFailed:
    "金鑰可能已在永豐金證券建立，但系統無法安全取得。請先到永豐金證券 API 管理頁檢查並刪除剛建立的 API Key，再重新申請。",
} as const;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DomCallTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const realClock: DriverClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

interface FormSnapshot {
  name: string;
  expiresOn: string;
  permissions: Record<OnboardingPermission, boolean>;
  accounts: {
    label: string;
    type: OnboardingAccountType | undefined;
    checked: boolean;
  }[];
  ipMode: "restricted" | "unlimited" | undefined;
  ips: string[];
}

export function createSinopacOnboardingDriver(
  browser: BrowserLike,
  options: DriverOptions = {},
): OnboardingDriver {
  const clock = options.clock ?? realClock;
  const t: DriverTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const dialogMessages: string[] = [];
  const prepared = new WeakSet<object>();

  // ---- 基礎工具 ----------------------------------------------------------

  /** 輪詢到 probe 回傳真值或逾時；換頁造成的暫時性錯誤視為「還沒好」。 */
  async function waitFor<T>(
    probe: () => Promise<T | undefined | false>,
    timeoutMs: number,
  ): Promise<T | undefined> {
    const deadline = clock.now() + timeoutMs;
    for (;;) {
      let value: T | undefined | false;
      try {
        value = await probe();
      } catch (error) {
        if (!isNavigationRace(error) && !(error instanceof DomCallTimeout)) {
          throw error;
        }
        value = undefined;
      }
      if (value) return value;
      if (clock.now() >= deadline) return undefined;
      await clock.sleep(t.pollMs);
    }
  }

  async function dom<T>(page: PageLike, op: DomOp): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await withTimeout(
          page.evaluate(buildDomScript(op)),
          t.domCallMs,
        )) as T;
      } catch (error) {
        if (attempt < 2 && isNavigationRace(error)) {
          await clock.sleep(t.pollMs);
          continue;
        }
        throw error;
      }
    }
  }

  const find = (page: PageLike, role: DomRole, pat: Pattern, nth?: number) =>
    dom<DomHit>(page, { kind: "find", role, ...pat, nth });
  const list = (page: PageLike, role: DomRole, pat: Pattern) =>
    dom<DomList>(page, { kind: "list", role, ...pat });

  /** 每個分頁每個 driver 只處理一次：攔截原生對話方塊、統一桌機視窗大小。 */
  async function prepare(page: PageLike) {
    if (prepared.has(page)) return;
    prepared.add(page);
    page.on?.("dialog", (dialog) => {
      dialogMessages.push(dialog.message());
      // 只代按 alert（以及離開頁面確認）；confirm、prompt 可能是需要使用者決定的動作，一律取消。
      const type = dialog.type();
      const handled =
        type === "alert" || type === "beforeunload"
          ? dialog.accept()
          : dialog.dismiss();
      void handled.catch(() => undefined);
    });
    await Promise.resolve(page.setViewport?.(VIEWPORT)).catch(() => undefined);
  }

  /** 頁面可見文字，加上攔截到的原生對話方塊訊息。 */
  async function readText(page: PageLike): Promise<string> {
    const { text } = await dom<DomText>(page, { kind: "text" });
    return [text, ...dialogMessages].join("\n");
  }

  const hostOf = (page: PageLike) => {
    try {
      return new URL(page.url()).hostname;
    } catch {
      return "";
    }
  };

  async function livePages(): Promise<PageLike[]> {
    const pages = (await browser.pages()).filter((page) => !page.isClosed());
    for (const page of pages) await prepare(page);
    return pages;
  }

  const certPage = async () =>
    (await livePages()).find((page) => hostOf(page) === CA_HOST);
  /** 憑證相關分頁（含安裝中的 osu 頁）是否還開著。 */
  const anyCertPage = async () =>
    (await livePages()).some((page) => CERT_HOSTS.has(hostOf(page)));

  /** 一律以網址找頁面，不假設 pages()[0] 是目標；接回遠端瀏覽器後也重新解析。 */
  async function mainPage(create: boolean): Promise<PageLike> {
    const pages = await livePages();
    const found =
      pages.find((page) => hostOf(page) === WWW_HOST) ??
      pages.find((page) => !CERT_HOSTS.has(hostOf(page)));
    if (found) return found;
    if (create) {
      const page = await browser.newPage();
      await prepare(page);
      return page;
    }
    return fail("ONBOARDING_SESSION_EXPIRED", MSG.mainGone);
  }

  async function requireCertPage(): Promise<PageLike> {
    const page = await waitFor(certPage, t.popupMs);
    return page ?? fail("ONBOARDING_SITE_CHANGED", MSG.popupMissing);
  }

  type ClickHow = "mouse" | "dom";
  /**
   * 永豐金證券 API 管理頁（www，已登入之後）的按鈕對 CDP 滑鼠事件沒有反應（實測：滑鼠點「新增 API Key」後頁面完全沒變），
   * 頁面內的 click 才會動；憑證彈出視窗（ca）與登入框則照常用滑鼠。
   */
  const prefer = (page: PageLike): ClickHow =>
    hostOf(page) === WWW_HOST ? "dom" : "mouse";
  const other = (how: ClickHow): ClickHow => (how === "dom" ? "mouse" : "dom");

  async function press(
    page: PageLike,
    role: DomRole,
    pat: Pattern,
    hit: DomHit,
    how: ClickHow,
    nth?: number,
  ) {
    if (how === "dom") await dom(page, { kind: "click", role, ...pat, nth });
    else await page.mouse.click(hit.x, hit.y);
  }

  async function click(
    page: PageLike,
    role: DomRole,
    pat: Pattern,
    label: string,
    how: ClickHow = prefer(page),
  ): Promise<DomHit> {
    const hit = await find(page, role, pat);
    if (!hit.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing(label));
    if (hit.disabled) fail("ONBOARDING_SITE_CHANGED", MSG.disabled(label));
    await press(page, role, pat, hit, how);
    return hit;
  }

  /** 聚焦欄位並清空後輸入。輸入的文字只走 keyboard，不進任何腳本。 */
  /**
   * 在文字欄位輸入內容。實測永豐金證券 API 管理頁的欄位有時整段鍵盤事件都沒進去（欄位維持空白，同樣的流程
   * 有時成功有時失敗），所以依序換三種輸入法，每一種之後都確認欄位真的收到完整長度才往下：
   * 1. 頁面內聚焦＋鍵盤事件　2. 滑鼠點進去取得真正的焦點＋輸入法插入　3. 頁面內聚焦＋輸入法插入。
   * 輸入的文字只走 keyboard，不進任何腳本。回傳 "done" 代表 options.done 已成立（例如官網在輸入最後一碼時
   * 就自動換了畫面），呼叫端不必再往下輸入。verify=false 用在自己有回讀與備援的欄位（例如原生日期欄）。
   */
  async function typeInto(
    page: PageLike,
    pat: Pattern,
    label: string,
    text: string,
    nth?: number,
    options: { verify?: boolean; done?: () => Promise<boolean> } = {},
  ): Promise<"typed" | "done"> {
    const insert = (value: string) =>
      page.keyboard.sendCharacter
        ? page.keyboard.sendCharacter(value)
        : page.keyboard.type(value);
    let found = false;
    const methods: (() => Promise<boolean>)[] = [
      async () => {
        const focused = await dom<{ found: boolean }>(page, {
          kind: "focus",
          role: "textbox",
          ...pat,
          nth,
        });
        if (!focused.found) return false;
        // focus 會選取全部內容，Backspace 清掉預填值（例如「記住我的身份證字號」）。
        await page.keyboard.press("Backspace");
        await page.keyboard.type(text);
        return true;
      },
      async () => {
        const hit = await find(page, "textbox", pat, nth);
        if (!hit.found) return false;
        await page.mouse.click(hit.x, hit.y);
        for (let i = 0; i < text.length + 2; i++) {
          await page.keyboard.press("Backspace");
        }
        await insert(text);
        return true;
      },
      async () => {
        const focused = await dom<{ found: boolean }>(page, {
          kind: "focus",
          role: "textbox",
          ...pat,
          nth,
        });
        if (!focused.found) return false;
        await page.keyboard.press("Backspace");
        await insert(text);
        return true;
      },
    ];
    for (let attempt = 0; attempt < methods.length; attempt++) {
      if (attempt > 0) await clock.sleep(t.pollMs);
      if (options.done && (await options.done())) return "done";
      if (!(await methods[attempt]!())) continue;
      found = true;
      if (options.verify === false) return "typed";
      const filled = await waitFor(async () => {
        const typed = await dom<DomValue>(page, {
          kind: "value",
          role: "textbox",
          ...pat,
          nth,
        });
        return typed.found && typed.length === text.length ? true : undefined;
      }, 2_000);
      if (filled) return "typed";
    }
    if (options.done && (await options.done())) return "done";
    return fail(
      "ONBOARDING_SITE_CHANGED",
      found ? MSG.notFilled(label) : MSG.missing(label),
    );
  }

  async function readValue(
    page: PageLike,
    pat: Pattern,
    label: string,
    reveal: boolean,
    nth?: number,
  ): Promise<DomValue> {
    const value = await dom<DomValue>(page, {
      kind: "value",
      role: "textbox",
      ...pat,
      nth,
      reveal,
    });
    if (!value.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing(label));
    return value;
  }

  /** 只比對長度，絕不把帳密、OTP 讀回來。 */
  async function expectLength(
    page: PageLike,
    pat: Pattern,
    label: string,
    length: number,
  ) {
    const value = await readValue(page, pat, label, false);
    if (value.length !== length) {
      fail("ONBOARDING_SITE_CHANGED", MSG.notFilled(label));
    }
  }

  async function setChecked(
    page: PageLike,
    role: "checkbox" | "radio",
    pat: Pattern,
    label: string,
    wanted: boolean,
  ) {
    const before = await find(page, role, pat);
    if (!before.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing(label));
    if (before.checked === wanted) return;
    if (before.disabled) fail("ONBOARDING_SITE_CHANGED", MSG.disabled(label));
    const reached = () =>
      waitFor(async () => {
        const hit = await find(page, role, pat);
        return hit.found && hit.checked === wanted ? hit : undefined;
      }, t.settleMs);
    const how = prefer(page);
    await press(page, role, pat, before, how);
    // 沒變就換另一種點法再試一次（點到已選取的項目不會取消，所以重試不會把它切回去）。
    if (!(await reached())) {
      const again = await find(page, role, pat);
      if (again.found && again.checked !== wanted && !again.disabled) {
        await press(page, role, pat, again, other(how));
      }
    }
    if (!(await reached())) fail("ONBOARDING_SITE_CHANGED", MSG.formMismatch);
  }

  // ---- 登入 --------------------------------------------------------------

  // 登入前的頁面骨架也會先顯示「最多可建立 30 個 API Key」「新增 API Key」，之後才轉址到登入頁。
  // 所以還要看到已登入才有的「登出」且沒有「客戶登入」，否則會把尚未登入誤判成已登入，
  // 直接跳過憑證流程（實測：/start 約 1 秒就回 logged_in，下一步 SESSION_EXPIRED）。
  const isManagePage = (page: PageLike, text: string) =>
    /PythonAPIKey/i.test(page.url()) &&
    /登出/.test(text) &&
    !/客戶登入/.test(text) &&
    (/最多可建立\s*\d+\s*個\s*API\s*Key/.test(text) ||
      (/新增\s*API\s*Key/.test(text) && /下載憑證/.test(text)));

  /** 登入前的頁面狀態：登入框或已登入的 API 管理頁。出現勾選式檢核框就停止。 */
  async function reachLoginSurface(
    main: PageLike,
    mode: "first" | "second",
  ): Promise<"login" | "manage"> {
    const look = async () => {
      const text = await readText(main);
      if (isManagePage(main, text)) return "manage" as const;
      if (RECAPTCHA_TEXT.test(text)) {
        fail("ONBOARDING_RECAPTCHA_CHALLENGE", MSG.recaptcha);
      }
      const idBox = await find(main, "textbox", ID_FIELD);
      return idBox.found ? ("login" as const) : undefined;
    };
    const open = () =>
      main.goto(API_KEY_URL, {
        waitUntil: "domcontentloaded",
        timeout: t.navigationMs,
      });
    if (mode === "first") await open();
    let seen = await waitFor(look, mode === "first" ? t.stepMs * 2 : t.stepMs);
    if (seen === "manage" && mode === "first") {
      // 首次載入若一開始就像已登入，稍等一下確認沒有正要轉址。
      await clock.sleep(1_000);
      seen =
        (await look()) === "manage"
          ? "manage"
          : await waitFor(look, t.stepMs * 2);
    }
    if (!seen && mode === "second") {
      // 只是重新載入網址讓登入框回來，不是送出登入。
      await open();
      seen = await waitFor(look, t.stepMs * 2);
    }
    return seen ?? fail("ONBOARDING_BLOCKED_BY_SITE", MSG.loginSurface);
  }

  /** 填入帳密並按「登 入」恰好一次，然後等結果。這裡沒有任何重試。 */
  async function submitLogin(
    main: PageLike,
    credentials: { idNumber: string; password: string },
    mode: "first" | "second",
  ): Promise<OnboardingLoginOutcome> {
    if (!credentials.idNumber || !credentials.password) {
      fail("ONBOARDING_INVALID_REQUEST", MSG.badInput);
    }
    // 憑證安裝後的重新登入前若彈出視窗還在，代表流程不對；不送出任何登入。
    if (mode === "second" && (await anyCertPage())) {
      fail("ONBOARDING_SITE_CHANGED", MSG.secondCert);
    }
    if ((await reachLoginSurface(main, mode)) === "manage") {
      return "logged_in";
    }

    await typeInto(main, ID_FIELD, "身分證字號", credentials.idNumber);
    await typeInto(main, PASSWORD_FIELD, "密碼", credentials.password);
    await expectLength(
      main,
      ID_FIELD,
      "身分證字號",
      credentials.idNumber.length,
    );
    await expectLength(
      main,
      PASSWORD_FIELD,
      "密碼",
      credentials.password.length,
    );

    const baseline = await readText(main);
    await click(main, "button", LOGIN_BUTTON, "登入", "mouse");

    const outcome = await waitFor(async () => {
      if (await certPage()) {
        if (mode === "second") fail("ONBOARDING_SITE_CHANGED", MSG.secondCert);
        return "webca_birthday" as const;
      }
      const text = await readText(main);
      if (isManagePage(main, text)) return "logged_in" as const;
      // 先看勾選式檢核框，再看一般錯誤文字。
      if (RECAPTCHA_TEXT.test(text)) {
        fail("ONBOARDING_RECAPTCHA_CHALLENGE", MSG.recaptcha);
      }
      const fresh = newLines(baseline, text).join("\n");
      if (LOCKED_TEXT.test(fresh))
        fail("ONBOARDING_ACCOUNT_LOCKED", MSG.locked);
      if (LOGIN_ERROR_TEXT.test(fresh)) {
        fail("ONBOARDING_BAD_CREDENTIALS", MSG.badCredentials);
      }
      return undefined;
    }, t.loginMs);
    return outcome ?? fail("ONBOARDING_BLOCKED_BY_SITE", MSG.loginNoResponse);
  }

  async function login(input: { idNumber: string; password: string }) {
    return submitLogin(await mainPage(true), input, "first");
  }

  async function relogin(input: { idNumber: string; password: string }) {
    await submitLogin(await mainPage(false), input, "second");
  }

  // ---- 憑證流程：生日、OTP、條款 -------------------------------------------

  async function submitBirthday(birthday: string) {
    if (!isBirthday8(birthday))
      fail("ONBOARDING_INVALID_REQUEST", MSG.badInput);
    const page = await requireCertPage();
    const box = await waitFor(async () => {
      const hit = await find(page, "textbox", BIRTHDAY_FIELD);
      return hit.found ? hit : undefined;
    }, t.stepMs);
    if (!box) fail("ONBOARDING_SITE_CHANGED", MSG.missing("生日"));
    await typeInto(page, BIRTHDAY_FIELD, "生日", birthday);
    await expectLength(page, BIRTHDAY_FIELD, "生日", birthday.length);
    const baseline = await readText(page);
    await click(page, "button", CONFIRM_BUTTON, "確定");

    const advanced = async () => {
      if (page.isClosed()) fail("ONBOARDING_SITE_CHANGED", MSG.noProgress);
      const { url, text } = await dom<DomText>(page, { kind: "text" });
      // UNVERIFIED: 以網址 BirthCheck 或畫面標題「OTP 驗證」判斷生日已通過。
      if (/BirthCheck/i.test(url) || /OTP\s*驗證/.test(text)) return true;
      if (BIRTHDAY_ERROR_TEXT.test(newLines(baseline, text).join("\n"))) {
        // 契約沒有「生日錯誤」專用代碼；用 INVALID_REQUEST，頁面仍在生日步驟，使用者可修正後再送。
        fail("ONBOARDING_INVALID_REQUEST", MSG.birthday);
      }
      return undefined;
    };
    let moved = await waitFor(advanced, t.settleMs * 2);
    if (!moved) {
      // 憑證頁剛載入、事件還沒綁好時（網站慢的時候實測會發生）第一下可能沒反應：按鈕還在就換另一種點法
      // 再按一次同一個生日，只重試這一次。
      const again = await find(page, "button", CONFIRM_BUTTON);
      if (again.found && !again.disabled) {
        await press(page, "button", CONFIRM_BUTTON, again, other(prefer(page)));
      }
      moved = await waitFor(advanced, t.stepMs);
    }
    if (!moved) fail("ONBOARDING_SITE_CHANGED", MSG.noProgress);
  }

  const otpPage = (purpose: OnboardingOtpPurpose) =>
    purpose === "cert" ? requireCertPage() : mainPage(false);

  const radioFor = (channel: OnboardingOtpChannel) =>
    channel === "sms" ? RADIO_SMS : RADIO_EMAIL;

  /** 選定收碼管道；該管道不存在或被鎖定（倒數期間）且不是目前選取時回傳 false。 */
  async function selectChannel(page: PageLike, channel: OnboardingOtpChannel) {
    const pat = radioFor(channel);
    const radio = await find(page, "radio", pat);
    if (!radio.found) return false;
    if (radio.checked) return true;
    if (radio.disabled) return false;
    const selected = () =>
      waitFor(async () => {
        const hit = await find(page, "radio", pat);
        return hit.found && hit.checked ? hit : undefined;
      }, t.settleMs);
    const how = prefer(page);
    await press(page, "radio", pat, radio, how);
    let done = await selected();
    if (!done) {
      await press(page, "radio", pat, radio, other(how));
      done = await selected();
    }
    if (!done) fail("ONBOARDING_SITE_CHANGED", MSG.missing("收碼管道"));
    return true;
  }

  /**
   * 讀目前管道的下拉選項並遮罩。index 是「通過遮罩篩選後」的順位，
   * optionIndex 是原始選項位置，sendOtp 用同一套篩選再對回去。
   * 身分驗證視窗實測是 Ant Design Select，只顯示目前登記的號碼（dom-kit 把它當唯一選項）；原生 select 仍照舊支援。
   */
  async function readSelectTargets(
    page: PageLike,
    channel: OnboardingOtpChannel,
    waitMs = t.settleMs,
  ): Promise<{ optionIndex: number; target: OnboardingOtpTarget }[]> {
    const read = async () => {
      const opts = await dom<DomOptions>(page, { kind: "options" });
      if (!opts.found) return undefined;
      const targets: { optionIndex: number; target: OnboardingOtpTarget }[] =
        [];
      opts.options.forEach((option, optionIndex) => {
        if (option.disabled) return;
        const target = maskOtpTarget(option.text, channel, targets.length);
        if (target) targets.push({ optionIndex, target });
      });
      return targets.length ? targets : undefined;
    };
    return (await waitFor(read, waitMs)) ?? [];
  }

  async function readOtpTargets(purpose: OnboardingOtpPurpose) {
    const page = await otpPage(purpose);
    const ready = await waitFor(async () => {
      const hit = await find(page, "radio", RADIO_SMS);
      return hit.found ? hit : undefined;
    }, t.stepMs);
    if (!ready) fail("ONBOARDING_SITE_CHANGED", MSG.missing("收碼方式"));

    // UNVERIFIED: 下拉可能只列出目前管道的目標，所以逐一切換管道讀取，最後還原成手機。
    // 號碼清單由頁面非同步載入，手機有時比 Email 晚好幾秒（實測：只等 3 秒讀不到手機），所以每個管道最多等
    // stepMs；讀完 Email 還原成手機之後，手機若仍是空的再補讀一次。
    const targets: OnboardingOtpTarget[] = [];
    for (const channel of ["sms", "email"] as const) {
      if (!(await selectChannel(page, channel))) continue;
      targets.push(
        ...(await readSelectTargets(page, channel, t.stepMs)).map(
          (item) => item.target,
        ),
      );
    }
    await selectChannel(page, "sms");
    if (!targets.some((target) => target.channel === "sms")) {
      const late = await readSelectTargets(page, "sms", t.settleMs);
      targets.unshift(...late.map((item) => item.target));
    }
    if (targets.length === 0) fail("ONBOARDING_SITE_CHANGED", MSG.noTargets);
    return targets;
  }

  async function sendOtp(
    purpose: OnboardingOtpPurpose,
    channel: OnboardingOtpChannel,
    targetIndex: number,
  ) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
      fail("ONBOARDING_INVALID_REQUEST", MSG.badInput);
    }
    const page = await otpPage(purpose);
    if (!(await selectChannel(page, channel))) {
      fail("ONBOARDING_SITE_CHANGED", MSG.missing("收碼管道"));
    }
    const chosen = (await readSelectTargets(page, channel))[targetIndex];
    if (!chosen) fail("ONBOARDING_INVALID_REQUEST", MSG.noTarget);
    const picked = await dom<DomOptions>(page, {
      kind: "pick",
      index: chosen.optionIndex,
    });
    if (!picked.found || picked.selected !== chosen.optionIndex) {
      fail("ONBOARDING_SITE_CHANGED", MSG.missing("收碼目標"));
    }

    const baseline = await readText(page);
    const sendLabel = purpose === "cert" ? "取得驗證碼" : "發送驗證碼";
    await click(
      page,
      "button",
      purpose === "cert" ? SEND_CERT : SEND_KEY,
      sendLabel,
    );

    const sentProbe = async () => {
      const countdown = await find(page, "button", COUNTDOWN_BUTTON);
      if (countdown.found) {
        // 「倒數4分57秒」「4分55秒」；解析失敗退回 300 秒。
        return { expiresInSeconds: parseCountdownSeconds(countdown.text) };
      }
      if (purpose === "cert") {
        // UNVERIFIED: 取得驗證碼後才會出現「請輸入驗證碼」欄位；沒讀到倒數時用它判斷已寄出。
        const code = await find(page, "textbox", CODE_FIELD);
        if (code.found) return { expiresInSeconds: 300 };
      }
      const fresh = newLines(baseline, await readText(page)).join("\n");
      if (SEND_FAILED_TEXT.test(fresh)) {
        fail("ONBOARDING_BLOCKED_BY_SITE", MSG.sendFailed);
      }
      return undefined;
    };
    let sent = await waitFor(sentProbe, t.settleMs * 2);
    if (!sent) {
      // 沒有出現倒數：若「發送／取得驗證碼」仍然可按，換另一種點法再試一次；
      // 已經寄出的話按鈕會變成倒數，不會重複寄送。
      const sendPattern = purpose === "cert" ? SEND_CERT : SEND_KEY;
      const again = await find(page, "button", sendPattern);
      if (again.found && !again.disabled) {
        await press(page, "button", sendPattern, again, other(prefer(page)));
      }
      sent = await waitFor(sentProbe, t.stepMs);
    }
    return sent ?? fail("ONBOARDING_BLOCKED_BY_SITE", MSG.sendFailed);
  }

  async function submitOtp(purpose: OnboardingOtpPurpose, code: string) {
    // 與路由、前端相同的規則（4 到 12 個英數字），三處一致才不會在驗證碼已耗用後才被 driver 拒絕。
    if (!/^[0-9A-Za-z]{4,12}$/.test(code)) {
      fail("ONBOARDING_INVALID_REQUEST", MSG.badInput);
    }
    const page = await otpPage(purpose);
    const sendPattern = purpose === "cert" ? SEND_CERT : SEND_KEY;
    const countdown = await find(page, "button", COUNTDOWN_BUTTON);
    const send = await find(page, "button", sendPattern);
    // UNVERIFIED: 倒數結束後「發送／取得驗證碼」會恢復可按，視為驗證碼已過期。
    if (!countdown.found && send.found && !send.disabled) {
      fail("ONBOARDING_OTP_EXPIRED", MSG.otpExpired);
    }

    // 官網可能在輸入最後一碼時就自動送出驗證並換成下一個畫面（欄位隨之消失），所以先看新表單是否已出現。
    const nextShown = async () =>
      purpose === "key" && (await find(page, "textbox", KEY_NAME_FIELD)).found;
    // 輸入驗證碼（輸入法備援與回讀確認都在 typeInto 裡）；官網若已自動換畫面就不用再往下。
    const typedCode = await typeInto(
      page,
      CODE_FIELD,
      "驗證碼",
      code,
      undefined,
      {
        done: nextShown,
      },
    );
    if (typedCode === "done") return;
    const baseline = await readText(page);
    const confirm = purpose === "cert" ? CONFIRM_BUTTON : CONFIRM_KEY_OTP;
    const confirmLabel = purpose === "cert" ? "確定" : "確認驗證";
    // 「確認驗證」在輸入驗證碼之前是 disabled，等它啟用。
    const button = await waitFor(async () => {
      // 讀回之後官網才自動換畫面（欄位與按鈕一起消失）：已經通過，不用再按。
      if (await nextShown()) return "next" as const;
      const hit = await find(page, "button", confirm);
      return hit.found && !hit.disabled ? hit : undefined;
    }, t.settleMs);
    if (button === "next") return;
    if (!button) fail("ONBOARDING_SITE_CHANGED", MSG.missing(confirmLabel));
    // 按下前最後再看一次，避免對已自動送出的驗證碼多按一次「確認驗證」。
    if (await nextShown()) return;
    await press(page, "button", confirm, button, prefer(page));

    const passed = await waitFor(async () => {
      if (purpose === "cert") {
        if (page.isClosed()) fail("ONBOARDING_SITE_CHANGED", MSG.noProgress);
        const { url } = await dom<DomText>(page, { kind: "text" });
        const terms = await find(page, "checkbox", TERMS_CHECKBOX);
        if (/OTPRet/i.test(url) || terms.found) return true;
      } else {
        const form = await find(page, "textbox", KEY_NAME_FIELD);
        if (form.found) return true;
      }
      const fresh = newLines(baseline, await readText(page)).join("\n");
      if (OTP_EXPIRED_TEXT.test(fresh)) {
        fail("ONBOARDING_OTP_EXPIRED", MSG.otpExpired);
      }
      if (OTP_INVALID_TEXT.test(fresh)) {
        fail("ONBOARDING_OTP_INVALID", MSG.otpInvalid);
      }
      return undefined;
    }, t.stepMs);
    // UNVERIFIED: 留在 OTP 頁面且沒有任何提示，視為驗證碼不正確。
    if (!passed) fail("ONBOARDING_OTP_INVALID", MSG.otpInvalid);
  }

  async function readTerms() {
    const page = await requireCertPage();
    const box = await waitFor(async () => {
      const hit = await find(page, "checkbox", TERMS_CHECKBOX);
      return hit.found ? hit : undefined;
    }, t.stepMs);
    if (!box) fail("ONBOARDING_SITE_CHANGED", MSG.terms);
    const { text } = await dom<DomText>(page, { kind: "text", scope: "terms" });
    // UNVERIFIED: 以「最深層的可捲動元素」當條款框；條款全文也可能含個資，先遮罩。
    const cleaned = scrubText(tidyLines(text));
    if (cleaned.length < 50) fail("ONBOARDING_SITE_CHANGED", MSG.terms);
    return cleaned.slice(0, MAX_TERMS_LENGTH);
  }

  /** 呼叫前，我們的畫面已由使用者本人勾選同意。 */
  async function acceptTerms() {
    const page = await requireCertPage();
    const box = await waitFor(async () => {
      const hit = await find(page, "checkbox", TERMS_CHECKBOX);
      return hit.found ? hit : undefined;
    }, t.stepMs);
    if (!box) fail("ONBOARDING_SITE_CHANGED", MSG.missing("憑證作業條款"));
    await setChecked(page, "checkbox", TERMS_CHECKBOX, "憑證作業條款", true);
    await click(page, "button", CONFIRM_BUTTON, "確定");

    // 確定後彈出視窗會依序載入多個網域的 webcaDepEx.html（ezfund、opac、bond、osu……每次順序不同）
    // 把憑證裝進各網域，完成後自行關閉。要等到只剩主頁才往下：憑證還在安裝時就開始操作主頁，
    // 實測有一次兩個分頁同時失去回應、整個流程卡了三分鐘。
    const closed = await waitFor(async () => {
      const pages = await livePages();
      return pages.every((p) => hostOf(p) === WWW_HOST) ? true : undefined;
    }, t.certInstallMs);
    if (!closed) fail("ONBOARDING_SITE_CHANGED", MSG.certNotClosed);
    await mainPage(false);
  }

  // ---- 建立 API Key --------------------------------------------------------

  async function openKeyIdentityDialog() {
    const main = await mainPage(false);
    // 管理頁剛載入時還在讀取金鑰清單（「資料加載中…」），這時按「新增 API Key」可能沒有反應；等它載完再按。
    await waitFor(async () => {
      const text = await readText(main);
      return LOADING_TEXT.test(text) ? undefined : true;
    }, t.stepMs);
    const baseline = await readText(main);
    if (!isManagePage(main, baseline)) {
      const idBox = await find(main, "textbox", ID_FIELD);
      fail(
        idBox.found ? "ONBOARDING_SESSION_EXPIRED" : "ONBOARDING_SITE_CHANGED",
        idBox.found ? MSG.sessionLost : MSG.noProgress,
      );
    }
    // 永豐金證券的「新增 API Key」對 CDP 滑鼠事件沒有反應（實測：滑鼠點擊後頁面完全沒變），頁面內的 click 才會
    // 開啟身分驗證，所以先用頁面內的 click；沒有出現再退回滑鼠點擊，各只做一次。
    const addKey = await find(main, "button", ADD_KEY_BUTTON);
    if (!addKey.found)
      fail("ONBOARDING_SITE_CHANGED", MSG.missing("新增 API Key"));
    if (addKey.disabled) {
      fail("ONBOARDING_SITE_CHANGED", MSG.disabled("新增 API Key"));
    }
    await dom(main, { kind: "click", role: "button", ...ADD_KEY_BUTTON });
    const dialogOpened = async () => {
      const send = await find(main, "button", SEND_KEY);
      if (send.found) return true;
      // UNVERIFIED: 達 30 組上限時的畫面沒有觀察過；只看按下之後新出現的提示行。
      const fresh = newLines(baseline, await readText(main)).join("\n");
      if (KEY_LIMIT_TEXT.test(fresh)) {
        fail("ONBOARDING_KEY_LIMIT_REACHED", MSG.keyLimit);
      }
      return undefined;
    };
    let opened = await waitFor(dialogOpened, t.settleMs * 2);
    if (!opened) {
      // 按鈕若仍然可點（沒被對話方塊遮罩蓋住）就改用滑鼠點一次。
      const again = await find(main, "button", ADD_KEY_BUTTON);
      if (again.found && !again.disabled) {
        await main.mouse.click(again.x, again.y);
      }
      opened = await waitFor(dialogOpened, t.stepMs);
    }
    if (!opened) fail("ONBOARDING_SITE_CHANGED", MSG.noProgress);
  }

  async function fillExpiry(page: PageLike, expiresOn: string) {
    const current = async () =>
      normalizeDate(
        (await readValue(page, EXPIRY_FIELD, "到期時間", true)).value ?? "",
      );
    if ((await current()) === expiresOn) return;
    await typeInto(page, EXPIRY_FIELD, "到期時間", expiresOn, undefined, {
      verify: false,
    });
    await page.keyboard.press("Tab");
    if ((await current()) === expiresOn) return;
    // UNVERIFIED: 備援：直接設定欄位值並觸發事件，日期元件未必吃這一套；最終仍由表單回讀把關。
    await dom(page, {
      kind: "set",
      role: "textbox",
      ...EXPIRY_FIELD,
      value: expiresOn,
    });
  }

  /**
   * 只勾方案要、且表單上確實有的帳戶類型；表單上沒有的類型（這個帳號沒有該類帳戶）直接略過。
   * 一個都沒有才停止。回傳實際勾選的類型，表單回讀以它為準。
   */
  async function setAccounts(
    page: PageLike,
    types: OnboardingAccountType[],
  ): Promise<OnboardingAccountType[]> {
    const first = await list(page, "checkbox", ACCOUNT_BOX);
    if (!first.found || first.items.length === 0) {
      fail("ONBOARDING_SITE_CHANGED", MSG.missing("帳戶"));
    }
    const effective = types.filter((type) =>
      first.items.some((item) => accountTypeOf(item.label) === type),
    );
    if (effective.length === 0) {
      fail("ONBOARDING_NO_ACCOUNT_TYPE", MSG.noAccountType);
    }
    for (let index = 0; index < first.items.length; index++) {
      // 每勾一次就重讀，狀態與座標以最新為準。
      const item = (await list(page, "checkbox", ACCOUNT_BOX)).items[index];
      if (!item) break;
      const type = accountTypeOf(item.label);
      const wanted = type !== undefined && effective.includes(type);
      if (item.checked === wanted) continue;
      const hit = await find(page, "checkbox", ACCOUNT_BOX, index);
      if (!hit.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing("帳戶"));
      await press(page, "checkbox", ACCOUNT_BOX, hit, prefer(page), index);
    }
    return effective;
  }

  async function setIp(page: PageLike, ip: OnboardingPlan["ip"]) {
    const restricted = ip.mode === "restricted";
    await setChecked(
      page,
      "radio",
      restricted ? IP_RESTRICTED : IP_UNLIMITED,
      restricted ? "限制 IP" : "無限制 IP",
      true,
    );
    if (!restricted) return;
    for (let index = 0; index < ip.addresses.length; index++) {
      if ((await list(page, "textbox", IP_FIELD)).items.length <= index) {
        await click(page, "text", ADD_IP, "+ 新增另一組 IP");
        const grown = await waitFor(async () => {
          return (await list(page, "textbox", IP_FIELD)).items.length > index
            ? true
            : undefined;
        }, t.settleMs);
        if (!grown) fail("ONBOARDING_SITE_CHANGED", MSG.missing("IP 位置"));
      }
      await typeInto(
        page,
        IP_FIELD,
        "IP 位置",
        ip.addresses[index]!.trim(),
        index,
      );
    }
  }

  async function readForm(page: PageLike): Promise<FormSnapshot> {
    const name =
      (await readValue(page, KEY_NAME_FIELD, "API Key 名稱", true)).value ?? "";
    const expiresOn = normalizeDate(
      (await readValue(page, EXPIRY_FIELD, "到期時間", true)).value ?? "",
    );
    const permissions = {} as Record<OnboardingPermission, boolean>;
    for (const key of PERMISSION_KEYS) {
      const field = PERMISSION_FIELDS[key];
      const hit = await find(page, "checkbox", field.pattern);
      if (!hit.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing(field.label));
      permissions[key] = hit.checked;
    }
    const accounts = (await list(page, "checkbox", ACCOUNT_BOX)).items.map(
      (item) => ({
        label: item.label,
        type: accountTypeOf(item.label),
        checked: item.checked,
      }),
    );
    const restricted = await find(page, "radio", IP_RESTRICTED);
    const unlimited = await find(page, "radio", IP_UNLIMITED);
    const ipMode =
      unlimited.found && unlimited.checked
        ? ("unlimited" as const)
        : restricted.found && restricted.checked
          ? ("restricted" as const)
          : undefined;
    const ips: string[] = [];
    const count = (await list(page, "textbox", IP_FIELD)).items.length;
    for (let index = 0; index < count; index++) {
      const value =
        (await readValue(page, IP_FIELD, "IP 位置", true, index)).value ?? "";
      if (value.trim()) ips.push(value.trim());
    }
    return { name, expiresOn, permissions, accounts, ipMode, ips };
  }

  /**
   * 表單回讀必須與方案完全一致，否則在按下「確 定」之前就停止。
   * plan.accountTypes 是 setAccounts 實際勾選的類型（已略過表單上沒有的類型）。
   */
  function verifyForm(form: FormSnapshot, plan: OnboardingPlan) {
    const wantedTypes = new Set(plan.accountTypes);
    const sameIps =
      JSON.stringify([...form.ips].sort()) ===
      JSON.stringify(plan.ip.addresses.map((address) => address.trim()).sort());
    const ok =
      form.name === plan.name.trim() &&
      form.expiresOn === plan.expiresOn &&
      PERMISSION_KEYS.every(
        (key) => form.permissions[key] === plan.permissions[key],
      ) &&
      form.accounts.length > 0 &&
      form.accounts.every(
        (account) =>
          account.type !== undefined &&
          account.checked === wantedTypes.has(account.type),
      ) &&
      [...wantedTypes].every((type) =>
        form.accounts.some((account) => account.type === type),
      ) &&
      form.ipMode === plan.ip.mode &&
      (plan.ip.mode === "unlimited" || sameIps);
    if (!ok) fail("ONBOARDING_SITE_CHANGED", MSG.formMismatch);
  }

  async function createKey(plan: OnboardingPlan) {
    // 方案欄位在這裡再檢查一次；driver 不信任呼叫端已檢查過。
    if (Object.keys(validateOnboardingPlan(plan)).length > 0) {
      fail("ONBOARDING_INVALID_REQUEST", MSG.invalidPlan);
    }
    const main = await mainPage(false);
    const nameBox = await waitFor(async () => {
      const hit = await find(main, "textbox", KEY_NAME_FIELD);
      return hit.found ? hit : undefined;
    }, t.stepMs);
    if (!nameBox)
      fail("ONBOARDING_SITE_CHANGED", MSG.missing("新增 API KEY 表單"));

    await typeInto(main, KEY_NAME_FIELD, "API Key 名稱", plan.name.trim());
    await fillExpiry(main, plan.expiresOn);
    for (const key of PERMISSION_KEYS) {
      const field = PERMISSION_FIELDS[key];
      await setChecked(
        main,
        "checkbox",
        field.pattern,
        field.label,
        plan.permissions[key],
      );
    }
    const accountTypes = await setAccounts(main, plan.accountTypes);
    await setIp(main, plan.ip);

    const form = await readForm(main);
    verifyForm(form, { ...plan, accountTypes });
    const accountLabels = [
      ...new Set(
        form.accounts
          .filter((account) => account.checked)
          .map((account) => maskAccountLabel(account.label)),
      ),
    ];

    // 「確 定」會真的建立金鑰：可按的必須剛好一個，否則不知道會按到哪一個，在建立之前就停止。
    const submitButtons = await list(main, "button", CONFIRM_BUTTON);
    if (submitButtons.items.length !== 1) {
      fail("ONBOARDING_SITE_CHANGED", MSG.ambiguousConfirm);
    }

    // 從這裡開始，金鑰可能已在永豐金證券建立；任何失敗都要請使用者回官網確認。
    const baseline = await readText(main);
    const submit = await find(main, "button", CONFIRM_BUTTON);
    if (!submit.found) fail("ONBOARDING_SITE_CHANGED", MSG.missing("確 定"));
    if (submit.disabled) fail("ONBOARDING_SITE_CHANGED", MSG.disabled("確 定"));
    let dialogText = "";
    let parsed: { apiKey: string; secretKey: string } | undefined;
    // 固定的 hint 區分成因（不含頁面文字），現場排查才知道是哪一種。
    const captureFail: (hint: string) => never = (hint) => {
      const failure = new OnboardingDriverError(
        "ONBOARDING_KEY_CAPTURE_FAILED",
        MSG.captureFailed,
      );
      failure.diag = { step: "createKey", reason: MSG.captureFailed, hint };
      throw failure;
    };
    try {
      await press(main, "button", CONFIRM_BUTTON, submit, prefer(main));
      const created = await waitFor(async () => {
        const text = await readText(main);
        const at = text.indexOf("新增成功");
        if (at >= 0) {
          // 只取「新增成功」之後的文字，避免誤抓列表中既有金鑰。
          dialogText = text.slice(at, at + 1500);
          return true;
        }
        const fresh = newLines(baseline, text).join("\n");
        if (KEY_LIMIT_TEXT.test(fresh)) {
          fail("ONBOARDING_KEY_LIMIT_REACHED", MSG.keyLimit);
        }
        if (SUBMIT_ERROR_TEXT.test(fresh)) captureFail("submit-error-text");
        return undefined;
      }, t.successMs);
      if (!created) captureFail("no-success-dialog");
      parsed = parseKeySuccessDialog(dialogText);
      if (!parsed) captureFail("unparsable-dialog");
    } catch (error) {
      // 從按下「確 定」起金鑰可能已在永豐金證券建立：除了明確的上限錯誤，任何失敗（連線中斷、逾時、頁面例外）
      // 一律請使用者回官網確認並刪除，不能當成可以重來。
      if (
        error instanceof OnboardingDriverError &&
        (error.code === "ONBOARDING_KEY_LIMIT_REACHED" ||
          error.code === "ONBOARDING_KEY_CAPTURE_FAILED")
      ) {
        throw error;
      }
      const failure = new OnboardingDriverError(
        "ONBOARDING_KEY_CAPTURE_FAILED",
        MSG.captureFailed,
      );
      failure.diag = {
        step: "createKey",
        reason: MSG.captureFailed,
        hint: errorHint(error),
      };
      throw failure;
    }

    // 金鑰已到手；關閉視窗失敗不得影響回傳。
    // 若此時畫面上有多個「確 定」（例如表單的送出鈕仍可按），不點，免得建立第二把沒人看得到的金鑰。
    try {
      const closers = await list(main, "button", CONFIRM_BUTTON);
      if (closers.items.length === 1) {
        const ok = await find(main, "button", CONFIRM_BUTTON);
        if (ok.found && !ok.disabled) {
          await press(main, "button", CONFIRM_BUTTON, ok, prefer(main));
          await waitFor(async () => {
            const { text } = await dom<DomText>(main, { kind: "text" });
            return text.includes("新增成功") ? undefined : true;
          }, t.settleMs);
        }
      }
    } catch {
      // 忽略：視窗留在遠端瀏覽器，session 結束時一併關閉。
    }
    return {
      apiKey: parsed.apiKey,
      secretKey: parsed.secretKey,
      accountLabels,
    };
  }

  // 錯誤邊界：driver 外只會看到固定訊息的 OnboardingDriverError。
  // 另附 diag（步驟名稱、固定訊息與 errorHint）供 service 記錄，不含頁面文字、帳密、OTP 或金鑰。
  const guard =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        const failure = toDriverError(error);
        failure.diag ??= {
          step: name,
          reason: failure.message,
          hint: errorHint(error),
        };
        throw failure;
      }
    };

  return {
    login: guard("login", login),
    submitBirthday: guard("submitBirthday", submitBirthday),
    readOtpTargets: guard("readOtpTargets", readOtpTargets),
    sendOtp: guard("sendOtp", sendOtp),
    submitOtp: guard("submitOtp", submitOtp),
    readTerms: guard("readTerms", readTerms),
    acceptTerms: guard("acceptTerms", acceptTerms),
    relogin: guard("relogin", relogin),
    openKeyIdentityDialog: guard(
      "openKeyIdentityDialog",
      openKeyIdentityDialog,
    ),
    createKey: guard("createKey", createKey),
  };
}
