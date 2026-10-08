import { useId } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { getAccountState } from '../lib/account-store';
import * as t from './settings-test-order.css';
import * as v from './settings-account-verification.css';

export type Market = 'S' | 'F';
export type VerificationStatus = 'ok' | 'fail' | 'none';
export const MARKETS: readonly Market[] = ['S', 'F'];
export const MARKET_LABEL: Record<Market, string> = { S: '證券', F: '期貨' };

export const VERIFY_WAIT = '約需 1 分鐘至數小時不等';
export const VERIFY_LEGEND = '✓ 表示帳戶已通過簽署與模擬測試；✕ 表示尚未通過。';
export const VERIFY_SEND_RULE = '在模擬環境登入，各送一筆測試單：證券用 2890 永豐金、期貨用台指近月（即測試單預設商品）。';
export const PROD_SWITCH_HINT = '請切換到模擬環境，用設定 > 帳號的「測試單」送出。';
export const VERIFY_RULES: readonly string[] = [
    '可測試時間：開盤日（週一至週五）08:00–20:00（台北時間）；18:00–20:00 僅限台灣 IP。',
    '證券、期貨須各別簽署、各別測試（只測已簽署的商品）。',
    '簽署時間須早於測試時間，否則審核不會通過。',
    VERIFY_SEND_RULE,
    '連續送測試單需間隔 1 秒以上，系統才會記錄。',
    `測試成功與否${VERIFY_WAIT}；若是先登入才完成簽署或測試，請登出後重新登入才會生效。`,
];

type AccountsView = Pick<ReturnType<typeof getAccountState>, 'accounts' | 'selectedStock' | 'selectedFutures'> & { loaded?: boolean };

export function verificationStatus(market: Market, s: AccountsView): VerificationStatus | undefined {
    if (s.loaded === false || s.accounts.length === 0) return undefined;
    const sel = market === 'S' ? s.selectedStock : s.selectedFutures;
    if (sel?.account_type === market && sel.signed === true) return 'ok';
    return s.accounts.some((a) => a.account_type === market) ? 'fail' : 'none';
}

/** 任一市場為 ✕（未通過或無帳戶）才顯示「如何通過驗證」；未知（帳戶尚未載入）時兩邊都是 undefined，不顯示。 */
export function needsVerificationRules(s: AccountsView): boolean {
    return MARKETS.some((market) => {
        const status = verificationStatus(market, s);
        return status === 'fail' || status === 'none';
    });
}

export function VerificationIcon({ status, size = 12 }: { status: VerificationStatus; size?: number }) {
    return status === 'ok'
        ? <CircleCheck size={size} aria-hidden className={t.okIcon} />
        : <CircleX size={size} aria-hidden className={v.failIcon} />;
}

export function VerificationLegend() {
    return (
        <p className={v.legend}>
            <VerificationIcon status='ok' /><span className={t.srOnly}>✓</span>{' 表示帳戶已通過簽署與模擬測試；'}
            <VerificationIcon status='fail' /><span className={t.srOnly}>✕</span>{' 表示尚未通過。'}
        </p>
    );
}

export function VerificationRules({ production = false }: { production?: boolean }) {
    const id = useId();
    return (
        <section role='region' aria-labelledby={id} className={v.rules}>
            <p id={id} className={v.rulesTitle}>如何通過驗證</p>
            <ul role='list' className={t.instructions}>
                {VERIFY_RULES.map(rule => (
                    <li key={rule}>{rule}{production && rule === VERIFY_SEND_RULE ? PROD_SWITCH_HINT : null}</li>
                ))}
            </ul>
        </section>
    );
}
