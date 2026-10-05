import type { OnboardingAccountType } from "../../src/lib/sinopac-onboarding/types";

/** 可序列化給頁面端的樣式。RegExp 物件經過 evaluate 會變成 {}，所以只傳 source 與 flags。 */
export interface Pattern {
  name: string;
  flags?: string;
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 逐字之間容許空白，例如「登入」可以符合「登 入」。整串必須完全相符。 */
export function loose(text: string): Pattern {
  const body = [...text.replace(/\s+/g, "")].map(escapeRegExp).join("\\s*");
  return { name: `^\\s*${body}\\s*$`, flags: "i" };
}

export function pattern(source: string, flags = "i"): Pattern {
  return { name: source, flags };
}

export function regexOf(pattern: Pattern): RegExp {
  return new RegExp(pattern.name, pattern.flags ?? "i");
}

export const normalizeText = (value: string) =>
  value.replace(/\s+/g, " ").trim();

/** 把頁面文字整理成一行一段；連續空行合併。 */
export function tidyLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解析「倒數4分57秒」「4分55秒」「57秒」。解析不出來或不合理時回傳 fallback（300 秒）。 */
export function parseCountdownSeconds(text: string, fallback = 300): number {
  const full = /(\d{1,2})\s*分\s*(\d{1,2})\s*秒/.exec(text);
  const secondsOnly = /(\d{1,3})\s*秒/.exec(text);
  const total = full
    ? Number(full[1]) * 60 + Number(full[2])
    : secondsOnly
      ? Number(secondsOnly[1])
      : Number.NaN;
  if (!Number.isFinite(total) || total <= 0 || total > 900) return fallback;
  return total;
}

// UNVERIFIED: 金鑰實際字元集未觀察，只知道各 44 字元；放寬到 base58／base64 常見字元。
const KEY_TOKEN = "[A-Za-z0-9+/_=-]{44}";

/**
 * 從「新增成功」視窗的文字取出 API Key 與 Secret Key。
 * 逐行解析：標籤那一行（或下一行）必須恰為 44 字元的單一字串，否則視為失敗。
 */
export function parseKeySuccessDialog(
  text: string,
): { apiKey: string; secretKey: string } | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // innerText 常把同一排的「複製」按鈕接在金鑰後面（空白、Tab 或直接相連），容許金鑰後面有它。
  const copy = "(?:\\s*複\\s*製)?";
  const tokenAfter = (label: RegExp): string | undefined => {
    const inline = new RegExp(
      `^${label.source}\\s*[:：]?\\s*(${KEY_TOKEN})${copy}$`,
      "i",
    );
    const alone = new RegExp(`^${label.source}\\s*[:：]?$`, "i");
    const tokenOnly = new RegExp(`^(${KEY_TOKEN})${copy}$`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = inline.exec(line);
      if (match) return match[1];
      const next = lines[i + 1];
      const nextMatch = next ? tokenOnly.exec(next) : null;
      if (alone.test(line) && nextMatch) return nextMatch[1];
    }
    return undefined;
  };
  const apiKey = tokenAfter(/API\s*Key/);
  const secretKey = tokenAfter(/Secret\s*Key/);
  if (!apiKey || !secretKey || apiKey === secretKey) return undefined;
  return { apiKey, secretKey };
}

/** 「證券」「期權」「海外」開頭的帳戶核取方塊對應到帳戶類型。 */
export function accountTypeOf(
  label: string,
): OnboardingAccountType | undefined {
  const head = /^\s*(證券|期權|海外)/.exec(label)?.[1];
  return head === "證券"
    ? "stock"
    : head === "期權"
      ? "futures"
      : head === "海外"
        ? "overseas"
        : undefined;
}

/** 回傳 after 中沒有出現在 before 的行，用來只看「按下按鈕之後」新冒出的提示文字。 */
export function newLines(before: string, after: string): string[] {
  const seen = new Set(before.split(/\r?\n/).map((line) => line.trim()));
  return after
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(line));
}

/** 日期輸入框可能顯示 2027/10/04，統一成 YYYY-MM-DD。 */
export function normalizeDate(value: string): string {
  return value.trim().replace(/\//g, "-");
}
