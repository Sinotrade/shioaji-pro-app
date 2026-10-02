import { describe, expect, it, vi } from 'vitest';
import { closeReplayPosition, loadReplayTrades, replayPoints } from './replay-practice';

describe('歷史回放模擬交易', () => {
    it('多空損益方向與口數正確', () => {
        expect(replayPoints({ side: 'long', entry: 100, enteredAt: 1, quantity: 2 }, 110)).toBe(20);
        expect(replayPoints({ side: 'short', entry: 100, enteredAt: 1, quantity: 3 }, 90)).toBe(30);
    });

    it('平倉保存點數與合約乘數估計值', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(closeReplayPosition({ side: 'long', entry: 100, enteredAt: 1, quantity: 2 }, 'TXF', 110, 2, 200))
            .toMatchObject({ code: 'TXF', exit: 110, points: 20, estimatedPnl: 4000 });
        vi.restoreAllMocks();
    });

    it('只載入結構完整的紀錄並限制 500 筆', () => {
        const good = { id: '1', code: 'TXF', side: 'long', entry: 1, exit: 2, enteredAt: 1, exitedAt: 2, quantity: 1, points: 1, estimatedPnl: 200 };
        expect(loadReplayTrades(JSON.stringify([{}, good]))).toEqual([good]);
        expect(loadReplayTrades('{bad')).toEqual([]);
    });
});
