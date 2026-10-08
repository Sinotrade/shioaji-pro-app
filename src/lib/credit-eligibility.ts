// src/lib/credit-eligibility.ts — 可否融資／融券（閃電下單信用條件）
//
// 合約欄位 margin_trading_balance／short_selling_balance 是餘額，不是能不能
// 信用交易的旗標，不能拿來判斷。這裡用 App 已有的 credit_enquire（籌碼卡在用）：
// 成數或單位「確定是 0」才判定不可（擋單）；查詢失敗、沒有資料或欄位不是
// 數字一律是「無法確認」— 不擋，最後由券商端決定。結果依伺服器＋股票＋
// 台北交易日快取；失敗不快取，下次再查。

import { useEffect, useState } from 'react';
import { apiPost } from './api';
import { CREDIT_TEXT } from './odd-lot';
import { getApiBase } from './runtime';
import type { ContractBase } from './types/contract';

export interface CreditEnquire {
    stock_id: string;
    system: string;
    update_time: string;
    margin_unit: number;
    short_unit: number;
    margin_loan_ratio: number;
    short_margin_ratio: number;
}

export type CreditCond = 'MarginTrading' | 'ShortSelling';
export type CreditStatus = 'ok' | 'blocked' | 'unknown';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 成數或單位為 0 → blocked；兩者都是數字 → ok；其他 → unknown */
export function creditStatus(row: CreditEnquire | undefined | null, cond: CreditCond): CreditStatus {
    if (!row) return 'unknown';
    const ratio = num(cond === 'MarginTrading' ? row.margin_loan_ratio : row.short_margin_ratio);
    const unit = num(cond === 'MarginTrading' ? row.margin_unit : row.short_unit);
    if (ratio === 0 || unit === 0) return 'blocked';
    if (ratio === null || unit === null) return 'unknown';
    return 'ok';
}

const TAIPEI_OFFSET_MS = 8 * 3600_000;
export const taipeiDay = (now = Date.now()) => new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
const msToTaipeiMidnight = (now = Date.now()) => 86_400_000 - ((now + TAIPEI_OFFSET_MS) % 86_400_000);

type ContractKey = Pick<ContractBase, 'code' | 'security_type' | 'exchange'>;
const cache = new Map<string, Promise<CreditEnquire | undefined>>();

/** 當日快取的 credit_enquire（同一檔同一天同一伺服器只查一次；失敗會 reject 且不快取）。 */
/** 快取鍵：伺服器＋交易所＋代碼＋台北日期（任何一個變了就要重查） */
export function creditEnquireKey(contract: ContractKey): string {
    return `${getApiBase()}|${contract.exchange}|${contract.code}|${taipeiDay()}`;
}

/** `fresh`：不用快取、重新查並取代快取（送出前的最後確認用） */
export function loadCreditEnquire(contract: ContractKey, opts?: { fresh?: boolean }): Promise<CreditEnquire | undefined> {
    const key = creditEnquireKey(contract);
    const hit = opts?.fresh ? undefined : cache.get(key);
    if (hit) return hit;
    const p = apiPost<CreditEnquire[]>('/api/v1/data/credit_enquire', {
        contracts: [{ security_type: contract.security_type, exchange: contract.exchange, code: contract.code }],
    // 只採用這一檔的回覆：沒有對應的列＝無法確認（不拿別檔的 0 來擋）
    }).then(rows => (Array.isArray(rows) ? rows.find(r => r?.stock_id === contract.code) : undefined));
    cache.set(key, p);
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
    // 重新查到的結果通知畫面（例如點擊時重查發現額度已恢復）
    if (opts?.fresh) void p.then(() => { if (cache.get(key) === p) cacheListeners.forEach(l => l(key)); }, () => undefined);
    return p;
}

const cacheListeners = new Set<(key: string) => void>();

export function resetCreditEnquireCache(): void {
    cache.clear();
}

export interface CreditEnquireState {
    /** the answer for the current key (undefined while loading, failed or empty) */
    row?: CreditEnquire;
    key?: string;
    loading: boolean;
    failed: boolean;
}

/** 面板需要信用條件時（融資／融券）才查。換股票、換伺服器或過了台北午夜
 * 就是新的鍵：舊答案立即不算（回到 loading）並重查。 */
export function useCreditEnquire(contract: ContractKey, enabled: boolean): CreditEnquireState {
    const [state, setState] = useState<CreditEnquireState>({ loading: false, failed: false });
    const [, setDayTick] = useState(0);
    const active = enabled && contract.security_type === 'STK';
    const key = active ? creditEnquireKey(contract) : '';
    // 開著過夜的面板：午夜後重新 render，讓日期進到鍵裡
    useEffect(() => {
        if (!active) return;
        const t = setTimeout(() => setDayTick(n => n + 1), msToTaipeiMidnight() + 1000);
        return () => clearTimeout(t);
    }, [active, key]);
    // 別處（點擊時）重新查到的新結果：重新讀取
    const [refreshTick, setRefreshTick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const onFresh = (k: string) => { if (k === key) setRefreshTick(n => n + 1); };
        cacheListeners.add(onFresh);
        return () => { cacheListeners.delete(onFresh); };
    }, [active, key]);
    useEffect(() => {
        if (!active) return;
        let alive = true;
        if (refreshTick === 0) setState({ key, loading: true, failed: false });
        loadCreditEnquire(contract).then(
            row => { if (alive) setState({ key, row, loading: false, failed: false }); },
            () => { if (alive) setState({ key, loading: false, failed: true }); },
        );
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, key, refreshTick]);
    if (!active) return { loading: false, failed: false };
    // an answer for another stock, server or day never applies
    if (state.key !== key) return { key, loading: true, failed: false };
    return state;
}

// ---- 閃電與圖表下單共用：信用條件每一邊的停用原因、點下去時的檢查 ----

/** 面板（閃電、K 線圖）的信用條件；現股＋不當沖為預設 */
export interface PanelCredit { cond: string; daytradeShort: boolean }
export type CreditCheck = CreditStatus | 'loading';

const SELL_ONLY_CONDS: ReadonlySet<string> = new Set(['ShortSelling', 'SBLShort', 'SBLShortPriceExempt']);

/** 面板要查 credit_enquire 的條件：只有融資／融券；借券類由券源決定，不查 */
export function creditEnquireCond(credit: PanelCredit): CreditCond | null {
    return credit.cond === 'MarginTrading' || credit.cond === 'ShortSelling' ? credit.cond : null;
}

/** 只有會「新增」信用部位的那一邊要看可否融資券：融資買進、融券賣出 */
export function creditOpensFor(action: 'Buy' | 'Sell', credit: PanelCredit): CreditCond | null {
    if (credit.cond === 'MarginTrading' && action === 'Buy') return 'MarginTrading';
    if (credit.cond === 'ShortSelling' && action === 'Sell') return 'ShortSelling';
    return null;
}

export const creditRefusedText = (code: string, cond: CreditCond) => `${code} 目前不能${cond === 'MarginTrading' ? '融資買進' : '融券賣出'}，已停止送單`;

/**
 * 每一邊不能送的原因（null＝可送）。信用了結不受暫停限制（證交所）：可否融資
 * 只擋「融資買進」，可否融券只擋「融券賣出」；融資賣出償還照常。查詢中或
 * 無法確認一律不擋（由券商端決定）。
 */
export function creditSideBlocks(contract: { code: string; day_trade?: string }, credit: PanelCredit, check: CreditCheck) {
    const sellOnly = SELL_ONLY_CONDS.has(credit.cond);
    const creditBlocked = check === 'blocked' && creditEnquireCond(credit)
        ? (credit.cond === 'MarginTrading'
            ? `${contract.code} 目前不能融資買進，已停止融資買進；融資賣出（償還）照常`
            : `${contract.code} 目前不能融券賣出，已停止送單；改回現股或換股票`)
        : null;
    const dayTradeBlocked = credit.daytradeShort && contract.day_trade !== 'Yes'
        ? (contract.day_trade === 'OnlyBuy' ? '此股票只能先買後賣，不能現沖先賣；點賣已停用' : '此股票不可當沖，不能現沖先賣；點賣已停用')
        : null;
    return {
        sellOnly,
        creditBlocked,
        dayTradeBlocked,
        buy: (credit.cond === 'MarginTrading' ? creditBlocked : null) ?? (sellOnly ? CREDIT_TEXT.shortBuy : null),
        sell: (credit.cond === 'ShortSelling' ? creditBlocked : null) ?? dayTradeBlocked,
        /** 送單時的固定規則（不含可能過時的可否融資券結果，那個送出前重查） */
        rule: { Buy: sellOnly ? CREDIT_TEXT.shortBuy : null, Sell: dayTradeBlocked } as Record<'Buy' | 'Sell', string | null>,
    };
}

/**
 * 點下去時的信用檢查（閃電與 K 線圖共用）：
 * - 融資買進／融券賣出：先看 credit_enquire（當日快取；快取是 0 再重查一次，
 *   額度可能已恢復）；確定不可就丟錯，查詢失敗不擋。查詢期間換了伺服器位址
 *   也不送。回傳 afterConfirm：確認之後不用快取重查，確認期間變成 0 就不送。
 * - check()：送出前（beforeSend）呼叫 — 確認視窗開著跨過台北午夜或換了伺服器，
 *   可否融資券／可否當沖要重新確認，這筆不送。
 */
export async function prepareCreditOrder(
    contract: ContractKey,
    action: 'Buy' | 'Sell',
    credit: PanelCredit,
): Promise<{ afterConfirm?: () => Promise<void>; check: () => void }> {
    const clickDay = taipeiDay();
    const dayBound = action === 'Sell' && credit.cond === 'Cash' && credit.daytradeShort;
    const cond = creditOpensFor(action, credit);
    let enquiryKey: string | null = null;
    if (cond) {
        enquiryKey = creditEnquireKey(contract);
        const clickBase = getApiBase();
        let row = await loadCreditEnquire(contract).catch(() => undefined);
        if (creditStatus(row, cond) === 'blocked') row = await loadCreditEnquire(contract, { fresh: true }).catch(() => undefined);
        // 模式的比對交給 placeQuickOrder（點擊當下固定的閘門，在確認之後檢查）
        if (getApiBase() !== clickBase) throw new Error('確認可否融資券期間伺服器已切換，這筆沒有送出');
        if (creditStatus(row, cond) === 'blocked') throw new Error(creditRefusedText(contract.code, cond));
    }
    const key = enquiryKey;
    return {
        ...(cond ? {
            afterConfirm: async () => {
                const fresh = await loadCreditEnquire(contract, { fresh: true }).catch(() => undefined);
                if (creditStatus(fresh, cond) === 'blocked') throw new Error(creditRefusedText(contract.code, cond));
            },
        } : {}),
        check: () => {
            if (key !== null && creditEnquireKey(contract) !== key) throw new Error('確認期間已跨日或伺服器已切換，可否融資券需重新確認，這筆沒有送出');
            if (dayBound && taipeiDay() !== clickDay) throw new Error('確認期間已跨日，可否當沖需重新確認，這筆沒有送出');
        },
    };
}
