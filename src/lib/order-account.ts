// src/lib/order-account.ts — capture the order account BEFORE a manual
// confirmation and re-check it after (issue #139). The app-wide selection now
// syncs across windows, so it can change while a confirmation dialog is open;
// resolving it again at send time would silently reroute the order to an
// account the user never confirmed.

import { getAccountState } from './account-store';
import { accountMatches } from './flash-account';
import type { Account } from './types/portfolio';

/** The currently selected, signed account of this market (or undefined). */
export function captureSelectedAccount(type: 'S' | 'F'): Account | undefined {
    const state = getAccountState();
    const account = type === 'S' ? state.selectedStock : state.selectedFutures;
    return account?.signed && account.account_type === type ? account : undefined;
}

/** Still a signed account in the current list. */
export function isAccountAvailable(account: Account): boolean {
    return getAccountState().accounts.some((a) => a.signed && accountMatches(a, account));
}

/** The app-wide selection still points at `captured` and it is still usable. */
export function isSelectedAccountUnchanged(captured: Account): boolean {
    return accountMatches(captureSelectedAccount(captured.account_type as 'S' | 'F'), captured)
        && isAccountAvailable(captured);
}

export const ACCOUNT_CHANGED_MESSAGE = '確認期間帳戶已變更或不可用，未送出，請重新確認';
