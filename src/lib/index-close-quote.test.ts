// src/lib/index-close-quote.test.ts：收盤那筆指數報價存在本機，重開後依快照日期讀回
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => map.set(k, v),
        removeItem: (k: string) => map.delete(k),
    };
    return map;
});

import { recalledIndexClose, rememberIndexClose } from './index-close-quote';
import type { SseIndexQuote } from './types/market';

// quote_idx 的日期是 2026/10/19，快照的 datetime 是 2026-10-19T13:33:00，格式不同也要對得上
const quote = (time: string, date = '2026/10/19'): SseIndexQuote => ({
    code: 'IX0001',
    exchange: 'TSE',
    date,
    time,
    reference: '47111.26',
    open: '46844.64',
    high: '46844.64',
    low: '46170.0',
    close: '46822.08',
    raise_count: 160,
    flat_count: 72,
    fall_count: 862,
    limit_up_count: 7,
    limit_down_count: 2,
});

afterEach(() => store.clear());

describe('rememberIndexClose', () => {
    it('只存 13:33 起的報價（收盤後的最終那筆），後到的覆蓋先到的', () => {
        rememberIndexClose(quote('13:30:00.000000'));
        rememberIndexClose(quote('13:32:59.000000'));
        expect(store.size).toBe(0);
        rememberIndexClose(quote('13:33:00.000000'));
        rememberIndexClose({ ...quote('13:33:00.000000'), raise_count: 161 });
        expect(JSON.parse(store.get('sj-index-close:IX0001')!).raise_count).toBe(161);
    });

    it('沒帶家數的報價不存，也不蓋掉先前存好的那筆', () => {
        rememberIndexClose(quote('13:33:00'));
        rememberIndexClose({ ...quote('13:34:00'), raise_count: undefined });
        expect(JSON.parse(store.get('sj-index-close:IX0001')!).time).toBe('13:33:00');
    });

    it('儲存失敗（空間滿、被停用）不丟錯，即時行情照常', () => {
        const setItem = localStorage.setItem;
        localStorage.setItem = () => {
            throw new Error('QuotaExceededError');
        };
        try {
            expect(() => rememberIndexClose(quote('13:33:00'))).not.toThrow();
        } finally {
            localStorage.setItem = setItem;
        }
    });
});

describe('recalledIndexClose', () => {
    it('快照同一個交易日才讀回，價格和家數是同一天', () => {
        rememberIndexClose(quote('13:33:00'));
        expect(recalledIndexClose('IX0001', '2026-10-19T13:33:00')?.raise_count).toBe(160);
    });

    it('實測的 quote_idx 格式（日期 2026-10-19、時間不帶微秒）也存得進、讀得回', () => {
        rememberIndexClose(quote('13:33:00', '2026-10-19'));
        expect(recalledIndexClose('IX0001', '2026-10-19T13:33:00')?.fall_count).toBe(862);
    });

    it('快照是別天（隔天盤前伺服器已翻日、或存的是更早的收盤）不讀回', () => {
        rememberIndexClose(quote('13:33:00', '2026/10/16'));
        expect(recalledIndexClose('IX0001', '2026-10-19T13:33:00')).toBeUndefined();
    });

    it('沒有快照、沒存過、存的內容壞掉，都回 undefined', () => {
        rememberIndexClose(quote('13:33:00'));
        expect(recalledIndexClose('IX0001', undefined)).toBeUndefined();
        expect(recalledIndexClose('IX0043', '2026-10-19T13:33:00')).toBeUndefined();
        store.set('sj-index-close:IX0001', '{not json');
        expect(recalledIndexClose('IX0001', '2026-10-19T13:33:00')).toBeUndefined();
        // 日期對得上但缺 time（舊版或壞掉的存檔）也不用，免得看板切字串時丟錯
        store.set('sj-index-close:IX0001', JSON.stringify({ ...quote('13:33:00'), time: undefined }));
        expect(recalledIndexClose('IX0001', '2026-10-19T13:33:00')).toBeUndefined();
    });
});
