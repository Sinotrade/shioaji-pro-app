// src/lib/conditional/panel-bracket.ts — 括號單 from the 條件單管理面板
// (#226): place the entry (限價／市價 now, or a 觸價 entry that fires later)
// and register its protection — stop / 分批停利 / 移動停損 / 保本 computed
// from the actual fill price. Runs in this window's engines (the background
// engine does not have these rules yet).

import { ensureBracketHost, registerBracket, registrationFailureText } from '../bracket';
import { bracketPlanProblem, tierSpecs } from './bracket-rules';
import { stepPrice } from '../utils/ticksize';
import { contractMarket } from '../contract-market';
import { warrantProtectProblem, warrantTriggerProblem } from '../warrant-rules';

/** Stop / take prices at the reference price must be valid prices. */
export function derivedPriceProblem(r: Pick<PanelBracketRequest, 'contract' | 'action' | 'plan' | 'refPrice'>): string | null {
    const dir = r.action === 'Buy' ? 1 : -1;
    const stop = stepPrice(r.contract, r.refPrice, -dir * r.plan.stopTicks);
    if (!(stop > 0)) return `停損 ${r.plan.stopTicks} 檔會讓停損價小於等於 0，請改小`;
    for (const t of r.plan.tiers) {
        if (t.takeTicks !== null && !(stepPrice(r.contract, r.refPrice, dir * t.takeTicks) > 0)) return `停利 ${t.takeTicks} 檔會讓停利價小於等於 0，請改小`;
    }
    return null;
}
import { currentProtectionEnv } from '../protection-env';
import { notify, placeQuickOrder } from '../trade';
import { backgroundOwnerForNew, backgroundSupported, createBackgroundBracket } from '../execution/background';
import { panelBracketRequest } from '../execution/background-bracket';
import { tickTableOf } from '../execution/background-view';
import { ensureTickBands } from '../tick-bands';
import { addTrigger, type BracketEntryPlan, type TriggerSend, type TriggerValidity } from '../trigger-engine';
import type { ContractInfo } from '../types/contract';
import type { Account } from '../types/portfolio';
import type { OrderType } from '../types/order';
import type { ServerModeGuard } from '../server-info-store';

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
    /** #216 the entry's own order conditions (閃電下單); absent: ROD limit,
     * market IOC, futures 自動 — the panel's defaults */
    order?: PanelOrderOptions;
}

/** #216 how the window sends a 限價／市價 entry (the flash panel's settings
 * and guards). A 觸價 entry goes out by its send style instead. */
export interface PanelOrderOptions {
    /** 限價 entries: ROD (default), IOC or FOK */
    orderType?: OrderType;
    /** futures: 自動 (default) or 新倉 (brackets protect new positions) */
    octype?: 'Auto' | 'New';
    /** futures market entries: 市價 (default) or 範圍市價 */
    futuresPriceType?: 'MKT' | 'MKP';
    /** the caller's last checks, run right before the entry leaves */
    beforeSend?: () => void;
    isAccountCurrent?: () => boolean;
    serverMode?: ServerModeGuard;
    /** shown in the order confirmation */
    confirmNote?: string;
}

/** The entry's placeQuickOrder options (shared by both executors). */
function entryOrderOptions(r: PanelBracketRequest, futures: boolean, guard: () => void) {
    const o = r.order ?? {};
    return {
        source: 'manual' as const, // 下單確認設定照常適用
        account: r.account,
        beforeSend: () => { o.beforeSend?.(); guard(); },
        ...(o.isAccountCurrent ? { isAccountCurrent: o.isAccountCurrent } : {}),
        ...(o.serverMode ? { serverMode: o.serverMode } : {}),
        ...(o.confirmNote ? { confirmNote: o.confirmNote } : {}),
        ...(futures ? { ocType: o.octype ?? 'Auto' as const } : {}),
        ...(futures && r.entry.type === 'MKT' && o.futuresPriceType === 'MKP' ? { futuresPriceType: 'MKP' as const } : {}),
        ...(r.entry.type === 'LMT' ? { orderType: o.orderType ?? 'ROD' as const } : {}),
    };
}

/** 'placed': entry sent and protection registered; 'trigger': the 觸價
 * entry is armed; a string: what went wrong (shown to the user). */
export async function placePanelBracket(r: PanelBracketRequest): Promise<'placed' | 'trigger' | { error: string }> {
    const market = contractMarket(r.contract.security_type);
    if (!market) return { error: '此商品不支援括號單' };
    const futures = market === 'F';
    // checked before anything is sent; a warrant: whole lots in cash, its
    // exits are market orders (none on a foreign underlying), a 觸價 entry
    // as a trigger of its own (觸價後限價 on the warrant tick grid)
    const problem = warrantProtectProblem(r.contract)
        ?? (r.entry.type === 'touch' ? warrantTriggerProblem(r.contract, { send: r.entry.send, price: r.entry.price }) : null)
        ?? bracketPlanProblem(r.plan) ?? derivedPriceProblem(r);
    if (problem) return { error: problem };
    const qty = r.plan.tiers.reduce((s, t) => s + t.quantity, 0);
    // #226: with 「背景持續執行」 on, a futures / options bracket runs in the
    // background (one owner, decided before anything is sent)
    // (stocks too: 現股 整股 — the panel's brackets are whole lots in cash)
    if (backgroundSupported()) {
        const env = currentProtectionEnv();
        if (!env) return { error: '伺服器模式（模擬／正式）尚未確認，括號單未送出' };
        const owner = await backgroundOwnerForNew({ liveOn: env });
        if (owner === 'background') return placeBackgroundPanelBracket(r, qty, env);
        if (owner !== 'window') return { error: owner.refused };
    }
    if (r.entry.type === 'touch') {
        const made = await addTrigger({ code: r.contract.code, condition: r.entry.condition, price: r.entry.price, action: r.action, quantity: qty,
            kind: (r.entry.condition === 'below') === (r.action === 'Sell') ? 'stop' : 'take', role: 'entry', bracketPlan: r.plan,
            ...(r.entry.send.type !== 'MKT' ? { send: r.entry.send } : {}), validity: r.entry.validity,
            ...(futures && r.order?.octype === 'New' ? { octype: 'New' as const } : {}) }, r.contract, { account: r.account });
        return made ? 'trigger' : { error: '觸價進場單沒有建立（原因見通知）' };
    }
    const env = currentProtectionEnv();
    if (!env) return { error: '伺服器模式（模擬／正式）尚未確認，括號單未送出' };
    // the main window must be able to track it BEFORE the entry is sent
    await ensureBracketHost();
    const trade = await placeQuickOrder(r.contract, r.action, r.entry.type === 'LMT' ? r.entry.price : null, qty,
        // the protection is registered for this environment: never send in another
        entryOrderOptions(r, futures, () => { if (currentProtectionEnv() !== env) throw new Error('伺服器或模擬／正式模式已切換，進場單未送出'); }));
    const specs = tierSpecs({
        env,
        account: { account_type: futures ? 'F' : 'S', broker_id: r.account.broker_id, account_id: r.account.account_id },
        orderId: trade.order.id, seqno: trade.order.seqno, quoteCode: r.contract.code,
        orderCode: trade.contract?.target_code || trade.contract?.code || r.contract.target_code || r.contract.code,
        // the window's bracket record: a warrant is a stock here (its contract decides the ticks)
        securityType: (futures ? r.contract.security_type : 'STK') as 'STK' | 'FUT' | 'OPT', exchange: r.contract.exchange ?? '',
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

/** The panel bracket in the background engine: tiers priced there from the
 * actual fill price. A 觸價 entry is fired by the engine (an opening order:
 * the App's risk checks apply); a 限價／市價 entry is sent here first (the
 * order confirmation setting applies), then handed over with its trade id. */
async function placeBackgroundPanelBracket(r: PanelBracketRequest, qty: number, env: string): Promise<'placed' | 'trigger' | { error: string }> {
    const c = r.contract as PanelBracketRequest['contract'] & { tick_rule?: string; tick?: number };
    const st = c.security_type === 'OPT' ? 'OPT' as const : c.security_type === 'WRT' ? 'WRT' as const
        : c.security_type === 'STK' ? 'STK' as const : 'FUT' as const;
    const stock = st === 'STK' || st === 'WRT';
    // a stock sell bracket's exits would buy back unchecked: not in the background
    if (stock && r.action === 'Sell') return { error: '背景執行：股票賣出括號單（出場為買進）目前不支援，請關閉背景持續執行改用本視窗' };
    // a stock entry opens a position: with a daily loss limit set the stock
    // account's day P&L is needed, which is not known here (as the engine refuses)
    const stockLossLimit = async () => {
        if (!stock) return false;
        const { getRiskSettings } = await import('../risk');
        const s = getRiskSettings();
        return s.enabled && s.maxDailyLoss > 0;
    };
    const LOSS_LIMIT_TEXT = '設了當日虧損上限，但股票帳戶的當日損益無法取得，股票括號單的進場單不送出';
    const bands = c.tick_rule && (st === 'FUT' || st === 'OPT') ? await ensureTickBands(c.tick_rule, st) : undefined;
    const tickTable = tickTableOf(c, bands);
    if (!tickTable) return { error: '背景執行：跳動點級距尚未取得，無法依成交價計算停損停利，請稍後再試' };
    const base = { env, account: { account_type: stock ? 'S' as const : 'F' as const, broker_id: r.account.broker_id, account_id: r.account.account_id },
        quoteCode: r.contract.code, securityType: st, action: r.action, plan: r.plan, tickTable } as const;
    if (r.entry.type === 'touch') {
        const request = panelBracketRequest({ ...base, orderCode: r.contract.target_code || r.contract.code,
            entry: { trigger: { condition: r.entry.condition, price: r.entry.price, send: r.entry.send, validity: r.entry.validity,
                ...(!stock && r.order?.octype === 'New' ? { octype: 'New' as const } : {}) } } });
        if (!request) return { error: '背景執行：括號單缺少帳戶或伺服器資訊' };
        const created = await createBackgroundBracket(request);
        if (created === 'created') return 'trigger';
        return { error: 'refused' in created ? `背景執行：${created.refused}`
            : `背景執行：建立結果未確認（${created.unconfirmed}）；請先看清單是否已有這張，不要直接重掛` };
    }
    if (await stockLossLimit()) return { error: LOSS_LIMIT_TEXT };
    const { getRiskSettings } = stock ? await import('../risk') : { getRiskSettings: null };
    let sentAt = Date.now();
    const trade = await placeQuickOrder(r.contract, r.action, r.entry.type === 'LMT' ? r.entry.price : null, qty,
        entryOrderOptions(r, !stock, () => {
            if (currentProtectionEnv() !== env) throw new Error('伺服器或模擬／正式模式已切換，進場單未送出');
            // the limit may have been set while the confirmation was open
            const s = getRiskSettings?.();
            if (s && s.enabled && s.maxDailyLoss > 0) throw new Error(LOSS_LIMIT_TEXT);
            // when it really leaves (after the order confirmation): its trading session
            sentAt = Date.now();
        }));
    const request = panelBracketRequest({ ...base, orderCode: trade.contract?.target_code || trade.contract?.code || r.contract.target_code || r.contract.code,
        entry: { tradeId: trade.order.id, seqno: trade.order.seqno ?? null, ordno: trade.order.ordno ?? null, sentAt } });
    const created = request && request.entry ? await createBackgroundBracket(request)
        : { refused: '進場單沒有委託編號（送出結果可能尚未確認）' };
    if (created === 'created') return 'placed';
    // the entry is out: say so, never resend, never suggest another stop (a late one could double the exit)
    const text = 'refused' in created
        ? `背景括號單未建立（${created.refused}）。請到委託／持倉確認後自行處理出場；系統不會自動補送`
        : `背景括號單建立結果未確認（${created.unconfirmed}）。請先查看條件單清單確認是否已建立；確認前不要另外設定停損或出場單`;
    notify({ kind: 'err', title: '括號單保護未確認', body: `${r.contract.code} 進場單已送出；${text}` });
    return { error: `進場單已送出；${text}` };
}
