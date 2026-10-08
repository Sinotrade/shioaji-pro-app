// K 棒讀值（開高低收，issue #240）純函式測試
import { describe, expect, it } from 'vitest';
import type { Candle } from './types/market';
import { createOhlcStore, findBarIndex, ohlcLayout, ohlcReadout } from './ohlc-legend';

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 10): Candle =>
    ({ time, open, high, low, close, volume });

const bars: Candle[] = [
    bar(60, 49100, 49150, 49000, 49120, 800),
    bar(120, 49120, 49210, 49050, 49180, 1234),
    bar(180, 49180, 49190, 49020, 49030, 2500000),
];
const intDecimals = () => 0;

describe('findBarIndex', () => {
    it('精確對到 K 棒時間，找不到回 -1', () => {
        expect(findBarIndex(bars, 60)).toBe(0);
        expect(findBarIndex(bars, 120)).toBe(1);
        expect(findBarIndex(bars, 180)).toBe(2);
        expect(findBarIndex(bars, 90)).toBe(-1);
        expect(findBarIndex([], 60)).toBe(-1);
    });
});

describe('ohlcReadout', () => {
    it('沒有 K 棒時不顯示', () => {
        expect(ohlcReadout([], null, intDecimals)).toBeNull();
    });

    it('滑鼠移到某根 K 棒就讀那一根，漲跌以前一根收盤計算', () => {
        const r = ohlcReadout(bars, 120, intDecimals)!;
        expect(r).toMatchObject({
            time: 120,
            hovering: true,
            open: '49,120',
            high: '49,210',
            low: '49,050',
            close: '49,180',
            barDir: 1,
            change: '+60',
            changePct: '+0.12%',
            changeDir: 1,
            volume: '1,234',
        });
    });

    it('游標離開（null）或不在任何 K 棒上時讀最新一根', () => {
        const latest = ohlcReadout(bars, null, intDecimals)!;
        expect(latest.time).toBe(180);
        expect(latest.hovering).toBe(false);
        expect(latest.close).toBe('49,030');
        expect(latest.change).toBe('-150');
        expect(latest.changePct).toBe('-0.31%');
        expect(latest.changeDir).toBe(-1);
        expect(latest.barDir).toBe(-1);
        expect(latest.volume).toBe('2,500,000');
        expect(ohlcReadout(bars, 999, intDecimals)!.time).toBe(180);
    });

    it('第一根沒有前一根收盤時不顯示漲跌', () => {
        const r = ohlcReadout(bars, 60, intDecimals)!;
        expect(r.change).toBeNull();
        expect(r.changePct).toBeNull();
        expect(r.changeDir).toBe(0);
    });

    it('平盤顯示 0 / 0.00%，方向為平', () => {
        const r = ohlcReadout([bar(60, 10, 10, 10, 10), bar(120, 10, 10.5, 9.9, 10)], null, () => 2)!;
        expect(r.change).toBe('0.00');
        expect(r.changePct).toBe('0.00%');
        expect(r.changeDir).toBe(0);
        expect(r.barDir).toBe(0);
    });

    it('小數位依跳動價位（以該根最低價判斷），四個價一致', () => {
        const seen: number[] = [];
        const r = ohlcReadout(
            [bar(60, 48, 48, 48, 48), bar(120, 49.95, 50.3, 49.9, 50.2, 3)],
            null,
            (p) => {
                seen.push(p);
                return p < 50 ? 2 : 1;
            },
        )!;
        expect(seen).toEqual([49.9]);
        expect(r).toMatchObject({ open: '49.95', high: '50.30', low: '49.90', close: '50.20', change: '+2.20', changePct: '+4.58%' });
    });

    it('選擇權等小數價位', () => {
        const r = ohlcReadout([bar(60, 1.2, 1.4, 1.1, 1.3), bar(120, 1.3, 1.5, 1.2, 1.4)], 120, () => 1)!;
        expect(r).toMatchObject({ open: '1.3', high: '1.5', low: '1.2', close: '1.4', change: '+0.1', changePct: '+7.69%' });
    });
});

describe('ohlcLayout（窄面板縮短，不擋 K 棒）', () => {
    it('寬面板顯示完整：開高低收＋漲跌幅＋量', () => {
        expect(ohlcLayout(900)).toEqual({ open: true, change: true, pct: true, volume: true });
        expect(ohlcLayout(560)).toEqual({ open: true, change: true, pct: true, volume: true });
    });
    it('中等寬度省略量與漲跌幅', () => {
        expect(ohlcLayout(559)).toEqual({ open: true, change: true, pct: false, volume: false });
        expect(ohlcLayout(400)).toEqual({ open: true, change: true, pct: false, volume: false });
    });
    it('很窄時只留高低收', () => {
        expect(ohlcLayout(399)).toEqual({ open: false, change: false, pct: false, volume: false });
        expect(ohlcLayout(200)).toEqual({ open: false, change: false, pct: false, volume: false });
    });
    it('寬度未知（0）時當作寬面板', () => {
        expect(ohlcLayout(0)).toEqual({ open: true, change: true, pct: true, volume: true });
    });
});

describe('createOhlcStore', () => {
    it('移動游標更新選中時間、離開回 null；同值不通知', () => {
        const s = createOhlcStore();
        let n = 0;
        const off = s.subscribe(() => n++);
        expect(s.snapshot().hoverTime).toBeNull();
        s.hover(120);
        expect(s.snapshot().hoverTime).toBe(120);
        s.hover(120);
        expect(n).toBe(1);
        s.hover(null);
        expect(s.snapshot().hoverTime).toBeNull();
        expect(n).toBe(2);
        off();
        s.hover(60);
        expect(n).toBe(2);
    });
    it('資料更新（tick）讓快照換新，讀值才會重算', () => {
        const s = createOhlcStore();
        const a = s.snapshot();
        s.bump();
        expect(s.snapshot()).not.toBe(a);
        expect(s.snapshot().version).toBe(a.version + 1);
    });
});
