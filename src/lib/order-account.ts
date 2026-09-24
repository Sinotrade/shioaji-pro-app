// src/lib/order-account.ts — capture the order account BEFORE a manual
// confirmation and re-check it after (issue #139). The selection can change
// within this window while a confirmation dialog is open (another panel's
// account menu, a hotkey); resolving it again at send time would silently
// reroute the order to an account the user never confirmed.

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

/**
 * Armed automatic paths (combo price-watch, grid follow) capture their
 * account when armed; each fire re-checks it. undefined = stop, don't send.
 */
export function usableCapturedAccount(captured: Account | undefined): Account | undefined {
    return captured && isAccountAvailable(captured) ? captured : undefined;
}

/** This window's app-wide selection, for pinning a new flash popout. */
export function mainFlashSelection(): { S: Account | null; F: Account | null } {
    const state = getAccountState();
    return { S: state.selectedStock, F: state.selectedFutures };
}

export const ACCOUNT_CHANGED_MESSAGE = '確認期間帳戶已變更或不可用，未送出，請重新確認';
