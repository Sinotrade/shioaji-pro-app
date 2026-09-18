// src/lib/position-exit.ts — 市價平倉／反手的共用實作
//
// 原本只長在持倉 tab 裡。K 線圖也要能平倉之後就必須共用：平倉會真的送出
// 市價單，兩處各寫一份驗證遲早會漂開，而漂開的那一份就是會送錯單的那份。
//
// 送單前的驗證刻意嚴格且「寧可不送」：帳戶歸屬、市場別、數量方向只要有
// 一項對不上就整筆拒絕。這裡拒絕的成本是使用者多按兩下，猜錯的成本是
// 一張方向或數量錯誤的市價單。

import { ensureContract } from './contracts-cache';
import { placeQuickOrder, placeStockExitByShares } from './trade';
import { isStockPosition, type AccountedPosition, type Position } from './types/portfolio';
import type { Action } from './types/order';

export type ExitMode = 'close' | 'reverse';

export { isStockPosition };

// 平倉方向永遠是持倉的反向
export function exitActionOf(p: Position): Action {
    return p.direction === 'Buy' ? 'Sell' : 'Buy';
}

export interface ExitResult {
    exit: Action;
    qty: number;
}

// 送出市價平倉（或反手）。驗證不過就 throw，且保證還沒送出任何委託 —
// 呼叫端的錯誤訊息可以放心說「未送出」。
export async function closePositionAtMarket(
    p: AccountedPosition,
    mode: ExitMode,
): Promise<ExitResult> {
    const account = p.account;
    if (
        !account?.signed ||
        !account.broker_id ||
        !account.account_id ||
        !['S', 'F'].includes(account.account_type)
    ) {
        throw new Error('持倉帳戶歸屬不明，未送出委託');
    }
    if ((isStockPosition(p) ? 'S' : 'F') !== account.account_type) {
        throw new Error('持倉單位與帳戶市場不符，未送出委託');
    }
    if (!Number.isInteger(p.quantity) || p.quantity <= 0 || !['Buy', 'Sell'].includes(p.direction)) {
        throw new Error('持倉數量或方向不明，未送出委託');
    }
    // 股票反手與信用倉的交易條件（資／券／現股）不是這裡猜得出來的
    if (isStockPosition(p) && (mode === 'reverse' || !('cond' in p) || p.cond !== 'Cash')) {
        throw new Error('股票反手或信用持倉請分開確認交易條件，未送出委託');
    }
    const contract = await ensureContract(p.code);
    if ((contract.security_type === 'STK' ? 'S' : 'F') !== account.account_type) {
        throw new Error('商品與持倉帳戶市場不符，未送出委託');
    }
    const exit = exitActionOf(p);
    const qty = mode === 'reverse' ? p.quantity * 2 : p.quantity;
    if (isStockPosition(p)) {
        await placeStockExitByShares(contract, exit, p.quantity, account);
    } else {
        await placeQuickOrder(contract, exit, null, qty, {
            account,
            ocType: mode === 'reverse' ? 'Auto' : 'Cover',
        });
    }
    return { exit, qty };
}
