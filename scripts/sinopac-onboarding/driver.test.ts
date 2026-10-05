import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingPlan } from "../../src/lib/sinopac-onboarding/types";
import { OnboardingDriverError } from "./driver";
import { createSinopacOnboardingDriver } from "./sinopac-driver";
import {
  API_KEY,
  BIRTHDAY,
  FakeSinopacSite,
  ID_NUMBER,
  OTP_CODE,
  PASSWORD,
  SECRET_KEY,
  type SiteOptions,
} from "./fake-site";

const credentials = { idNumber: ID_NUMBER, password: PASSWORD };

const PLAN: OnboardingPlan = {
  name: "週報同步",
  expiresOn: "2027-12-31",
  permissions: { quote: false, account: true, trade: false, prod: true },
  accountTypes: ["stock", "overseas"],
  ip: { mode: "restricted", addresses: ["203.0.113.42", "198.51.100.7"] },
};

/** 每一步都換一個全新的 driver，模擬「接回遠端瀏覽器後不保留任何記憶」。 */
function setup(options: SiteOptions = {}) {
  const site = new FakeSinopacSite(options);
  const driver = () =>
    createSinopacOnboardingDriver(site.browser, { clock: site.clock });
  return { site, driver };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OnboardingDriverError);
    return (error as OnboardingDriverError).code;
  }
  throw new Error("預期要失敗");
}

afterEach(() => vi.restoreAllMocks());

describe("永豐金證券 driver：沒有憑證，經過 WebCA 流程", () => {
  it("走完整條路並建立金鑰", async () => {
    const consoleSpies = (
      ["log", "warn", "error", "info", "debug"] as const
    ).map((method) => vi.spyOn(console, method));
    const { site, driver } = setup();

    expect(await driver().login(credentials)).toBe("webca_birthday");
    expect(site.loginPresses).toBe(1);
    expect(site.typedCredentials).toEqual({
      id: ID_NUMBER,
      password: PASSWORD,
    });

    await driver().submitBirthday(BIRTHDAY);

    expect(await driver().readOtpTargets("cert")).toEqual([
      { channel: "sms", index: 0, masked: "09*****950" },
      { channel: "sms", index: 1, masked: "09*****333" },
      { channel: "email", index: 0, masked: "a***@example.com" },
    ]);
    const sent = await driver().sendOtp("cert", "sms", 1);
    expect(sent.expiresInSeconds).toBe(297);
    expect(site.sentTo).toBe("0922***333");
    await driver().submitOtp("cert", OTP_CODE);

    const terms = await driver().readTerms();
    expect(terms).toContain("第四條");
    expect(terms).not.toContain("service@example.com");
    // 使用者勾選後才呼叫；憑證視窗自行關閉。
    await driver().acceptTerms();
    expect(site.ca?.closed).toBe(true);

    await driver().relogin(credentials);
    expect(site.loginPresses).toBe(2);

    await driver().openKeyIdentityDialog();
    expect(await driver().readOtpTargets("key")).toEqual([
      { channel: "sms", index: 0, masked: "09*****678" },
      { channel: "email", index: 0, masked: "b***@example.org" },
    ]);
    expect((await driver().sendOtp("key", "email", 0)).expiresInSeconds).toBe(
      295,
    );
    expect(site.sentTo).toBe("bob@example.org");
    await driver().submitOtp("key", OTP_CODE);

    const created = await driver().createKey(PLAN);
    expect(created.apiKey).toBe(API_KEY);
    expect(created.secretKey).toBe(SECRET_KEY);
    expect(created.accountLabels).toEqual(["證券 ••••5678", "海外 ••••2222"]);
    expect(JSON.stringify(created.accountLabels)).not.toContain("王小明");
    expect(site.submitted).toBe(true);

    // 帳密與 OTP 只經過 keyboard.type，絕不出現在任何頁面腳本。
    const scripts = [site.main, site.ca!].flatMap((page) => page.scripts);
    expect(scripts.length).toBeGreaterThan(20);
    for (const secret of [PASSWORD, OTP_CODE, SECRET_KEY]) {
      expect(scripts.some((script) => script.includes(secret))).toBe(false);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("表單依方案設定：取消預設勾選、勾選指定帳戶、填兩組 IP", async () => {
    const { site, driver } = setup();
    await driver().login(credentials);
    await driver().submitBirthday(BIRTHDAY);
    await driver().sendOtp("cert", "sms", 0);
    await driver().submitOtp("cert", OTP_CODE);
    await driver().acceptTerms();
    await driver().relogin(credentials);
    await driver().openKeyIdentityDialog();
    await driver().sendOtp("key", "sms", 0);
    await driver().submitOtp("key", OTP_CODE);
    await driver().createKey(PLAN);

    // 提交後視窗已關閉，表單控制項被換掉，改檢查點擊紀錄。
    expect(site.main.clicks).toContain("行情／資料"); // 預設勾選，方案不要，取消
    expect(site.main.clicks).not.toContain("帳務"); // 預設勾選且方案要
    expect(site.main.clicks).not.toContain("交易");
    expect(site.main.clicks).toContain("期權 - 王小明 9B87654321"); // 取消
    expect(site.main.clicks).toContain("海外 - 王小明 7C11112222"); // 勾選
    expect(site.main.clicks).toContain("+ 新增另一組 IP");
  });

  it("每個步驟都以網址重新找頁面，不依賴 pages()[0]", async () => {
    const { site, driver } = setup();
    await driver().login(credentials);
    // 把分頁順序反過來：彈出視窗排第一。
    site.pages.reverse();
    await driver().submitBirthday(BIRTHDAY);
    expect(await driver().readOtpTargets("cert")).toHaveLength(3);
  });
});

describe("永豐金證券 driver：已經有憑證", () => {
  it("第一次登入就進 API 管理頁，沒有 WebCA", async () => {
    const { site, driver } = setup({ hasCertificate: true });
    expect(await driver().login(credentials)).toBe("logged_in");
    expect(site.loginPresses).toBe(1);
    expect(site.ca).toBeUndefined();

    await driver().openKeyIdentityDialog();
    await driver().sendOtp("key", "sms", 0);
    await driver().submitOtp("key", OTP_CODE);
    const created = await driver().createKey({
      ...PLAN,
      accountTypes: ["stock", "futures"],
      ip: { mode: "restricted", addresses: ["203.0.113.42"] },
    });
    expect(created.apiKey).toBe(API_KEY);
    expect(created.accountLabels).toEqual(["證券 ••••5678", "期權 ••••4321"]);
  });
});

describe("永豐金證券 driver：登入前的頁面骨架", () => {
  it("網址先是 PythonAPIKey、骨架先出現 API 管理文字，過一下才轉登入頁：不能誤判已登入", async () => {
    const { site, driver } = setup({ skeletonFirst: true });
    // 沒有憑證，所以登入後要走 WebCA；誤判成已登入就會直接回 logged_in。
    expect(await driver().login(credentials)).toBe("webca_birthday");
    expect(site.loginPresses).toBe(1);
    expect(site.typedCredentials.id).toBe(credentials.idNumber);
  });
});

describe("永豐金證券 driver：登入失敗模式", () => {
  it.each([
    ["silent", "ONBOARDING_BLOCKED_BY_SITE"],
    ["recaptcha", "ONBOARDING_RECAPTCHA_CHALLENGE"],
    ["bad_password", "ONBOARDING_BAD_CREDENTIALS"],
    ["locked", "ONBOARDING_ACCOUNT_LOCKED"],
  ] as const)(
    "登入結果 %s 對應 %s，且只按一次登入",
    async (loginResult, code) => {
      const { site, driver } = setup({ loginResult });
      expect(await codeOf(driver().login(credentials))).toBe(code);
      expect(site.loginPresses).toBe(1);
    },
  );

  it("彈出視窗從未出現：登入逾時視為被網站擋下，不重按登入", async () => {
    const { site, driver } = setup({ popupAppears: false });
    expect(await codeOf(driver().login(credentials))).toBe(
      "ONBOARDING_BLOCKED_BY_SITE",
    );
    expect(site.loginPresses).toBe(1);
    expect(site.ca).toBeUndefined();
  });

  it("輪詢途中換頁造成的暫時性錯誤不會讓登入中斷或重按", async () => {
    const { site, driver } = setup({ hasCertificate: true });
    site.main.flakyCalls = 7;
    expect(await driver().login(credentials)).toBe("logged_in");
    expect(site.loginPresses).toBe(1);
  });

  it("沒有彈出視窗時，送生日會停止而不是亂猜", async () => {
    const { driver } = setup({ popupAppears: false });
    expect(await codeOf(driver().submitBirthday(BIRTHDAY))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
  });

  it("原生 alert 的錯誤訊息也能辨識", async () => {
    const { site, driver } = setup({ loginResult: "silent" });
    // 登入送出後兩秒（虛擬時間）網站跳出 alert。
    site.clock.after(2_000, () => site.main.alert("密碼錯誤"));
    expect(await codeOf(driver().login(credentials))).toBe(
      "ONBOARDING_BAD_CREDENTIALS",
    );
    expect(site.loginPresses).toBe(1);
  });

  it("confirm 對話方塊一律取消，不會被代按成第二次送出", async () => {
    const { site, driver } = setup({ loginResult: "silent" });
    let confirm: { accepted: boolean; dismissed: boolean } | undefined;
    let alertResult: { accepted: boolean; dismissed: boolean } | undefined;
    site.clock.after(1_000, () => {
      confirm = site.main.fireDialog("confirm", "確定要重新登入嗎？");
    });
    site.clock.after(2_000, () => {
      alertResult = site.main.alert("密碼錯誤");
    });
    expect(await codeOf(driver().login(credentials))).toBe(
      "ONBOARDING_BAD_CREDENTIALS",
    );
    expect(confirm).toEqual({ accepted: false, dismissed: true });
    expect(alertResult).toEqual({ accepted: true, dismissed: false });
    expect(site.loginPresses).toBe(1);
  });

  it("每個分頁（含後來彈出的 WebCA）都會統一成桌機視窗大小", async () => {
    const { site, driver } = setup();
    await driver().login(credentials);
    await driver().submitBirthday(BIRTHDAY);
    for (const page of [site.main, site.ca!]) {
      // 每個 driver（每個請求）對看到的每個分頁各設定一次，因為重新接回後會被套回 800x600。
      expect(page.viewports.length).toBeGreaterThan(0);
      for (const viewport of page.viewports) {
        expect(viewport).toEqual({ width: 1280, height: 800 });
      }
    }
  });

  it("憑證安裝後重新登入又彈出視窗：停止，不申請第二張憑證", async () => {
    const { site, driver } = setup({ secondLoginPopup: true });
    await driver().login(credentials);
    await driver().submitBirthday(BIRTHDAY);
    await driver().sendOtp("cert", "sms", 0);
    await driver().submitOtp("cert", OTP_CODE);
    await driver().acceptTerms();
    expect(await codeOf(driver().relogin(credentials))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    expect(site.loginPresses).toBe(2);
  });

  it("重新登入前彈出視窗仍開著：不送出第二次登入", async () => {
    const { site, driver } = setup({ certClosesAfterTerms: false });
    await driver().login(credentials);
    await driver().submitBirthday(BIRTHDAY);
    await driver().sendOtp("cert", "sms", 0);
    await driver().submitOtp("cert", OTP_CODE);
    expect(await codeOf(driver().acceptTerms())).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    // 憑證視窗沒關，relogin 在按下登入之前就停止。
    expect(await codeOf(driver().relogin(credentials))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    expect(site.loginPresses).toBe(1);
  });
});

describe("永豐金證券 driver：生日與 OTP 失敗模式", () => {
  it("生日被拒絕：回 INVALID_REQUEST，頁面仍在生日步驟", async () => {
    const { driver } = setup();
    await driver().login(credentials);
    expect(await codeOf(driver().submitBirthday("19800202"))).toBe(
      "ONBOARDING_INVALID_REQUEST",
    );
  });

  it("生日格式不對：不碰頁面", async () => {
    const { site, driver } = setup();
    await driver().login(credentials);
    const before = site.ca?.scripts.length ?? 0;
    expect(await codeOf(driver().submitBirthday("1990-01-01"))).toBe(
      "ONBOARDING_INVALID_REQUEST",
    );
    expect(site.ca?.scripts.length ?? 0).toBe(before);
  });

  async function atCertOtp(options: SiteOptions = {}) {
    const ctx = setup(options);
    await ctx.driver().login(credentials);
    await ctx.driver().submitBirthday(BIRTHDAY);
    await ctx.driver().sendOtp("cert", "sms", 0);
    return ctx;
  }

  it.each([
    ["text", "ONBOARDING_OTP_INVALID"],
    ["silent", "ONBOARDING_OTP_INVALID"],
    ["expired_text", "ONBOARDING_OTP_EXPIRED"],
  ] as const)("驗證碼錯誤（%s）對應 %s", async (otpFailure, code) => {
    const { driver } = await atCertOtp({ otpFailure });
    expect(await codeOf(driver().submitOtp("cert", "000000"))).toBe(code);
  });

  it("倒數結束後再送驗證碼：視為過期，不輸入也不按確定", async () => {
    const { site, driver } = await atCertOtp();
    site.clock.advance(298_000);
    const before = site.ca!.clicks.length;
    expect(await codeOf(driver().submitOtp("cert", OTP_CODE))).toBe(
      "ONBOARDING_OTP_EXPIRED",
    );
    expect(site.ca!.clicks.length).toBe(before);
  });

  it("驗證碼格式不對：不碰頁面", async () => {
    const { driver } = await atCertOtp();
    // 太短、含符號或空白都不碰頁面（與路由、前端相同：4 到 12 個英數字）。
    for (const bad of ["12", "12 34", "12-34", "1".repeat(13)]) {
      expect(await codeOf(driver().submitOtp("cert", bad))).toBe(
        "ONBOARDING_INVALID_REQUEST",
      );
    }
  });

  it("收碼目標順位超出範圍：INVALID_REQUEST，且不會按下發送", async () => {
    const { site, driver } = setup();
    await driver().login(credentials);
    await driver().submitBirthday(BIRTHDAY);
    expect(await codeOf(driver().sendOtp("cert", "sms", 9))).toBe(
      "ONBOARDING_INVALID_REQUEST",
    );
    expect(site.ca!.clicks).not.toContain("取得驗證碼");
  });
});

describe("永豐金證券 driver：建立金鑰失敗模式", () => {
  async function atKeyDialog(options: SiteOptions = {}) {
    const ctx = setup({ hasCertificate: true, ...options });
    await ctx.driver().login(credentials);
    await ctx.driver().openKeyIdentityDialog();
    await ctx.driver().sendOtp("key", "sms", 0);
    await ctx.driver().submitOtp("key", OTP_CODE);
    return ctx;
  }

  it("達到 30 組上限（措辭未驗證）：KEY_LIMIT_REACHED", async () => {
    const { driver } = setup({ hasCertificate: true, keyLimit: true });
    await driver().login(credentials);
    expect(await codeOf(driver().openKeyIdentityDialog())).toBe(
      "ONBOARDING_KEY_LIMIT_REACHED",
    );
  });

  it("成功視窗解析不出金鑰：KEY_CAPTURE_FAILED，訊息提醒到官網確認", async () => {
    const { driver } = await atKeyDialog({ dialog: "unparsable" });
    const error = await driver()
      .createKey(PLAN)
      .catch((e: unknown) => e as OnboardingDriverError);
    expect(error).toBeInstanceOf(OnboardingDriverError);
    expect((error as OnboardingDriverError).code).toBe(
      "ONBOARDING_KEY_CAPTURE_FAILED",
    );
    expect((error as OnboardingDriverError).message).toContain("API 管理頁");
  });

  it("成功視窗從未出現：KEY_CAPTURE_FAILED", async () => {
    const { driver } = await atKeyDialog({ dialog: "never" });
    expect(await codeOf(driver().createKey(PLAN))).toBe(
      "ONBOARDING_KEY_CAPTURE_FAILED",
    );
  });

  it("表單狀態與方案不符：在按下確定之前就停止", async () => {
    const { site, driver } = await atKeyDialog({ stuckControl: "帳務" });
    // 方案要取消帳務，但網站沒有回應點擊。
    const plan = {
      ...PLAN,
      permissions: { quote: true, account: false, trade: false, prod: true },
    };
    expect(await codeOf(driver().createKey(plan))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    expect(site.submitted).toBe(false);
  });

  it("帳戶核取方塊沒有回應：回讀表單發現與方案不符，未按確定", async () => {
    const { site, driver } = await atKeyDialog({
      stuckControl: "海外 - 王小明 7C11112222",
    });
    expect(await codeOf(driver().createKey(PLAN))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    expect(site.submitted).toBe(false);
  });

  it("表單上有兩個可按的「確 定」：在建立之前就停止，不猜", async () => {
    const { site, driver } = await atKeyDialog({ duplicateConfirm: true });
    expect(await codeOf(driver().createKey(PLAN))).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
    expect(site.submitCount).toBe(0);
  });

  it("成功視窗沒有蓋住表單：照樣回傳金鑰，但不點「確 定」去關視窗", async () => {
    const { site, driver } = await atKeyDialog({ successOverlap: true });
    const created = await driver().createKey(PLAN);
    expect(created.apiKey).toBe(API_KEY);
    expect(created.secretKey).toBe(SECRET_KEY);
    // 若誤點表單的送出鈕，會建立第二把沒人看得到的金鑰。
    expect(site.submitCount).toBe(1);
  });

  it("方案要的帳戶類型有一部分不在表單上：略過沒有的類型，用其餘類型建立金鑰", async () => {
    const { site, driver } = await atKeyDialog();
    // 移除海外帳戶，模擬使用者沒有該類型帳戶；PLAN 要求證券加海外。
    site.main.controls = site.main.controls.filter(
      (control) => !control.name.startsWith("海外"),
    );
    const created = await driver().createKey(PLAN);
    expect(created.apiKey).toBe(API_KEY);
    expect(created.accountLabels).toEqual(["證券 ••••5678"]);
    expect(site.main.clicks).toContain("期權 - 王小明 9B87654321"); // 預設勾選，方案不要，取消
    expect(site.submitCount).toBe(1);
  });

  it("方案要的帳戶類型都不在表單上：NO_ACCOUNT_TYPE，未按確定", async () => {
    const { site, driver } = await atKeyDialog();
    site.main.controls = site.main.controls.filter(
      (control) => !control.name.startsWith("海外"),
    );
    const error = (await driver()
      .createKey({ ...PLAN, accountTypes: ["overseas"] })
      .catch((e: unknown) => e)) as OnboardingDriverError;
    expect(error).toBeInstanceOf(OnboardingDriverError);
    expect(error.code).toBe("ONBOARDING_NO_ACCOUNT_TYPE");
    expect(error.message).toBe("這個帳號沒有你選的任何帳戶類型。");
    expect(site.main.clicks).not.toContain("期權 - 王小明 9B87654321");
    expect(site.submitted).toBe(false);
  });

  it("交易加無限制 IP：照方案選「無限制 IP」並建立金鑰", async () => {
    const { site, driver } = await atKeyDialog();
    const trade: OnboardingPlan = {
      ...PLAN,
      permissions: { quote: true, account: true, trade: true, prod: true },
      ip: { mode: "unlimited", addresses: [] },
    };
    expect(await driver().createKey(trade)).toMatchObject({ apiKey: API_KEY });
    expect(site.main.clicks).toContain("交易");
    expect(site.main.clicks).toContain("無限制 IP");
    expect(site.main.clicks).not.toContain("+ 新增另一組 IP");
    expect(site.submitCount).toBe(1);
  });

  it("無效方案在 driver 內再擋一次", async () => {
    const { site, driver } = await atKeyDialog();
    expect(await codeOf(driver().createKey({ ...PLAN, name: "" }))).toBe(
      "ONBOARDING_INVALID_REQUEST",
    );
    expect(site.submitted).toBe(false);
  });

  it("「新增 API Key」忽略滑鼠點擊時，改用頁面內的 click 就能開啟身分驗證", async () => {
    const { site, driver } = setup({
      hasCertificate: true,
      addKeyIgnoresMouse: true,
    });
    await driver().login(credentials);
    await driver().openKeyIdentityDialog();
    expect(await driver().readOtpTargets("key")).toHaveLength(2);
    expect(site.main.clicks).toContain("新增 API Key");
  });

  it("欄位收不到鍵盤事件時（驗證碼、金鑰名稱），改用輸入法插入仍能完成金鑰申請", async () => {
    const { site, driver } = setup({ hasCertificate: true });
    await driver().login(credentials);
    await driver().openKeyIdentityDialog();
    await driver().readOtpTargets("key");
    await driver().sendOtp("key", "email", 0);
    site.main.typingIgnored = true;
    await driver().submitOtp("key", OTP_CODE);
    // 之後填表的名稱欄位同樣收不到鍵盤事件，也要靠輸入法備援填進去。
    expect(await driver().createKey(PLAN)).toMatchObject({ apiKey: API_KEY });
  });

  it("登入後首頁公告含「失敗」「停用」字樣：不會被誤判成密碼錯誤或帳戶鎖定", async () => {
    const { driver } = setup({ hasCertificate: true, bannerNoise: true });
    await expect(driver().login(credentials)).resolves.toBe("logged_in");
  });

  it("按下「確 定」之後連線中斷：一律回 KEY_CAPTURE_FAILED，請使用者回官網確認，不能當成可重來", async () => {
    const { site, driver } = setup({
      hasCertificate: true,
      dropAfterSubmit: true,
    });
    await driver().login(credentials);
    await driver().openKeyIdentityDialog();
    await driver().readOtpTargets("key");
    await driver().sendOtp("key", "email", 0);
    await driver().submitOtp("key", OTP_CODE);
    expect(await codeOf(driver().createKey(PLAN))).toBe(
      "ONBOARDING_KEY_CAPTURE_FAILED",
    );
    expect(site.submitted).toBe(true);
  });

  it("手機清單比 Email 晚載入也讀得到：回頭補讀手機", async () => {
    const { site, driver } = setup({ hasCertificate: true });
    // 手機清單 5 秒後才出現；舊版只等 3 秒，會只剩 Email。
    site.delaySmsList(5_000);
    await driver().login(credentials);
    await driver().openKeyIdentityDialog();
    const targets = await driver().readOtpTargets("key");
    expect(targets.map((target) => target.channel)).toContain("sms");
  });

  it("憑證頁剛載入、第一下按生日「確定」沒有反應：再按一次就能前進，不會停在生日步驟", async () => {
    const { driver } = setup({ birthdayFirstClickIgnored: true });
    await driver().login(credentials);
    await expect(driver().submitBirthday(BIRTHDAY)).resolves.toBeUndefined();
    expect((await driver().readOtpTargets("cert")).length).toBeGreaterThan(0);
  });

  it("驗證碼被讀回之後官網才自動換畫面：視為已通過，不會因找不到「確認驗證」而中止", async () => {
    const { driver } = setup({
      hasCertificate: true,
      autoSubmitAfterRead: true,
    });
    await driver().login(credentials);
    await driver().openKeyIdentityDialog();
    await driver().readOtpTargets("key");
    await driver().sendOtp("key", "email", 0);
    await expect(driver().submitOtp("key", OTP_CODE)).resolves.toBeUndefined();
    expect(await driver().createKey(PLAN)).toMatchObject({ apiKey: API_KEY });
  });

  it("API 管理頁被登出：SESSION_EXPIRED", async () => {
    const { site, driver } = setup({ hasCertificate: true });
    await driver().login(credentials);
    site.showLogin();
    expect(await codeOf(driver().openKeyIdentityDialog())).toBe(
      "ONBOARDING_SESSION_EXPIRED",
    );
  });
});

describe("永豐金證券 driver：機敏值不外洩", () => {
  it("頁面拋出夾帶機敏值的錯誤時，driver 只丟固定訊息", async () => {
    const { site, driver } = setup();
    const consoleSpies = (
      ["log", "warn", "error", "info", "debug"] as const
    ).map((method) => vi.spyOn(console, method));
    site.main.failWith = new Error(
      `Evaluation failed: ${PASSWORD} ${OTP_CODE} ${SECRET_KEY}`,
    );
    let thrown: unknown;
    try {
      await driver().login(credentials);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OnboardingDriverError);
    const text = JSON.stringify({
      message: (thrown as Error).message,
      code: (thrown as OnboardingDriverError).code,
      cause: (thrown as Error).cause,
      stack: (thrown as Error).stack?.split("\n")[0],
    });
    for (const secret of [PASSWORD, OTP_CODE, SECRET_KEY, ID_NUMBER]) {
      expect(text).not.toContain(secret);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("所有可預期失敗的訊息都不含帳密、驗證碼與金鑰", async () => {
    const collected: string[] = [];
    const attempts: (() => Promise<unknown>)[] = [];
    for (const loginResult of [
      "silent",
      "recaptcha",
      "bad_password",
      "locked",
    ] as const) {
      attempts.push(() => setup({ loginResult }).driver().login(credentials));
    }
    attempts.push(async () => {
      const { driver } = setup();
      await driver().login(credentials);
      await driver().submitBirthday(BIRTHDAY);
      await driver().sendOtp("cert", "sms", 0);
      await driver().submitOtp("cert", OTP_CODE.split("").reverse().join(""));
    });
    attempts.push(async () => {
      const { driver } = setup({ hasCertificate: true, dialog: "unparsable" });
      await driver().login(credentials);
      await driver().openKeyIdentityDialog();
      await driver().sendOtp("key", "sms", 0);
      await driver().submitOtp("key", OTP_CODE);
      await driver().createKey(PLAN);
    });
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch (error) {
        collected.push(
          [(error as Error).message, (error as Error).name].join(" "),
        );
      }
    }
    expect(collected).toHaveLength(attempts.length);
    for (const message of collected) {
      for (const secret of [
        PASSWORD,
        OTP_CODE,
        SECRET_KEY,
        API_KEY,
        ID_NUMBER,
      ]) {
        expect(message).not.toContain(secret);
      }
    }
  });
});
