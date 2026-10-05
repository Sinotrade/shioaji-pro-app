// 完成畫面用：剛綁定的帳戶是否已開通 API 下單。伺服器回報的 signed 要等 API 約定書簽署
// 並通過模擬登入／下單測試後才會是 true（見 account-signing.ts），所以兩件事一起看。
import type { Account } from '../types/portfolio';

type Product = 'stock' | 'futures';

export type Readiness =
    | { kind: 'ready' }
    | { kind: 'pending'; items: { product: Product; label: string }[] }
    | { kind: 'unknown' };

const UNKNOWN: Readiness = { kind: 'unknown' };
// 標籤來自 driver 的 maskAccountLabel：「證券 ••••1234」，沒有尾碼時只剩類別。
const LABEL = /^(證券|期權|海外)(?: ••••([0-9A-Za-z]{4}))?$/;
const PRODUCTS: Record<string, { type: string; product: Product }> = {
    證券: { type: 'S', product: 'stock' },
    期權: { type: 'F', product: 'futures' },
};

/**
 * 每個證券／期權標籤都要對到伺服器目前登入的同類帳戶（帳號英數字結尾相同）才下結論；
 * 對不上就是 unknown：伺服器可能登入的是另一組帳戶。海外帳戶沒有約定書可簽，略過。
 */
export function assessReadiness(
    accountLabels: string[],
    accounts: Pick<Account, 'account_type' | 'account_id' | 'signed'>[],
): Readiness {
    const items: { product: Product; label: string }[] = [];
    let checked = 0;
    for (const label of new Set(accountLabels)) {
        const [, word = '', tail] = LABEL.exec(label) ?? [];
        if (word === '海外') continue;
        const kind = PRODUCTS[word];
        // 認不出類別（driver 的「帳戶」）或沒有尾碼就無法確認，不能當作不用簽。
        if (!kind || !tail) return UNKNOWN;
        const matches = accounts.filter(
            (account) =>
                account.account_type === kind.type && account.account_id.replace(/[^0-9A-Za-z]/g, '').endsWith(tail),
        );
        if (matches.length === 0) return UNKNOWN;
        checked++;
        // 同尾碼的帳戶有一個沒開通就列出來，寧可多提醒也不誤報已開通。
        if (matches.some((account) => account.signed !== true)) items.push({ product: kind.product, label });
    }
    if (checked === 0) return UNKNOWN;
    if (items.length === 0) return { kind: 'ready' };
    return {
        kind: 'pending',
        items: [...items.filter((item) => item.product === 'stock'), ...items.filter((item) => item.product === 'futures')],
    };
}

/** 任何失敗、逾時或格式不對都回 unknown，畫面改提示之後到伺服器面板確認。 */
export async function checkReadiness(
    accountLabels: string[],
    fetch: (opts: { signal?: AbortSignal }) => Promise<unknown>,
    timeoutMs = 8000,
): Promise<Readiness> {
    // 自己管計時器而不用 AbortSignal.timeout()：它在請求結束後仍會 abort，
    // Tauri HTTP plugin 會因此丟出 unhandled rejection（見 tauri.ts 的 tauriFetchWithTimeout）。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const accounts = await fetch({ signal: controller.signal });
        return Array.isArray(accounts) ? assessReadiness(accountLabels, accounts) : UNKNOWN;
    } catch {
        return UNKNOWN;
    } finally {
        clearTimeout(timer);
    }
}
