// src/lib/privacy-text.ts — React 端套用 revealText（#268）：通知中心、toast、
// 錯誤回饋、伺服器 log 等顯示「產生當下組好的文字」的地方，在渲染時依目前的
// 隱私／遮金額開關重新遮蔽，並把文字裡出現的已知帳號遮成末兩碼。

import { useCallback, useMemo } from 'react';
import { useAccounts } from './account-store';
import { revealText, usePrivacyMode, usePrivacyMoney } from './privacy';

export function useRevealText(): (text: string) => string {
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const { accounts } = useAccounts();
    const accountIds = useMemo(() => accounts.map(a => a.account_id), [accounts]);
    return useCallback(
        (text: string) => revealText(text, { priv, privMoney, accountIds }),
        [priv, privMoney, accountIds],
    );
}
