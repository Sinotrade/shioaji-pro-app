// src/lib/exit-plan.ts — 平倉拆腿與終態彙總的純函式（無 SDK 依賴，可直接單元測試）

import type { DayTrade } from './types/contract';
import type { Action, OrderStatusName, StockOrderLot } from './types/order';

export interface ExitLeg {
    label: '整張' | '現沖' | '零股';
    quantity: number; // 整張/現沖＝張數；零股＝股數
    price: number | null; // null → 市價
    orderLot?: StockOrderLot;
    daytradeShort?: boolean;
}

export interface ExitPlanInput {
    action: Action;
    closeShares: number; // 平掉既有部位的股數
    openShares?: number; // 反手時新開反向部位的股數；純平倉為 0
    ydShares?: number; // 昨日庫存股數（Position.yd_quantity），只有賣出才有意義
    cond?: string; // Position.cond：Cash / Netting / MarginTrading / ShortSelling / Emerging
    limits: { limit_up?: number; limit_down?: number; day_trade?: DayTrade };
}

export interface ExitPlan {
    legs: ExitLeg[];
    skipped: LegError[]; // 刻意不送的腿與原因（不送必死單，但也不擋住送得出去的）
}

const joinParts = (parts: (string | undefined)[]) =>
    parts.filter(Boolean).join('；');

// 只擋「現股單處理不了」的信用部位。其餘（Cash 現股、Netting 現股當沖、
// Emerging 興櫃、以及後端沒填值）都是現股交割，一律放行 —— 尤其 Netting 正是
// 本功能自己用 daytrade_short 開出來的部位，擋掉它等於盤中平不掉當沖單。
const CREDIT_COND: Record<string, string> = {
    MarginTrading: '融資',
    ShortSelling: '融券',
};

// 拆腿計畫：所有前置驗證都在這裡（送出任何一腿之前）完成 —
// 不會發生「第一腿已送出，才發現後面的腿必死」的半途 throw。
//
// 賣出超過昨日庫存的部分是今日買進 — 集保 T+2 還沒入帳，普通現股賣出會被
// 「集保賣出餘股數不足」退件（2026-07-16 6244 平倉事件）；反手要新開的空單同樣
// 是先賣後買。兩者都必須掛現股當沖賣（daytrade_short），合併成同一腿送出。
// closeShares/openShares 分開傳是為了讓訊息講得出零股卡在哪一邊 —— 反手時
// 「超出昨日庫存」可能一股今日買進都沒有，全是新開的空單。
//
// 送不出去的腿一律「具名跳過」而不是讓整筆計畫 throw：平倉是降風險動作，
// 因為今日買進的那 2 張不可現沖，就連昨日庫存的 1 張都賣不掉，等於把使用者
// 鎖在部位裡（而且「請改為只賣昨日庫存」這種建議，UI 上根本沒有對應操作）。
// 跳過的腿會走與送出失敗完全相同的回報路徑，終態彙總因此不可能報「全部成交」。
export function planStockExitLegs({
    action,
    closeShares,
    openShares = 0,
    ydShares,
    cond,
    limits,
}: ExitPlanInput): ExitPlan {
    // 融資／融券部位不能用現股單處理 —— 現股買進不會回補融券，只會另外開一筆
    // 現股多單讓曝險加倍。一腿都不送，交人工。
    if (cond && CREDIT_COND[cond]) {
        return {
            legs: [],
            skipped: [
                {
                    leg: '全部',
                    sent: 'no',
                    error: `${CREDIT_COND[cond]}部位不支援一鍵平倉／反手（本功能只送現股單）— 請至「委託」分頁自行處理`,
                },
            ],
        };
    }
    // 買進（回補空單／反手做多）沒有集保庫存問題，全部走普通現股
    if (action === 'Buy') {
        return buildPlan(action, closeShares + openShares, 0, limits, []);
    }
    const skipped: LegError[] = [];
    const yd = ydShares ?? Number.POSITIVE_INFINITY;
    const todayBought = Math.max(0, closeShares - yd);
    let dtShares = todayBought + openShares;
    const dtOdd = dtShares % 1000;
    if (dtOdd > 0) {
        // 零股不可現沖，但整張的部分照送
        skipped.push({
            leg: '零股現沖',
            sent: 'no',
            error: oddDaytradeMessage(todayBought, openShares),
        });
        dtShares -= dtOdd;
    }
    // 'OnlyBuy'＝只能先買後賣，而 daytrade_short 正是先賣，同樣不可現沖
    if (dtShares > 0 && limits.day_trade !== 'Yes') {
        skipped.push({
            leg: '現沖',
            sent: 'no',
            error: `本檔不可現股當沖（day_trade=${limits.day_trade || '未知'}）— 需現沖賣出的 ${dtShares} 股送出必被退件，已跳過`,
        });
        dtShares = 0;
    }
    return buildPlan(
        action,
        closeShares - todayBought,
        dtShares,
        limits,
        skipped,
    );
}

function buildPlan(
    action: Action,
    plainShares: number,
    dtShares: number,
    limits: { limit_up?: number; limit_down?: number },
    skipped: LegError[],
): ExitPlan {
    const legs: ExitLeg[] = [];
    const lots = Math.floor(plainShares / 1000);
    const odd = plainShares % 1000;
    if (lots > 0) {
        legs.push({ label: '整張', quantity: lots, price: null });
    }
    if (dtShares > 0) {
        legs.push({
            label: '現沖',
            quantity: dtShares / 1000,
            price: null,
            daytradeShort: true,
        });
    }
    if (odd > 0) {
        // 盤中零股只收 LMT — 用漲跌停價當 marketable limit
        const limitPrice =
            action === 'Sell' ? limits.limit_down : limits.limit_up;
        if (limitPrice) {
            legs.push({
                label: '零股',
                quantity: odd,
                price: limitPrice,
                orderLot: 'IntradayOdd',
            });
        } else {
            skipped.push({
                leg: '零股',
                sent: 'no',
                error: `取不到漲跌停價，${odd} 股零股無法掛限價單 — 請至「委託」分頁自行掛單`,
            });
        }
    }
    return { legs, skipped };
}

// 零股卡在哪一邊，訊息就要講哪一邊 —— 反手時可能一股今日買進都沒有，
// 卡住的是新開空單的零股；此時叫使用者「留倉隔日再賣」是錯誤指引
// （那些零股是昨日庫存，今天用「平」就賣得掉）。
function oddDaytradeMessage(todayBought: number, openShares: number): string {
    const odd = (todayBought + openShares) % 1000;
    if (todayBought > 0 && openShares > 0) {
        return `今日買進 ${todayBought} 股加上反手新空單 ${openShares} 股湊不成整張（餘 ${odd} 股）— 盤中零股不可現股當沖，請改用「平」只平倉`;
    }
    if (openShares > 0) {
        return `反手新空單 ${openShares} 股含 ${odd} 股零股 — 盤中零股不可現股當沖放空；請改用「平」只平倉`;
    }
    return `今日買進 ${todayBought} 股含 ${odd} 股零股 — 盤中零股不可現股當沖賣出，零股請留倉隔日再賣`;
}

export interface LegError {
    leg: string;
    error: string;
    // 'no'＝我們決定不送，券商不可能有這筆委託；'unknown'＝送出過程中炸了，
    // 無從得知券商收到沒有。兩者給使用者的指示完全相反，不可混為一談。
    sent: 'no' | 'unknown';
}

export interface PlacedLegs<T> {
    placed: T[];
    errors: LegError[];
}

// 逐腿送出：任一腿同步失敗「不 throw」— 已送出的腿一定回傳給 caller 進
// reconcile，失敗的腿記名回報。半途 throw 會讓已送出的腿失去追蹤，使用者
// 看到「平倉失敗」重按就重複送單。
export async function executeExitLegs<T>(
    legs: ExitLeg[],
    send: (leg: ExitLeg) => Promise<T>,
): Promise<PlacedLegs<T>> {
    const placed: T[] = [];
    const errors: LegError[] = [];
    for (const leg of legs) {
        try {
            placed.push(await send(leg));
        } catch (e) {
            errors.push({
                leg: leg.label,
                // 送出過程中丟出來的例外無法區分「還沒送到券商就被擋下」與
                // 「已送出但回應遺失」，保守起見一律當作不確定
                sent: 'unknown',
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    return { placed, errors };
}

export interface TradeOutcome {
    status: OrderStatusName;
    orderQty: number;
    dealQty: number;
    unit: '張' | '股' | '口';
    msg: string;
}

export interface OutcomeNotice {
    kind: 'ok' | 'err' | 'info';
    title: string;
    body: string;
}

const STATUS_LABEL: Record<string, string> = {
    Filled: '成交',
    PartFilled: '部分成交',
    Cancelled: '已取消',
    Failed: '退件',
    Inactive: '失效',
    Submitted: '委託中',
    PreSubmitted: '委託中',
    PendingSubmit: '傳送中',
};

export const statusText = (s: string) => STATUS_LABEL[s] ?? s;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'Filled',
    'Failed',
    'Cancelled',
    'Inactive',
]);

export interface TerminalCheck {
    status: OrderStatusName;
    orderQty: number;
    dealQty: number;
    cancelQty: number;
}

// PartFilled 本身不是結束 —— 盤中零股腿是 LMT+ROD，可以合法停在部分成交繼續
// 等下一輪撮合。但把它一律當「還在工作中」，「部分成交後取消」這個情境就永遠
// 走不到終態彙總，只會空轉到逾時。判準：成交＋取消已涵蓋委託量才算塵埃落定。
export function isTerminal(t: TerminalCheck): boolean {
    if (TERMINAL_STATUSES.has(t.status)) return true;
    return t.status === 'PartFilled' && t.dealQty + t.cancelQty >= t.orderQty;
}

// deal_quantity 有時還沒結算，成交明細卻已經掛在 status.deals 上（姊妹專案
// stock-shioaji 同券商同 SDK 就因此把已成交的回補腿誤判成未成交）。取兩者較大者，
// 讓「Filled 但 deal_quantity=0」不會被說成沒成交。
export function resolveDealQty(status: {
    deal_quantity?: number | null;
    deals?: { quantity: number }[];
}): number {
    const fromDeals = (status.deals ?? []).reduce(
        (s, d) => s + (d.quantity || 0),
        0,
    );
    return Math.max(status.deal_quantity ?? 0, fromDeals);
}

// Trade → 判讀輸入的接線也放在純函式這側，讓單位判定與成交量取值可被測試
// （watchTradesToTerminal 只剩輪詢迴圈本身）
export interface TradeLike {
    order: { quantity: number; order_lot?: string };
    status: {
        status: OrderStatusName;
        deal_quantity?: number | null;
        cancel_quantity?: number | null;
        msg: string;
        deals?: { quantity: number }[];
    };
}

export function tradeToOutcome(
    t: TradeLike,
    accountType: 'S' | 'F',
): TradeOutcome {
    return {
        status: t.status.status,
        orderQty: t.order.quantity,
        dealQty: resolveDealQty(t.status),
        unit:
            accountType === 'F'
                ? '口'
                : t.order.order_lot === 'IntradayOdd'
                  ? '股'
                  : '張',
        msg: t.status.msg,
    };
}

export function isTerminalTrade(t: TradeLike): boolean {
    return isTerminal({
        status: t.status.status,
        orderQty: t.order.quantity,
        dealQty: resolveDealQty(t.status),
        cancelQty: t.status.cancel_quantity ?? 0,
    });
}

const legDetail = (outcomes: TradeOutcome[]) =>
    outcomes
        .map(
            (o) =>
                `${STATUS_LABEL[o.status] ?? o.status} ${o.dealQty}/${o.orderQty} ${o.unit}`,
        )
        .join('；');

const unsentDetail = (unsent: LegError[]) =>
    unsent.length
        ? `未送出：${unsent.map((l) => `${l.leg}（${l.error}）`).join('、')}`
        : '';

// 終態彙總：只有「每腿 Filled 且 deal_quantity 足量」才算成交成功。
// dealt>0 不代表全成交 — Cancelled 可能是部分成交後取消、多腿可能一腿 Filled
// 一腿 Cancelled；這些都是「持倉未完整處理」，必須紅色警示附明細。
//
// unsentLegs＝送出階段就失敗、連 order id 都沒拿到的腿。它們不在 outcomes 裡，
// 若不一併傳進來，every() 會對「被縮小過的集合」成立而報出綠色「全部成交」——
// 部位其實只平了一半。分母錯了，腿級判讀再嚴格也沒用。
export function summarizeTerminalOutcomes(
    label: string,
    outcomes: TradeOutcome[],
    unsentLegs: LegError[] = [],
): OutcomeNotice {
    const unsentBody = unsentDetail(unsentLegs);
    if (outcomes.length === 0) {
        return {
            kind: 'err',
            title: `❌ ${label} 沒有任何委託送出`,
            body: joinParts([
                unsentBody || '沒有取得任何委託回報',
                '請到「委託」分頁確認後再決定是否重送',
            ]),
        };
    }
    // Filled 卻回報 0 成交量＝回報自相矛盾，不可對成交與否下定論
    if (outcomes.some((o) => o.status === 'Filled' && o.dealQty <= 0)) {
        return {
            kind: 'err',
            title: `⚠️ ${label} 無法確認成交數量`,
            body: joinParts([
                '委託回報 Filled 但成交量為 0 — 請到「委託」分頁與持倉核對，勿直接重按',
                unsentBody,
            ]),
        };
    }
    const allFull = outcomes.every(
        (o) => o.status === 'Filled' && o.dealQty === o.orderQty,
    );
    if (allFull && unsentLegs.length === 0) {
        return { kind: 'ok', title: `✅ ${label} 全部成交`, body: '' };
    }
    if (allFull) {
        return {
            kind: 'err',
            title: `⚠️ ${label} 僅部分處理`,
            body: joinParts([
                `已送出的 ${outcomes.length} 腿全部成交`,
                unsentBody,
                '持倉未完整處理，請到「委託」分頁確認剩餘部位',
            ]),
        };
    }
    const failed = outcomes.filter(
        (o) => o.status === 'Failed' || o.status === 'Inactive',
    );
    const failBody = failed
        .map((o) => o.msg || `${o.status}（無原因）`)
        .join('；');
    const anyDealt = outcomes.some((o) => o.dealQty > 0);
    if (!anyDealt) {
        if (failed.length > 0) {
            return {
                kind: 'err',
                title: `❌ ${label} 委託被退件`,
                body: joinParts([failBody, unsentBody]),
            };
        }
        // 整筆被取消、一股都沒成交＝部位完全沒處理。使用者按的是「平倉」，
        // 這是意圖失敗，不能用最低調的中性通知帶過（市價 IOC 遇到薄簿很常見）
        return {
            kind: 'err',
            title: `⚠️ ${label} 未成交（委託已取消）`,
            body: joinParts([
                legDetail(outcomes),
                unsentBody,
                '持倉完全未處理，請確認後再決定是否重送',
            ]),
        };
    }
    return {
        kind: 'err',
        title: `⚠️ ${label} 僅部分成交`,
        body: `${joinParts([legDetail(outcomes), failBody, unsentBody])} — 持倉未完整處理，請到「委託」分頁確認剩餘部位`,
    };
}

// 逾時 ≠ 委託還掛著。對一條已經退件／取消的腿說「仍掛著」是事實錯誤，會讓
// 使用者以為出場還在進行中而繼續等待。如實列出「最後已知狀態」，並把
// 「查不到狀態」與「查到了但還沒結束」分開講。
export function summarizeTimeout(
    label: string,
    lastKnown: TradeOutcome[],
    unsentLegs: LegError[] = [],
): OutcomeNotice {
    const unsentBody = unsentDetail(unsentLegs);
    if (lastKnown.length === 0) {
        // 「完全不知道委託怎麼了」比「知道它失敗了」更危險，不可以比退件更低調
        return {
            kind: 'err',
            title: `⚠️ ${label} 無法確認委託狀態`,
            body: joinParts([
                '整段追蹤期間都查不到這些委託',
                unsentBody,
                '請到「委託」分頁確認委託與持倉後再決定是否重送',
            ]),
        };
    }
    const unresolved = lastKnown.some(
        (o) =>
            o.status === 'Failed' ||
            o.status === 'Inactive' ||
            o.status === 'Cancelled' ||
            o.dealQty > 0,
    );
    const bad = unresolved || unsentLegs.length > 0;
    return {
        kind: bad ? 'err' : 'info',
        title: bad
            ? `⚠️ ${label} 未完整成交（逾時）`
            : `⏳ ${label} 仍在撮合中`,
        body: joinParts([
            `最後狀態：${legDetail(lastKnown)}`,
            unsentBody,
            '請到「委託」分頁確認剩餘部位',
        ]),
    };
}
