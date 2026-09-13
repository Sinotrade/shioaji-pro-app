// src/lib/spiderweb-engine.ts — client-side spider-web (蛛網) strategy
// engine. Manages multi-level grid strategies where each entry automatically
// arms a reverse exit at the next price level. Persists to localStorage and
// runs while the app is open (stops when app closes — inherent client-side
// limitation). Reconciles fills via SSE deal events + polling fallback.

import { useSyncExternalStore } from 'react';
import { ensureContract } from './contracts-cache';
import { onOrderEvent, getAliasFor } from './stream';
import { fetchTrades, placeFuturesOrder, placeStockOrder, cancelOrder } from './shioaji';
import { isFuturesContract, notify } from './trade';
import { stepPrice } from './utils/ticksize';
import type { ContractInfo } from './types/contract';
import type { Action, Trade } from './types/order';
import { ACTIVE_ORDER_STATUSES } from './types/order';

const STORAGE_KEY = 'sj-pro-spiderweb';
const TAG_PREFIX = 'sw'; // custom_field = sw + base36(levelIdx) — max 6 chars

export type StepMode = 'percent' | 'ticks' | 'points';

export type LevelState =
    | 'idle'          // not placed yet
    | 'entry-working' // entry order placed, waiting for fill
    | 'held'          // entry filled, position held
    | 'exit-working'  // exit order placed, waiting for fill
    | 'done';         // round-trip complete (closed or cancelled)

export interface StrategyLevel {
    idx: number;
    entryPrice: number;
    exitPrice: number;
    state: LevelState;
    entrySeqno?: string;   // from OrderResult after placement
    exitSeqno?: string;
    entryOrderId?: string; // Trade.order.id for cancellation
    exitOrderId?: string;
    entryFillQty: number;  // actual filled quantity (may differ from requested)
    exitFillQty: number;
    entryAvgPrice: number; // average fill price (for multi-fill partials)
    exitAvgPrice: number;
}

export interface SpiderwebStrategy {
    id: string;
    name: string;           // user-defined strategy name
    enabled: boolean;
    code: string;           // display code (matches quote-store)
    security_type: string;
    side: Action;           // 'Buy' = long grid, 'Sell' = short grid
    startPrice: number;
    stepMode: StepMode;
    stepValue: number;      // meaning depends on stepMode
    numLevels: number;
    qtyPerLevel: number;
    levels: StrategyLevel[];
    createdAt: number;      // epoch ms
    startDate?: string;     // YYYY-MM-DD — strategy active from
    endDate?: string;       // YYYY-MM-DD — strategy expires after
}

const STORAGE_KEY_NEXT_ID = 'sj-pro-spiderweb-next';

function load(): SpiderwebStrategy[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr as SpiderwebStrategy[];
        }
    } catch {
        // corrupted — start clean
    }
    return [];
}

let strategies: SpiderwebStrategy[] = load();
const listeners = new Set<() => void>();
const pendingOrders = new Map<string, { strategyId: string; levelIdx: number; side: 'entry' | 'exit' }>();

// cross-window sync (popouts share localStorage but not module state)
window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
        strategies = load();
        emit();
    }
});

function emit() {
    listeners.forEach((l) => l());
}

function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strategies));
    emit();
}

function nextId(): string {
    const stored = localStorage.getItem(STORAGE_KEY_NEXT_ID);
    const n = stored ? Number.parseInt(stored, 10) : 1;
    localStorage.setItem(STORAGE_KEY_NEXT_ID, String(n + 1));
    return `sw-${n}`;
}

function tagFor(levelIdx: number): string {
    // custom_field max 6 chars for stock orders: 'sw' + base36 idx
    const encoded = levelIdx.toString(36);
    return TAG_PREFIX + encoded;
}

function parseLevelFromTag(tag: string): number | null {
    if (!tag.startsWith(TAG_PREFIX)) return null;
    const encoded = tag.slice(TAG_PREFIX.length);
    const idx = Number.parseInt(encoded, 36);
    return Number.isNaN(idx) ? null : idx;
}

export function getStrategies(): SpiderwebStrategy[] {
    return strategies;
}

export function useStrategies(): SpiderwebStrategy[] {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => strategies,
    );
}

function computeLevelPrices(s: Omit<SpiderwebStrategy, 'id' | 'levels' | 'createdAt'>): { entry: number; exit: number }[] {
    const out: { entry: number; exit: number }[] = [];
    const dummyContract: ContractInfo = {
        code: s.code,
        security_type: s.security_type as any,
        exchange: '' as any,
        name: s.code,
        currency: 'TWD',
        limit_up: 0,
        limit_down: 0,
        reference: 0,
        day_trade: '',
        update_date: '',
        category: '',
        margin_trading_balance: 0,
        short_selling_balance: 0,
        target_code: null,
    };

    for (let i = 0; i < s.numLevels; i++) {
        let entryPrice = s.startPrice;
        let exitPrice = s.startPrice;

        switch (s.stepMode) {
            case 'percent': {
                const factor = 1 + (s.stepValue / 100);
                if (s.side === 'Buy') {
                    // long: buy at progressively lower prices
                    entryPrice = s.startPrice / Math.pow(factor, i);
                    exitPrice = i === 0 ? s.startPrice : s.startPrice / Math.pow(factor, i - 1);
                } else {
                    // short: sell at progressively higher prices
                    entryPrice = s.startPrice * Math.pow(factor, i);
                    exitPrice = i === 0 ? s.startPrice : s.startPrice * Math.pow(factor, i - 1);
                }
                entryPrice = Number(entryPrice.toFixed(2));
                exitPrice = Number(exitPrice.toFixed(2));
                break;
            }
            case 'ticks': {
                const ticks = Math.round(s.stepValue);
                if (s.side === 'Buy') {
                    entryPrice = stepPrice(dummyContract, s.startPrice, -(i * ticks));
                    exitPrice = i === 0 ? s.startPrice : stepPrice(dummyContract, s.startPrice, -((i - 1) * ticks));
                } else {
                    entryPrice = stepPrice(dummyContract, s.startPrice, i * ticks);
                    exitPrice = i === 0 ? s.startPrice : stepPrice(dummyContract, s.startPrice, (i - 1) * ticks);
                }
                break;
            }
            case 'points': {
                if (s.side === 'Buy') {
                    entryPrice = Number((s.startPrice - i * s.stepValue).toFixed(2));
                    exitPrice = i === 0 ? s.startPrice : Number((s.startPrice - (i - 1) * s.stepValue).toFixed(2));
                } else {
                    entryPrice = Number((s.startPrice + i * s.stepValue).toFixed(2));
                    exitPrice = i === 0 ? s.startPrice : Number((s.startPrice + (i - 1) * s.stepValue).toFixed(2));
                }
                break;
            }
        }

        out.push({ entry: entryPrice, exit: exitPrice });
    }

    return out;
}

export function createStrategy(params: Omit<SpiderwebStrategy, 'id' | 'levels' | 'createdAt'>): SpiderwebStrategy {
    const prices = computeLevelPrices(params);
    const levels: StrategyLevel[] = prices.map((p, idx) => ({
        idx,
        entryPrice: p.entry,
        exitPrice: p.exit,
        state: 'idle',
        entryFillQty: 0,
        exitFillQty: 0,
        entryAvgPrice: 0,
        exitAvgPrice: 0,
    }));

    const strategy: SpiderwebStrategy = {
        ...params,
        id: nextId(),
        levels,
        createdAt: Date.now(),
    };

    strategies = [...strategies, strategy];
    persist();
    notify({
        kind: 'info',
        title: '🕸 蛛網策略已建立',
        body: `${strategy.code} ${strategy.side === 'Buy' ? '多方' : '空方'} ${strategy.numLevels}檔 × ${strategy.qtyPerLevel}`,
    });
    return strategy;
}

export function deleteStrategy(id: string) {
    strategies = strategies.filter((s) => s.id !== id);
    persist();
}

export function updateStrategy(id: string, patch: Partial<SpiderwebStrategy>) {
    const current = strategies.find((s) => s.id === id);
    if (!current) return;

    // If critical params changed (startPrice, stepMode, stepValue, numLevels), regenerate levels
    const needsRegenerate =
        (patch.startPrice !== undefined && patch.startPrice !== current.startPrice) ||
        (patch.stepMode !== undefined && patch.stepMode !== current.stepMode) ||
        (patch.stepValue !== undefined && patch.stepValue !== current.stepValue) ||
        (patch.numLevels !== undefined && patch.numLevels !== current.numLevels);

    let updatedStrategy = { ...current, ...patch };

    if (needsRegenerate && !current.enabled) {
        // Only regenerate if strategy is not running
        const prices = computeLevelPrices({
            code: updatedStrategy.code,
            security_type: updatedStrategy.security_type,
            side: updatedStrategy.side,
            startPrice: updatedStrategy.startPrice,
            stepMode: updatedStrategy.stepMode,
            stepValue: updatedStrategy.stepValue,
            numLevels: updatedStrategy.numLevels,
            qtyPerLevel: updatedStrategy.qtyPerLevel,
            enabled: updatedStrategy.enabled,
            name: updatedStrategy.name,
        });

        updatedStrategy.levels = prices.map((p, idx) => ({
            idx,
            entryPrice: p.entry,
            exitPrice: p.exit,
            state: 'idle',
            entryFillQty: 0,
            exitFillQty: 0,
            entryAvgPrice: 0,
            exitAvgPrice: 0,
        }));
    }

    strategies = strategies.map((s) => (s.id === id ? updatedStrategy : s));
    persist();
}

function findStrategy(id: string): SpiderwebStrategy | undefined {
    return strategies.find((s) => s.id === id);
}

async function placeEntryOrder(s: SpiderwebStrategy, level: StrategyLevel): Promise<void> {
    const contract = await ensureContract(s.code);
    const tag = tagFor(level.idx);
    const req = {
        action: s.side,
        price: level.entryPrice,
        quantity: s.qtyPerLevel,
        order_type: 'ROD' as const,
        custom_field: tag,
    };

    const trade = isFuturesContract(contract)
        ? await placeFuturesOrder(contract, { ...req, price_type: 'LMT', octype: 'Auto' })
        : await placeStockOrder(contract, { ...req, price_type: 'LMT', order_lot: 'Common' });

    pendingOrders.set(trade.order.seqno, { strategyId: s.id, levelIdx: level.idx, side: 'entry' });

    updateStrategy(s.id, {
        levels: s.levels.map((lv) =>
            lv.idx === level.idx
                ? { ...lv, state: 'entry-working', entrySeqno: trade.order.seqno, entryOrderId: trade.order.id }
                : lv
        ),
    });
}

async function placeExitOrder(s: SpiderwebStrategy, level: StrategyLevel): Promise<void> {
    const contract = await ensureContract(s.code);
    const tag = tagFor(level.idx);
    const exitAction: Action = s.side === 'Buy' ? 'Sell' : 'Buy';
    const req = {
        action: exitAction,
        price: level.exitPrice,
        quantity: level.entryFillQty, // exit the actually-filled quantity
        order_type: 'ROD' as const,
        custom_field: tag,
    };

    const trade = isFuturesContract(contract)
        ? await placeFuturesOrder(contract, { ...req, price_type: 'LMT', octype: 'Auto' })
        : await placeStockOrder(contract, { ...req, price_type: 'LMT', order_lot: 'Common' });

    pendingOrders.set(trade.order.seqno, { strategyId: s.id, levelIdx: level.idx, side: 'exit' });

    updateStrategy(s.id, {
        levels: s.levels.map((lv) =>
            lv.idx === level.idx
                ? { ...lv, state: 'exit-working', exitSeqno: trade.order.seqno, exitOrderId: trade.order.id }
                : lv
        ),
    });
}

function onEntryFilled(s: SpiderwebStrategy, level: StrategyLevel, fillQty: number, fillPrice: number) {
    // entry filled → move to held, schedule exit placement
    const newFillQty = level.entryFillQty + fillQty;
    const newAvgPrice =
        level.entryFillQty === 0
            ? fillPrice
            : (level.entryAvgPrice * level.entryFillQty + fillPrice * fillQty) / newFillQty;

    updateStrategy(s.id, {
        levels: s.levels.map((lv) =>
            lv.idx === level.idx
                ? { ...lv, state: 'held', entryFillQty: newFillQty, entryAvgPrice: newAvgPrice }
                : lv
        ),
    });

    // immediately arm the exit
    const updated = findStrategy(s.id);
    if (updated) {
        const updatedLevel = updated.levels.find((lv) => lv.idx === level.idx);
        if (updatedLevel && updatedLevel.state === 'held') {
            void placeExitOrder(updated, updatedLevel).catch((e) => {
                notify({
                    kind: 'err',
                    title: '🕸 蛛網反向單失敗',
                    body: `${s.code} 檔位${level.idx} ${e instanceof Error ? e.message : String(e)}`,
                });
            });
        }
    }
}

function onExitFilled(s: SpiderwebStrategy, level: StrategyLevel, fillQty: number, fillPrice: number) {
    // exit filled → mark done, reset to idle for re-arm if strategy still enabled
    const newFillQty = level.exitFillQty + fillQty;
    const newAvgPrice =
        level.exitFillQty === 0
            ? fillPrice
            : (level.exitAvgPrice * level.exitFillQty + fillPrice * fillQty) / newFillQty;

    const allFilled = newFillQty >= level.entryFillQty;

    updateStrategy(s.id, {
        levels: s.levels.map((lv) =>
            lv.idx === level.idx
                ? {
                      ...lv,
                      state: allFilled ? 'idle' : 'exit-working',
                      exitFillQty: newFillQty,
                      exitAvgPrice: newAvgPrice,
                      // reset counters if round-trip complete
                      entryFillQty: allFilled ? 0 : lv.entryFillQty,
                      entryAvgPrice: allFilled ? 0 : lv.entryAvgPrice,
                  }
                : lv
        ),
    });

    if (allFilled) {
        const pnl = (level.exitAvgPrice - level.entryAvgPrice) * (s.side === 'Buy' ? 1 : -1) * level.entryFillQty;
        notify({
            kind: 'ok',
            title: '🕸 蛛網回合完成',
            body: `${s.code} 檔位${level.idx} 損益 ${pnl > 0 ? '+' : ''}${Math.round(pnl)}`,
        });
    }
}

let engineStarted = false;

export function startSpiderwebEngine() {
    if (engineStarted) return;
    engineStarted = true;

    // SSE deal event reconciliation
    onOrderEvent((ev) => {
        if (ev.kind !== 'deal' || !ev.seqno) return;
        const pending = pendingOrders.get(ev.seqno);
        if (!pending) return;

        const s = findStrategy(pending.strategyId);
        if (!s || !s.enabled) return;

        const level = s.levels.find((lv) => lv.idx === pending.levelIdx);
        if (!level) return;

        if (pending.side === 'entry') {
            onEntryFilled(s, level, ev.quantity, ev.price);
        } else {
            onExitFilled(s, level, ev.quantity, ev.price);
        }

        pendingOrders.delete(ev.seqno);
    });

    // periodic reconciliation fallback (poll trades for strategies with working orders)
    setInterval(reconcilePoll, 5000);
}

async function reconcilePoll() {
    const active = strategies.filter((s) => s.enabled && s.levels.some((lv) => lv.state === 'entry-working' || lv.state === 'exit-working'));
    if (active.length === 0) return;

    try {
        const [stockTrades, futuresTrades] = await Promise.all([
            fetchTrades('S').catch(() => [] as Trade[]),
            fetchTrades('F').catch(() => [] as Trade[]),
        ]);
        const allTrades = [...stockTrades, ...futuresTrades];

        for (const s of active) {
            for (const level of s.levels) {
                if (level.state === 'entry-working' && level.entrySeqno) {
                    const trade = allTrades.find((t) => t.order.seqno === level.entrySeqno);
                    if (trade && trade.status.deal_quantity > level.entryFillQty) {
                        const newQty = trade.status.deal_quantity - level.entryFillQty;
                        const avgPrice = trade.status.deals.length > 0
                            ? trade.status.deals.reduce((sum, d) => sum + d.price * d.quantity, 0) / trade.status.deal_quantity
                            : trade.order.price;
                        onEntryFilled(s, level, newQty, avgPrice);
                    }
                } else if (level.state === 'exit-working' && level.exitSeqno) {
                    const trade = allTrades.find((t) => t.order.seqno === level.exitSeqno);
                    if (trade && trade.status.deal_quantity > level.exitFillQty) {
                        const newQty = trade.status.deal_quantity - level.exitFillQty;
                        const avgPrice = trade.status.deals.length > 0
                            ? trade.status.deals.reduce((sum, d) => sum + d.price * d.quantity, 0) / trade.status.deal_quantity
                            : trade.order.price;
                        onExitFilled(s, level, newQty, avgPrice);
                    }
                }
            }
        }
    } catch {
        // retry next round
    }
}

export async function armStrategy(id: string) {
    const s = findStrategy(id);
    if (!s || s.enabled) return;

    updateStrategy(id, { enabled: true });

    // place entry orders for all idle levels
    const idleLevels = s.levels.filter((lv) => lv.state === 'idle');

    for (const level of idleLevels) {
        try {
            // Always get fresh strategy state before each placement
            const current = findStrategy(id);
            if (!current) break;

            const currentLevel = current.levels.find((lv) => lv.idx === level.idx);
            if (!currentLevel || currentLevel.state !== 'idle') continue;

            await placeEntryOrder(current, currentLevel);
        } catch (e) {
            notify({
                kind: 'err',
                title: '🕸 蛛網掛單失敗',
                body: `${s.code} 檔位${level.idx} ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    const final = findStrategy(id);
    notify({
        kind: 'ok',
        title: '🕸 蛛網策略啟動',
        body: `${s.code} ${final?.levels.filter(lv => lv.entryOrderId).length || 0}/${s.numLevels}檔已掛單`,
    });
}

export async function disarmStrategy(id: string) {
    const s = findStrategy(id);
    if (!s || !s.enabled) return;

    updateStrategy(id, { enabled: false });

    // Collect all order IDs from strategy levels (most reliable method)
    const myOrderIds = s.levels
        .flatMap((lv) => [lv.entryOrderId, lv.exitOrderId])
        .filter(Boolean) as string[];

    if (myOrderIds.length === 0) {
        notify({
            kind: 'info',
            title: '🕸 蛛網策略停止',
            body: `${s.code} 無在途委託`,
        });
        return;
    }

    try {
        // Cancel by order ID directly (no need to fetch trades)
        const results = await Promise.allSettled(myOrderIds.map((orderId) => cancelOrder(orderId)));
        const ok = results.filter((r) => r.status === 'fulfilled').length;

        // Clear order IDs from levels after cancellation
        updateStrategy(id, {
            levels: s.levels.map((lv) => ({
                ...lv,
                entryOrderId: undefined,
                exitOrderId: undefined,
            })),
        });

        notify({
            kind: ok === myOrderIds.length ? 'ok' : 'info',
            title: '🕸 蛛網策略停止',
            body: `${s.code} 已撤${ok}/${myOrderIds.length}筆`,
        });
    } catch (e) {
        notify({
            kind: 'err',
            title: '🕸 蛛網停止失敗',
            body: e instanceof Error ? e.message : String(e),
        });
    }
}
