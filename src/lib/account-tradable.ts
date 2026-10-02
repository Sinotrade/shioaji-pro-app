import { knownServerInfo } from './server-info-store';
import type { Account } from './types/portfolio';

/** Paper trading permits unsigned accounts; production and unknown modes
 * require the original signed flag. Never rewrite the wire account. */
export function canTrade(account: Account | null | undefined): boolean {
    return !!account && (knownServerInfo()?.simulation === true || account.signed === true);
}
