// src/lib/flash-flatten-restore.ts — 閃電「平倉」 ends the product's
// 停損停利 first, then sends a market IOC close. When that close does not
// fill (or fills partly), the lots still held were left unprotected (QA
// 10/13: a night-session IOC close was cancelled with nothing filled). This
// re-reads the position and, once, puts the protection back for what is
// still held (capped by the position and by what was protected), as plain
// protective stop / take triggers at the prices they had. It never sends an
// order: a stop already crossed now is not put back (it would fire at once)
// and the user is told.

import type { ProtectionSnapshot } from './flash-trigger';
// 「仍持有 N」是持倉數量：遮金額時不露，通知中心渲染時可重遮（#268）
import { secretMoney } from './privacy';
import type { NewTrigger } from './trigger-engine';

/** One protection to put back. */
export interface RestoreLeg {
    exitAction: 'Buy' | 'Sell';
    stop: number | null;
    take: number | null;
    quantity: number;
}

export interface RestorePlan {
    legs: RestoreLeg[];
    /** what was not put back and why */
    skipped: string[];
}

const crossedStop = (exit: 'Buy' | 'Sell', stop: number, last: number) => (exit === 'Sell' ? last <= stop : last >= stop);
const crossedTake = (exit: 'Buy' | 'Sell', take: number, last: number) => (exit === 'Sell' ? last >= take : last <= take);

/** What to put back for `remaining` held lots (same direction as before). */
export function restorePlan(snapshots: readonly ProtectionSnapshot[], remaining: number, last: number | null): RestorePlan {
    const out: RestorePlan = { legs: [], skipped: [] };
    let left = Math.max(0, Math.floor(remaining));
    for (const s of [...snapshots].sort((a, b) => b.quantity - a.quantity)) {
        if (left <= 0) break;
        const quantity = Math.min(left, s.quantity);
        let { stop, take } = s;
        if (last !== null && stop !== null && crossedStop(s.exitAction, stop, last)) {
            out.skipped.push(`停損 ${stop} 已穿價（現價 ${last}），沒有恢復，避免立刻觸發`);
            stop = null;
        }
        if (last !== null && take !== null && crossedTake(s.exitAction, take, last)) {
            out.skipped.push(`停利 ${take} 已穿價（現價 ${last}），沒有恢復，避免立刻觸發`);
            take = null;
        }
        if (stop === null && take === null) continue;
        out.legs.push({ exitAction: s.exitAction, stop, take, quantity });
        left -= quantity;
    }
    return out;
}

/** The triggers of one leg: protective (no entry role), futures close only. */
export function restoreTriggers(leg: RestoreLeg, c: { code: string; futures: boolean; odd: boolean; group: string }): NewTrigger[] {
    const base = {
        code: c.code, action: leg.exitAction, quantity: leg.quantity,
        ...(c.futures ? { octype: 'Cover' as const } : {}),
        ...(c.odd ? { orderLot: 'IntradayOdd' as const } : {}),
    };
    const sell = leg.exitAction === 'Sell';
    const out: NewTrigger[] = [];
    if (leg.stop !== null) out.push({ ...base, condition: sell ? 'below' : 'above', price: leg.stop, kind: 'stop' });
    if (leg.take !== null) out.push({ ...base, condition: sell ? 'above' : 'below', price: leg.take, kind: 'take' });
    return out.length > 1 ? out.map(t => ({ ...t, group: c.group, ocoMode: 'trigger' as const })) : out;
}

export const READBACK_DELAYS_MS = [1500, 2500, 4000, 6000];

/** The close order as the App knows it now; null: not readable. */
export interface CloseState {
    /** Filled / Cancelled / Failed (never PendingSubmit / Inactive / Submitted) */
    final: boolean;
    filled: number;
}

export interface WatchDeps {
    /** the close order's state (cache read, no broker call) */
    readClose: () => Promise<CloseState | null>;
    /** signed held quantity in the order unit now (null: could not read) */
    readHeld: () => Promise<number | null>;
    /** the traded price of THIS product now (null: unknown) */
    last: () => number | null | Promise<number | null>;
    /** the protection environment is still the one the close was sent in */
    envOk: () => boolean | Promise<boolean>;
    /** puts one leg back; false / throw: not confirmed */
    restore: (leg: RestoreLeg) => Promise<boolean>;
    notify: (n: { kind: 'ok' | 'err' | 'info'; title: string; body: string }) => void;
    sleep?: (ms: number) => Promise<void>;
    delays?: readonly number[];
}

export type WatchOutcome = 'closed' | 'restored' | 'partly' | 'failed' | 'unknown' | 'none';

export const READ_TIMEOUT_MS = 5_000;
/** A read that does not answer in time counts as unreadable (never holds the flow). */
function bounded<T>(p: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T | null> {
    return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]).catch(() => null);
}

const UNPROTECTED_TAIL = '請到委託與持倉確認，必要時自行設定停損停利';

/** After a 平倉: wait until the close order is final, re-read the position,
 * then put back (once) the protection for what is still held. `before` is
 * the signed position the close was sent for (order units). Nothing is put
 * back while the close may still fill, in another environment, or without a
 * price of this product to check crossed legs against. */
export async function restoreAfterUnfilledClose(before: number, snapshots: readonly ProtectionSnapshot[], code: string, unit: string,
    deps: WatchDeps): Promise<WatchOutcome> {
    if (!snapshots.length || before === 0) return 'none';
    const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    const say = (title: string, body: string) => deps.notify({ kind: 'err', title, body });
    // 1. the close must be final first (a working close may still fill)
    let close: CloseState | null = null;
    for (const d of deps.delays ?? READBACK_DELAYS_MS) {
        close = await bounded(deps.readClose());
        if (close?.final) break;
        await sleep(d);
    }
    if (!close?.final) {
        say('⚡ 平倉結果尚未確定，停損停利未恢復', `${code}：平倉單還沒有最終結果，平倉前取消的停損停利沒有恢復（未受保護）。${UNPROTECTED_TAIL}`);
        return 'unknown';
    }
    if (close.filled >= Math.abs(before)) return 'closed';
    // 2. the position after the final close (a short wait for it to catch up)
    let held: number | null = null;
    for (const d of [0, ...(deps.delays ?? READBACK_DELAYS_MS).slice(0, 2)]) {
        if (d) await sleep(d);
        held = await bounded(deps.readHeld());
        if (held !== null) break;
    }
    if (held === null) {
        say('⚡ 平倉未完全成交，停損停利未恢復', `${code}：無法重新查詢持倉，平倉前取消的停損停利沒有恢復（未受保護）。${UNPROTECTED_TAIL}`);
        return 'unknown';
    }
    // flat, or the other way round: never protect a position we did not hold
    if (held === 0 || Math.sign(held) !== Math.sign(before)) return 'closed';
    const remaining = Math.min(Math.abs(held), Math.abs(before) - close.filled);
    if (remaining <= 0) return 'closed';
    if (!(await deps.envOk())) {
        say('⚡ 平倉未成交，停損停利未恢復（未受保護）', `${code} 仍持有 ${secretMoney(`${remaining} ${unit}`)}；伺服器或模擬／正式模式已切換，沒有恢復。${UNPROTECTED_TAIL}`);
        return 'failed';
    }
    const last = await deps.last();
    if (last === null) {
        say('⚡ 平倉未成交，停損停利未恢復（未受保護）', `${code} 仍持有 ${secretMoney(`${remaining} ${unit}`)}；沒有即時成交價可確認停損停利是否已穿價，沒有恢復。${UNPROTECTED_TAIL}`);
        return 'failed';
    }
    // only protections that close what is held (a long's protection sells)
    const exit = held > 0 ? 'Sell' : 'Buy';
    const plan = restorePlan(snapshots.filter(s => s.exitAction === exit), remaining, last);
    let restored = 0;
    const failed: string[] = [];
    for (const leg of plan.legs) {
        // each leg binds the environment current when it is created: checked per leg
        if (!(await deps.envOk())) { failed.push(`${leg.quantity} ${unit}（伺服器或模擬／正式模式已切換）`); continue; }
        try {
            if (await deps.restore(leg)) restored += leg.quantity;
            else failed.push(`${leg.quantity} ${unit}`);
        } catch (e) {
            failed.push(`${leg.quantity} ${unit}（${e instanceof Error ? e.message : String(e)}）`);
        }
    }
    const what = plan.legs.map(l => `${l.stop !== null ? `停損 ${l.stop}` : ''}${l.stop !== null && l.take !== null ? '・' : ''}${l.take !== null ? `停利 ${l.take}` : ''}`).join('；');
    const notes = [...plan.skipped, ...(failed.length ? [`恢復未確認：${failed.join('、')}`] : [])];
    const unprotected = remaining - restored;
    if (restored > 0 && unprotected <= 0 && !notes.length) {
        say('⚡ 平倉未成交，已恢復停損停利', `${code} 仍持有 ${secretMoney(`${remaining} ${unit}`)}：已恢復 ${what}（固定價格，不含移動停損）。不會自動再平倉`);
        return 'restored';
    }
    if (restored > 0) {
        say('⚡ 平倉未成交，停損停利只恢復一部分', `${code} 仍持有 ${secretMoney(`${remaining} ${unit}`)}：已恢復 ${restored} ${unit}（${what}）${
            unprotected > 0 ? `；未受保護 ${unprotected} ${unit}` : ''}。${notes.join('；')}；請自行補上沒有恢復的部分`);
        return 'partly';
    }
    say('⚡ 平倉未成交，停損停利未恢復（未受保護）', `${code} 仍持有 ${secretMoney(`${remaining} ${unit}`)}，沒有停損停利。${notes.join('；') || '恢復未確認'}；請自行處理`);
    return 'failed';
}

/** Stocks: nothing is put back (a sell trigger without the shares could open
 * a short); when shares are still held after the close, say they are no
 * longer protected. `beforeShares` is the share count the close was for. */
export async function warnIfStillHeld(beforeShares: number, code: string, deps: Pick<WatchDeps, 'readHeld' | 'notify' | 'sleep' | 'delays'>): Promise<boolean> {
    const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    let held: number | null = null;
    for (const d of deps.delays ?? READBACK_DELAYS_MS) {
        await sleep(d);
        held = await bounded(deps.readHeld());
        if (held !== null && (held === 0 || Math.sign(held) !== Math.sign(beforeShares))) return false;
    }
    deps.notify({ kind: 'err', title: '⚡ 平倉未完全成交，停損停利已取消（未受保護）', body: held === null
        ? `${code}：無法確認平倉後的持倉；平倉前取消的停損停利不會自動恢復。${UNPROTECTED_TAIL}`
        : `${code} 仍持有 ${secretMoney(`${Math.abs(held).toLocaleString()} 股`)}；平倉前取消的停損停利不會自動恢復（股票）。${UNPROTECTED_TAIL}` });
    return true;
}

// ---- one 平倉 at a time per account + product, across windows ----

const localHeld = new Set<string>();
/** Runs `fn` holding the account + product's 平倉 lock (also across windows
 * with Web Locks); false when another 平倉 of it is still running or watching. */
export async function withFlattenLock(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (localHeld.has(key)) return false;
    localHeld.add(key);
    try {
        const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
        if (!locks?.request) { await fn(); return true; }
        let ran = false;
        await locks.request(`sj-flash-flatten:${key}`, { ifAvailable: true }, async lock => {
            if (!lock) return;
            ran = true;
            await fn();
        });
        return ran;
    } finally {
        localHeld.delete(key);
    }
}
