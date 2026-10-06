import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_ERROR_CODES } from "../../src/lib/sinopac-onboarding/types";
import { OnboardingDriverError } from "./driver";
import {
  createOnboardingService,
  OnboardingError,
  type OnboardingDeps,
  type OnboardingService,
  type SessionState,
} from "./service";
import {
  createFakeGateway,
  createSpyRepository,
  credentials,
  FAKE_FRAME,
  SENTINEL,
  validPlan,
} from "./service-fakes";

const T0 = Date.UTC(2026, 9, 5, 4, 0, 0);
const minutes = (count: number) => count * 60_000;
const seconds = (count: number) => count * 1_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CERT_SMS = { purpose: "cert", channel: "sms", targetIndex: 0 } as const;
const KEY_SMS = { purpose: "key", channel: "sms", targetIndex: 0 } as const;

// 持久化的 session 只允許這些欄位；新增欄位時要有意識地改這裡，避免帳密之類的東西溜進去。
const SESSION_KEYS = [
  "flowId",
  "sessionId",
  "step",
  "startedAt",
  "expiresAt",
  "lock",
  "logins",
  "otp",
  "otpTargets",
  "termsText",
  "plan",
  "keyRequested",
];

describe("永豐金證券 API Key 申請精靈 service（記憶體 repository + 假瀏覽器）", () => {
  let fake: ReturnType<typeof createFakeGateway>;
  let spy: ReturnType<typeof createSpyRepository>;
  let saved: { apiKey: string; secretKey: string }[];
  let nowMs: number;
  let logged: unknown[][];

  beforeEach(() => {
    fake = createFakeGateway();
    spy = createSpyRepository();
    saved = [];
    nowMs = T0;
    logged = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeService(overrides: Partial<OnboardingDeps> = {}) {
    return createOnboardingService({
      gateway: fake.gateway,
      repository: spy.repository,
      saveCredentials: async (keys) => {
        saved.push(keys);
      },
      now: () => new Date(nowMs),
      ...overrides,
    });
  }

  const persisted = () => spy.read();
  const session = async () => (await spy.read())?.session;

  async function patchSession(patch: Partial<SessionState>) {
    await spy.repository.update((current) => ({
      ...current,
      session: { ...current!.session!, ...patch },
    }));
  }

  function expectNoSentinels(value: unknown, allowed: string[] = []) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of Object.values(SENTINEL)) {
      if (!allowed.includes(secret)) expect(text ?? "").not.toContain(secret);
    }
  }
  const consoleOutput = () =>
    logged
      .map((args) =>
        args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      )
      .join("\n");
  const stoppedLogs = () =>
    logged.map((args) => JSON.parse(args[0] as string) as unknown);

  async function toRelogin(service: OnboardingService) {
    await service.start(credentials);
    await service.birthday(SENTINEL.birthday);
    await service.sendOtp(CERT_SMS);
    await service.verifyOtp({ purpose: "cert", code: SENTINEL.otp });
    await service.acceptTerms();
  }
  async function toCreating(service: OnboardingService) {
    await service.submitPlan(validPlan());
    await service.sendOtp(KEY_SMS);
    await service.verifyOtp({ purpose: "key", code: SENTINEL.otp });
  }
  async function reject(promise: Promise<unknown>) {
    return (await promise.catch((e: unknown) => e)) as OnboardingError;
  }

  describe("憑證不落地", () => {
    it("憑證流程走完：每一步的回應、每一次寫入的狀態與 log 都不含帳密、生日、OTP 或金鑰，成功後清除狀態", async () => {
      const service = makeService();
      const check = async (
        status: Awaited<ReturnType<OnboardingService["status"]>>,
        step: string,
      ) => {
        expect(status.step).toBe(step);
        expectNoSentinels(status);
        const current = await session();
        expectNoSentinels(current);
        if (current) {
          expect(Object.keys(current).every((k) => SESSION_KEYS.includes(k)))
            .toBe(true);
        }
        return status;
      };

      await check(await service.start(credentials), "birthday");
      const certTargets = await check(
        await service.birthday(SENTINEL.birthday),
        "cert_otp",
      );
      expect(certTargets.otpTargets).toEqual(fake.state.certTargets);
      const sent = await check(await service.sendOtp(CERT_SMS), "cert_otp");
      expect(sent.otp).toEqual({
        purpose: "cert",
        channel: "sms",
        targetIndex: 0,
        expiresAt: iso(T0 + 300_000),
      });
      const terms = await check(
        await service.verifyOtp({ purpose: "cert", code: SENTINEL.otp }),
        "terms",
      );
      expect(terms).toMatchObject({
        termsText: fake.state.termsText,
        otp: null,
        otpTargets: [],
      });
      const relogin = await check(await service.acceptTerms(), "relogin");
      expect(relogin.termsText).toBeNull();
      await check(await service.relogin(credentials), "plan");
      const keyStep = await check(
        await service.submitPlan(validPlan()),
        "key_otp",
      );
      expect(keyStep.otpTargets).toEqual(fake.state.keyTargets);
      await check(await service.sendOtp(KEY_SMS), "key_otp");
      await check(
        await service.verifyOtp({ purpose: "key", code: SENTINEL.otp }),
        "creating",
      );

      const done = await service.createKey(true);
      expect(done.revealed).toEqual({
        apiKey: SENTINEL.apiKey,
        secretKey: SENTINEL.secretKey,
      });
      expect(done.result).toEqual({
        apiKeyLast4: "ABCD",
        expiresOn: "2027-10-05",
        permissions: ["quote", "account", "prod"],
        accountLabels: ["證券 ••••1234"],
      });
      expectNoSentinels(done.result);

      // 帳密只交給 driver，登入最多兩次；金鑰只交給 saveCredentials；流程結束後瀏覽器關閉、狀態清除。
      expect(fake.received.login).toEqual([credentials, credentials]);
      expect(fake.count("login")).toBe(1);
      expect(fake.count("relogin")).toBe(1);
      expect(fake.open.size).toBe(0);
      expect(saved).toEqual([
        { apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey },
      ]);
      expect(await persisted()).toBeNull();
      expectNoSentinels(spy.writes);
      expectNoSentinels(consoleOutput());
    });

    it("已有憑證：登入後直接進方案；不要求回傳金鑰時回應不含 Secret，但金鑰已交給 saveCredentials", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      expect((await service.start(credentials)).step).toBe("plan");
      await toCreating(service);

      const done = await service.createKey(false);
      expect(done.revealed).toBeNull();
      expectNoSentinels(done);
      expect(fake.count("submitBirthday")).toBe(0);
      expect(fake.count("relogin")).toBe(0);
      expect(fake.received.createKeyPlan).toEqual(validPlan());
      expect(saved).toEqual([
        { apiKey: SENTINEL.apiKey, secretKey: SENTINEL.secretKey },
      ]);
      expectNoSentinels(spy.writes);
    });

    it("方案會先正規化（名稱去空白、帳戶類型與 IP 去重）再交給 driver 與持久化", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await service.submitPlan({
        ...validPlan(),
        name: "  tw-fin-hub  ",
        accountTypes: ["stock", "stock"],
        ip: { mode: "restricted", addresses: [" 203.0.113.42", "203.0.113.42"] },
      });
      expect((await session())?.plan).toEqual({
        ...validPlan(),
        ip: { mode: "restricted", addresses: ["203.0.113.42"] },
      });
    });
  });

  describe("登入次數", () => {
    it("start 與 relogin 都在送出登入「之前」就記帳（logins 1、2）", async () => {
      const service = makeService();
      const releaseLogin = fake.hold("login");
      const first = service.start(credentials);
      await vi.waitFor(() => expect(fake.events).toContain("login"));
      expect((await session())?.logins).toBe(1);
      releaseLogin();
      await first;

      await service.birthday(SENTINEL.birthday);
      await service.sendOtp(CERT_SMS);
      await service.verifyOtp({ purpose: "cert", code: SENTINEL.otp });
      await service.acceptTerms();
      const releaseRelogin = fake.hold("relogin");
      const relogin = service.relogin(credentials);
      await vi.waitFor(() => expect(fake.events).toContain("relogin"));
      expect((await session())?.logins).toBe(2);
      releaseRelogin();
      await relogin;
    });

    it("登入請求中途死掉（租約過期後）：再登入不會送出第 3 次", async () => {
      const service = makeService();
      await toRelogin(service);
      const release = fake.hold("relogin");
      const dying = service.relogin(credentials);
      await vi.waitFor(() => expect(fake.events).toContain("relogin"));

      nowMs = T0 + seconds(121);
      await expect(service.relogin(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      expect(fake.count("relogin")).toBe(1);
      expect(fake.received.login).toHaveLength(2);
      release();
      await dying;
    });

    it("登入次數用完（logins 已是 2）且租約已過期：再登入同樣不會送出", async () => {
      const service = makeService();
      await toRelogin(service);
      await patchSession({
        logins: 2,
        lock: { id: "stale-lease", until: iso(T0 - 1) },
      });
      await expect(service.relogin(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      expect(fake.count("relogin")).toBe(0);
    });

    it("密碼錯誤：停止、關瀏覽器、清除狀態；沒有冷卻，可立刻重新開始，且登入不自動重試", async () => {
      const service = makeService();
      fake.failures.set(
        "login",
        new OnboardingDriverError(
          "ONBOARDING_BAD_CREDENTIALS",
          `page said wrong ${SENTINEL.password}`,
        ),
      );
      const error = await reject(service.start(credentials));
      expect(error).toBeInstanceOf(OnboardingError);
      expect(error).toMatchObject({
        code: "ONBOARDING_BAD_CREDENTIALS",
        status: 400,
      });
      expect(error.message).toContain("帳號或密碼錯誤");
      expect(error.message).not.toContain("page said");
      expectNoSentinels(error.message);
      expect(fake.open.size).toBe(0);
      expect(fake.received.login).toHaveLength(1);
      expect(await persisted()).toBeNull();
      expectNoSentinels(consoleOutput());

      expect((await service.status()).step).toBe("login");
      expect((await service.start(credentials)).step).toBe("birthday");
      expect(fake.state.launches).toBe(2);
    });

    it("重新登入失敗同樣停止，整個流程送出的登入不超過 2 次；失敗後可以重新開始", async () => {
      const service = makeService();
      await toRelogin(service);
      fake.failures.set(
        "relogin",
        new OnboardingDriverError("ONBOARDING_ACCOUNT_LOCKED", "locked"),
      );
      await expect(service.relogin(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_ACCOUNT_LOCKED",
        status: 429,
      });
      expect(fake.open.size).toBe(0);
      expect(fake.received.login).toHaveLength(2);
      expect(await persisted()).toBeNull();
      expect((await service.start(credentials)).step).toBe("birthday");
    });
  });

  describe("租約與並行", () => {
    it("第二個 start 與重複的 relogin 只得到 BROWSER_BUSY，不會多啟動瀏覽器或多登入一次", async () => {
      const service = makeService();
      const releaseLogin = fake.hold("login");
      const first = service.start(credentials);
      await vi.waitFor(() => expect(fake.events).toContain("login"));
      await expect(service.start(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
        status: 409,
      });
      expect(fake.state.launches).toBe(1);
      releaseLogin();
      expect((await first).step).toBe("birthday");

      await service.birthday(SENTINEL.birthday);
      await service.sendOtp(CERT_SMS);
      await service.verifyOtp({ purpose: "cert", code: SENTINEL.otp });
      await service.acceptTerms();
      const releaseRelogin = fake.hold("relogin");
      const relogin = service.relogin(credentials);
      await vi.waitFor(() => expect(fake.events).toContain("relogin"));
      await expect(service.relogin(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
      });
      releaseRelogin();
      expect((await relogin).step).toBe("plan");
      expect(fake.count("relogin")).toBe(1);
    });

    it("先 claim 再 connect：被擋下的第二個請求完全不碰 gateway；租約 120 秒內一律 BUSY", async () => {
      const service = makeService();
      await service.start(credentials);
      const release = fake.hold("submitBirthday");
      const first = service.birthday(SENTINEL.birthday);
      await vi.waitFor(() => expect(fake.events).toContain("submitBirthday"));
      const connects = fake.count("connect");

      nowMs = T0 + seconds(119);
      await expect(service.birthday(SENTINEL.birthday)).rejects.toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
      });
      expect(fake.count("connect")).toBe(connects);
      expect(fake.count("submitBirthday")).toBe(1);

      release();
      await first;
      expect(fake.count("submitBirthday")).toBe(1);
      expect((await session())?.step).toBe("cert_otp");
    });

    it("租約過期後新請求可以接手；醒來的舊請求因租約不符寫回失敗，並依 fail-safe 終止流程", async () => {
      const service = makeService();
      await service.start(credentials);
      const release = fake.hold("submitBirthday", true);
      const stale = reject(service.birthday(SENTINEL.birthday));
      await vi.waitFor(() => expect(fake.events).toContain("submitBirthday"));

      nowMs = T0 + seconds(121);
      expect((await service.birthday(SENTINEL.birthday)).step).toBe("cert_otp");
      expect(fake.count("submitBirthday")).toBe(2);

      release();
      expect(await stale).toMatchObject({ code: "ONBOARDING_SESSION_EXPIRED" });
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
    });
  });

  describe("逾時", () => {
    it("過期的 session 先關瀏覽器、清狀態再回 SESSION_EXPIRED；成功步驟會順延期限但有 30 分鐘封頂", async () => {
      const service = makeService();
      await service.start(credentials);
      nowMs = T0 + minutes(11);
      await expect(service.birthday(SENTINEL.birthday)).rejects.toMatchObject({
        code: "ONBOARDING_SESSION_EXPIRED",
        status: 409,
      });
      expect(fake.open.size).toBe(0);
      expect(fake.count("submitBirthday")).toBe(0);
      expect(await persisted()).toBeNull();
      expect((await service.status()).step).toBe("login");

      nowMs = T0;
      await service.start(credentials);
      nowMs = T0 + minutes(9);
      expect((await service.birthday(SENTINEL.birthday)).expiresAt).toBe(
        iso(T0 + minutes(19)),
      );
      nowMs = T0 + minutes(15);
      expect((await service.status()).step).toBe("cert_otp");
      nowMs = T0 + minutes(18);
      await service.sendOtp(CERT_SMS);
      nowMs = T0 + minutes(27);
      // 先前的 OTP 已過期，改驗證前要重寄一組；這裡只看期限封頂。
      const resent = await service.sendOtp(CERT_SMS);
      expect(resent.expiresAt).toBe(iso(T0 + minutes(30)));

      nowMs = T0 + minutes(30);
      const stopped = await service.status();
      expect(stopped.step).toBe("stopped");
      expect(stopped.error?.code).toBe("ONBOARDING_SESSION_EXPIRED");
    });

    it("步驟執行期間時間流逝：寫回時依完成時間重新順延閒置期限", async () => {
      const service = makeService();
      await service.start(credentials);
      const release = fake.hold("submitBirthday");
      const running = service.birthday(SENTINEL.birthday);
      await vi.waitFor(() => expect(fake.events).toContain("submitBirthday"));
      nowMs = T0 + minutes(5);
      release();
      expect((await running).expiresAt).toBe(iso(T0 + minutes(15)));
    });

    it("沒有背景工作：過期後瀏覽器與狀態維持原樣，直到下一個請求才發現；status 的 stopped 只回一次", async () => {
      const service = makeService();
      await service.start(credentials);
      nowMs = T0 + minutes(11);
      expect(fake.open.size).toBe(1);
      expect((await session())?.step).toBe("birthday");

      const stopped = await service.status();
      expect(stopped).toMatchObject({
        step: "stopped",
        error: { code: "ONBOARDING_SESSION_EXPIRED" },
      });
      expect(stopped.error?.message).toContain("連線已逾時");
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
      expect(await service.status()).toMatchObject({
        step: "login",
        error: null,
      });
    });

    it("過期的舊 session 不擋新的 start：先關掉舊瀏覽器再開新的", async () => {
      const service = makeService();
      await service.start(credentials);
      nowMs = T0 + minutes(11);
      expect((await service.start(credentials)).step).toBe("birthday");
      expect(fake.state.launches).toBe(2);
      expect([...fake.open]).toEqual(["local-2"]);
    });

    it("建立金鑰進行中即使超過期限（含 30 分鐘封頂）也不會被輪詢或取消關掉瀏覽器，Secret 才不會遺失", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      nowMs = T0 + minutes(9);
      await service.submitPlan(validPlan());
      nowMs = T0 + minutes(18);
      await service.sendOtp(KEY_SMS);
      nowMs = T0 + minutes(22);
      await service.verifyOtp({ purpose: "key", code: SENTINEL.otp });

      nowMs = T0 + minutes(29) + 55_000;
      const release = fake.hold("createKey");
      const creating = service.createKey(true);
      await vi.waitFor(() => expect(fake.events).toContain("createKey"));
      nowMs = T0 + minutes(30) + 30_000;
      expect((await service.status()).step).toBe("creating");
      await expect(service.cancel()).rejects.toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
      });
      expect(fake.open.size).toBe(1);
      release();
      expect((await creating).revealed).toEqual({
        apiKey: SENTINEL.apiKey,
        secretKey: SENTINEL.secretKey,
      });
    });

    it("已送出建立金鑰的流程逾時：status 回 KEY_CAPTURE_FAILED（金鑰可能已建立），不是一般逾時", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      await patchSession({ keyRequested: true });
      nowMs = T0 + minutes(45);
      const status = await service.status();
      expect(status.step).toBe("stopped");
      expect(status.error?.code).toBe("ONBOARDING_KEY_CAPTURE_FAILED");
      expect(status.error?.message).toContain("到永豐金證券官網刪除該組 Key");
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
    });
  });

  describe("播放窗畫面", () => {
    it("流程中給畫面；進入 creating 起（成功視窗會顯示 Secret）一律不給，也不續期", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      expect(await service.liveFrame()).toBeNull();

      await service.start(credentials);
      const before = await session();
      expect(await service.liveFrame()).toBe(FAKE_FRAME);
      // 只讀：看畫面不算流程有動靜，不 connect、不寫 repository。
      expect(fake.count("connect")).toBe(0);
      expect(await session()).toEqual(before);

      await toCreating(service);
      expect(await service.liveFrame()).toBeNull();
      const release = fake.hold("createKey");
      const creating = service.createKey(true);
      await vi.waitFor(() => expect(fake.events).toContain("createKey"));
      expect(await service.liveFrame()).toBeNull();
      release();
      await creating;
      expect(await service.liveFrame()).toBeNull();
    });

    it("擷圖期間流程進入 creating：擷到的那一格也丟掉", async () => {
      const service = makeService({
        gateway: {
          ...fake.gateway,
          async capture() {
            await patchSession({ step: "creating" });
            return FAKE_FRAME;
          },
        },
      });
      await service.start(credentials);
      expect(await service.liveFrame()).toBeNull();
    });
  });

  describe("建立金鑰（最多一次）", () => {
    it("取得 /key 租約的當下就寫入 keyRequested", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      expect((await session())?.keyRequested).toBeUndefined();
      // /status 也帶出來：還原到 creating 的畫面靠它決定送第一次還是只等候。
      expect((await service.status()).keyRequested).toBe(false);

      const release = fake.hold("createKey");
      const creating = service.createKey(true);
      await vi.waitFor(() => expect(fake.events).toContain("createKey"));
      expect((await session())?.keyRequested).toBe(true);
      expect((await service.status()).keyRequested).toBe(true);
      release();
      await creating;
    });

    it("建立請求死掉（租約過期）後重試：不會再建第二組，結束流程並請使用者到永豐金證券確認", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);

      const release = fake.hold("createKey");
      const dying = service.createKey(true);
      await vi.waitFor(() => expect(fake.events).toContain("createKey"));
      nowMs = T0 + seconds(121);
      const retry = await reject(service.createKey(true));
      expect(retry).toMatchObject({
        code: "ONBOARDING_KEY_CAPTURE_FAILED",
        status: 502,
      });
      expect(fake.count("createKey")).toBe(1);
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
      release();
      await dying;
    });

    it("已標記 keyRequested 的流程再 /key：直接 KEY_CAPTURE_FAILED，不再驅動頁面建立", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      await patchSession({ keyRequested: true });
      await expect(service.createKey(true)).rejects.toMatchObject({
        code: "ONBOARDING_KEY_CAPTURE_FAILED",
        status: 502,
      });
      expect(fake.count("createKey")).toBe(0);
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
    });

    it("建立金鑰前會再確認持久化的方案：方案不見時不建立金鑰、也不標記 keyRequested", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      await patchSession({ plan: null });
      await expect(service.createKey(true)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      expect(fake.count("createKey")).toBe(0);
      expect((await session())?.keyRequested).toBeUndefined();
    });

    it("交易加無限制 IP 的方案照常交給 driver 建立金鑰", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      const trade = {
        ...validPlan(),
        permissions: { ...validPlan().permissions, trade: true },
      };
      await service.submitPlan(trade);
      await service.sendOtp(KEY_SMS);
      await service.verifyOtp({ purpose: "key", code: SENTINEL.otp });
      await service.createKey(false);
      expect(fake.received.createKeyPlan).toEqual(trade);
      expect(saved).toHaveLength(1);
    });

    it("非 creating 步驟呼叫 /key：INVALID_STATE，不碰瀏覽器", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await expect(service.createKey(true)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      expect(fake.count("createKey")).toBe(0);
    });
  });

  describe("金鑰保存失敗（salvage）", () => {
    it("保存失敗：回 KEY_CAPTURE_FAILED；revealSecret 為 true 時一次性帶回金鑰，否則不含 Secret，且狀態清除", async () => {
      fake.state.loginOutcome = "logged_in";
      const failingSave = async () => {
        throw new Error(`disk down ${SENTINEL.secretKey}`);
      };

      for (const reveal of [true, false]) {
        const service = makeService({ saveCredentials: failingSave });
        await service.start(credentials);
        await toCreating(service);
        const error = await reject(service.createKey(reveal));
        expect(error).toMatchObject({
          code: "ONBOARDING_KEY_CAPTURE_FAILED",
          status: 502,
        });
        expect(error.message).not.toContain("disk down");
        expectNoSentinels(error.message);
        // 存檔失敗時不論 revealSecret 都附上金鑰：這是唯一還拿得到 Secret 的時機。
        void reveal;
        expect(error.extra).toEqual({
          result: expect.objectContaining({ apiKeyLast4: "ABCD" }),
          revealed: {
            apiKey: SENTINEL.apiKey,
            secretKey: SENTINEL.secretKey,
          },
        });
        expect(fake.open.size).toBe(0);
        expect(await persisted()).toBeNull();
        expectNoSentinels(consoleOutput());
        expectNoSentinels(spy.writes);
      }
    });

    it("收尾（關瀏覽器、清狀態）失敗也不會弄丟已取得的金鑰；殘留狀態逾時後由下一個請求清掉", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService({
        saveCredentials: async (keys) => {
          saved.push(keys);
          spy.control.failUpdates = true;
        },
      });
      await service.start(credentials);
      await toCreating(service);
      const done = await service.createKey(true);
      expect(done.revealed).toEqual({
        apiKey: SENTINEL.apiKey,
        secretKey: SENTINEL.secretKey,
      });
      expect(saved).toHaveLength(1);

      spy.control.failUpdates = false;
      nowMs = T0 + minutes(11);
      expect((await service.status()).step).toBe("stopped");
      expect((await service.status()).step).toBe("login");
    });

    it("driver 回傳空金鑰：不呼叫 saveCredentials，也不帶回任何金鑰", async () => {
      fake.state.loginOutcome = "logged_in";
      fake.state.created = { apiKey: "", secretKey: "", accountLabels: [] };
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      const error = await reject(service.createKey(true));
      expect(error).toMatchObject({ code: "ONBOARDING_KEY_CAPTURE_FAILED" });
      expect(error.extra).toBeUndefined();
      expect(saved).toHaveLength(0);
      expect(fake.open.size).toBe(0);
    });

    it("按下確定後 driver 失敗：固定錯誤、關瀏覽器、清狀態，不呼叫 saveCredentials", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      fake.failures.set(
        "createKey",
        new OnboardingDriverError(
          "ONBOARDING_KEY_CAPTURE_FAILED",
          `page ${SENTINEL.secretKey}`,
        ),
      );
      const error = await reject(service.createKey(true));
      expect(error).toMatchObject({
        code: "ONBOARDING_KEY_CAPTURE_FAILED",
        status: 502,
      });
      expect(error.message).not.toContain("page ");
      expectNoSentinels(error.message);
      expect(saved).toHaveLength(0);
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
      expectNoSentinels(consoleOutput());
    });
  });

  describe("固定訊息與 log", () => {
    it("每個錯誤代碼都只回固定訊息（不轉述 driver 訊息、輸入或金鑰），retryAfterSeconds 原樣帶出", async () => {
      const messages = new Set<string>();
      for (const code of ONBOARDING_ERROR_CODES) {
        const service = makeService();
        fake.failures.set(
          "login",
          new OnboardingDriverError(code, `leak ${SENTINEL.password}`, 7),
        );
        const error = await reject(service.start(credentials));
        expect(error).toBeInstanceOf(OnboardingError);
        expect(error.code).toBe(code);
        expect(error.status).toBeGreaterThanOrEqual(400);
        expect(error.message).not.toContain("leak");
        expect(error.message.length).toBeGreaterThan(0);
        expect(error.retryAfterSeconds).toBe(7);
        expect(await persisted()).toBeNull();
        messages.add(error.message);
      }
      expect(messages.size).toBe(ONBOARDING_ERROR_CODES.length);
      expectNoSentinels(consoleOutput());
    });

    it("log 只有固定事件名、代碼、步驟與 driver 附上的固定 diag", async () => {
      const service = makeService();
      const failure = new OnboardingDriverError(
        "ONBOARDING_SITE_CHANGED",
        `page text ${SENTINEL.password}`,
      );
      failure.diag = { step: "login", reason: "form missing", hint: "no field" };
      fake.failures.set("login", failure);
      await reject(service.start(credentials));
      expect(stoppedLogs()).toEqual([
        {
          event: "sinopac_onboarding_stopped",
          code: "ONBOARDING_SITE_CHANGED",
          step: "login",
          diag: { step: "login", reason: "form missing", hint: "no field" },
        },
      ]);
      expectNoSentinels(consoleOutput());
      expect(consoleOutput()).not.toContain("page text");
    });

    it("OTP 錯誤與未預期的例外都會終止流程，只回固定訊息，不洩漏輸入", async () => {
      const service = makeService();
      await service.start(credentials);
      await service.birthday(SENTINEL.birthday);
      await service.sendOtp(CERT_SMS);
      fake.failures.set(
        "submitOtp",
        new OnboardingDriverError(
          "ONBOARDING_OTP_INVALID",
          `bad ${SENTINEL.otp}`,
        ),
      );
      const invalid = await reject(
        service.verifyOtp({ purpose: "cert", code: SENTINEL.otp }),
      );
      expect(invalid).toMatchObject({
        code: "ONBOARDING_OTP_INVALID",
        status: 400,
      });
      expectNoSentinels(invalid.message);
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();

      await service.start(credentials);
      await service.birthday(SENTINEL.birthday);
      fake.failures.set("sendOtp", new Error(`boom ${SENTINEL.password}`));
      const unknown = await reject(service.sendOtp(CERT_SMS));
      expect(unknown).toMatchObject({
        code: "ONBOARDING_SITE_CHANGED",
        status: 502,
      });
      expectNoSentinels(unknown.message);
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
      expectNoSentinels(consoleOutput());
    });
  });

  describe("瀏覽器 gateway 失敗", () => {
    it("啟動失敗：固定的 BROWSER_BUSY，不洩漏例外內容，不留殘留狀態，之後可再開始", async () => {
      const service = makeService();
      fake.state.launchError = new Error(`chrome missing ${SENTINEL.password}`);
      const error = await reject(service.start(credentials));
      expect(error).toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
        status: 409,
      });
      expect(error.message).not.toContain("chrome missing");
      expect(await persisted()).toBeNull();
      expectNoSentinels(consoleOutput());

      fake.state.launchError = undefined;
      expect((await service.start(credentials)).step).toBe("birthday");
    });

    it("啟動時 gateway 丟出已分類的錯誤：原代碼與 retryAfterSeconds 保留", async () => {
      const service = makeService();
      fake.state.launchError = new OnboardingDriverError(
        "ONBOARDING_QUOTA_EXHAUSTED",
        "x",
        3600,
      );
      await expect(service.start(credentials)).rejects.toMatchObject({
        code: "ONBOARDING_QUOTA_EXHAUSTED",
        status: 429,
        retryAfterSeconds: 3600,
      });
      expect(await persisted()).toBeNull();
    });

    it("接回瀏覽器失敗：SESSION_EXPIRED，清除狀態", async () => {
      const service = makeService();
      await service.start(credentials);
      fake.state.connectError = new Error("browser crashed");
      await expect(service.birthday(SENTINEL.birthday)).rejects.toMatchObject({
        code: "ONBOARDING_SESSION_EXPIRED",
      });
      expect(await persisted()).toBeNull();
    });
  });

  describe("OTP 倒數與步驟檢查", () => {
    it("倒數期間不可重寄；過期後驗證不碰瀏覽器、保留 session 並允許重寄", async () => {
      const service = makeService();
      await service.start(credentials);
      await service.birthday(SENTINEL.birthday);
      await service.sendOtp(CERT_SMS);
      await expect(service.sendOtp(CERT_SMS)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      nowMs = T0 + 301_000;
      await expect(
        service.verifyOtp({ purpose: "cert", code: SENTINEL.otp }),
      ).rejects.toMatchObject({ code: "ONBOARDING_OTP_EXPIRED", status: 409 });
      expect(fake.count("submitOtp")).toBe(0);
      expect((await service.status()).step).toBe("cert_otp");
      const resent = await service.sendOtp(CERT_SMS);
      expect(resent.otp?.expiresAt).toBe(iso(nowMs + 300_000));
      expect(fake.count("sendOtp")).toBe(2);
    });

    it("還沒寄 OTP 就驗證、或用錯誤用途驗證：INVALID_STATE，不碰瀏覽器、保留 session", async () => {
      const service = makeService();
      await service.start(credentials);
      await service.birthday(SENTINEL.birthday);
      await expect(
        service.verifyOtp({ purpose: "cert", code: SENTINEL.otp }),
      ).rejects.toMatchObject({ code: "ONBOARDING_INVALID_STATE" });
      await service.sendOtp(CERT_SMS);
      await expect(
        service.verifyOtp({ purpose: "key", code: SENTINEL.otp }),
      ).rejects.toMatchObject({ code: "ONBOARDING_INVALID_STATE" });
      expect(fake.count("submitOtp")).toBe(0);
      expect((await session())?.step).toBe("cert_otp");
    });

    it("生日格式不正確：INVALID_REQUEST，不碰瀏覽器、保留 session", async () => {
      const service = makeService();
      await service.start(credentials);
      for (const bad of ["1988-02-14", "19881340", "20991231"]) {
        await expect(service.birthday(bad)).rejects.toMatchObject({
          code: "ONBOARDING_INVALID_REQUEST",
          status: 400,
        });
      }
      expect(fake.count("submitBirthday")).toBe(0);
      expect((await session())?.step).toBe("birthday");
    });

    it("頁面讀不到收碼管道或條款：視為改版（SITE_CHANGED）並停止", async () => {
      const service = makeService();
      await service.start(credentials);
      fake.state.certTargets = [];
      await expect(service.birthday(SENTINEL.birthday)).rejects.toMatchObject({
        code: "ONBOARDING_SITE_CHANGED",
      });
      expect(await persisted()).toBeNull();

      fake.state.certTargets = [{ channel: "sms", index: 0, masked: "09***123" }];
      fake.state.termsText = "   ";
      await service.start(credentials);
      await service.birthday(SENTINEL.birthday);
      await service.sendOtp(CERT_SMS);
      await expect(
        service.verifyOtp({ purpose: "cert", code: SENTINEL.otp }),
      ).rejects.toMatchObject({ code: "ONBOARDING_SITE_CHANGED" });
      expect(await persisted()).toBeNull();
      expect(fake.open.size).toBe(0);
    });
  });

  describe("方案檢查", () => {
    it("無效方案在碰瀏覽器前被拒絕；交易加無限制 IP 可以送出；錯誤步驟、未快取的收碼管道也被拒絕", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);

      const invalid = await reject(
        service.submitPlan({
          name: "  ",
          expiresOn: "2020-01-01",
          permissions: {
            quote: false,
            account: false,
            trade: false,
            prod: false,
          },
          accountTypes: [],
          ip: { mode: "restricted", addresses: ["999.1.1.1"] },
        }),
      );
      expect(invalid).toMatchObject({
        code: "ONBOARDING_INVALID_REQUEST",
        status: 400,
      });
      expect(Object.keys(invalid.extra?.fields as object).sort()).toEqual([
        "accountTypes",
        "expiresOn",
        "ip",
        "name",
        "permissions",
      ]);
      expect(fake.count("openKeyIdentityDialog")).toBe(0);
      expect((await service.status()).step).toBe("plan");
      await expect(service.acceptTerms()).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });

      // 交易搭配無限制 IP 是允許的（動態 IP 的使用者只能這樣設定）。
      const trade = {
        ...validPlan(),
        permissions: { ...validPlan().permissions, trade: true },
      };
      const accepted = await service.submitPlan(trade);
      expect(accepted.step).toBe("key_otp");
      expect((await session())?.plan).toEqual(trade);
      await expect(
        service.sendOtp({ purpose: "key", channel: "sms", targetIndex: 7 }),
      ).rejects.toMatchObject({ code: "ONBOARDING_INVALID_REQUEST" });
      await expect(service.sendOtp(CERT_SMS)).rejects.toMatchObject({
        code: "ONBOARDING_INVALID_STATE",
      });
      expect(fake.count("sendOtp")).toBe(0);
    });
  });

  describe("取消", () => {
    it("沒有進行中的流程：回到初始狀態，不碰瀏覽器", async () => {
      const service = makeService();
      expect(await service.cancel()).toMatchObject({
        step: "login",
        expiresAt: null,
        error: null,
      });
      expect(fake.events).toEqual([]);
    });

    it("取消後關瀏覽器、清狀態；之後到的請求拿到 SESSION_EXPIRED 且不碰瀏覽器", async () => {
      const service = makeService();
      await service.start(credentials);
      expect((await service.cancel()).step).toBe("login");
      expect(fake.open.size).toBe(0);
      expect(await persisted()).toBeNull();
      const connects = fake.count("connect");
      await expect(service.birthday(SENTINEL.birthday)).rejects.toMatchObject({
        code: "ONBOARDING_SESSION_EXPIRED",
      });
      expect(fake.count("connect")).toBe(connects);
      expect(fake.count("submitBirthday")).toBe(0);
    });

    it("建立金鑰進行中拒絕取消（瀏覽器與狀態不變）；請求死掉、租約過期後才允許", async () => {
      fake.state.loginOutcome = "logged_in";
      const service = makeService();
      await service.start(credentials);
      await toCreating(service);
      const release = fake.hold("createKey");
      const creating = service.createKey(true);
      await vi.waitFor(() => expect(fake.events).toContain("createKey"));

      const before = await persisted();
      await expect(service.cancel()).rejects.toMatchObject({
        code: "ONBOARDING_BROWSER_BUSY",
        status: 409,
      });
      expect(fake.open.size).toBe(1);
      expect(await persisted()).toEqual(before);

      nowMs = T0 + seconds(121);
      expect((await service.cancel()).step).toBe("login");
      expect(fake.open.size).toBe(0);
      release();
      await creating;
    });

    it("非建立金鑰的步驟進行中可以取消，原請求以 SESSION_EXPIRED 結束", async () => {
      const service = makeService();
      const release = fake.hold("login");
      const starting = reject(service.start(credentials));
      await vi.waitFor(() => expect(fake.events).toContain("login"));
      expect((await service.cancel()).step).toBe("login");
      expect(fake.open.size).toBe(0);
      release();
      expect(await starting).toMatchObject({
        code: "ONBOARDING_SESSION_EXPIRED",
      });
      expect(await persisted()).toBeNull();
    });
  });
});
