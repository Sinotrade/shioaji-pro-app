import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';
import {
    appendReplayTrade,
    closeReplayPosition,
    loadReplayTrades,
    mergeReplayTrades,
    readReplayTrades,
    REPLAY_TRADES_KEY,
    replayFetchDates,
    replayMultiplier,
    replayPointDiff,
    replayPoints,
    summarizeReplayTrades,
    writeReplayTrades,
    type ReplayPracticeTrade,
} from './replay-practice';

function trade(code: string, estimatedPnl: number, id = `${code}-${estimatedPnl}`): ReplayPracticeTrade {
    return { id, code, side: 'long', entry: 1, exit: 2, enteredAt: 1, exitedAt: 2, quantity: 1, points: 1, estimatedPnl };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('歷史回放模擬交易', () => {
    it('多空損益方向與口數正確', () => {
        expect(replayPoints({ side: 'long', entry: 100, enteredAt: 1, quantity: 2 }, 110)).toBe(20);
        expect(replayPoints({ side: 'short', entry: 100, enteredAt: 1, quantity: 3 }, 90)).toBe(30);
    });

    it('每口點數差不含口數', () => {
        expect(replayPointDiff({ side: 'long', entry: 100, enteredAt: 1, quantity: 5 }, 110)).toBe(10);
        expect(replayPointDiff({ side: 'short', entry: 100, enteredAt: 1, quantity: 5 }, 110)).toBe(-10);
    });

    it('平倉保存點數與合約乘數估計值', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(closeReplayPosition({ side: 'long', entry: 100, enteredAt: 1, quantity: 2 }, 'TXF', 110, 2, 200))
            .toMatchObject({ code: 'TXF', exit: 110, points: 20, estimatedPnl: 4000 });
    });

    it('只載入結構完整的紀錄並限制 500 筆', () => {
        const good = trade('TXF', 200, '1');
        expect(loadReplayTrades(JSON.stringify([{}, null, good]))).toEqual([good]);
        expect(loadReplayTrades('{bad')).toEqual([]);
        const many = Array.from({ length: 520 }, (_, i) => trade('TXF', i, String(i)));
        expect(loadReplayTrades(JSON.stringify(many))).toHaveLength(500);
    });
});

describe('回放預設日期', () => {
    it('未選日期時期權先試明天（夜盤屬下一交易日）再退回今天', () => {
        vi.useFakeTimers();
        // 2026-10-08 20:00 台北（夜盤時段）
        vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
        expect(replayFetchDates('', true)).toEqual(['2026-10-09', '2026-10-08']);
    });

    it('未選日期時股票只看今天，不預設昨天', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-08T02:00:00Z'));
        expect(replayFetchDates('', false)).toEqual(['2026-10-08']);
    });

    it('選了日期就只載入該日', () => {
        expect(replayFetchDates('2026-10-01', true)).toEqual(['2026-10-01']);
        expect(replayFetchDates('2026-10-01', false)).toEqual(['2026-10-01']);
    });
});

describe('回放乘數', () => {
    const base = { code: 'X', exchange: 'TAIFEX', target_code: null } as unknown as ContractInfo;

    it('期貨沿用 contractMultiplier()', () => {
        expect(replayMultiplier({ ...base, security_type: 'FUT', category: 'TXF' } as ContractInfo)).toBe(200);
        expect(replayMultiplier({ ...base, security_type: 'FUT', category: 'MXF' } as ContractInfo)).toBe(50);
        expect(replayMultiplier({ ...base, security_type: 'FUT', category: 'ZZZ', multiplier: 2000 } as ContractInfo)).toBe(2000);
    });

    it('股票以張計，不退成 1', () => {
        expect(replayMultiplier({ ...base, exchange: 'TSE', security_type: 'STK', category: '24' } as ContractInfo)).toBe(1000);
    });

    it('權證一張 1,000 單位，不依標的代號被當成個股期 2,000', () => {
        expect(replayMultiplier({ ...base, code: '030392', exchange: 'TSE', security_type: 'WRT', underlying_code: '2330' } as ContractInfo)).toBe(1000);
    });
});

describe('累計損益按商品分開', () => {
    it('只加總同一商品', () => {
        const trades = [trade('TXFJ6', 4000), trade('MXFJ6', -500), trade('TXFJ6', -1000), trade('2330', 3000)];
        expect(summarizeReplayTrades(trades, 'TXFJ6')).toEqual({ count: 2, estimatedPnl: 3000 });
        expect(summarizeReplayTrades(trades, 'MXFJ6')).toEqual({ count: 1, estimatedPnl: -500 });
        expect(summarizeReplayTrades(trades, '2454')).toEqual({ count: 0, estimatedPnl: 0 });
    });
});

describe('localStorage 讀寫不拋錯', () => {
    it('讀取被封鎖時回傳空陣列', () => {
        const storage = { getItem: () => { throw new Error('SecurityError'); } };
        expect(readReplayTrades(storage)).toEqual([]);
        expect(readReplayTrades(undefined)).toEqual([]);
    });

    it('寫滿時回傳 false', () => {
        const storage = { setItem: () => { throw new Error('QuotaExceededError'); } };
        expect(writeReplayTrades([trade('TXF', 1)], storage)).toBe(false);
        expect(writeReplayTrades([trade('TXF', 1)], undefined)).toBe(false);
    });

    it('正常寫入後可讀回', () => {
        const map = new Map<string, string>();
        const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
        expect(writeReplayTrades([trade('TXF', 1)], storage)).toBe(true);
        expect(map.has(REPLAY_TRADES_KEY)).toBe(true);
        expect(readReplayTrades(storage)).toEqual([trade('TXF', 1)]);
    });
});

describe('多面板紀錄合併與上限', () => {
    it('依 id 合併，保留既有順序並接上另一份獨有的紀錄', () => {
        const a = [trade('TXF', 1, 'a1'), trade('TXF', 2, 'a2')];
        const b = [trade('TXF', 2, 'a2'), trade('MXF', 3, 'b1')];
        expect(mergeReplayTrades(a, b).map((t) => t.id)).toEqual(['a1', 'a2', 'b1']);
    });

    it('新增紀錄後與 localStorage 一樣只保留 500 筆', () => {
        const many = Array.from({ length: 500 }, (_, i) => trade('TXF', i, String(i)));
        const next = appendReplayTrade(many, trade('TXF', 999, 'new'));
        expect(next).toHaveLength(500);
        expect(next[0]!.id).toBe('1');
        expect(next[499]!.id).toBe('new');
    });
});
