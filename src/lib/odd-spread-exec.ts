// src/lib/odd-spread-exec.ts — 整零價差兩腳送單的狀態機（純函式，可測）。
//
// reduce(state, event, ctx) → { state, commands }：呼叫端依 commands 實際送單／
// 刪單，再把結果（placed／placeUnknown／placeFailed／report／cancelResult）當成
// event 餵回來。ctx.quoteHedge 以「當下」委託簿替補單重新定價並判斷是否仍在
// 滑價上限與成本內；狀態機本身不讀行情。
//
// 總量模型（不依賴事件轉換的先後）：每個事件後都以「這筆執行所有委託」的最新
// 委託／成交狀態重算：
//   filled(leg)     各腳累計成交
//   potential(leg)  各腳最多可能成交＝已成交＋仍可能成交的剩餘量
//                   （送出中、結果不明、委託中都算；使用者標記「未送出」的不算）
//   目標量          由另一腳（sequential 為第一腳）的成交與最多可能成交推得
//                   區間 [min, max]；第一腳／另一腳還有委託在途時 min < max
// 規則：
//   · 補單只在目標確定（另一腳沒有在途委託）且 min − potential > 0 時送出；
//     自己這腳仍在途的量已算進 potential，所以「仍可能補上缺口」時絕不送。
//   · potential 超過 max（例如刪掉的單晚到成交）時，多出來的補單（由新到舊）
//     一律發刪單，直到不再超過；刪過頭的缺口下一輪以剛好的量重補。
//   · sequential 補單在滑價上限與成本內自動送；否則、或 simultaneous、或先前
//     補單被拒／被使用者刪除時，停在 hedgeDecision 由使用者決定。
//
// 終態只認券商確認：委託回報的 Filled／Cancelled／Failed（或送出前就確定沒送出）。
// 使用者按「未送出」只是暫定：之後委託列出現這筆（回報或下單回應），立即回到
// 委託中並重新計算。
//
// 冪等：每筆委託有唯一 key，只有 unsent → sending 會產生 place 指令；成交量以
// 累計量回報（取最大值）；券商終態不會被較舊的「委託中」回報蓋回。

import { ODD_LOT_MAX_SHARES, SHARES_PER_LOT } from './odd-lot';
import type { LegOrder, SpreadDirection } from './odd-spread';

export type ExecMode = 'sequential' | 'simultaneous';
export type LegKind = 'odd' | 'round';

export type ExecPhase =
    | 'idle'
    | 'oddPending'
    | 'oddPartial'
    | 'roundPending'
    | 'roundPartial'
    | 'bothPending'
    | 'unknown'
    | 'hedgeDecision'
    | 'done'
    | 'failed'
    | 'cancelled';

export type SlotStatus = 'unsent' | 'sending' | 'unknown' | 'working' | 'filled' | 'cancelled' | 'failed';

export interface OrderSlot {
    key: string;
    leg: LegKind;
    action: 'Buy' | 'Sell';
    price: number;
    /** 整股為張、零股為股 */
    quantity: number;
    status: SlotStatus;
    orderId?: string;
    /** 取得 orderId 時的 sidecar 世代（trade_id 只在該 sidecar 程序內有效）；世代變了
     * 舊 id 不可信，只能以唯一標記重新接回 */
    idGen?: string | null;
    /** 累計成交（同 quantity 單位） */
    filled: number;
    /** 券商回報的刪單量（判斷終態數量是否對得上） */
    cancelledQty?: number;
    /** 送出前就確定沒送出（mutationNotStarted）或尚未送出就取消 */
    local?: boolean;
    /** 結果不明時使用者標記「未送出」（暫定；委託出現就撤銷） */
    markedUnsent?: boolean;
    /** 使用者確認沒送出、放棄追蹤 */
    abandoned?: boolean;
    /** 使用者在面板指定的（沒有標記的）委託：只在同一伺服器身分內以編號對帳 */
    userClaimed?: boolean;
    /** 刪單狀態：pending＝已發出等待結果、sent＝券商已受理、failed＝刪單失敗、
     * unknown＝等待結果時重新整理而遺失回應（委託仍在委託中就可再按取消重試） */
    cancelState?: 'pending' | 'sent' | 'failed' | 'unknown';
    cancelError?: string;
    /** 送出途中／結果不明時要刪：拿到委託編號就刪單 */
    cancelWanted?: boolean;
    /** 為多出的補單而刪（不算「補單被拒」） */
    surplus?: boolean;
    /** 補單 */
    hedge?: boolean;
    error?: string;
}

export interface ExecPlan {
    direction: SpreadDirection;
    mode: ExecMode;
    /** sequential 的第一腳，預設零股 */
    firstLeg?: LegKind;
    /** 整股計畫張數 */
    lots: number;
    /** 整股限價 */
    roundPrice: number;
    /** 零股計畫委託（每筆 ≤ 999 股） */
    oddOrders: LegOrder[];
    /** 計畫時的加權淨價差 元/股（補單重新定價的成本上限） */
    netPerShare?: number;
}

export interface PendingHedge {
    leg: LegKind;
    action: 'Buy' | 'Sell';
    /** 需補數量（整股張、零股股） */
    quantity: number;
    reason: string;
    /** 以最新委託簿建議的補單 */
    orders: LegOrder[];
    /** 決定版本：腳、方向或數量改變就換版本，舊的確認一律拒絕 */
    version: number;
}

export interface ExecState {
    plan: ExecPlan;
    phase: ExecPhase;
    slots: OrderSlot[];
    started: boolean;
    cancelRequested: boolean;
    seq: number;
    /** 使用者選擇不補的數量（各腳單位） */
    waived: Record<LegKind, number>;
    pendingHedge: PendingHedge | null;
    /** 補單決定的版本序號 */
    hedgeSeq?: number;
}

export type HedgeQuote = { ok: true; orders: LegOrder[] } | { ok: false; reason: string; orders: LegOrder[] };

export interface ExecContext {
    /** 以當下委託簿為補單定價；ok=false 時不自動送 */
    quoteHedge: (leg: LegKind, action: 'Buy' | 'Sell', quantity: number) => HedgeQuote;
    /** 目前的伺服器身分（連線世代）；null＝無法判定。省略時視為委託編號都可信（純測試用） */
    currentGen?: () => string | null;
}

/** 委託編號在目前伺服器身分下可信（trade_id 只在同一 sidecar 程序有效） */
function idTrusted(s: OrderSlot, ctx: ExecContext): boolean {
    if (!s.orderId) return false;
    if (!ctx.currentGen) return true;
    const g = ctx.currentGen();
    return g !== null && s.idGen === g;
}

export type ReportStatus = 'working' | 'filled' | 'cancelled' | 'failed';

export type ExecEvent =
    | { type: 'start' }
    /** 取得委託編號；rebind=true 表示以唯一標記在權威更新中找到同一筆、換成新 id */
    | { type: 'placed'; key: string; orderId: string; gen?: string | null; rebind?: boolean; userClaimed?: boolean }
    /** 送出失敗但可能已到券商 */
    | { type: 'placeUnknown'; key: string; error: string }
    /** 確定沒有送出 */
    | { type: 'placeFailed'; key: string; error: string }
    /** 委託最新狀態（累計成交、刪單量） */
    | { type: 'report'; key: string; filled: number; status: ReportStatus; cancelled?: number }
    | { type: 'cancel' }
    | { type: 'cancelResult'; key: string; ok: boolean; error?: string }
    /** 使用者核對後認為 unknown 那筆沒有送出（暫定） */
    | { type: 'resolveUnknown'; key: string }
    /** 使用者確認補單：數量與委託（價格）都是確認當下凍結的；缺口已變就拒絕 */
    | { type: 'hedgeAccept'; version: number; leg: LegKind; action: 'Buy' | 'Sell'; quantity: number; orders: LegOrder[] }
    | { type: 'hedgeDecline'; version: number }
    /** 使用者確認標記「未送出」的委託確實沒有送出、放棄追蹤（不再阻擋新的價差單） */
    | { type: 'abandonUnknown'; key: string }
    /** 重新整理接回後重算一次（例如重新發出遺失回應的多餘補單刪單） */
    | { type: 'refresh' };

export type ExecCommand =
    | { kind: 'place'; key: string; leg: LegKind; action: 'Buy' | 'Sell'; price: number; quantity: number }
    | { kind: 'cancel'; key: string; orderId: string };

export interface ExecResult {
    state: ExecState;
    commands: ExecCommand[];
}

const FINAL: ReadonlySet<SlotStatus> = new Set(['filled', 'cancelled', 'failed']);

/** 仍可能成交（在途） */
export function isLive(s: OrderSlot): boolean {
    return s.status === 'sending' || s.status === 'working' || (s.status === 'unknown' && !s.markedUnsent);
}

/** 券商確認的終態（或送出前就確定沒送出），且數量對得上 */
export function isBrokerFinal(s: OrderSlot): boolean {
    if (!FINAL.has(s.status)) return false;
    if (s.local || s.status === 'filled' || s.status === 'failed') return true;
    return s.cancelledQty !== undefined && s.filled + s.cancelledQty >= s.quantity;
}

/** 成交＋刪單量已涵蓋委託量 → 不論回讀狀態（可能仍是 Submitted，見 ADR 0004）都是終態 */
function coveredStatus(filled: number, cancelled: number | undefined, quantity: number): SlotStatus | null {
    if (filled >= quantity) return 'filled';
    if (cancelled !== undefined && filled + cancelled >= quantity) return 'cancelled';
    return null;
}

/** 已發刪單（刪單失敗的由使用者按「再次取消」重試，不自動連發） */
const cancelIssued = (s: OrderSlot) => s.cancelState === 'pending' || s.cancelState === 'sent' || s.cancelState === 'failed' || !!s.cancelWanted;
/** 在途剩餘：委託量 − 成交 − 已刪（部分刪單後的回讀仍可能是 Submitted） */
const remaining = (s: OrderSlot) => (isLive(s) ? Math.max(0, s.quantity - s.filled - (s.cancelledQty ?? 0)) : 0);
/** 券商已回報「刪單」，但「成交＋刪單量」還對不上委託量：差額仍可能是尚未送達的成交。
 * Failed（拒單）是終態：成交以回報為準，沒有剩餘可能成交量。 */
export function unaccounted(s: OrderSlot): number {
    if (s.local || s.status !== 'cancelled' || s.cancelledQty === undefined) return 0;
    return Math.max(0, s.quantity - s.filled - s.cancelledQty);
}
/** 仍可能增加的成交量（在途剩餘＋對不上的差額） */
const open = (s: OrderSlot) => remaining(s) + unaccounted(s);

export function isTerminalPhase(p: ExecPhase): boolean {
    return p === 'done' || p === 'failed' || p === 'cancelled';
}

export function legAction(direction: SpreadDirection, leg: LegKind): 'Buy' | 'Sell' {
    const buyOdd = direction === 'buyOddSellRound';
    return (leg === 'odd') === buyOdd ? 'Buy' : 'Sell';
}

function firstLegOf(plan: ExecPlan): LegKind {
    return plan.firstLeg ?? 'odd';
}

/** 零股每筆上限 999 股：超過就拆（總量不變） */
function splitOdd(orders: LegOrder[]): LegOrder[] {
    const out: LegOrder[] = [];
    for (const o of orders) {
        for (let left = o.quantity; left > 0;) {
            const q = Math.min(ODD_LOT_MAX_SHARES, left);
            out.push({ price: o.price, quantity: q });
            left -= q;
        }
    }
    return out;
}

function makeSlots(state: ExecState, leg: LegKind, orders: LegOrder[], hedge = false): { slots: OrderSlot[]; seq: number } {
    let seq = state.seq;
    const slots = (leg === 'odd' ? splitOdd(orders) : orders)
        .filter(o => o.quantity > 0 && o.price > 0)
        .map(o => ({
            key: `${leg}:${seq++}`,
            leg,
            action: legAction(state.plan.direction, leg),
            price: o.price,
            quantity: o.quantity,
            status: 'unsent' as const,
            filled: 0,
            ...(hedge ? { hedge: true } : {}),
        }));
    return { slots, seq };
}

/** 計畫的零股委託取前 shares 股 */
export function takeOddOrders(orders: LegOrder[], shares: number): LegOrder[] {
    const out: LegOrder[] = [];
    let left = shares;
    for (const o of orders) {
        if (left <= 0) break;
        const q = Math.min(o.quantity, left);
        out.push({ price: o.price, quantity: q });
        left -= q;
    }
    return out;
}

export function initExec(plan: ExecPlan): ExecState {
    return { plan, phase: 'idle', slots: [], started: false, cancelRequested: false, seq: 0, waived: { odd: 0, round: 0 }, pendingHedge: null };
}

// ---- 總量 ----

export function filledOf(s: ExecState, leg: LegKind): number {
    return s.slots.filter(x => x.leg === leg).reduce((a, x) => a + x.filled, 0);
}

export function potentialOf(s: ExecState, leg: LegKind): number {
    return s.slots.filter(x => x.leg === leg).reduce((a, x) => a + x.filled + open(x), 0);
}

function oddPlanned(plan: ExecPlan): number {
    return plan.oddOrders.reduce((a, o) => a + o.quantity, 0);
}

export interface LegTarget {
    /** 依另一腳已成交推得的目標（確定要配的量） */
    min: number;
    /** 依另一腳最多可能成交推得的上限 */
    max: number;
    /** 另一腳沒有在途委託 → min 即最終目標 */
    determined: boolean;
}

/** 各腳的配對目標（只有需要配對的腳才有） */
export function legTargets(s: ExecState): Partial<Record<LegKind, LegTarget>> {
    const { plan } = s;
    if (!s.started) return {};
    const lots = plan.lots;
    const oddCap = oddPlanned(plan);
    const roundFrom = (oddShares: number) => (oddShares >= oddCap ? lots : Math.min(lots, Math.floor(oddShares / SHARES_PER_LOT)));
    const oddFrom = (roundLots: number) => (roundLots >= lots ? oddCap : Math.min(oddCap, roundLots * SHARES_PER_LOT));
    const liveOn = (leg: LegKind) => s.slots.some(x => x.leg === leg && open(x) > 0);
    if (plan.mode === 'sequential') {
        const first = firstLegOf(plan);
        if (!s.slots.some(x => x.leg === first)) return {};
        const f = first === 'odd' ? roundFrom : oddFrom;
        const hedgeLeg: LegKind = first === 'odd' ? 'round' : 'odd';
        return { [hedgeLeg]: { min: f(filledOf(s, first)), max: f(potentialOf(s, first)), determined: !liveOn(first) } };
    }
    return {
        round: { min: roundFrom(filledOf(s, 'odd')), max: roundFrom(potentialOf(s, 'odd')), determined: !liveOn('odd') },
        odd: { min: oddFrom(filledOf(s, 'round')), max: oddFrom(potentialOf(s, 'round')), determined: !liveOn('round') },
    };
}

export interface ExecSummary {
    oddFilledShares: number;
    roundFilledLots: number;
    /** 零股計畫股數 */
    oddPlannedShares: number;
    /** 未配對股數：零股成交股數 − 整股成交股數（>0 表示零股那邊多） */
    unhedgedShares: number;
    /** 結果不明（未標記）的委託數 */
    unknownCount: number;
}

export function execSummary(s: ExecState): ExecSummary {
    const odd = filledOf(s, 'odd');
    const round = filledOf(s, 'round');
    return {
        oddFilledShares: odd,
        roundFilledLots: round,
        oddPlannedShares: oddPlanned(s.plan),
        unhedgedShares: odd - round * SHARES_PER_LOT,
        unknownCount: s.slots.filter(x => x.status === 'unknown' && !x.markedUnsent).length,
    };
}

/** 每筆委託都已是券商確認的終態 */
export function allBrokerFinal(s: ExecState): boolean {
    return s.slots.every(isBrokerFinal);
}

function sendUnsent(slots: OrderSlot[], commands: ExecCommand[]): OrderSlot[] {
    return slots.map(s => {
        if (s.status !== 'unsent') return s;
        commands.push({ kind: 'place', key: s.key, leg: s.leg, action: s.action, price: s.price, quantity: s.quantity });
        return { ...s, status: 'sending' };
    });
}

/** 對一筆在途委託發刪單（或登記拿到委託編號後刪） */
function cancelSlot(s: OrderSlot, commands: ExecCommand[], ctx: ExecContext, surplus = false): OrderSlot {
    if (s.status === 'unsent') return { ...s, status: 'cancelled', local: true, surplus };
    if (!isLive(s)) return s;
    // 沒有委託編號，或編號來自別的伺服器身分（sidecar 重啟後可能被別的委託重用）：
    // 絕不以舊編號刪單，登記「待重新接回後刪單」
    if (!s.orderId || !idTrusted(s, ctx)) return { ...s, cancelWanted: true, ...(surplus ? { surplus } : {}) };
    if (s.cancelState === 'pending') return s;
    commands.push({ kind: 'cancel', key: s.key, orderId: s.orderId });
    return { ...s, cancelState: 'pending', cancelError: undefined, ...(surplus ? { surplus } : {}) };
}

/** 建議委託的總量對齊需補數量（不足的部分加到最後一筆） */
function fitOrders(orders: LegOrder[], quantity: number): LegOrder[] {
    const out = takeOddOrders(orders, quantity);
    const got = out.reduce((a, o) => a + o.quantity, 0);
    const last = out[out.length - 1];
    if (got < quantity && last) out[out.length - 1] = { ...last, quantity: last.quantity + quantity - got };
    return out;
}

// 每個事件後以總量重算：刪多出的補單、決定是否補單、計算 phase
function advance(state: ExecState, commands: ExecCommand[], ctx: ExecContext): ExecState {
    let s = state;
    const targets = legTargets(s);
    let pending: PendingHedge | null = null;
    for (const leg of ['round', 'odd'] as LegKind[]) {
        const t = targets[leg];
        if (!t) continue;
        // 1) 多出的補單：potential 超過上限就由新到舊刪，直到不再超過；刪掉後若反而
        //    不足，下一輪會以剛好的缺口重新補（委託量不能部分刪，寧可重補也不超送）
        let effective = s.slots.filter(x => x.leg === leg).reduce((a, x) => a + x.filled + unaccounted(x) + (cancelIssued(x) ? 0 : remaining(x)), 0);
        if (effective > t.max) {
            const slots = [...s.slots];
            for (let i = slots.length - 1; i >= 0 && effective > t.max; i--) {
                const x = slots[i]!;
                if (x.leg !== leg || !x.hedge || !isLive(x) || cancelIssued(x)) continue;
                slots[i] = cancelSlot(x, commands, ctx, true);
                effective -= remaining(x);
            }
            s = { ...s, slots };
        }
        // 2) 缺口：目標確定、且連在途的量都補不上時才補
        const gap = t.determined ? t.min - potentialOf(s, leg) - s.waived[leg] : 0;
        if (gap <= 0) continue;
        const action = legAction(s.plan.direction, leg);
        const q = ctx.quoteHedge(leg, action, gap);
        // 補單被拒或被使用者刪掉（非為多出而刪）→ 不自動重送
        const rejectedBefore = s.slots.some(x => x.leg === leg && x.hedge && !x.surplus && (x.status === 'failed' || x.status === 'cancelled') && x.filled < x.quantity);
        const auto = s.plan.mode === 'sequential' && !rejectedBefore && !s.pendingHedge && q.ok;
        if (auto) {
            const made = makeSlots(s, leg, fitOrders(q.orders, gap), true);
            s = { ...s, seq: made.seq, slots: sendUnsent([...s.slots, ...made.slots], commands) };
        } else {
            const reason = !q.ok ? q.reason
                : s.plan.mode === 'simultaneous' ? '兩腳成交數量不對等'
                    : rejectedBefore ? '補單未成交（被拒或已刪除）' : s.pendingHedge?.reason ?? '第二腳待確認';
            const prev = s.pendingHedge;
            const same = prev && prev.leg === leg && prev.action === action && prev.quantity === gap;
            const version = same ? prev.version : (s.hedgeSeq ?? 0) + 1;
            pending = { leg, action, quantity: gap, reason, orders: fitOrders(q.orders, gap), version };
            s = { ...s, hedgeSeq: Math.max(s.hedgeSeq ?? 0, version) };
        }
    }
    s = { ...s, pendingHedge: pending };
    return { ...s, phase: phaseOf(s) };
}

function phaseOf(s: ExecState): ExecPhase {
    if (!s.started) return s.cancelRequested ? 'cancelled' : 'idle';
    if (s.slots.some(x => x.status === 'unknown' && !x.markedUnsent)) return 'unknown';
    if (s.pendingHedge) return 'hedgeDecision';
    const live = s.slots.filter(x => open(x) > 0);
    if (live.length > 0) {
        if (s.plan.mode === 'simultaneous') return 'bothPending';
        const leg = live[0]!.leg;
        const filled = s.slots.filter(x => x.leg === leg).some(x => x.filled > 0);
        if (leg === 'odd') return filled ? 'oddPartial' : 'oddPending';
        return filled ? 'roundPartial' : 'roundPending';
    }
    const sum = execSummary(s);
    if (sum.roundFilledLots === s.plan.lots && sum.oddFilledShares === sum.oddPlannedShares) return 'done';
    if (sum.unhedgedShares !== 0) return 'failed';
    return s.cancelRequested ? 'cancelled' : 'failed';
}

function mapSlot(state: ExecState, key: string, fn: (s: OrderSlot) => OrderSlot | null): ExecState | null {
    let changed = false;
    const slots = state.slots.map(s => {
        if (s.key !== key) return s;
        const next = fn(s);
        if (!next || next === s) return s;
        changed = true;
        return next;
    });
    return changed ? { ...state, slots } : null;
}

/** 重新整理後接回：送出中 → 結果不明；刪單等待中 → 刪單結果不明 */
export function restoreAfterReload(state: ExecState): ExecState {
    return {
        ...state,
        slots: state.slots.map(s => ({
            ...s,
            ...(s.status === 'sending' ? { status: 'unknown' as const } : {}),
            ...(s.cancelState === 'pending' ? { cancelState: 'unknown' as const } : {}),
        })),
    };
}

export function execReduce(state: ExecState, event: ExecEvent, ctx: ExecContext): ExecResult {
    const commands: ExecCommand[] = [];
    const done = (next: ExecState | null): ExecResult => (next ? { state: advance(next, commands, ctx), commands } : { state, commands });
    switch (event.type) {
        case 'start': {
            if (state.started || state.cancelRequested) return { state, commands };
            const { plan } = state;
            if (plan.lots <= 0 || plan.oddOrders.every(o => o.quantity <= 0)) {
                return { state: { ...state, started: true, phase: 'failed' }, commands };
            }
            let s: ExecState = { ...state, started: true };
            const add = (leg: LegKind, orders: LegOrder[]) => {
                const made = makeSlots(s, leg, orders);
                s = { ...s, seq: made.seq, slots: [...s.slots, ...made.slots] };
            };
            const round = [{ price: plan.roundPrice, quantity: plan.lots }];
            if (plan.mode === 'simultaneous') {
                add('odd', plan.oddOrders);
                add('round', round);
            } else if (firstLegOf(plan) === 'odd') add('odd', plan.oddOrders);
            else add('round', round);
            s = { ...s, slots: sendUnsent(s.slots, commands) };
            return { state: { ...s, phase: phaseOf(s) }, commands };
        }
        case 'placed':
            return done(mapSlot(state, event.key, s => {
                if (s.status === 'unsent' || s.local) return null;
                if (s.orderId && !event.rebind) return null;
                if (s.orderId === event.orderId && s.idGen === event.gen) return null;
                // 回報可能比下單回應先到；標記「未送出」的委託出現了 → 撤銷標記；
                // sidecar 重啟後同一筆委託換了 id → 以唯一標記接回的新 id 取代
                const status: SlotStatus = s.status === 'sending' || s.status === 'unknown' ? 'working' : s.status;
                const next: OrderSlot = { ...s, status, orderId: event.orderId, idGen: event.gen, markedUnsent: false, userClaimed: event.userClaimed ?? false };
                const fresh = !ctx.currentGen || (event.gen !== undefined && event.gen !== null && event.gen === ctx.currentGen());
                if (s.cancelWanted && status === 'working' && fresh) {
                    commands.push({ kind: 'cancel', key: s.key, orderId: event.orderId });
                    next.cancelState = 'pending';
                    next.cancelWanted = false;
                }
                return next;
            }));
        case 'placeUnknown':
            return done(mapSlot(state, event.key, s => (s.status === 'sending' ? { ...s, status: 'unknown', error: event.error } : null)));
        case 'placeFailed':
            return done(mapSlot(state, event.key, s => (s.status === 'sending' ? { ...s, status: 'failed', local: true, error: event.error } : null)));
        case 'abandonUnknown':
            return done(mapSlot(state, event.key, s => (s.status === 'unknown' && s.markedUnsent ? { ...s, status: 'failed', local: true, abandoned: true, markedUnsent: false } : null)));
        case 'resolveUnknown':
            return done(mapSlot(state, event.key, s => (s.status === 'unknown' && !s.markedUnsent ? { ...s, markedUnsent: true } : null)));
        case 'report':
            return done(mapSlot(state, event.key, s => {
                if (s.local) return null;
                const filled = Math.min(s.quantity, Math.max(s.filled, Math.trunc(event.filled) || 0));
                const cancelledQty = event.cancelled !== undefined ? Math.max(s.cancelledQty ?? 0, event.cancelled) : s.cancelledQty;
                let status: SlotStatus;
                const covered = coveredStatus(filled, cancelledQty, s.quantity);
                if (covered === 'filled') status = 'filled';
                else if (FINAL.has(s.status)) status = s.status; // 券商終態不被較舊的回報蓋回
                else if (event.status === 'cancelled' || event.status === 'failed') status = event.status;
                else status = covered ?? 'working'; // 回讀仍 Submitted，但刪單量已涵蓋全部 → 終態
                const next: OrderSlot = { ...s, filled, status, cancelledQty, markedUnsent: false };
                if (next.status === s.status && next.filled === s.filled && next.cancelledQty === s.cancelledQty && !s.markedUnsent) return null;
                if (!isLive(next)) next.cancelWanted = false;
                return next;
            }));
        case 'cancelResult':
            return done(mapSlot(state, event.key, s => (s.cancelState === 'pending'
                ? { ...s, cancelState: event.ok ? 'sent' : 'failed', cancelError: event.ok ? undefined : event.error }
                : null)));
        case 'cancel': {
            if (!state.started) return { state: { ...state, phase: 'cancelled', cancelRequested: true }, commands };
            // 已發出、尚未有結果的不重送；失敗、結果不明或受理後仍在委託中的可再刪
            const slots = state.slots.map(s => (isLive(s) || s.status === 'unsent' ? cancelSlot(s, commands, ctx) : s));
            return { state: advance({ ...state, cancelRequested: true, slots }, commands, ctx), commands };
        }
        case 'hedgeAccept': {
            const p = state.pendingHedge;
            // 確認內容（版本、腳、方向、數量、每筆價格）凍結；待補內容變了就不送，由呼叫端
            // 重新詢問；絕不送與確認不同的腳或超過確認的量
            const total = event.orders.reduce((a, o) => a + o.quantity, 0);
            if (!p || event.version !== p.version || event.leg !== p.leg || event.action !== p.action || event.quantity !== p.quantity
                || total !== event.quantity || event.orders.some(o => !(o.quantity > 0 && o.price > 0))) return { state, commands };
            const orders = event.orders;
            const made = makeSlots(state, p.leg, orders, true);
            const s: ExecState = { ...state, pendingHedge: null, seq: made.seq, slots: sendUnsent([...state.slots, ...made.slots], commands) };
            return { state: { ...s, phase: phaseOf(s) }, commands };
        }
        case 'refresh':
            return { state: advance(state, commands, ctx), commands };
        case 'hedgeDecline': {
            const p = state.pendingHedge;
            if (!p || p.version !== event.version) return { state, commands };
            const s: ExecState = { ...state, pendingHedge: null, waived: { ...state.waived, [p.leg]: state.waived[p.leg] + p.quantity } };
            return { state: { ...s, phase: phaseOf(s) }, commands };
        }
    }
}

export const PHASE_LABEL: Record<ExecPhase, string> = {
    idle: '待送出',
    oddPending: '零股委託中',
    oddPartial: '零股部分成交',
    roundPending: '整股委託中',
    roundPartial: '整股部分成交',
    bothPending: '兩腳委託中',
    unknown: '委託結果未確認',
    hedgeDecision: '未配對，待處理',
    done: '完成',
    failed: '未完成',
    cancelled: '已取消',
};
