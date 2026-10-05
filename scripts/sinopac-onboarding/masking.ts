import type {
  OnboardingOtpChannel,
  OnboardingOtpTarget,
} from "../../src/lib/sinopac-onboarding/types";

/** 個資離開 driver 之前一律先遮罩。永豐金證券頁面可能顯示未遮罩的手機號碼與完整帳號。 */

const PHONE = /\+?\d[\d*＊•xX-]{5,}\d/;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/;

/** 保留前 2 碼與後 3 碼，其餘以 * 取代；已被遮罩的輸入也得到相同格式。 */
export function maskPhone(raw: string): string {
  const compact = raw.replace(/[^\d*＊•xX]/g, "").replace(/[＊•xX]/g, "*");
  if (compact.length <= 5) return "*".repeat(compact.length);
  return `${compact.slice(0, 2)}${"*".repeat(compact.length - 5)}${compact.slice(-3)}`;
}

/** 保留第一個字元與網域。 */
export function maskEmail(raw: string): string {
  const at = raw.lastIndexOf("@");
  if (at < 0) return "***";
  const first = [...raw.slice(0, at)][0] ?? "";
  return `${first}***@${raw.slice(at + 1)}`;
}

/** 「證券 - 王小明 9A12345678」變成「證券 ••••5678」，丟掉戶名。 */
export function maskAccountLabel(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  const type = /^(證券|期權|海外)/.exec(text)?.[1] ?? "帳戶";
  const token = text.split(" ").at(-1) ?? "";
  // 最後一段不含數字時它是戶名，不能拿來當帳號尾碼。
  const tail = /\d/.test(token)
    ? token.replace(/[^0-9A-Za-z]/g, "").slice(-4)
    : "";
  return tail.length === 4 ? `${type} ••••${tail}` : type;
}

/**
 * 從選項文字取出該管道的收碼目標並遮罩；其餘文字一律丟棄。
 * 找不到對應格式（例如「請選擇」或殘留的另一管道選項）時回傳 undefined。
 */
export function maskOtpTarget(
  text: string,
  channel: OnboardingOtpChannel,
  index: number,
): OnboardingOtpTarget | undefined {
  if (channel === "email") {
    const email = EMAIL.exec(text)?.[0];
    return email ? { channel, index, masked: maskEmail(email) } : undefined;
  }
  if (EMAIL.test(text)) return undefined;
  const phone = PHONE.exec(text)?.[0];
  return phone ? { channel, index, masked: maskPhone(phone) } : undefined;
}

/** 條款全文等會原樣回給前端的文字：遮掉 Email、身分證字號與手機號碼。 */
export function scrubText(text: string): string {
  return text
    .replace(new RegExp(EMAIL.source, "g"), (m) => maskEmail(m))
    // 身分證字號（第二碼 1／2）與新式統一證號（第二碼 8／9）。
    .replace(/\b[A-Za-z][1289]\d{8}\b/g, (m) => `${m[0]}*********`)
    .replace(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, (m) => maskPhone(m));
}
