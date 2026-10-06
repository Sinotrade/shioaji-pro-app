// service.test.ts 用的假 gateway／driver／repository；全部是明顯的合成值，不碰任何真實網站。
import type {
  OnboardingOtpTarget,
  OnboardingPlan,
} from "../../src/lib/sinopac-onboarding/types";
import {
  OnboardingDriverError,
  type OnboardingBrowserGateway,
  type OnboardingDriver,
  type OnboardingLoginOutcome,
  type OnboardingSession,
} from "./driver";
import {
  createInMemoryOnboardingRepository,
  type OnboardingRepository,
} from "./service";

/** 明顯的合成值；測試斷言它們絕不出現在回應、錯誤、log 或持久化狀態。 */
export const SENTINEL = {
  idNumber: "Z188776655",
  password: "SENTINEL-PASSWORD-123",
  birthday: "19880214",
  otp: "SENTINELOTP9",
  apiKey: "SENTINEL-API-KEY-0000-ABCD",
  secretKey: "SENTINEL-SECRET-KEY-1111",
} as const;

export const credentials = {
  idNumber: SENTINEL.idNumber,
  password: SENTINEL.password,
};

/** 假播放窗畫面：JPEG 的 SOI／EOI 標記夾一個位元組。 */
export const FAKE_FRAME = new Uint8Array([0xff, 0xd8, 0x2a, 0xff, 0xd9]);

export function validPlan(): OnboardingPlan {
  return {
    name: "tw-fin-hub",
    expiresOn: "2027-10-05",
    permissions: { quote: true, account: true, trade: false, prod: true },
    accountTypes: ["stock"],
    ip: { mode: "unlimited", addresses: [] },
  };
}

/** 記憶體 repository 加上「每次寫入後的完整 JSON」紀錄，可注入寫入失敗。 */
export function createSpyRepository() {
  const inner = createInMemoryOnboardingRepository();
  const writes: string[] = [];
  const control = { failUpdates: false };
  const repository: OnboardingRepository = {
    read: () => inner.read(),
    async update(mutate) {
      if (control.failUpdates) throw new Error("repository down");
      const next = await inner.update(mutate);
      writes.push(JSON.stringify(next));
      return next;
    },
  };
  return { repository, writes, control, read: () => inner.read() };
}

/** 假的瀏覽器 gateway：記錄呼叫、可注入失敗、可卡住某個步驟以測試並行。 */
export function createFakeGateway() {
  const events: string[] = [];
  const open = new Set<string>();
  const failures = new Map<string, unknown>();
  const gates = new Map<string, { promise: Promise<void>; once: boolean }>();
  const received = {
    login: [] as { idNumber: string; password: string }[],
    createKeyPlan: undefined as OnboardingPlan | undefined,
  };
  const state = {
    launches: 0,
    launchError: undefined as unknown,
    connectError: undefined as unknown,
    loginOutcome: "webca_birthday" as OnboardingLoginOutcome,
    otpSeconds: 300,
    certTargets: [
      { channel: "sms", index: 0, masked: "09***123" },
      { channel: "email", index: 1, masked: "a***@example.com" },
    ] as OnboardingOtpTarget[],
    keyTargets: [
      { channel: "sms", index: 0, masked: "09***123" },
    ] as OnboardingOtpTarget[],
    termsText: "憑證作業條款（合成文字）",
    created: {
      apiKey: SENTINEL.apiKey,
      secretKey: SENTINEL.secretKey,
      accountLabels: ["證券 ••••1234"],
    } as { apiKey: string; secretKey: string; accountLabels: string[] },
  };

  async function step(name: string) {
    events.push(name);
    const gate = gates.get(name);
    if (gate?.once) gates.delete(name);
    if (gate) await gate.promise;
    if (failures.has(name)) {
      const failure = failures.get(name);
      failures.delete(name);
      throw failure;
    }
  }

  const driver: OnboardingDriver = {
    async login(input) {
      received.login.push(input);
      await step("login");
      return state.loginOutcome;
    },
    async submitBirthday() {
      await step("submitBirthday");
    },
    async readOtpTargets(purpose) {
      await step(`readOtpTargets:${purpose}`);
      return purpose === "cert" ? state.certTargets : state.keyTargets;
    },
    async sendOtp() {
      await step("sendOtp");
      return { expiresInSeconds: state.otpSeconds };
    },
    async submitOtp() {
      await step("submitOtp");
    },
    async readTerms() {
      await step("readTerms");
      return state.termsText;
    },
    async acceptTerms() {
      await step("acceptTerms");
    },
    async relogin(input) {
      received.login.push(input);
      await step("relogin");
    },
    async openKeyIdentityDialog() {
      await step("openKeyIdentityDialog");
    },
    async createKey(plan) {
      received.createKeyPlan = plan;
      await step("createKey");
      return state.created;
    },
  };

  function session(sessionId: string): OnboardingSession {
    return {
      sessionId,
      driver,
      async detach() {
        events.push("detach");
      },
      async close() {
        events.push("close");
        open.delete(sessionId);
      },
    };
  }

  const gateway: OnboardingBrowserGateway = {
    async launch() {
      events.push("launch");
      if (state.launchError) throw state.launchError;
      const id = `local-${++state.launches}`;
      open.add(id);
      return session(id);
    },
    async connect(sessionId) {
      events.push("connect");
      if (state.connectError) throw state.connectError;
      if (!open.has(sessionId)) {
        throw new OnboardingDriverError(
          "ONBOARDING_SESSION_EXPIRED",
          "local session is gone",
        );
      }
      return session(sessionId);
    },
    async capture(sessionId) {
      return open.has(sessionId) ? FAKE_FRAME : null;
    },
  };

  return {
    gateway,
    events,
    open,
    failures,
    state,
    received,
    count: (name: string) => events.filter((event) => event === name).length,
    /** 讓指定步驟停住，直到回傳的函式被呼叫；once 為 true 時只攔第一個呼叫。 */
    hold(name: string, once = false) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = () => {
          gates.delete(name);
          resolve();
        };
      });
      gates.set(name, { promise, once });
      return release;
    },
  };
}
