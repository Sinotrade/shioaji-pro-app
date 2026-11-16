import type { AccountedPosition } from './types/portfolio';

/** Broker IDs and projected timestamps are not unique across credit books
 * or accounts. Selection and React identity must include the whole book. */
export function positionKey(p: AccountedPosition): string {
    return JSON.stringify([p.account?.account_type, p.account?.broker_id, p.account?.account_id,
        p.code, 'cond' in p ? p.cond : undefined, p.direction, p.id]);
}
