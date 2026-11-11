// src/lib/execution/background-loss-limit.ts — 當日虧損上限 vs background
// opening entries (#403).
//
// The background engine checks an OPENING entry (a program with `opens`)
// against the App's daily loss limit with one account's P&L only: the
// futures account whose margin the main window reads (trading-state
// `marginAccount`, pushed as `pnlAccount`, see background.ts pushRiskNow).
// With risk on and a limit above 0 it refuses, when the trigger fires, an
// entry on a stock account (that P&L is never known) and one on any other
// futures account. Such a trigger would be armed for nothing, so it is
// refused when created or changed instead. Exits / protections (no `opens`)
// are never checked by the engine and are never refused here.

import type { RiskSettings } from '../risk';
import type { AccountKey } from './model';

export const LOSS_LIMIT_STOCK_TEXT = '設了當日虧損上限時，背景執行拿不到股票帳戶的當日損益，股票進場觸價單觸發後不會送出。'
    + '請到 設定 → 風控 把日虧上限設為 0，或關閉背景持續執行';
export const LOSS_LIMIT_FUTURES_TEXT = '設了當日虧損上限時，背景執行只取得主視窗選取的期貨帳戶的當日損益，其他期貨帳戶的進場觸價單觸發後不會送出。'
    + '請改選該帳戶，或到 設定 → 風控 把日虧上限設為 0';
/** The risk dialog's note while a limit is set. */
export const LOSS_LIMIT_SETTINGS_NOTE = '背景執行的股票進場觸價單（含括號單觸價進場）在設了日虧上限時不會送出，也不能新建；停損停利不受影響。';

/** Risk on with a daily loss limit above 0. */
export function dailyLossLimitSet(s: Pick<RiskSettings, 'enabled' | 'maxDailyLoss'>): boolean {
    return s.enabled && s.maxDailyLoss > 0;
}

/** "F:<broker>:<account>" (trading-state `marginAccount`) as the engine's
 * P&L account; anything else: unknown. */
export function pnlAccountOf(marginAccount: string | undefined | null): { brokerId: string; accountId: string } | null {
    const [type, brokerId, accountId] = (marginAccount ?? '').split(':');
    return type === 'F' && brokerId && accountId ? { brokerId, accountId } : null;
}

/** Why the engine would refuse this opening entry for the loss limit, or
 * null. `pnlAccount` unknown (not read yet): a futures entry is not refused
 * here (the engine waits for it like for the P&L itself). */
export function backgroundEntryLossLimitProblem(entry: { opens: boolean; account: AccountKey | null | undefined },
    risk: Pick<RiskSettings, 'enabled' | 'maxDailyLoss'>,
    pnlAccount: { brokerId: string; accountId: string } | null): string | null {
    if (!entry.opens || !dailyLossLimitSet(risk) || !entry.account) return null;
    if (entry.account.accountType === 'S') return LOSS_LIMIT_STOCK_TEXT;
    if (pnlAccount && (pnlAccount.brokerId !== entry.account.brokerId || pnlAccount.accountId !== entry.account.accountId)) {
        return LOSS_LIMIT_FUTURES_TEXT;
    }
    return null;
}

/** The same with the App's current settings and selected futures account. */
export async function currentEntryLossLimitProblem(entry: { opens: boolean; account: AccountKey | null | undefined }): Promise<string | null> {
    if (!entry.opens || !entry.account) return null;
    // loaded on use: risk.ts reads window / localStorage when imported
    const { getRiskSettings } = await import('../risk');
    const risk = getRiskSettings();
    if (!dailyLossLimitSet(risk)) return null;
    // the P&L account matters for a futures entry only
    const pnlAccount = entry.account.accountType === 'F'
        ? pnlAccountOf((await import('../trading-state')).getTradingState().marginAccount) : null;
    return backgroundEntryLossLimitProblem(entry, risk, pnlAccount);
}
