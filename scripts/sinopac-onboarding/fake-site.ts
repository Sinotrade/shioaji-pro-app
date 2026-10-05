import {
  decodeDomScript,
  type DomRole,
} from "./dom-kit";
import { regexOf } from "./parsing";
import type {
  BrowserLike,
  DialogLike,
  DriverClock,
  PageLike,
} from "./sinopac-driver";

/**
 * 腳本化的永豐金證券官網假頁面：不執行 DOM 程式碼，直接解讀 driver 送出的 op，
 * 用一個小狀態機模擬真實畫面的轉場。這裡的畫面文字與控制項名稱取自已觀察到的事實，
 * 但整體只驗證 driver 的控制流程，不證明真實 DOM 比對正確（見 dom-kit.ts 的 UNVERIFIED）。
 */

export const ID_NUMBER = "SENTINELID1";
export const PASSWORD = "SENTINEL-PASSWORD-123";
export const OTP_CODE = "654321";
export const BIRTHDAY = "19900101";
export const API_KEY = "SENTINELAPIKEY".padEnd(44, "a");
export const SECRET_KEY = "SENTINELSECRETKEY".padEnd(44, "z");
const OLD_KEY = "OLDEXISTINGKEY".padEnd(44, "o");
const MANAGE_URL = "https://www.sinotrade.com.tw/newweb/PythonAPIKey/";

export class FakeClock implements DriverClock {
  time = 0;
  private timers: { at: number; run: () => void }[] = [];
  now() {
    return this.time;
  }
  after(ms: number, run: () => void) {
    this.timers.push({ at: this.time + ms, run });
  }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.time = Math.max(this.time, due.at);
      due.run();
    }
    this.time = target;
  }
  async sleep(ms: number) {
    this.advance(ms);
  }
}

export interface FakeControl {
  role: DomRole;
  name: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  group?: string;
  /** 模擬網站沒有回應點擊 */
  stuck?: boolean;
  /** 模擬網站只回應頁面內的 click，忽略滑鼠事件（實測的「新增 API Key」） */
  ignoresMouse?: boolean;
  onClick?: () => void;
}

export class FakePage implements PageLike {
  scripts: string[] = [];
  clicks: string[] = [];
  controls: FakeControl[] = [];
  text = "";
  terms = "";
  select = {
    options: [] as string[],
    selected: 0,
    onChange: undefined as (() => void) | undefined,
  };
  closed = false;
  focused?: FakeControl;
  /** 讀取欄位值時的鉤子（模擬官網在輸入完成後才自動換畫面）。 */
  onRead?: (name: string) => void;
  failWith?: Error;
  /** 接下來幾次 evaluate 都模擬「換頁造成執行環境被銷毀」。 */
  flakyCalls = 0;
  onGoto?: () => void;
  private dialogHandler?: (dialog: DialogLike) => void;

  constructor(public currentUrl: string) {}

  url() {
    return this.currentUrl;
  }
  isClosed() {
    return this.closed;
  }
  async goto(url: string) {
    this.currentUrl = url;
    this.onGoto?.();
  }
  on(_event: "dialog", handler: (dialog: DialogLike) => void) {
    this.dialogHandler = handler;
  }
  viewports: { width: number; height: number }[] = [];
  async setViewport(viewport: { width: number; height: number }) {
    this.viewports.push(viewport);
  }
  /** 模擬網站跳出原生對話方塊，回傳 driver 是接受還是取消。 */
  fireDialog(type: string, message: string) {
    const result = { accepted: false, dismissed: false };
    this.dialogHandler?.({
      type: () => type,
      message: () => message,
      accept: async () => {
        result.accepted = true;
      },
      dismiss: async () => {
        result.dismissed = true;
      },
    });
    return result;
  }
  alert(message: string) {
    return this.fireDialog("alert", message);
  }

  private press(control: FakeControl | undefined) {
    if (!control || control.disabled) return;
    this.clicks.push(control.name);
    if (control.stuck) return;
    if (control.role === "checkbox") control.checked = !control.checked;
    if (control.role === "radio") {
      for (const other of this.controls) {
        if (other.role === "radio" && other.group === control.group) {
          other.checked = false;
        }
      }
      control.checked = true;
    }
    control.onClick?.();
  }

  mouse = {
    click: async (x: number, _y: number) => {
      const control = this.controls[x];
      if (control?.ignoresMouse) return;
      this.press(control);
    },
  };
  /** 模擬鍵盤事件沒有進到欄位（實測的驗證碼欄位）；輸入法插入仍然有效。 */
  typingIgnored = false;
  keyboard = {
    type: async (text: string) => {
      if (this.typingIgnored) return;
      if (this.focused) {
        this.focused.value = (this.focused.value ?? "") + text;
      }
    },
    sendCharacter: async (text: string) => {
      if (this.focused) {
        this.focused.value = (this.focused.value ?? "") + text;
      }
    },
    press: async (key: string) => {
      if (key === "Backspace" && this.focused) this.focused.value = "";
    },
  };

  private matches(op: { role: DomRole; name: string; flags?: string }) {
    const re = regexOf(op);
    return this.controls.filter(
      (control) => control.role === op.role && re.test(control.name),
    );
  }

  async evaluate(script: string): Promise<unknown> {
    if (this.failWith) throw this.failWith;
    if (this.flakyCalls > 0) {
      this.flakyCalls--;
      throw new Error(
        "Execution context was destroyed, most likely because of a navigation.",
      );
    }
    this.scripts.push(script);
    const op = decodeDomScript(script);
    switch (op.kind) {
      case "text":
        return {
          url: this.currentUrl,
          text: op.scope === "terms" ? this.terms : this.text,
        };
      case "find": {
        const list = this.matches(op);
        const control = op.nth === undefined ? list.at(-1) : list[op.nth];
        return control ? this.state(control) : { found: false };
      }
      case "list":
        return {
          found: true,
          items: this.matches(op).map((c) => this.state(c)),
        };
      case "click": {
        const list = this.matches(op);
        const control = op.nth === undefined ? list.at(-1) : list[op.nth];
        this.press(control);
        return { found: Boolean(control) };
      }
      case "focus": {
        const list = this.matches(op);
        const control = op.nth === undefined ? list.at(-1) : list[op.nth];
        this.focused = control;
        return { found: Boolean(control) };
      }
      case "value": {
        const list = this.matches(op);
        const control = op.nth === undefined ? list.at(-1) : list[op.nth];
        if (!control) return { found: false, length: 0 };
        const value = control.value ?? "";
        this.onRead?.(control.name);
        return {
          found: true,
          length: value.length,
          value: op.reveal ? value : undefined,
        };
      }
      case "set": {
        const control = this.matches(op).at(-1);
        if (control) control.value = op.value;
        return { found: Boolean(control) };
      }
      case "options":
        return {
          found: this.select.options.length > 0,
          selected: this.select.selected,
          options: this.select.options.map((text) => ({
            text,
            disabled: false,
          })),
        };
      case "pick":
        this.select.selected = op.index;
        this.select.onChange?.();
        return { found: true, selected: op.index, options: [] };
    }
  }

  private state(control: FakeControl) {
    return {
      found: true,
      x: this.controls.indexOf(control),
      y: 0,
      label: control.name,
      text: control.role === "textbox" ? "" : control.name,
      checked: control.checked === true,
      disabled: control.disabled === true,
    };
  }
}

export interface SiteOptions {
  /** 遠端瀏覽器已有憑證：登入直接進 API 管理頁 */
  hasCertificate?: boolean;
  loginResult?: "ok" | "bad_password" | "locked" | "recaptcha" | "silent";
  /** 網址先是 PythonAPIKey、頁面骨架先出現 API 管理文字，過一下才轉到登入頁。 */
  skeletonFirst?: boolean;
  /** 登入後是否彈出 WebCA 視窗（沒有憑證時） */
  popupAppears?: boolean;
  certClosesAfterTerms?: boolean;
  /** 憑證安裝後重新登入又彈出 WebCA */
  secondLoginPopup?: boolean;
  keyLimit?: boolean;
  /** 輸入完驗證碼並被讀回之後，官網才自動換成金鑰表單（欄位與「確認驗證」一起消失）。 */
  autoSubmitAfterRead?: boolean;
  /** 憑證頁剛載入、第一下按生日「確定」沒有反應（實測網站慢的時候）。 */
  birthdayFirstClickIgnored?: boolean;
  /** 按下送出「確 定」之後連線中斷（金鑰其實已建立）。 */
  dropAfterSubmit?: boolean;
  /** 按下登入後首頁輪播公告出現含「失敗」「停用」的字樣。 */
  bannerNoise?: boolean;
  /** 「新增 API Key」忽略滑鼠點擊，只回應頁面內的 click（實測的永豐金證券行為）。 */
  addKeyIgnoresMouse?: boolean;
  otpFailure?: "text" | "silent" | "expired_text";
  dialog?: "ok" | "unparsable" | "never";
  /** 表單中名稱符合的控制項不回應點擊 */
  stuckControl?: string;
  /** 成功視窗出現後，表單的「確 定」仍然可按（視窗不是模態） */
  successOverlap?: boolean;
  /** 表單上另有一個同名的「確 定」按鈕 */
  duplicateConfirm?: boolean;
}

export class FakeSinopacSite {
  clock = new FakeClock();
  main = new FakePage("about:blank");
  pages: FakePage[] = [this.main];
  ca?: FakePage;
  loginPresses = 0;
  certInstalled: boolean;
  submitted = false;
  private smsDelayMs = 0;
  private birthdayClicked = false;
  /** 身分驗證視窗的手機清單延後多久才載入。要在開啟視窗之前呼叫。 */
  delaySmsList(ms: number) {
    this.smsDelayMs = ms;
  }
  submitCount = 0;
  sentTo = "";
  typedCredentials = { id: "", password: "" };
  browser: BrowserLike = {
    // 刻意連已關閉的分頁一起回傳，驗證 driver 自己會過濾。
    pages: async () => [...this.pages],
    newPage: async () => this.main,
  };

  constructor(public opts: SiteOptions = {}) {
    this.certInstalled = opts.hasCertificate ?? false;
    this.main.onGoto = () => {
      if (!this.main.currentUrl.includes("/PythonAPIKey")) return;
      if (this.opts.skeletonFirst) {
        // 實測：網址一開始是 PythonAPIKey，頁面骨架先顯示 API 管理的文字，約 2 秒後才轉到登入頁。
        this.showSkeleton();
        this.clock.after(1_500, () => this.showLogin());
        return;
      }
      this.showLogin();
    };
  }

  // ---- 主分頁 ----

  showSkeleton() {
    const main = this.main;
    main.currentUrl = MANAGE_URL;
    main.text =
      "客戶登入\nAPI 管理\n最多可建立 30 個 API Key\n下載憑證\n新增 API Key";
    main.controls = [];
  }

  showLogin() {
    const main = this.main;
    main.currentUrl = "https://www.sinotrade.com.tw/newweb/";
    main.text =
      "登入\n請輸入身份證字號\n密碼\n記住我的身份證字號\n本網站受 Google reCAPTCHA 保護";
    main.controls = [
      { role: "textbox", name: "請輸入身份證字號", value: "" },
      { role: "textbox", name: "密碼", value: "" },
      { role: "checkbox", name: "記住我的身份證字號" },
      { role: "button", name: "登 入", onClick: () => this.onLogin() },
    ];
  }

  private onLogin() {
    this.loginPresses++;
    this.typedCredentials = {
      id: this.main.controls[0]!.value ?? "",
      password: this.main.controls[1]!.value ?? "",
    };
    const result = this.opts.loginResult ?? "ok";
    // 首頁輪播公告可能出現「失敗」「停用」等字樣，不能被當成登入失敗。
    if (this.opts.bannerNoise) {
      this.main.text +=
        "\n【公告】盤後交易失敗改單說明\n【公告】舊版下單軟體停用通知";
    }
    if (result === "bad_password") this.main.text += "\n帳號或密碼錯誤";
    else if (result === "locked") {
      this.main.text += "\n密碼輸入錯誤已達上限，帳號已鎖定";
    } else if (result === "recaptcha") {
      this.main.text += "\n請勾選檢核框後再試";
    } else if (result === "silent") {
      // 沒有任何反應
    } else if (this.loginPresses >= 2 && this.opts.secondLoginPopup) {
      this.openPopup();
    } else if (!this.certInstalled) {
      if (this.opts.popupAppears !== false) this.openPopup();
    } else {
      this.clock.after(800, () => this.showManage());
    }
  }

  showManage() {
    const main = this.main;
    main.currentUrl = MANAGE_URL;
    main.text = `API 管理介面\n登出\n最多可建立 30 個 API Key\n下載憑證\n新增 API Key\nAPI Key\n${OLD_KEY}`;
    main.controls = [
      { role: "button", name: "下載憑證" },
      {
        role: "button",
        name: "新增 API Key",
        ignoresMouse: this.opts.addKeyIgnoresMouse,
        onClick: () => {
          if (this.opts.keyLimit) {
            main.text += "\n已達 API Key 數量上限，無法新增";
            return;
          }
          this.showIdentity();
        },
      },
    ];
  }

  private showIdentity() {
    const main = this.main;
    main.text += "\n身份驗證\n手機\nEmail 信箱\n請輸入驗證碼\n發送驗證碼";
    const setSms = () => {
      main.select = {
        options: ["請選擇", "0912345678"],
        selected: 0,
        onChange: undefined,
      };
    };
    const setEmail = () => {
      main.select = {
        options: ["請選擇", "bob@example.org"],
        selected: 0,
        onChange: undefined,
      };
    };
    if (this.opts.autoSubmitAfterRead) {
      main.onRead = (name) => {
        if (name !== "請輸入驗證碼") return;
        main.onRead = undefined;
        this.clock.after(200, () => this.showKeyForm());
      };
    }
    setSms();
    if (this.smsDelayMs > 0) {
      // 手機清單晚一點才載入（真實頁面實測）：先是空的，之後才出現。
      const phone = main.select;
      main.select = { options: [], selected: 0, onChange: undefined };
      this.clock.after(this.smsDelayMs, () => {
        if (main.select.options.length === 0) main.select = phone;
      });
    }
    main.controls.push(
      {
        role: "radio",
        name: "手機",
        checked: true,
        group: "k",
        onClick: setSms,
      },
      { role: "radio", name: "Email 信箱", group: "k", onClick: setEmail },
      {
        role: "button",
        name: "發送驗證碼",
        onClick: () => {
          this.sentTo = main.select.options[main.select.selected] ?? "";
          main.controls = main.controls.filter((c) => c.name !== "發送驗證碼");
          main.controls.push({
            role: "button",
            name: "4分55秒",
            disabled: true,
          });
          this.clock.after(295_000, () => {
            main.controls = main.controls.filter((c) => c.name !== "4分55秒");
            main.controls.push({ role: "button", name: "發送驗證碼" });
          });
        },
      },
      { role: "textbox", name: "請輸入驗證碼", value: "" },
      { role: "button", name: "取 消" },
      {
        role: "button",
        name: "確認驗證",
        onClick: () => {
          const code = main.controls.find((c) => c.name === "請輸入驗證碼");
          if (code?.value === OTP_CODE) {
            this.clock.after(300, () => this.showKeyForm());
          } else this.otpFailed(main);
        },
      },
    );
  }

  private showKeyForm() {
    const main = this.main;
    main.text =
      "API 管理介面\n新增 API KEY\nAPI Key名稱 :\n到期時間 :\n行情／資料\n帳務\n交易\n正式環境\n限制 IP (推薦)\n無限制 IP\n+ 新增另一組 IP";
    const stuck = (name: string) => name === this.opts.stuckControl;
    const box = (name: string, checked: boolean): FakeControl => ({
      role: "checkbox",
      name,
      checked,
      stuck: stuck(name),
    });
    const ipBox = (): FakeControl => ({
      role: "textbox",
      name: "請輸入IP位置",
      value: "",
    });
    main.controls = [
      { role: "textbox", name: "API Key名稱 :", value: "" },
      { role: "textbox", name: "到期時間 :", value: "2027-10-04" },
      box("行情／資料", true),
      box("帳務", true),
      box("交易", false),
      box("正式環境", true),
      box("證券 - 王小明 9A12345678", true),
      box("期權 - 王小明 9B87654321", true),
      box("海外 - 王小明 7C11112222", false),
      { role: "radio", name: "限制 IP (推薦)", checked: true, group: "ip" },
      { role: "radio", name: "無限制 IP", group: "ip" },
      ipBox(),
      {
        role: "text",
        name: "+ 新增另一組 IP",
        onClick: () => {
          const at = main.controls.findIndex((c) => c.role === "text");
          main.controls.splice(at, 0, ipBox());
        },
      },
      { role: "button", name: "取 消" },
      ...(this.opts.duplicateConfirm
        ? [{ role: "button" as const, name: "確 定" }]
        : []),
      { role: "button", name: "確 定", onClick: () => this.onSubmitKey() },
    ];
  }

  private onSubmitKey() {
    this.submitted = true;
    this.submitCount++;
    if (this.opts.dropAfterSubmit) {
      this.main.failWith = new Error(
        "Protocol error (Runtime.callFunctionOn): Target closed",
      );
      return;
    }
    const mode = this.opts.dialog ?? "ok";
    if (mode === "never") return;
    this.clock.after(600, () => {
      const main = this.main;
      const stamp = "建立時間: 2026/10/04 10:00:00";
      const [apiKey, secretKey] =
        mode === "ok" ? [API_KEY, SECRET_KEY] : ["tooShort", "alsoShort"];
      main.text = `API 管理介面\nAPI Key\n${OLD_KEY}\n新增成功\nmy key\n${stamp}\nAPI Key\n${apiKey}\n複製\nSecret Key\n${secretKey}\n複製\n請確保已將此保存完成，您將不會再次得到此 Secret Key。\n確 定`;
      const close: FakeControl = {
        role: "button",
        name: "確 定",
        onClick: () => this.showManage(),
      };
      main.controls = this.opts.successOverlap
        ? [...main.controls, close]
        : [close];
    });
  }

  // ---- WebCA 彈出視窗 ----

  private openPopup() {
    const popup = new FakePage("about:blank");
    this.pages.push(popup);
    this.ca = popup;
    this.clock.after(500, () => {
      popup.currentUrl = "https://ca.sinotrade.com.tw/WebCAEx/WebCA";
      this.showBirthday(popup);
    });
  }

  private showBirthday(popup: FakePage) {
    popup.text = "生日驗證\n請輸入8 碼西元年生日";
    popup.controls = [
      { role: "textbox", name: "請輸入8 碼西元年生日 (YYYYMMDD)", value: "" },
      {
        role: "button",
        name: "確定",
        onClick: () => {
          if (this.opts.birthdayFirstClickIgnored && !this.birthdayClicked) {
            this.birthdayClicked = true;
            return;
          }
          if (popup.controls[0]!.value === BIRTHDAY) {
            this.clock.after(300, () => this.showBirthCheck(popup));
          } else popup.text += "\n生日驗證失敗";
        },
      },
    ];
  }

  private showBirthCheck(popup: FakePage) {
    popup.currentUrl = "https://ca.sinotrade.com.tw/WebCAEx/BirthCheck";
    popup.text = "OTP 驗證\n手機\nEmail信箱\n取得驗證碼";
    const setSms = () => {
      popup.select = {
        options: ["請選擇", "0981***950", "0922***333"],
        selected: 0,
        onChange: undefined,
      };
    };
    const setEmail = () => {
      popup.select = {
        options: ["請選擇", "alice@example.com"],
        selected: 0,
        onChange: undefined,
      };
    };
    setSms();
    popup.controls = [
      {
        role: "radio",
        name: "手機",
        checked: true,
        group: "c",
        onClick: setSms,
      },
      { role: "radio", name: "Email信箱", group: "c", onClick: setEmail },
      {
        role: "button",
        name: "取得驗證碼",
        onClick: () => {
          this.sentTo = popup.select.options[popup.select.selected] ?? "";
          popup.controls.forEach((c) => {
            if (c.role === "radio") c.disabled = true;
          });
          popup.controls = popup.controls.filter(
            (c) => c.name !== "取得驗證碼",
          );
          popup.controls.push(
            { role: "button", name: "倒數4分57秒", disabled: true },
            { role: "textbox", name: "請輸入驗證碼", value: "" },
            {
              role: "button",
              name: "確定",
              onClick: () => {
                const code = popup.controls.find(
                  (c) => c.name === "請輸入驗證碼",
                );
                if (code?.value === OTP_CODE) {
                  this.clock.after(300, () => this.showTerms(popup));
                } else this.otpFailed(popup);
              },
            },
          );
          this.clock.after(297_000, () => {
            popup.controls = popup.controls.filter(
              (c) => c.name !== "倒數4分57秒",
            );
            popup.controls.push({ role: "button", name: "取得驗證碼" });
          });
        },
      },
    ];
  }

  private otpFailed(page: FakePage) {
    const failure = this.opts.otpFailure ?? "text";
    if (failure === "text") page.text += "\n驗證碼錯誤，請重新輸入";
    if (failure === "expired_text") page.text += "\n驗證碼已逾時";
  }

  private showTerms(popup: FakePage) {
    popup.currentUrl = "https://ca.sinotrade.com.tw/WebCAEx/OTPRet";
    popup.terms =
      "TWCA 電子憑證作業條款\n第一條 用戶申請電子憑證時應提供正確資料。\n第二條 用戶應妥善保管憑證。\n聯絡信箱 service@example.com\n第四條 不得洩漏或交付予他人使用。";
    popup.text = `憑證申請\n${popup.terms}\n我已閱讀並同意憑證作業條款\n確定\n取消`;
    popup.controls = [
      { role: "checkbox", name: "我已閱讀並同意憑證作業條款" },
      {
        role: "button",
        name: "確定",
        onClick: () => {
          if (!popup.controls[0]!.checked) return;
          popup.currentUrl =
            "https://osu.sinotrade.com.tw/html5CA/webcaDepEx.html";
          if (this.opts.certClosesAfterTerms === false) return;
          this.clock.after(3_000, () => {
            popup.closed = true;
            this.certInstalled = true;
            this.showLogin(); // 主分頁登入框被清空
          });
        },
      },
      { role: "button", name: "取消" },
    ];
  }
}
