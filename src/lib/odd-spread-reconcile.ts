// src/lib/odd-spread-reconcile.ts — 整零價差：委託列 → 狀態機事件（純函式）。
//
// 每筆委託帶唯一標記（custom_field，6 字元：o＋執行代碼 3 碼＋序號 2 碼）。
// 對帳規則：
// - 委託列中「完全相同標記」且商品／帳戶／方向／價量／單位都相同的唯一一筆，就是
//   這筆委託；id 與已知不同（sidecar 重啟後 trade_id 換了）→ 以新 id 重新接回。
// - 只以唯一標記對帳：沒有標記（例如投影把標記丟了）的列一律不自動採用——sidecar
//   重啟後舊編號可能被別筆委託重用，前端也無法在串流斷線前察覺；改列為候選由使用者
//   在面板指定。
// - 只有在「目前伺服器身分」下讀到的列才能把 id 授予目前身分（舊快照不行）。
// - 以標記認出的委託，價格／數量可能已被正常改單，只要求商品、帳戶、方向、單位相同。
// - 同一標記對到多列（不應發生）→ 不接回，避免猜錯。
//
// 回報帶累計成交、券商狀態與刪單量（刪單量讓「回讀仍 Submitted、刪單量已涵蓋全部」
// 也能判定為終態，見 ADR 0004）。

import { accountMatches } from './flash-account';
import { isOddLot } from './odd-lot';
import type { ExecEvent, ExecState, OrderSlot, ReportStatus } from './odd-spread-exec';

type AccountIdentity = { account_type: string; broker_id: string; account_id: string };

export interface TradeLike {
    account?: AccountIdentity;
    contract: { code: string };
    order: {
        id: string;
        action: string;
        price: number;
        quantity: number;
        order_lot?: string;
        custom_field?: string;
        account?: AccountIdentity;
    };
    status: {
        status: string;
        deal_quantity?: number;
        cancel_quantity?: number;
        deals?: { quantity: number }[];
    };
}

export interface ReconcileTarget {
    tagBase: string;
    code: string;
    account: AccountIdentity;
    state: ExecState;
}

/** 此執行某筆委託的 custom_field：o＋執行代碼 3 碼＋序號 2 碼（共 6 字元） */
export function slotTag(tagBase: string, key: string): string {
    const n = Number(key.split(':')[1] ?? 0);
    return `o${tagBase}${n.toString(36).padStart(2, '0')}`;
}

export function tradeReport(t: TradeLike): { filled: number; status: ReportStatus; cancelled?: number } {
    const deals = (t.status.deals ?? []).reduce((a, d) => a + (d.quantity || 0), 0);
    const filled = Math.max(t.status.deal_quantity || 0, deals);
    const st = t.status.status;
    const status: ReportStatus = st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working';
    const cancelled = Number(t.status.cancel_quantity);
    return { filled, status, ...(t.status.cancel_quantity !== undefined && Number.isFinite(cancelled) ? { cancelled } : {}) };
}

/** 商品、帳戶、方向、單位相同（標記或可信 id 已確認是同一筆時，價格與數量可能已被改） */
export function sameInstrument(rec: Pick<ReconcileTarget, 'code' | 'account'>, slot: OrderSlot, x: TradeLike): boolean {
    return accountMatches(x.account ?? x.order.account, rec.account)
        && x.contract.code === rec.code
        && x.order.action === slot.action
        && isOddLot(x.order.order_lot) === (slot.leg === 'odd');
}

/** 另外要求價格與數量也相同（沒有標記、只能靠內容比對時） */
export function sameOrder(rec: Pick<ReconcileTarget, 'code' | 'account'>, slot: OrderSlot, x: TradeLike): boolean {
    return sameInstrument(rec, slot, x)
        && Math.round(x.order.price * 100) === Math.round(slot.price * 100)
        && x.order.quantity === slot.quantity;
}

/**
 * 依委託列產生一筆執行的對帳事件。claimed：其他委託已使用的 id（會就地更新）；
 * gen：目前的 sidecar 世代。
 */
export function reconcileEvents(
    rec: ReconcileTarget,
    trades: TradeLike[],
    claimed: Set<string>,
    gen: string | null,
    /** 這一列是在哪個伺服器身分下取得的；省略＝目前身分（剛讀的委託列） */
    rowGen: (t: TradeLike) => string | null | undefined = () => gen,
): ExecEvent[] {
    const events: ExecEvent[] = [];
    // 舊快照（其他身分下讀到的列）不能把 id 授予目前身分
    const fresh = (t: TradeLike) => gen !== null && rowGen(t) === gen;
    for (const slot of rec.state.slots) {
        if (slot.status === 'unsent' || slot.local) continue;
        const tag = slotTag(rec.tagBase, slot.key);
        // 標記唯一：同一筆委託改價／改量後仍以標記認得（只要求商品、帳戶、方向、單位）
        const tagged = trades.filter(x => x.order.custom_field === tag && sameInstrument(rec, slot, x));
        if (tagged.length === 1) {
            const t = tagged[0]!;
            if (t.order.id !== slot.orderId || slot.idGen !== gen) {
                if (claimed.has(t.order.id) && t.order.id !== slot.orderId) continue;
                if (fresh(t)) {
                    events.push({ type: 'placed', key: slot.key, orderId: t.order.id, gen, rebind: !!slot.orderId });
                    claimed.add(t.order.id);
                } else if (!slot.orderId) {
                    // 第一次對上但來源身分不明：記下 id、不給可信身分（之後以新鮮的列確認）
                    events.push({ type: 'placed', key: slot.key, orderId: t.order.id, gen: null });
                } else if (t.order.id !== slot.orderId) {
                    continue; // 舊快照的 id 不取代，也不採用其回報
                }
            }
            events.push({ type: 'report', key: slot.key, ...tradeReport(t) });
            continue;
        }
        // 沒有唯一標記可對：不以委託編號或內容猜（編號可能被重啟後的別筆委託重用、
        // 標記被投影丟掉的列無法區分），交給使用者在面板指定。使用者指定過的委託，
        // 只在同一伺服器身分內、以新鮮的列按編號對帳
        if (slot.userClaimed && slot.orderId && gen !== null && slot.idGen === gen) {
            const t = trades.find(x => x.order.id === slot.orderId && fresh(x));
            if (t && (!t.order.custom_field || t.order.custom_field === tag) && sameInstrument(rec, slot, t)) {
                events.push({ type: 'report', key: slot.key, ...tradeReport(t) });
            }
        }
    }
    return events;
}

/** 使用者指定用的候選：同帳戶／商品／方向／價量／單位、未被認領、沒有或相同標記 */
export function candidateTrades(rec: ReconcileTarget, slot: OrderSlot, trades: TradeLike[], claimed: Set<string>, gen: string | null): TradeLike[] {
    if (slot.orderId && gen !== null && slot.idGen === gen) return [];
    const tag = slotTag(rec.tagBase, slot.key);
    return trades.filter(x => !claimed.has(x.order.id) && (!x.order.custom_field || x.order.custom_field === tag) && sameOrder(rec, slot, x));
}
