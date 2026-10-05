import type { Pattern } from "./parsing";

/**
 * 在遠端瀏覽器頁面內執行的唯一一段 DOM 程式碼。
 *
 * - 以字串（String.raw）保存而不是 TS 函式：Wrangler 預設 esbuild keepNames，會在函式內插入
 *   `__name(...)`，函式經 Puppeteer 序列化到頁面後會因 `__name` 不存在而丟錯。字串不受打包器改寫。
 * - 元件以「角色＋名稱」或可見文字定位，名稱用寬鬆的正規表示式（官網按鈕常有多餘空白）。
 *   不使用 CSS class 選擇器。
 * - 密碼、OTP 一律不放進這段程式碼；driver 以 keyboard.type 輸入，這裡只回報長度。
 *
 * DOM 比對已在登入框、憑證彈出視窗、身分驗證視窗（Ant Design）與新增表單於真實頁面運作；單元測試只涵蓋
 * 控制流程與解析，不涵蓋 DOM 比對。其他頁面狀態若找不到元件，先調整這裡的 names() 與 SEL。
 */

export type DomRole =
  "button" | "radio" | "checkbox" | "textbox" | "select" | "text";

export type DomOp =
  | { kind: "text"; scope?: "page" | "terms" }
  | ({ kind: "find"; role: DomRole; nth?: number } & Pattern)
  | ({ kind: "list"; role: DomRole } & Pattern)
  | ({ kind: "focus"; role: DomRole; nth?: number } & Pattern)
  | ({ kind: "click"; role: DomRole; nth?: number } & Pattern)
  | ({ kind: "value"; role: DomRole; nth?: number; reveal?: boolean } & Pattern)
  | ({ kind: "set"; role: DomRole; nth?: number; value: string } & Pattern)
  | { kind: "options" }
  | { kind: "pick"; index: number };

export interface DomText {
  url: string;
  text: string;
}
export interface DomHit {
  found: boolean;
  x: number;
  y: number;
  label: string;
  text: string;
  checked: boolean;
  disabled: boolean;
}
export interface DomList {
  found: boolean;
  items: DomHit[];
}
export interface DomValue {
  found: boolean;
  length: number;
  value?: string;
}
export interface DomOptions {
  found: boolean;
  selected: number;
  options: { text: string; disabled: boolean }[];
}

export const DOM_KIT_SOURCE = String.raw`(op) => {
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const re = typeof op.name === "string" ? new RegExp(op.name, op.flags || "i") : null;
  const SEL = {
    button: 'button, [role="button"], input[type="button"], input[type="submit"]',
    radio: 'input[type="radio"], [role="radio"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    textbox: 'input:not([type]), input[type="text"], input[type="password"], input[type="tel"], input[type="date"], input[type="number"], input[type="email"], input[type="search"], textarea, [role="textbox"]',
    select: 'select, [role="combobox"]',
    text: "body *",
  };
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  // 原生核取方塊常被縮成 0 大小，改點它外層的 label。
  const hitOf = (el) => {
    if (shown(el)) return el;
    const lab = el.closest("label");
    return lab && shown(lab) ? lab : null;
  };
  const names = (el) => {
    const out = [];
    const add = (v) => { const t = norm(v); if (t) out.push(t); };
    add(el.getAttribute("aria-label"));
    const by = el.getAttribute("aria-labelledby");
    if (by) add(by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" "));
    if (el.labels) for (const l of el.labels) add(l.textContent);
    const tag = el.tagName;
    if (tag === "INPUT" && /^(button|submit)$/i.test(el.type)) add(el.value);
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") add(el.textContent);
    add(el.getAttribute("placeholder"));
    add(el.getAttribute("title"));
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      // 往上找「只含這一個欄位、又有文字」的最近容器，當作它的標籤。
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        if (p.querySelectorAll("input, select, textarea").length !== 1) break;
        add(p.textContent);
      }
    }
    return out;
  };
  const candidates = () => {
    const out = [];
    for (const el of document.querySelectorAll(SEL[op.role])) {
      const hit = hitOf(el);
      if (!hit) continue;
      if (op.role === "text") {
        const t = norm(el.textContent);
        if (!re.test(t)) continue;
        if (Array.from(el.children).some((c) => re.test(norm(c.textContent)) && hitOf(c))) continue;
        out.push({ el, hit, label: t });
      } else {
        const ns = names(el);
        const label = re ? ns.find((n) => re.test(n)) : ns[0];
        if (re && label === undefined) continue;
        out.push({ el, hit, label: label || "" });
      }
    }
    return out;
  };
  // 捲到畫面中央並檢查中心點沒有被別的元素（例如對話方塊後面的遮罩）蓋住。
  const probe = (c) => {
    c.hit.scrollIntoView({ block: "center", inline: "center" });
    const b = c.hit.getBoundingClientRect();
    c.x = Math.round(b.left + b.width / 2);
    c.y = Math.round(b.top + b.height / 2);
    const top = document.elementFromPoint(c.x, c.y);
    const lab = c.el.closest("label");
    c.free = !!top && (top === c.hit || c.hit.contains(top) || top.contains(c.hit) || (lab !== null && lab.contains(top)));
    return c;
  };
  // clickable：要用滑鼠點的元件必須沒被蓋住。讀值與聚焦不需要點得到：
  // 官網的身分證欄位輸入後會被遮罩顯示蓋住（R12****212），這時改用全部符合的元件，不能判成找不到。
  const choose = (nth, clickable) => {
    const probed = candidates().map(probe);
    const free = probed.filter((c) => c.free);
    const list = clickable || free.length ? free : probed;
    if (!list.length) return { list, c: null };
    // 預設取 DOM 順序最後一個：後出現的通常是疊在最上層的對話方塊。
    const c = nth === undefined || nth === null ? list[list.length - 1] : list[nth] || null;
    return { list, c: c ? probe(c) : null };
  };
  const state = (c) => {
    const el = c.el;
    const field = el.tagName === "INPUT" ? /^(button|submit)$/i.test(el.type) : el.tagName !== "TEXTAREA";
    return {
      found: true,
      x: c.x,
      y: c.y,
      label: c.label,
      text: field ? norm(el.tagName === "INPUT" ? el.value : el.textContent) : "",
      checked: el.checked === true || el.getAttribute("aria-checked") === "true",
      disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true",
    };
  };
  const dispatch = (el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const lastSelect = () => {
    const all = Array.from(document.querySelectorAll("select")).filter((s) => hitOf(s));
    return all[all.length - 1] || null;
  };
  // 永豐金證券的身分驗證視窗用 Ant Design 的 Select（input[role=combobox]），不是原生 select；
  // 它只有展開時才有選項清單，所以只讀目前顯示的值。
  const lastAntdSelect = () => {
    const all = Array.from(document.querySelectorAll(".ant-select")).filter((s) => hitOf(s));
    return all[all.length - 1] || null;
  };
  const antdValue = (s) => {
    const item = s.querySelector(".ant-select-selection-item");
    return item ? norm(item.getAttribute("title") || item.textContent) : "";
  };

  switch (op.kind) {
    case "text": {
      if (op.scope === "terms") {
        // 條款框：取「沒有包含其他可捲動容器」的可捲動元素中文字最長者。
        const scrollers = [];
        for (const el of document.querySelectorAll("body *")) {
          const s = getComputedStyle(el);
          const text = (el.tagName === "TEXTAREA" ? el.value : el.innerText) || "";
          const scrolls = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
          if ((scrolls || el.tagName === "TEXTAREA") && shown(el) && text.length > 50) scrollers.push({ el, text });
        }
        const leaves = scrollers.filter((a) => !scrollers.some((b) => b !== a && a.el.contains(b.el)));
        leaves.sort((a, b) => b.text.length - a.text.length);
        return { url: location.href, text: leaves.length ? leaves[0].text : "" };
      }
      return { url: location.href, text: document.body ? document.body.innerText : "" };
    }
    case "find": {
      const { c } = choose(op.nth, true);
      return c ? state(c) : { found: false };
    }
    case "list": {
      return { found: true, items: choose(undefined, true).list.map(state) };
    }
    case "click": {
      // 直接在頁面內觸發 click：永豐金證券 API 管理頁的「新增 API Key」對 CDP 滑鼠事件沒有反應，頁面內的 click 才會開啟身分驗證。
      const { c } = choose(op.nth, true);
      if (!c) return { found: false };
      c.hit.click();
      return { found: true };
    }
    case "focus": {
      const { c } = choose(op.nth, false);
      if (!c) return { found: false };
      c.el.focus();
      if (typeof c.el.select === "function") { try { c.el.select(); } catch (e) {} }
      return { found: true };
    }
    case "value": {
      const { c } = choose(op.nth, false);
      if (!c) return { found: false, length: 0 };
      const v = String(c.el.value != null ? c.el.value : c.el.textContent || "");
      return { found: true, length: v.length, value: op.reveal && c.el.type !== "password" ? v : undefined };
    }
    case "set": {
      const { c } = choose(op.nth, false);
      if (!c) return { found: false };
      const proto = c.el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(c.el, op.value);
      dispatch(c.el);
      return { found: true };
    }
    case "options": {
      const s = lastSelect();
      if (s) return { found: true, selected: s.selectedIndex, options: Array.from(s.options).map((o) => ({ text: norm(o.textContent), disabled: o.disabled })) };
      // 身分驗證視窗每個管道只有一個登記的號碼：把目前顯示的值當唯一選項。
      const a = lastAntdSelect();
      const value = a ? antdValue(a) : "";
      if (!value) return { found: false, selected: -1, options: [] };
      return { found: true, selected: 0, options: [{ text: value, disabled: false }] };
    }
    case "pick": {
      const s = lastSelect();
      if (s) {
        s.selectedIndex = op.index;
        dispatch(s);
        return { found: true, selected: s.selectedIndex, options: [] };
      }
      const a = lastAntdSelect();
      return { found: Boolean(a && antdValue(a)) && op.index === 0, selected: 0, options: [] };
    }
    default:
      return { found: false };
  }
}`;

/** U+2028／U+2029 在 JS 字串字面值內需跳脫，保險起見一律處理（方案名稱來自使用者輸入）。 */
export function buildDomScript(op: DomOp): string {
  const json = JSON.stringify(op)
    .split(String.fromCharCode(0x2028))
    .join("\\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\\u2029");
  return `(${DOM_KIT_SOURCE})(${json})`;
}

/** 測試用：把 buildDomScript 的結果還原成 op，讓假頁面不必真的執行 DOM 程式碼。 */
export function decodeDomScript(script: string): DomOp {
  const prefix = `(${DOM_KIT_SOURCE})(`;
  if (!script.startsWith(prefix) || !script.endsWith(")")) {
    throw new Error("unexpected dom script");
  }
  return JSON.parse(script.slice(prefix.length, -1)) as DomOp;
}
