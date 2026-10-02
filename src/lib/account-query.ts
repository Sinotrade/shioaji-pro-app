import { canTrade } from './account-tradable';
import { accountFor, getAccountState } from './account-store';
import { getServerModeVersion } from './server-info-store';
import type { Account, AccountTypeName } from './types/portfolio';

type Selector = Pick<Account, 'broker_id' | 'account_id'>;
type AccountRef = Selector & Pick<Account, 'account_type'>;
const key = (account: AccountRef) => `${account.account_type}:${account.broker_id}:${account.account_id}`;

/** One mode generation for a read or a whole batch (including health → cache).
 * Resolve captured selectors against the current account list, never their
 * old signed flag. Recheck at each request and immediately before applying
 * buffered results. No account means refusal, not a server-default query. */
export function createAccountQuery() {
    const version = getServerModeVersion();
    const checked = new Map<string, AccountRef>();
    function assertMode() {
        if (getServerModeVersion() !== version) throw new Error('查詢期間伺服器模式已變更，已丟棄回應；請重新更新');
    }
    function account(type: AccountTypeName, selector?: Selector): Account {
        assertMode();
        const ref = selector ?? accountFor(type as 'S' | 'F');
        const current = ref && getAccountState().accounts.find(a => a.account_type === type
            && a.broker_id === ref.broker_id && a.account_id === ref.account_id);
        if (!current || !canTrade(current)) throw new Error('查詢帳戶已不可用，已丟棄回應；請重新更新');
        checked.set(key(current), { account_type: current.account_type, broker_id: current.broker_id, account_id: current.account_id });
        return current;
    }
    function assertCurrent() {
        assertMode();
        for (const ref of checked.values()) account(ref.account_type as AccountTypeName, ref);
    }
    async function read<T>(type: AccountTypeName, selector: Selector | undefined, request: (current: Account) => Promise<T>): Promise<T> {
        const value = await request(account(type, selector));
        assertCurrent();
        return value;
    }
    return { version, account, assertCurrent, read };
}
