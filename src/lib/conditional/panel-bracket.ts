// src/lib/conditional/panel-bracket.ts — 括號單 from the 條件單管理面板
// (#226): place the entry (限價／市價 now, or a 觸價 entry that fires later)
// and register its protection — stop / 分批停利 / 移動停損 / 保本 computed
// from the actual fill price. Runs in this window's engines (the background
// engine does not have these rules yet).

import { ensureBracketHost, registerBracket, registrationFailureText } from '../bracket';
import { tierSpecs } from './bracket-rules';
import { currentProtectionEnv } from '../protection-env';
import { notify, placeQuickOrder } from '../trade';
import { addTrigger, type BracketEntryPlan, type TriggerSend, type TriggerValidity } from '../trigger-engine';
import type { ContractInfo } from '../types/contract';
import type { Account } from '../types/portfolio';

export type PanelEntry =
    | { type: 'LMT'; price: number }
    | { type: 'MKT' }
    | { type: 'touch'; price: number; condition: 'below' | 'above'; send: TriggerSend; validity: TriggerValidity };

export interface PanelBracketRequest {
    contract: ContractInfo;
    account: Account;
    action: 'Buy' | 'Sell';
    entry: PanelEntry;
    plan: BracketEntryPlan;
    /** cost basis when a fill carries no price (limit, trigger or last) */
    refPrice: number;
}

/** 'placed': entry sent and protection registered; 'trigger': the 觸價
 * entry is armed; a string: what went wrong (shown to the user). */
export async function placePanelBracket(r: PanelBracketRequest): Promise<'placed' | 'trigger' | { error: string }> {
    const futures = r.contract.security_type === 'FUT' || r.contract.security_type === 'OPT';
    if (!futures && r.contract.security_type !== 'STK') return { error: '此商品不支援括號單' };
    const qty = r.plan.tiers.reduce((s, t) => s + t.quantity, 0);
    if (r.entry.type === 'touch') {
        const made = await addTrigger({ code: r.contract.code, condition: r.entry.condition, price: r.entry.price, action: r.action, quantity: qty,
            kind: (r.entry.condition === 'below') === (r.action === 'Sell') ? 'stop' : 'take', role: 'entry', bracketPlan: r.plan,
            ...(r.entry.send.type !== 'MKT' ? { send: r.entry.send } : {}), validity: r.entry.validity }, r.contract, { account: r.account });
        return made ? 'trigger' : { error: '觸價進場單沒有建立（原因見通知）' };
    }
    const env = currentProtectionEnv();
    if (!env) return { error: '伺服器模式（模擬／正式）尚未確認，括號單未送出' };
    // the main window must be able to track it BEFORE the entry is sent
    await ensureBracketHost();
    const trade = await placeQuickOrder(r.contract, r.action, r.entry.type === 'LMT' ? r.entry.price : null, qty, {
        source: 'manual', // 下單確認設定照常適用
        account: r.account,
        ...(futures ? { ocType: 'Auto' as const } : {}),
        ...(r.entry.type === 'LMT' ? { orderType: 'ROD' as const } : {}),
    });
    const specs = tierSpecs({
        env,
        account: { account_type: futures ? 'F' : 'S', broker_id: r.account.broker_id, account_id: r.account.account_id },
        orderId: trade.order.id, seqno: trade.order.seqno, quoteCode: r.contract.code,
        orderCode: trade.contract?.target_code || trade.contract?.code || r.contract.target_code || r.contract.code,
        securityType: r.contract.security_type as 'STK' | 'FUT' | 'OPT', exchange: r.contract.exchange ?? '',
        action: r.action, refPrice: r.refPrice,
    }, r.plan);
    try {
        for (const spec of specs) await registerBracket(spec);
    } catch (e) {
        const text = registrationFailureText(e);
        notify({ kind: 'err', title: '括號單保護未確認', body: `${r.contract.code} 進場單已送出；${text}` });
        return { error: `進場單已送出；${text}` };
    }
    return 'placed';
}
