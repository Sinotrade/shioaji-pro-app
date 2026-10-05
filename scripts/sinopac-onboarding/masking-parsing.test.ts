import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildDomScript,
  decodeDomScript,
  DOM_KIT_SOURCE,
} from "./dom-kit";
import { toDriverError } from "./errors";
import {
  maskAccountLabel,
  maskEmail,
  maskOtpTarget,
  maskPhone,
  scrubText,
} from "./masking";
import {
  accountTypeOf,
  loose,
  newLines,
  parseCountdownSeconds,
  parseKeySuccessDialog,
  regexOf,
} from "./parsing";
import { OnboardingDriverError } from "./driver";

describe("個資遮罩", () => {
  it("手機保留前 2 碼與後 3 碼，已遮罩的輸入得到相同格式", () => {
    expect(maskPhone("0912345678")).toBe("09*****678");
    expect(maskPhone("0981***950")).toBe("09*****950");
    expect(maskPhone("0912-345-678")).toBe("09*****678");
    expect(maskPhone("0912345678")).not.toContain("1234");
  });

  it("Email 保留第一個字元與網域", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("a***@example.com")).toBe("a***@example.com");
  });

  it("帳戶標籤只留類型與末四碼，丟掉戶名與完整帳號", () => {
    const masked = maskAccountLabel("證券 - 王小明 9A12345678");
    expect(masked).toBe("證券 ••••5678");
    expect(masked).not.toContain("王小明");
    expect(maskAccountLabel("期權 - 王小明 9B87654321")).toBe("期權 ••••4321");
    expect(maskAccountLabel("海外 - 王小明 7C11112222")).toBe("海外 ••••2222");
  });

  it("沒有帳號時不會把戶名尾巴當成帳號尾碼", () => {
    expect(maskAccountLabel("證券 - 王小明")).toBe("證券");
  });

  it("收碼選項只取出該管道的目標，其餘文字丟棄", () => {
    expect(maskOtpTarget("手機 0912345678 (預設)", "sms", 0)).toEqual({
      channel: "sms",
      index: 0,
      masked: "09*****678",
    });
    expect(maskOtpTarget("請選擇", "sms", 0)).toBeUndefined();
    expect(maskOtpTarget("alice@example.com", "sms", 0)).toBeUndefined();
    expect(maskOtpTarget("0912345678", "email", 0)).toBeUndefined();
    expect(maskOtpTarget("alice@example.com", "email", 2)).toEqual({
      channel: "email",
      index: 2,
      masked: "a***@example.com",
    });
  });

  it("條款文字中的 Email、身分證與手機也會被遮罩", () => {
    const scrubbed = scrubText(
      "聯絡 service@example.com，申請人 A123456789，電話 0912-345-678。",
    );
    expect(scrubbed).not.toContain("service@example.com");
    expect(scrubbed).not.toContain("A123456789");
    expect(scrubbed).not.toContain("345-678");
  });

  it("新式統一證號（第二碼 8／9）也會被遮罩", () => {
    const scrubbed = scrubText("居留證 A812345678、B912345678");
    expect(scrubbed).not.toContain("812345678");
    expect(scrubbed).not.toContain("912345678");
    expect(scrubbed).toContain("A*********");
  });
});

describe("解析", () => {
  it("解析倒數文字", () => {
    expect(parseCountdownSeconds("倒數4分57秒")).toBe(297);
    expect(parseCountdownSeconds("4分55秒")).toBe(295);
    expect(parseCountdownSeconds("倒數 0分 30秒")).toBe(30);
    expect(parseCountdownSeconds("45秒")).toBe(45);
  });

  it("解析不出來或不合理時退回 300 秒", () => {
    expect(parseCountdownSeconds("取得驗證碼")).toBe(300);
    expect(parseCountdownSeconds("")).toBe(300);
    expect(parseCountdownSeconds("99分00秒")).toBe(300);
    expect(parseCountdownSeconds("0分0秒")).toBe(300);
  });

  const apiKey = "A".repeat(44);
  const secretKey = "b".repeat(43) + "=";
  const dialog = (middle: string) =>
    `新增成功\nmy key\n建立時間: 2026/10/04 10:00:00\n${middle}\n請確保已將此保存完成，您將不會再次得到此 Secret Key。\n確 定`;

  it("解析新增成功視窗的兩組 44 字元金鑰", () => {
    const text = dialog(
      `API Key\n${apiKey}\n複製\nSecret Key\n${secretKey}\n複製`,
    );
    expect(parseKeySuccessDialog(text)).toEqual({ apiKey, secretKey });
  });

  it("標籤與金鑰在同一行也能解析", () => {
    const text = dialog(`API Key ${apiKey}\nSecret Key: ${secretKey}`);
    expect(parseKeySuccessDialog(text)).toEqual({ apiKey, secretKey });
  });

  it("金鑰後面接著同一排的「複製」按鈕文字也能解析", () => {
    const sameLine = dialog(
      `API Key\n${apiKey} 複製\nSecret Key\n${secretKey}複製`,
    );
    expect(parseKeySuccessDialog(sameLine)).toEqual({ apiKey, secretKey });
    const tabbed = dialog(
      `API Key\t${apiKey}\t複製\nSecret Key\t${secretKey}\t複 製`,
    );
    expect(parseKeySuccessDialog(tabbed)).toEqual({ apiKey, secretKey });
  });

  it("名稱剛好叫 API Key 時不會被誤認", () => {
    const text = `新增成功\nAPI Key\n建立時間: 2026/10/04 10:00:00\nAPI Key\n${apiKey}\nSecret Key\n${secretKey}`;
    expect(parseKeySuccessDialog(text)).toEqual({ apiKey, secretKey });
  });

  it.each([
    ["長度不是 44", `API Key\n${"A".repeat(43)}\nSecret Key\n${secretKey}`],
    ["缺少 Secret", `API Key\n${apiKey}`],
    ["兩組相同", `API Key\n${apiKey}\nSecret Key\n${apiKey}`],
    [
      "金鑰含空白",
      `API Key\n${"A".repeat(20)} ${"B".repeat(23)}\nSecret Key\n${secretKey}`,
    ],
    ["沒有標籤", `${apiKey}\n${secretKey}`],
  ])("嚴格模式拒絕：%s", (_label, middle) => {
    expect(parseKeySuccessDialog(dialog(middle))).toBeUndefined();
  });

  it("帳戶類型依前綴對應", () => {
    expect(accountTypeOf("證券 - 王小明 9A1")).toBe("stock");
    expect(accountTypeOf("期權 - 王小明 9B1")).toBe("futures");
    expect(accountTypeOf("海外 - 王小明 7C1")).toBe("overseas");
    expect(accountTypeOf("交易")).toBeUndefined();
  });

  it("loose 容許逐字空白但整串必須相符", () => {
    const login = regexOf(loose("登入"));
    expect(login.test("登 入")).toBe(true);
    expect(login.test("登入")).toBe(true);
    expect(login.test("  登  入 ")).toBe(true);
    expect(login.test("忘記登入")).toBe(false);
    expect(regexOf(loose("確定")).test("確 定")).toBe(true);
    expect(regexOf(loose("取得驗證碼")).test("取 得 驗 證 碼")).toBe(true);
  });

  it("newLines 只回傳按下按鈕之後新出現的行", () => {
    expect(newLines("a\nb", "a\nb\n密碼錯誤\n")).toEqual(["密碼錯誤"]);
    expect(newLines("a", "a")).toEqual([]);
  });
});

// 行分隔符；直接寫成字面值會讓檔案本身被工具誤判，所以用字元碼組出來。
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("頁面端程式碼", () => {
  it("DOM kit 是語法正確的函式運算式", () => {
    // 只編譯、不執行：驗證語法；DOM 比對本身沒有 DOM 環境可測（UNVERIFIED）。
    expect(() => new Script(`(${DOM_KIT_SOURCE})`)).not.toThrow();
  });

  it("DOM kit 不含 keepNames 會注入的 __name，也沒有密碼寫死", () => {
    expect(DOM_KIT_SOURCE).not.toContain("__name");
  });

  it("buildDomScript 與 decodeDomScript 可往返，含 U+2028 的使用者輸入", () => {
    const op = {
      kind: "set" as const,
      role: "textbox" as const,
      name: "到期時間",
      flags: "i",
      value: `a${LS}b${PS}c`,
    };
    const script = buildDomScript(op);
    expect(script).not.toContain(LS);
    expect(script).not.toContain(PS);
    expect(decodeDomScript(script)).toEqual(op);
    // 組出來的整段腳本本身是合法的 JS 運算式。
    expect(() => new Script(script)).not.toThrow();
  });
});

describe("錯誤對應", () => {
  it("OnboardingDriverError 原樣放行", () => {
    const error = new OnboardingDriverError(
      "ONBOARDING_OTP_INVALID",
      "固定訊息",
    );
    expect(toDriverError(error)).toBe(error);
  });

  it.each([
    [
      "Protocol error (Runtime.callFunctionOn): Target closed",
      "ONBOARDING_SESSION_EXPIRED",
    ],
    ["Navigation timeout of 30000 ms exceeded", "ONBOARDING_BLOCKED_BY_SITE"],
    [
      "Evaluation failed: TypeError: x is not a function",
      "ONBOARDING_SITE_CHANGED",
    ],
  ])("未知錯誤只用來分類：%s", (message, code) => {
    const mapped = toDriverError(new Error(`${message} SENTINEL-PASSWORD-123`));
    expect(mapped.code).toBe(code);
    expect(mapped.message).not.toContain("SENTINEL");
    expect(mapped.message).not.toContain(message);
    expect(mapped.cause).toBeUndefined();
  });

  it("非 Error 的 throw 也轉成固定訊息", () => {
    expect(toDriverError("SENTINEL-PASSWORD-123").code).toBe(
      "ONBOARDING_SITE_CHANGED",
    );
  });
});
