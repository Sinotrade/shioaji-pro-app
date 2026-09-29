// src/lib/stock-picker.test.ts — 短線選股引擎單測（多方＋空方）
import { describe, expect, it } from 'vitest';
import {
    collectEntrySignals,
    collectShortSignals,
    scoreStock,
    scoreStockShort,
} from './stock-picker';
import type { Candle } from './types/market';

const baseDay = Date.UTC(2026, 0, 1) / 1000;

function candle(day: number, o: number, h: number, l: number, c: number, v: number): Candle {
    return { time: baseDay + day * 86400, open: o, high: h, low: l, close: c, volume: v };
}

// 溫和多頭：每 5 根一循環（3 漲 2 跌、淨 +1.3），RSI 約 70 上下；
// 最後一根由 lastJump/lastVol 控制（放量、突破）。
function series(n = 40, lastJump = 2, lastVol = 300) {
    const out: Candle[] = [];
    let price = 100;
    const pat = [0.9, 0.5, -0.4, 0.6, -0.3];
    for (let i = 0; i < n; i++) {
        const drift = i === n - 1 ? lastJump : pat[i % pat.length]!;
        const o = price;
        const c = price + drift;
        out.push(candle(i, Math.min(o, c), Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, i === n - 1 ? lastVol : 100));
        price = c;
    }
    return out;
}

// 溫和空頭：每 5 根一循環（3 跌 2 彈、淨 -1.3），最後一根放量破底。
function shortSeries(n = 40, lastDrop = -2, lastVol = 300) {
    const out: Candle[] = [];
    let price = 120;
    const pat = [-0.9, -0.5, 0.4, -0.6, 0.3];
    for (let i = 0; i < n; i++) {
        const drift = i === n - 1 ? lastDrop : pat[i % pat.length]!;
        const o = price;
        const c = price + drift;
        out.push(candle(i, Math.max(o, c), Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, i === n - 1 ? lastVol : 100));
        price = c;
    }
    return out;
}

describe('多頭放量突破', () => {
    const s = scoreStock(series());
    it('判定可上車、放量突破、非過熱', () => {
        expect(s).not.toBeNull();
        expect(s!.side).toBe('long');
        expect(s!.excluded).toBe(false);
        expect(s!.isEntry).toBe(true);
        expect(s!.pattern).toBe('放量突破');
        expect(s!.score).toBeGreaterThanOrEqual(65);
        expect(['強轉', '蓄勢']).toContain(s!.status);
    });
    it('歷史信號至少收集到一筆', () => {
        expect(collectEntrySignals(series()).length).toBeGreaterThanOrEqual(1);
    });
});

describe('過熱排除', () => {
    // 最後一根大漲（>9%）→ 觸發單日漲幅排除
    const s = scoreStock(series(40, 12, 400));
    it('單日暴漲被排除、不追高', () => {
        expect(s).not.toBeNull();
        expect(s!.excluded).toBe(true);
        expect(s!.excludeReasons.join(',')).toContain('單日漲≥9%');
        expect(s!.status).toBe('觀望');
        expect(s!.pattern).toBe('過熱排除');
        expect(s!.isEntry).toBe(false);
    });
});

describe('空頭放量破底', () => {
    const s = scoreStockShort(shortSeries());
    it('判定可放空、放量破底、非過冷', () => {
        expect(s).not.toBeNull();
        expect(s!.side).toBe('short');
        expect(s!.excluded).toBe(false);
        expect(s!.isEntry).toBe(true);
        expect(s!.pattern).toBe('放量破底');
        expect(s!.score).toBeGreaterThanOrEqual(65);
        expect(['弱轉', '蓄勢']).toContain(s!.status);
    });
    it('歷史空方信號至少收集到一筆', () => {
        expect(collectShortSignals(shortSeries()).length).toBeGreaterThanOrEqual(1);
    });
});

describe('過冷排除', () => {
    // 最後一根暴跌（>9%）→ 觸發單日跌幅排除、不在極端超賣追空
    const s = scoreStockShort(shortSeries(40, -12, 400));
    it('單日暴跌被排除、不追空', () => {
        expect(s).not.toBeNull();
        expect(s!.excluded).toBe(true);
        expect(s!.excludeReasons.join(',')).toContain('單日跌≥9%');
        expect(s!.status).toBe('觀望');
        expect(s!.pattern).toBe('過冷排除');
        expect(s!.isEntry).toBe(false);
    });
});

describe('資料不足', () => {
    it('少於 warmup 回 null', () => {
        expect(scoreStock(series(15))).toBeNull();
        expect(scoreStockShort(shortSeries(15))).toBeNull();
    });
});
