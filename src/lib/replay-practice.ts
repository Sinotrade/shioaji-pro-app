// src/lib/replay-practice.ts — 行情回放的本機模擬練習：純計算與 localStorage
// 讀寫。只處理歷史 ticks 與本機紀錄，不呼叫任何下單、撤單或券商交易 API。

import { contractMarket } from './contract-market';
import type { ContractInfo } from './types/contract';
import { contractMultiplier } from './utils/contract-cost';
import { dateStrOffset } from './utils/kbars';

export interface ReplayPracticePosition {
    side: 'long' | 'short';
    entry: number;
    enteredAt: number;
    quantity: number;
}

export interface ReplayPracticeTrade extends ReplayPracticePosition {
    id: string;
    code: string;
    exit: number;
    exitedAt: number;
    // 已乘口數的點數（每口點數 × 口數）
    points: number;
    estimatedPnl: number;
}

export const REPLAY_TRADES_KEY = 'sj-pro-replay-practice-trades-v1';
const MAX_TRADES = 500;

// 未選日期（預設「今天」）時要嘗試的交易日。期權先試明天：夜盤屬於下一個
// 交易日，dateStrOffset 的負數代表未來；明天還沒有資料再退回今天。
export function replayFetchDates(selectedDate: string, isFop: boolean): string[] {
    if (selectedDate) return [selectedDate];
    return isFop ? [dateStrOffset(-1), dateStrOffset(0)] : [dateStrOffset(0)];
}

// 每口（每張）的點數差，不含口數
export function replayPointDiff(position: ReplayPracticePosition, price: number): number {
    const direction = position.side === 'long' ? 1 : -1;
    return (price - position.entry) * direction;
}

// 已乘口數的點數
export function replayPoints(position: ReplayPracticePosition, exit: number): number {
    return replayPointDiff(position, exit) * position.quantity;
}

// 每 1 單位數量的金額乘數：期權沿用 contractMultiplier()；股票與權證以「張」計，
// 一張 1,000 股（權證 1,000 單位，買賣辦法第 5 條）。權證沒有 multiplier，
// 不能落到期貨的乘數推算（會依標的代號被當成個股期 2,000）。
export function replayMultiplier(contract: ContractInfo): number {
    if (contractMarket(contract.security_type) === 'S') return 1000;
    return contractMultiplier(contract);
}

export function closeReplayPosition(
    position: ReplayPracticePosition,
    code: string,
    exit: number,
    exitedAt: number,
    multiplier: number,
): ReplayPracticeTrade {
    const points = replayPoints(position, exit);
    return {
        ...position,
        id: `${code}-${exitedAt}-${Math.random().toString(36).slice(2, 8)}`,
        code,
        exit,
        exitedAt,
        points,
        estimatedPnl: points * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1),
    };
}

export interface ReplayTradeSummary {
    count: number;
    estimatedPnl: number;
}

// 累計損益按商品分開：不同乘數的商品加總沒有意義
export function summarizeReplayTrades(
    trades: readonly ReplayPracticeTrade[],
    code: string,
): ReplayTradeSummary {
    let count = 0;
    let estimatedPnl = 0;
    for (const t of trades) {
        if (t.code !== code) continue;
        count += 1;
        estimatedPnl += t.estimatedPnl;
    }
    return { count, estimatedPnl };
}

// 與 localStorage 一致只保留最近 500 筆，重新開啟後累計不會變
export function appendReplayTrade(
    trades: readonly ReplayPracticeTrade[],
    trade: ReplayPracticeTrade,
): ReplayPracticeTrade[] {
    return [...trades, trade].slice(-MAX_TRADES);
}

// 依 id 合併兩份紀錄（例如另一個回放面板已寫入的）：保留 a 的順序，再接上 b 獨有的
// （exitedAt 是回放的歷史時間，不能拿來排序新舊）
export function mergeReplayTrades(
    a: readonly ReplayPracticeTrade[],
    b: readonly ReplayPracticeTrade[],
): ReplayPracticeTrade[] {
    const byId = new Map<string, ReplayPracticeTrade>();
    for (const t of a) byId.set(t.id, t);
    for (const t of b) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()].slice(-MAX_TRADES);
}

export function loadReplayTrades(raw: string | null): ReplayPracticeTrade[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((row): row is ReplayPracticeTrade => {
            if (!row || typeof row !== 'object') return false;
            const r = row as Partial<ReplayPracticeTrade>;
            return (
                typeof r.id === 'string' &&
                typeof r.code === 'string' &&
                (r.side === 'long' || r.side === 'short') &&
                [r.entry, r.exit, r.enteredAt, r.exitedAt, r.quantity, r.points, r.estimatedPnl].every(
                    (v) => typeof v === 'number' && Number.isFinite(v),
                )
            );
        }).slice(-MAX_TRADES);
    } catch {
        return [];
    }
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function defaultStorage(): Storage | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
        // 存取 localStorage 本身就可能被封鎖而拋錯
        return undefined;
    }
}

// localStorage 被封鎖或讀取失敗時回傳空陣列，不在 render 中拋錯
export function readReplayTrades(storage: ReadStorage | undefined = defaultStorage()): ReplayPracticeTrade[] {
    if (!storage) return [];
    try {
        return loadReplayTrades(storage.getItem(REPLAY_TRADES_KEY));
    } catch {
        return [];
    }
}

// 寫滿（QuotaExceededError）或被封鎖時回傳 false，不拋錯
export function writeReplayTrades(
    trades: readonly ReplayPracticeTrade[],
    storage: WriteStorage | undefined = defaultStorage(),
): boolean {
    if (!storage) return false;
    try {
        storage.setItem(REPLAY_TRADES_KEY, JSON.stringify(trades.slice(-MAX_TRADES)));
        return true;
    } catch {
        return false;
    }
}
