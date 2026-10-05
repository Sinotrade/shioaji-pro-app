import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dialog, Page } from "puppeteer-core";
import { OnboardingDriverError } from "./driver";
import {
  closeAllOnboardingSessions,
  isAllowedNavigation,
  localOnboardingGateway,
} from "./gateway";
import { sharedOnboardingRepository } from "./repository";
import type { DialogLike, PageLike } from "./sinopac-driver";

const pptr = vi.hoisted(() => ({ loaded: vi.fn(), launch: vi.fn() }));
vi.mock("puppeteer-core", () => {
  pptr.loaded();
  return { default: { launch: pptr.launch } };
});

// 編譯期檢查（tsc 才有效）：Puppeteer 的 Page／Dialog 不需要 cast 就滿足 driver 的轉接介面。
type Assert<T extends true> = T;
export type PageFitsPageLike = Assert<Page extends PageLike ? true : false>;
export type DialogFitsDialogLike = Assert<
  Dialog extends DialogLike ? true : false
>;

const SENTINEL = "SENTINEL-PASSWORD-123";

function fakeContext() {
  return {
    pages: vi.fn().mockResolvedValue([]),
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}
type FakeContext = ReturnType<typeof fakeContext>;

function fakeBrowser() {
  const contexts: FakeContext[] = [];
  let onDisconnected: (() => void) | undefined;
  return {
    contexts,
    createBrowserContext: vi.fn(async () => {
      const context = fakeContext();
      contexts.push(context);
      return context;
    }),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "disconnected") onDisconnected = handler;
    }),
    disconnect: () => onDisconnected?.(),
  };
}

const global_ = globalThis as { __sinopacOnboardingGateway?: unknown };
const launchBrowser = () => {
  const browser = fakeBrowser();
  pptr.launch.mockResolvedValue(browser);
  return browser;
};
const open = (keepAliveMs = 600_000) =>
  localOnboardingGateway.launch({ keepAliveMs });

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OnboardingDriverError);
    return error as OnboardingDriverError;
  }
  throw new Error("預期要失敗");
}

const connectError = async (sessionId: string) =>
  (await errorOf(localOnboardingGateway.connect(sessionId))).code;

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  delete global_.__sinopacOnboardingGateway;
  delete (globalThis as { __sinopacOnboardingRepository?: unknown })
    .__sinopacOnboardingRepository;
});

afterEach(async () => {
  await closeAllOnboardingSessions();
  vi.useRealTimers();
});

describe("localOnboardingGateway.launch", () => {
  it("第一次 launch 才載入 puppeteer，並以本機 Chrome 啟動", async () => {
    vi.resetModules();
    pptr.loaded.mockClear();
    const { localOnboardingGateway: gateway } = await import("./gateway");
    expect(pptr.loaded).not.toHaveBeenCalled();

    launchBrowser();
    const session = await gateway.launch({ keepAliveMs: 600_000 });

    expect(pptr.loaded).toHaveBeenCalledOnce();
    expect(pptr.launch).toHaveBeenCalledOnce();
    const options = pptr.launch.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      channel: "chrome",
      headless: true,
      protocolTimeout: 45_000,
      pipe: true,
      handleSIGINT: true,
      handleSIGTERM: true,
      handleSIGHUP: true,
    });
    expect(options).not.toHaveProperty("executablePath");
    expect(typeof session.driver.login).toBe("function");
  });

  it("SINOPAC_CHROME_PATH 取代 channel；SINOPAC_HEADLESS=0 顯示視窗", async () => {
    vi.stubEnv("SINOPAC_CHROME_PATH", "/opt/chrome/chrome");
    vi.stubEnv("SINOPAC_HEADLESS", "0");
    launchBrowser();
    await open();
    const options = pptr.launch.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      executablePath: "/opt/chrome/chrome",
      headless: false,
    });
    expect(options).not.toHaveProperty("channel");
  });

  it("整個行程只開一顆 Chrome，每個流程各自一個 BrowserContext", async () => {
    const browser = launchBrowser();
    const [a, b] = await Promise.all([open(), open()]);
    await a.close();
    await b.close();
    const c = await open();

    expect(pptr.launch).toHaveBeenCalledOnce();
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(3);
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
  });

  it("driver 綁在自己流程的 context，不會碰到別人的", async () => {
    const browser = launchBrowser();
    const [a, b] = await Promise.all([open(), open()]);
    const [ctxA, ctxB] = browser.contexts;

    // 假 context 沒有任何分頁，driver 會在列出分頁後立刻回 SESSION_EXPIRED。
    const error = await errorOf(a.driver.openKeyIdentityDialog());
    expect(error.code).toBe("ONBOARDING_SESSION_EXPIRED");
    expect(ctxA?.pages).toHaveBeenCalled();
    expect(ctxB?.pages).not.toHaveBeenCalled();
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it("新的 launch 會關掉上一輪遺留的孤兒 context（同一時間只有一個流程）", async () => {
    const browser = launchBrowser();
    const first = await open();
    const second = await open();

    expect(browser.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(browser.contexts[1]?.close).not.toHaveBeenCalled();
    expect(await connectError(first.sessionId)).toBe(
      "ONBOARDING_SESSION_EXPIRED",
    );
    await expect(
      localOnboardingGateway.connect(second.sessionId),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
  });

  it("找不到 Chrome：固定訊息指引安裝或設定 SINOPAC_CHROME_PATH，且之後可重試", async () => {
    pptr.launch.mockRejectedValueOnce(
      new Error(
        "Could not find Google Chrome executable for channel 'chrome' at:\n" +
          ` - /Users/${SENTINEL}/Chrome`,
      ),
    );
    const error = await errorOf(open());
    expect(error.code).toBe("ONBOARDING_QUOTA_EXHAUSTED");
    expect(error.message).toContain("Google Chrome");
    expect(error.message).toContain("SINOPAC_CHROME_PATH");
    expect(error.message).not.toContain(SENTINEL);

    launchBrowser();
    await expect(open()).resolves.toBeDefined();
    expect(pptr.launch).toHaveBeenCalledTimes(2);
  });

  it("指定的 Chrome 路徑不存在也是同一則固定訊息", async () => {
    pptr.launch.mockRejectedValueOnce(
      new Error("Browser was not found at the configured executablePath (/x)"),
    );
    expect((await errorOf(open())).message).toContain("SINOPAC_CHROME_PATH");
  });

  it("其他啟動失敗：固定訊息，不洩漏瀏覽器的原始錯誤，log 也只有固定代碼", async () => {
    pptr.launch.mockRejectedValueOnce(
      new Error(`Failed to launch the browser process ${SENTINEL}`),
    );
    const error = await errorOf(open());
    expect(error.code).toBe("ONBOARDING_QUOTA_EXHAUSTED");
    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).not.toContain("SINOPAC_CHROME_PATH");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      SENTINEL,
    );
  });

  it("建立 context 失敗同樣回固定訊息，且不留下追蹤中的 context", async () => {
    const browser = launchBrowser();
    browser.createBrowserContext.mockRejectedValueOnce(
      new Error(`boom ${SENTINEL}`),
    );
    const error = await errorOf(open());
    expect(error.message).not.toContain(SENTINEL);

    const session = await open();
    expect(browser.contexts).toHaveLength(1);
    await session.close();
  });
});

describe("頂層導向限制", () => {
  it("只允許永豐金證券相關網域（含子網域）；非 http(s) 放行", () => {
    for (const url of [
      "https://www.sinotrade.com.tw/newweb/PythonAPIKey/",
      "https://ca.sinotrade.com.tw/WebCAEx/WebCA",
      "https://osu.sinotrade.com.tw/html5CA/webcaDepEx.html",
      "https://sinotrade.com.tw/",
      "https://bank.sinopac.com/",
      "https://x.sinopac.com.tw/",
      "https://ezfund.spf.com.tw/",
      "https://www.twca.com.tw/",
      "about:blank",
    ])
      expect([url, isAllowedNavigation(url)]).toEqual([url, true]);
    for (const url of [
      "https://evil.example/",
      "https://evilsinotrade.com.tw/",
      "https://sinotrade.com.tw.evil.example/",
      "http://www.google.com/recaptcha",
      "not a url",
    ])
      expect([url, isAllowedNavigation(url)]).toEqual([url, false]);
  });

  it("新分頁開啟攔截：只中止清單外的頂層 document 導向，iframe 與子資源放行", async () => {
    const browser = launchBrowser();
    await open();
    const [event, onTarget] = browser.contexts[0]!.on.mock.calls[0]!;
    expect(event).toBe("targetcreated");
    const mainFrame = {};
    let onRequest: ((request: unknown) => void) | undefined;
    const page = {
      mainFrame: () => mainFrame,
      on: vi.fn((_: string, handler: typeof onRequest) => {
        onRequest = handler;
      }),
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
    };
    onTarget({ page: async () => page });
    await vi.waitFor(() =>
      expect(page.setRequestInterception).toHaveBeenCalledWith(true),
    );
    const fire = (url: string, type = "document", frame: unknown = mainFrame) => {
      const request = {
        url: () => url,
        resourceType: () => type,
        isNavigationRequest: () => type === "document",
        frame: () => frame,
        isInterceptResolutionHandled: () => false,
        abort: vi.fn().mockResolvedValue(undefined),
        continue: vi.fn().mockResolvedValue(undefined),
      };
      onRequest!(request);
      return request;
    };
    expect(fire("https://evil.example/").abort).toHaveBeenCalledWith(
      "blockedbyclient",
    );
    for (const request of [
      fire("https://www.sinotrade.com.tw/"),
      fire("https://www.google.com/recaptcha/api2/anchor", "document", {}),
      fire("https://cdn.example/app.js", "script"),
    ]) {
      expect(request.continue).toHaveBeenCalledOnce();
      expect(request.abort).not.toHaveBeenCalled();
    }
  });
});

describe("localOnboardingGateway.connect", () => {
  it("找不到的 session：SESSION_EXPIRED，固定訊息不回顯 id", async () => {
    const error = await errorOf(
      localOnboardingGateway.connect("missing-session-id"),
    );
    expect(error.code).toBe("ONBOARDING_SESSION_EXPIRED");
    expect(error.message).not.toContain("missing-session-id");
  });

  it("接回同一個 context，但每次都是全新的 driver", async () => {
    launchBrowser();
    const first = await open();
    const again = await localOnboardingGateway.connect(first.sessionId);
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.driver).not.toBe(first.driver);
  });

  it("Chrome 中斷後所有舊 session 失效，下一次 launch 重開 Chrome", async () => {
    vi.useFakeTimers();
    const first = launchBrowser();
    const session = await open();
    first.disconnect();

    expect(vi.getTimerCount()).toBe(0);
    expect(await connectError(session.sessionId)).toBe(
      "ONBOARDING_SESSION_EXPIRED",
    );
    await expect(session.detach()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    launchBrowser();
    await open();
    expect(pptr.launch).toHaveBeenCalledTimes(2);
  });
});

describe("close / detach / idle timer", () => {
  it("close() 關掉這個流程的 context 並取消追蹤；重複呼叫只關一次", async () => {
    const browser = launchBrowser();
    const session = await open();
    await session.close();
    await session.close();

    expect(browser.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(await connectError(session.sessionId)).toBe(
      "ONBOARDING_SESSION_EXPIRED",
    );
  });

  it("close() 與 detach() 不會丟出自己的失敗", async () => {
    const browser = launchBrowser();
    const session = await open();
    browser.contexts[0]?.close.mockRejectedValue(new Error("boom"));

    await expect(session.detach()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("detach() 之後閒置到期才關 context；connect() 會重新倒數", async () => {
    vi.useFakeTimers();
    const browser = launchBrowser();
    const session = await open(1_000);
    const context = browser.contexts[0];

    await session.detach();
    await vi.advanceTimersByTimeAsync(600);
    const again = await localOnboardingGateway.connect(session.sessionId);
    await vi.advanceTimersByTimeAsync(600);
    expect(context?.close).not.toHaveBeenCalled();

    await again.detach();
    await vi.advanceTimersByTimeAsync(999);
    expect(context?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(context?.close).toHaveBeenCalledOnce();
    expect(await connectError(session.sessionId)).toBe(
      "ONBOARDING_SESSION_EXPIRED",
    );
  });

  it("service 忘了 detach／close 時也會在閒置期限後關掉（第二層保險）", async () => {
    vi.useFakeTimers();
    const browser = launchBrowser();
    await open(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.contexts[0]?.close).toHaveBeenCalledOnce();

    const connected = await open(1_000);
    await localOnboardingGateway.connect(connected.sessionId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.contexts[1]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已關閉的 session 再 detach 不會重新排計時器", async () => {
    vi.useFakeTimers();
    launchBrowser();
    const session = await open(1_000);
    await session.close();
    await session.detach();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closeAllOnboardingSessions 關掉所有 context 並清掉計時器，Chrome 保留", async () => {
    vi.useFakeTimers();
    const browser = launchBrowser();
    await Promise.all([open(), open()]);

    await closeAllOnboardingSessions();

    for (const context of browser.contexts) {
      expect(context.close).toHaveBeenCalledOnce();
    }
    expect(vi.getTimerCount()).toBe(0);
    await open();
    expect(pptr.launch).toHaveBeenCalledOnce();
  });
});

describe("sharedOnboardingRepository", () => {
  it("同一個行程只有一份，模組重新載入（Vite 重建 server）後仍是同一份狀態", async () => {
    const repository = sharedOnboardingRepository();
    expect(sharedOnboardingRepository()).toBe(repository);
    await repository.update(() => ({
      session: {
        flowId: "flow-1",
        sessionId: "session-1",
        step: "plan",
        startedAt: "2026-10-05T00:00:00.000Z",
        expiresAt: "2026-10-05T00:10:00.000Z",
        lock: null,
        logins: 1,
        otp: null,
        otpTargets: [],
        termsText: null,
        plan: null,
      },
    }));

    vi.resetModules();
    const reloaded = await import("./repository");
    const after = await reloaded.sharedOnboardingRepository().read();
    expect(after?.session?.flowId).toBe("flow-1");
  });

  it("mutate 回傳 undefined 不變更、丟錯不寫入", async () => {
    const repository = sharedOnboardingRepository();
    await expect(repository.update(() => undefined)).resolves.toBeNull();
    await expect(
      repository.update(() => {
        throw new Error("拒絕");
      }),
    ).rejects.toThrow("拒絕");
    await expect(repository.read()).resolves.toBeNull();
  });
});
