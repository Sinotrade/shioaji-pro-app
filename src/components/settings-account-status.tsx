import { useId } from 'react';
import { useAccounts } from '../lib/account-store';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import {
    MARKETS, MARKET_LABEL, VerificationIcon, VerificationRules, needsVerificationRules, verificationStatus,
    type Market, type VerificationStatus,
} from './settings-account-verification';
import * as t from './settings-test-order.css';
import * as v from './settings-account-verification.css';

const TEXT: Record<VerificationStatus, (market: Market) => { main: string; sub?: string }> = {
    ok: () => ({ main: '已通過', sub: '，可正式下單' }),
    fail: () => ({ main: '未通過', sub: '：尚未完成 API 簽署或模擬測試，無法正式下單' }),
    none: market => ({ main: `無${MARKET_LABEL[market]}帳戶` }),
};

export function ProdAccountStatusSection() {
    const accounts = useAccounts();
    const priv = usePrivacyMode();
    const headId = useId();
    const rows = MARKETS.map(market => {
        const selected = market === 'S' ? accounts.selectedStock : accounts.selectedFutures;
        // 正式環境未通過時沒有選取帳戶，沿用帳戶清單順序顯示該市場第一個。
        const shown = selected?.account_type === market ? selected : accounts.accounts.find(a => a.account_type === market);
        return { market, status: verificationStatus(market, accounts), shown };
    });
    const unknown = rows.some(row => row.status === undefined);
    const showRules = needsVerificationRules(accounts);

    return (
        <section aria-labelledby={headId} className={t.card}>
            <div className={t.header}>
                <div className={t.heading}>
                    <span id={headId} className={t.title}>帳戶狀態</span>
                    <span className={t.environment}>正式環境</span>
                </div>
            </div>
            {unknown ? <p className={t.description}>取得帳號後顯示驗證狀態。</p> : (
                <ul role='list' className={v.statusList}>
                    {rows.map(({ market, status, shown }) => {
                        const text = TEXT[status!](market);
                        return (
                            <li key={market} className={v.statusRow} data-status={status}>
                                <span className={v.statusMarket}>{MARKET_LABEL[market]}</span>
                                <span className={v.statusText}>
                                    <VerificationIcon status={status!} size={14} />
                                    <span>
                                        <span className={v.statusMain}>{text.main}</span>
                                        {text.sub && <span className={v.statusSub}>{text.sub}</span>}
                                    </span>
                                </span>
                                {shown && (
                                    <span className={v.accountId}>
                                        <span className={t.srOnly}>帳號 </span>
                                        {shown.broker_id}-{maskAccountId(shown.account_id, priv)}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {showRules && <VerificationRules production />}
        </section>
    );
}
