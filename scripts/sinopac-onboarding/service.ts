// 申請流程的狀態機（狀態放在記憶體 repository）。
// 刻意沒有冷卻：任何失敗都不自動重試，登入最多 2 次。
import { randomUUID } from "node:crypto";
import {
  isBirthday8,
  validateOnboardingPlan,
  type OnboardingErrorCode,
  type OnboardingKeyResponse,
  type OnboardingOtpChannel,
  type OnboardingOtpPurpose,
  type OnboardingPermission,
  type OnboardingPlan,
  type OnboardingResult,
  type OnboardingStatus,
} from "../../src/lib/sinopac-onboarding/types";
import {
  OnboardingDriverError,
  type OnboardingBrowserGateway,
  type OnboardingDriver,
  type OnboardingSession,
} from "./driver";

const KEEP_ALIVE_MS = 600_000;
const SESSION_TTL_MS = 10 * 60_000;
const SESSION_MAX_MS = 30 * 60_000;
const BUSY_LEASE_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAX_LOGINS = 2;

const PERMISSION_ORDER: OnboardingPermission[] = [
  "quote",
  "account",
  "trade",
  "prod",
];

const MESSAGES: Record<OnboardingErrorCode, string> = {
  ONBOARDING_BAD_CREDENTIALS:
    "帳號或密碼錯誤。為避免帳戶被鎖定，已停止且不會自動重試；請先到永豐金證券官網確認密碼。",
  ONBOARDING_ACCOUNT_LOCKED:
    "永豐金證券帳戶已被鎖定或暫停登入，已停止。請依永豐金證券官網指示解除後再試。",
  ONBOARDING_OTP_INVALID:
    "驗證碼不正確。為避免重複嘗試，已停止這次申請，請重新開始。",
  ONBOARDING_OTP_EXPIRED: "驗證碼已過期，請重新寄送一組。",
  ONBOARDING_SESSION_EXPIRED:
    "連線已逾時或已結束，本機瀏覽器工作階段已關閉。請重新開始，並重新輸入密碼。",
  ONBOARDING_BROWSER_BUSY: "已有進行中的申請，請稍候或先取消目前的申請。",
  ONBOARDING_BLOCKED_BY_SITE:
    "永豐金證券網站拒絕了這次自動登入，已停止。請改到永豐金證券官網手動申請。",
  ONBOARDING_RECAPTCHA_CHALLENGE:
    "永豐金證券網站要求勾選檢核框，需要本人處理，已停止。請改到永豐金證券官網手動申請。",
  ONBOARDING_QUOTA_EXHAUSTED:
    "本機瀏覽器暫時無法啟動或已達系統限制，請稍後再試。",
  ONBOARDING_KEY_LIMIT_REACHED:
    "API Key 已達 30 組上限。請先到永豐金證券官網刪除不用的 Key 後再試。",
  ONBOARDING_SITE_CHANGED:
    "永豐金證券網頁與預期不同或發生未預期的錯誤，已停止且未再做任何操作。請改到永豐金證券官網手動申請。",
  ONBOARDING_KEY_CAPTURE_FAILED:
    "API Key 可能已在永豐金證券建立，但系統沒能保存。請到永豐金證券官網刪除該組 Key 後重新申請。",
  ONBOARDING_INVALID_REQUEST: "送出的資料不正確，請檢查後再試。",
  ONBOARDING_INVALID_STATE: "目前的步驟無法執行這個操作，請重新整理後再試。",
  ONBOARDING_FORBIDDEN_ORIGIN: "拒絕來自其他網站的請求。",
  ONBOARDING_NO_ACCOUNT_TYPE:
    "永豐金證券的表單上沒有你勾選的任何帳戶類型，已停止且未建立金鑰。請重新開始，只勾選實際擁有的帳戶。",
};

const STATUS: Record<OnboardingErrorCode, number> = {
  ONBOARDING_BAD_CREDENTIALS: 400,
  ONBOARDING_ACCOUNT_LOCKED: 429,
  ONBOARDING_OTP_INVALID: 400,
  ONBOARDING_OTP_EXPIRED: 409,
  ONBOARDING_SESSION_EXPIRED: 409,
  ONBOARDING_BROWSER_BUSY: 409,
  ONBOARDING_BLOCKED_BY_SITE: 502,
  ONBOARDING_RECAPTCHA_CHALLENGE: 502,
  ONBOARDING_QUOTA_EXHAUSTED: 429,
  ONBOARDING_KEY_LIMIT_REACHED: 409,
  ONBOARDING_SITE_CHANGED: 502,
  ONBOARDING_KEY_CAPTURE_FAILED: 502,
  ONBOARDING_INVALID_REQUEST: 400,
  ONBOARDING_INVALID_STATE: 409,
  ONBOARDING_FORBIDDEN_ORIGIN: 403,
  ONBOARDING_NO_ACCOUNT_TYPE: 400,
};

/** 對外唯一的錯誤型別。message 一律來自上面的固定表，絕不夾帶原始錯誤或輸入。 */
export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingErrorCode,
    readonly status: number,
    message: string = MESSAGES[code],
    readonly retryAfterSeconds?: number,
    /** 併入錯誤本體的固定欄位（方案欄位錯誤；金鑰擷取失敗時的一次性回傳）。 */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

function refuse(code: OnboardingErrorCode) {
  return new OnboardingError(code, STATUS[code]);
}

function toOnboardingError(
  error: unknown,
  fallback: OnboardingErrorCode,
): OnboardingError {
  if (error instanceof OnboardingError) return error;
  if (error instanceof OnboardingDriverError) {
    return new OnboardingError(
      error.code,
      STATUS[error.code],
      undefined,
      error.retryAfterSeconds,
    );
  }
  return refuse(fallback);
}

// 狀態只放已遮罩的收碼目標、條款、方案、倒數與計數；絕不放帳密、生日、OTP、金鑰。
export interface SessionState {
  /** 本次流程的識別碼；清理與釋放鎖都以它比對，避免誤清別次流程。 */
  flowId: string;
  /** gateway 的 BrowserContext session id；launch 完成前為空字串。 */
  sessionId: string;
  step:
    | "login"
    | "birthday"
    | "cert_otp"
    | "terms"
    | "relogin"
    | "plan"
    | "key_otp"
    | "creating";
  startedAt: string;
  /** 本機瀏覽器工作階段被丟棄的時間（閒置期限，每個成功步驟後順延）。 */
  expiresAt: string;
  /** 步驟進行中的租約；租約內的第二個請求一律回 BROWSER_BUSY。 */
  lock: { id: string; until: string } | null;
  /** 已送出的登入次數；上限 2（首次登入與憑證安裝後重新登入）。 */
  logins: number;
  otp: {
    purpose: OnboardingOtpPurpose;
    channel: OnboardingOtpChannel;
    targetIndex: number;
    expiresAt: string;
  } | null;
  otpTargets: OnboardingStatus["otpTargets"];
  termsText: string | null;
  plan: OnboardingPlan | null;
  /** 已開始建立金鑰；請求若中途中斷，不得再建第二組（Secret 可能已遺失）。 */
  keyRequested?: boolean;
}

export interface PersistedOnboarding {
  session?: SessionState;
}

export interface OnboardingRepository {
  read(): Promise<PersistedOnboarding | null>;
  /**
   * 讀目前狀態、交給 mutate 計算下一個狀態並寫回（mutate 必須同步，整段讀改寫不可被打斷）。
   * mutate 回傳 undefined 表示不變更；throw 表示拒絕（不寫入、錯誤原樣往上拋）。
   */
  update(
    mutate: (
      current: PersistedOnboarding | null,
    ) => PersistedOnboarding | null | undefined,
  ): Promise<PersistedOnboarding | null>;
}

const normalize = (value: PersistedOnboarding | null | undefined) =>
  value?.session ? value : null;

/** 單一本機使用者：JS 單執行緒下 mutate 同步跑完才輪到下一個呼叫，不需要 CAS 重試。 */
export function createInMemoryOnboardingRepository(): OnboardingRepository {
  let store: PersistedOnboarding | null = null;
  return {
    async read() {
      return store;
    },
    async update(mutate) {
      const next = mutate(store);
      if (next === undefined) return store;
      store = normalize(next);
      return store;
    },
  };
}

type StepName = SessionState["step"];
type StepPatch = Partial<
  Pick<
    SessionState,
    | "step"
    | "sessionId"
    | "otp"
    | "otpTargets"
    | "termsText"
    | "plan"
    | "logins"
    | "keyRequested"
  >
>;
/** claim 時在租約內重新驗證請求；throw OnboardingError 表示拒絕（不寫入、不終止流程）。 */
type Prepare = (session: SessionState, nowMs: number) => StepPatch | void;

export interface OnboardingDeps {
  gateway: OnboardingBrowserGateway;
  /** 把新建的金鑰寫入本機設定（例如 vite plugin 的 saveKeysToEnv 寫入 .env）。 */
  saveCredentials(keys: { apiKey: string; secretKey: string }): Promise<void>;
  /** 預設為每個 service 各自一份記憶體 repository；要跨重建共用或測試檢視狀態時才注入。 */
  repository?: OnboardingRepository;
  now?: () => Date;
}

const IDLE_STATUS: OnboardingStatus = {
  step: "login",
  expiresAt: null,
  otp: null,
  otpTargets: [],
  termsText: null,
  result: null,
  error: null,
};

const iso = (ms: number) => new Date(ms).toISOString();
/** 步驟進行中（租約有效）的 session 不算逾時：避免輪詢或重新整理把執行中的瀏覽器關掉。 */
const isLocked = (session: SessionState, nowMs: number) =>
  session.lock !== null && Date.parse(session.lock.until) > nowMs;
const isExpired = (session: SessionState, nowMs: number) =>
  Date.parse(session.expiresAt) <= nowMs && !isLocked(session, nowMs);
const slide = (session: SessionState, nowMs: number) =>
  iso(
    Math.min(
      nowMs + SESSION_TTL_MS,
      Date.parse(session.startedAt) + SESSION_MAX_MS,
    ),
  );

function toStatus(current: PersistedOnboarding | null): OnboardingStatus {
  const session = current?.session;
  if (session) {
    return {
      ...IDLE_STATUS,
      step: session.step,
      expiresAt: session.expiresAt,
      otp: session.otp,
      otpTargets: session.otpTargets,
      termsText: session.step === "terms" ? session.termsText : null,
      // 還原到 creating 的畫面靠它分辨「還沒送出建立請求」與「建立中／結果遺失」。
      ...(session.step === "creating"
        ? { keyRequested: session.keyRequested === true }
        : {}),
    };
  }
  return IDLE_STATUS;
}

function otpLifetimeMs(seconds: number) {
  const whole = Number.isFinite(seconds) ? Math.floor(seconds) : 300;
  return Math.min(Math.max(whole, 1), 600) * 1000;
}

function normalizePlan(plan: OnboardingPlan): OnboardingPlan {
  return {
    ...plan,
    name: plan.name.trim(),
    accountTypes: [...new Set(plan.accountTypes)],
    ip: {
      mode: plan.ip.mode,
      addresses:
        plan.ip.mode === "restricted"
          ? [...new Set(plan.ip.addresses.map((address) => address.trim()))]
          : [],
    },
  };
}

async function bestEffort(task: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(reject, CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 清理盡力而為；失敗時本機瀏覽器會在閒置逾時後自行關閉（見 gateway.ts）。
  } finally {
    clearTimeout(timer);
  }
}

function must(current: PersistedOnboarding | null) {
  if (!current?.session) throw refuse("ONBOARDING_SESSION_EXPIRED");
  return current.session;
}

export function createOnboardingService(deps: OnboardingDeps) {
  const { gateway } = deps;
  const repository = deps.repository ?? createInMemoryOnboardingRepository();
  const clock = deps.now ?? (() => new Date());
  const nowMs = () => clock().getTime();

  async function launch() {
    try {
      return await gateway.launch({ keepAliveMs: KEEP_ALIVE_MS });
    } catch (error) {
      throw toOnboardingError(error, "ONBOARDING_BROWSER_BUSY");
    }
  }

  async function connect(sessionId: string) {
    try {
      return await gateway.connect(sessionId);
    } catch (error) {
      throw toOnboardingError(error, "ONBOARDING_SESSION_EXPIRED");
    }
  }

  async function closeRemote(sessionId: string, live?: OnboardingSession) {
    if (!live && !sessionId) return;
    await bestEffort(async () =>
      (live ?? (await gateway.connect(sessionId))).close(),
    );
  }

  /** 只清同一個 flow 的 session；別次流程或已被清掉時不動。 */
  function clearSession(session: SessionState) {
    return repository.update((current) =>
      current?.session?.flowId === session.flowId
        ? { ...current, session: undefined }
        : undefined,
    );
  }

  /** 逾時或被取消的流程：關瀏覽器、清掉 session。 */
  async function discard(session: SessionState) {
    await closeRemote(session.sessionId);
    return clearSession(session);
  }

  /** 任何失敗的收尾：close、清 session。永遠回傳要丟出的固定錯誤。 */
  async function fail(
    session: SessionState,
    live: OnboardingSession | undefined,
    error: unknown,
    fallback: OnboardingErrorCode,
  ) {
    const failure = toOnboardingError(error, fallback);
    // 只記錄代碼、步驟與真實 driver 附上的固定診斷（diag）；不記錄原始錯誤、頁面文字或任何輸入。
    console.warn(
      JSON.stringify({
        event: "sinopac_onboarding_stopped",
        code: failure.code,
        step: session.step,
        diag: error instanceof OnboardingDriverError ? error.diag : undefined,
      }),
    );
    await closeRemote(session.sessionId, live);
    // 只清同一個 flow 的 session；別次流程的 session 不動。
    await clearSession(session);
    return failure;
  }

  async function claim(
    allowed: readonly StepName[],
    prepare?: Prepare,
  ): Promise<SessionState> {
    const now = nowMs();
    const existing = (await repository.read())?.session;
    if (existing && isExpired(existing, now)) {
      await discard(existing);
      throw refuse("ONBOARDING_SESSION_EXPIRED");
    }
    const lock = { id: randomUUID(), until: iso(now + BUSY_LEASE_MS) };
    const next = await repository.update((current) => {
      const session = current?.session;
      if (!session || isExpired(session, now))
        throw refuse("ONBOARDING_SESSION_EXPIRED");
      if (!allowed.includes(session.step))
        throw refuse("ONBOARDING_INVALID_STATE");
      if (isLocked(session, now)) throw refuse("ONBOARDING_BROWSER_BUSY");
      const patch = prepare?.(session, now) ?? {};
      // 期限同時順延，讓倒數涵蓋這一步的執行時間。
      return {
        ...current,
        session: { ...session, ...patch, lock, expiresAt: slide(session, now) },
      };
    });
    return must(next);
  }

  /** 以 flow 與租約比對後寫入步驟結果，並順延閒置期限。租約被取消或搶走時丟 SESSION_EXPIRED。 */
  async function commit(
    claimed: SessionState,
    patch: StepPatch,
    keepLock = false,
  ) {
    const now = nowMs();
    const next = await repository.update((current) => {
      const session = current?.session;
      if (
        !session ||
        session.flowId !== claimed.flowId ||
        session.lock?.id !== claimed.lock?.id
      ) {
        throw refuse("ONBOARDING_SESSION_EXPIRED");
      }
      return {
        ...current,
        session: {
          ...session,
          ...patch,
          lock: keepLock ? session.lock : null,
          expiresAt: slide(session, now),
        },
      };
    });
    return must(next);
  }

  async function runStep(
    allowed: readonly StepName[],
    prepare: Prepare | undefined,
    act: (
      driver: OnboardingDriver,
      session: SessionState,
    ) => Promise<StepPatch>,
  ): Promise<OnboardingStatus> {
    const claimed = await claim(allowed, prepare);
    let live: OnboardingSession | undefined;
    try {
      live = await connect(claimed.sessionId);
      const next = await commit(claimed, await act(live.driver, claimed));
      const attached = live;
      await bestEffort(() => attached.detach());
      return toStatus({ session: next });
    } catch (error) {
      throw await fail(claimed, live, error, "ONBOARDING_SITE_CHANGED");
    }
  }

  async function readTargets(
    driver: OnboardingDriver,
    purpose: OnboardingOtpPurpose,
  ) {
    const targets = await driver.readOtpTargets(purpose);
    // 讀不到任何收碼管道就無法往下，視為頁面改版。
    if (targets.length === 0) throw refuse("ONBOARDING_SITE_CHANGED");
    return targets;
  }

  async function status(): Promise<OnboardingStatus> {
    const now = nowMs();
    const current = await repository.read();
    if (current?.session && isExpired(current.session, now)) {
      // 已送出建立金鑰的請求：金鑰可能已在永豐金證券建立，要提醒使用者回官網確認，不能只說逾時。
      const code: OnboardingErrorCode = current.session.keyRequested
        ? "ONBOARDING_KEY_CAPTURE_FAILED"
        : "ONBOARDING_SESSION_EXPIRED";
      await discard(current.session);
      return {
        ...IDLE_STATUS,
        step: "stopped",
        error: { code, message: MESSAGES[code] },
      };
    }
    return toStatus(current);
  }

  async function start(input: {
    idNumber: string;
    password: string;
  }): Promise<OnboardingStatus> {
    const now = nowMs();
    const stale = (await repository.read())?.session;
    if (stale && isExpired(stale, now)) await discard(stale);

    let session: SessionState = {
      flowId: randomUUID(),
      sessionId: "",
      step: "login",
      startedAt: iso(now),
      expiresAt: iso(now + SESSION_TTL_MS),
      lock: { id: randomUUID(), until: iso(now + BUSY_LEASE_MS) },
      logins: 0,
      otp: null,
      otpTargets: [],
      termsText: null,
      plan: null,
    };
    const claimed = session;
    // 先 claim 再 launch：同時兩個 /start 只有一個能啟動瀏覽器。
    await repository.update((current) => {
      if (current?.session && !isExpired(current.session, now))
        throw refuse("ONBOARDING_BROWSER_BUSY");
      return { session: claimed };
    });

    let remote: OnboardingSession | undefined;
    try {
      remote = await launch();
      // 先把 sessionId 落地，之後即使行程中斷也找得到瀏覽器可清理。
      // logins 在送出登入「之前」就記成 1。
      session = await commit(
        session,
        { sessionId: remote.sessionId, logins: 1 },
        true,
      );
      // UNVERIFIED: 密碼錯誤、reCAPTCHA 勾選與被擋的頁面行為都未實測，
      // 一律由 driver 丟 OnboardingDriverError，這裡只負責停止、不重試。
      const outcome = await remote.driver.login(input);
      session = await commit(session, {
        step: outcome === "webca_birthday" ? "birthday" : "plan",
      });
      const attached = remote;
      await bestEffort(() => attached.detach());
      return toStatus({ session });
    } catch (error) {
      throw await fail(session, remote, error, "ONBOARDING_SITE_CHANGED");
    }
  }

  function birthday(value: string) {
    return runStep(
      ["birthday"],
      (_session, now) => {
        if (!isBirthday8(value, new Date(now)))
          throw refuse("ONBOARDING_INVALID_REQUEST");
      },
      async (driver) => {
        // UNVERIFIED: 生日錯誤時的頁面行為未實測；driver 丟錯即停止，不自動重試。
        await driver.submitBirthday(value);
        return {
          step: "cert_otp",
          otpTargets: await readTargets(driver, "cert"),
        };
      },
    );
  }

  function sendOtp(request: {
    purpose: OnboardingOtpPurpose;
    channel: OnboardingOtpChannel;
    targetIndex: number;
  }) {
    const { purpose, channel, targetIndex } = request;
    return runStep(
      [purpose === "cert" ? "cert_otp" : "key_otp"],
      (session, now) => {
        // 永豐金證券在倒數期間不允許重寄或改管道；超過倒數後才能重寄。
        if (session.otp && Date.parse(session.otp.expiresAt) > now)
          throw refuse("ONBOARDING_INVALID_STATE");
        // 收碼管道只能選快取在狀態裡、逐字取自永豐金證券頁面的那幾個。
        if (
          !session.otpTargets.some(
            (target) =>
              target.channel === channel && target.index === targetIndex,
          )
        ) {
          throw refuse("ONBOARDING_INVALID_REQUEST");
        }
      },
      async (driver) => {
        const { expiresInSeconds } = await driver.sendOtp(
          purpose,
          channel,
          targetIndex,
        );
        return {
          otp: {
            purpose,
            channel,
            targetIndex,
            expiresAt: iso(nowMs() + otpLifetimeMs(expiresInSeconds)),
          },
        };
      },
    );
  }

  function verifyOtp(request: { purpose: OnboardingOtpPurpose; code: string }) {
    const { purpose, code } = request;
    return runStep(
      [purpose === "cert" ? "cert_otp" : "key_otp"],
      (session, now) => {
        if (!session.otp || session.otp.purpose !== purpose)
          throw refuse("ONBOARDING_INVALID_STATE");
        // 超過倒數就不碰瀏覽器，直接要求重寄（session 保留）。
        if (Date.parse(session.otp.expiresAt) <= now)
          throw refuse("ONBOARDING_OTP_EXPIRED");
      },
      async (driver) => {
        // UNVERIFIED: OTP 錯誤時頁面是否允許重輸未實測；fail-safe 為停止整個流程。
        await driver.submitOtp(purpose, code);
        if (purpose === "key")
          return { step: "creating", otp: null, otpTargets: [] };
        const termsText = (await driver.readTerms()).trim();
        if (!termsText) throw refuse("ONBOARDING_SITE_CHANGED");
        return { step: "terms", otp: null, otpTargets: [], termsText };
      },
    );
  }

  function acceptTerms() {
    return runStep(["terms"], undefined, async (driver) => {
      // 路由已要求 accepted:true：使用者在條款畫面本人按下同意，或在這次登入前勾選同意、
      // 且精靈比對頁面條款與登入畫面顯示的全文一致後才代為送出。
      await driver.acceptTerms();
      return { step: "relogin", termsText: null };
    });
  }

  function relogin(input: { idNumber: string; password: string }) {
    return runStep(
      ["relogin"],
      (session) => {
        // 登入次數在 claim 時就先記帳：即使這次請求中途中斷也不會有第 3 次登入。
        if (session.logins >= MAX_LOGINS)
          throw refuse("ONBOARDING_INVALID_STATE");
        return { logins: session.logins + 1 };
      },
      async (driver) => {
        await driver.relogin(input);
        return { step: "plan" };
      },
    );
  }

  function submitPlan(rawPlan: OnboardingPlan) {
    const plan = normalizePlan(rawPlan);
    return runStep(
      ["plan"],
      (_session, now) => {
        const fields = validateOnboardingPlan(plan, new Date(now));
        if (Object.keys(fields).length > 0) {
          throw new OnboardingError(
            "ONBOARDING_INVALID_REQUEST",
            400,
            "方案內容不符合規則，請修正後再送出。",
            undefined,
            { fields },
          );
        }
      },
      async (driver) => {
        // 方案在 OTP 之前定案；實際帳戶清單要等金鑰 OTP 通過、官方表單出現後才讀，
        // 帳戶類型到實際帳戶的對應（含略過這個帳號沒有的類型）由 driver.createKey 完成。
        await driver.openKeyIdentityDialog();
        return {
          step: "key_otp",
          plan,
          otpTargets: await readTargets(driver, "key"),
        };
      },
    );
  }

  /**
   * 建立金鑰並保存。Secret Key 只在永豐金證券的成功視窗出現一次，所以從 driver 回傳
   * 之後的任何路徑都不可以把它弄丟：
   * - 存檔成功：回傳 OnboardingKeyResponse（revealSecret 為 true 才帶 revealed）。
   * - 存檔失敗：丟 ONBOARDING_KEY_CAPTURE_FAILED（HTTP 502），不論 revealSecret 都把
   *   result 與 revealed 放進錯誤本體的 extra，讓使用者自行複製、不必重建 Key。
   */
  async function createKey(
    revealSecret: boolean,
  ): Promise<OnboardingKeyResponse> {
    const claimed = await claim(["creating"], (session) => {
      if (!session.plan) throw refuse("ONBOARDING_INVALID_STATE");
      // 上一次建立請求若中途中斷，Key 可能已在永豐金證券建立而 Secret 已遺失，不可再建第二組。
      if (session.keyRequested) throw refuse("ONBOARDING_KEY_CAPTURE_FAILED");
      return { keyRequested: true };
    }).catch(async (error: unknown) => {
      if (
        error instanceof OnboardingError &&
        error.code === "ONBOARDING_KEY_CAPTURE_FAILED"
      ) {
        const interrupted = (await repository.read())?.session;
        if (interrupted) await discard(interrupted);
      }
      throw error;
    });
    const plan = claimed.plan as OnboardingPlan;
    let live: OnboardingSession | undefined;
    let created: Awaited<ReturnType<OnboardingDriver["createKey"]>>;
    try {
      live = await connect(claimed.sessionId);
      created = await live.driver.createKey(plan);
    } catch (error) {
      throw await fail(claimed, live, error, "ONBOARDING_SITE_CHANGED");
    }

    const { apiKey, secretKey } = created;
    const hasKeys =
      typeof apiKey === "string" &&
      apiKey.length > 0 &&
      typeof secretKey === "string" &&
      secretKey.length > 0;
    const result: OnboardingResult = {
      apiKeyLast4: hasKeys ? apiKey.slice(-4) : "",
      expiresOn: plan.expiresOn,
      permissions: PERMISSION_ORDER.filter((name) => plan.permissions[name]),
      accountLabels: Array.isArray(created.accountLabels)
        ? created.accountLabels.filter((label) => typeof label === "string")
        : [],
    };

    let saved = false;
    try {
      if (hasKeys) {
        await deps.saveCredentials({ apiKey, secretKey });
        saved = true;
      }
    } catch {
      // 不記錄、不轉述原始錯誤，下面統一回 KEY_CAPTURE_FAILED。
    }
    try {
      await closeRemote(claimed.sessionId, live);
      // 收尾：關瀏覽器並清掉本次流程的狀態（saveCredentials 不負責清狀態）。
      await clearSession(claimed);
    } catch {
      // 狀態殘留會在逾時後被清掉，不影響已取得的金鑰回傳。
    }

    if (!saved) {
      // 存檔失敗時不看 revealSecret：這是唯一還拿得到 Secret 的時機，不附上就只能到官網刪掉重建。
      throw new OnboardingError(
        "ONBOARDING_KEY_CAPTURE_FAILED",
        502,
        hasKeys
          ? "API Key 已在永豐金證券建立，但無法儲存到設定。這是唯一一次取得 Secret Key，請立即複製並手動貼到設定頁。"
          : undefined,
        undefined,
        hasKeys ? { result, revealed: { apiKey, secretKey } } : undefined,
      );
    }
    return {
      result,
      revealed: revealSecret ? { apiKey, secretKey } : null,
    };
  }

  async function cancel(): Promise<OnboardingStatus> {
    const now = nowMs();
    let target: SessionState | undefined;
    // 檢查與清除在同一次 update 內完成：建立金鑰的請求進行中不可取消（關掉瀏覽器會讓只出現一次的
    // Secret 消失）；先清掉 session 再關瀏覽器，之後才到的 /key 會在 claim 時拿到 SESSION_EXPIRED，
    // 不會碰到被關掉的瀏覽器。
    const after = await repository.update((current) => {
      const session = current?.session;
      target = session;
      if (!session) return undefined;
      if (session.keyRequested && isLocked(session, now))
        throw refuse("ONBOARDING_BROWSER_BUSY");
      return { ...current, session: undefined };
    });
    if (target) await closeRemote(target.sessionId);
    return toStatus(after);
  }

  return {
    status,
    start,
    birthday,
    sendOtp,
    verifyOtp,
    acceptTerms,
    relogin,
    submitPlan,
    createKey,
    cancel,
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
