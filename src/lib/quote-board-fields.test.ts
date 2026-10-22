import { describe, expect, it } from 'vitest';
import {
    compactQuoteBoardFields,
    decodeQuoteBoardFields,
    DEFAULT_QUOTE_BOARD_FIELDS,
    encodeQuoteBoardFields,
    isDefaultLayout,
    moveField,
    moveSection,
    normalizeQuoteBoardFields,
    resetKind,
    toggleField,
    visibleFields,
} from './quote-board-fields';

describe('報價欄自訂欄位', () => {
    it('沒有存檔時是預設，預設不寫進版面', () => {
        const f = normalizeQuoteBoardFields(undefined);
        expect(f).toEqual(DEFAULT_QUOTE_BOARD_FIELDS);
        expect(compactQuoteBoardFields(f)).toBeUndefined();
        expect(visibleFields(f.stock, 'stats')).toEqual(['highLow', 'open', 'volume', 'ratio', 'limits']);
    });

    it('讀存檔時丟掉不認得的值、補上缺的格子，格子不能跨區，比例條固定在最後', () => {
        const f = normalizeQuoteBoardFields({
            index: {
                sections: ['volume', 'bogus' as never],
                order: { breadth: ['breadthBar', 'fall', 'raise', 'amount' as never], volume: ['time'] } as never,
                hidden: ['flat', 'nope' as never],
            },
        });
        expect(f.index.sections).toEqual(['volume', 'breadth']);
        expect(f.index.order.breadth).toEqual(['fall', 'raise', 'limitUp', 'flat', 'limitDown', 'breadthBar']);
        expect(f.index.order.volume).toEqual(['time', 'amount', 'estimate', 'change']);
        expect(f.index.hidden).toEqual(['flat']);
        // 壞掉的存檔不丟例外
        expect(normalizeQuoteBoardFields('x' as never)).toEqual(DEFAULT_QUOTE_BOARD_FIELDS);
    });

    it('開關、上下移動、整區移動；邊界與固定格不動', () => {
        let f = normalizeQuoteBoardFields(undefined);
        f = toggleField(f, 'stock', 'open');
        expect(visibleFields(f.stock, 'stats')).toEqual(['highLow', 'volume', 'ratio', 'limits']);
        f = moveField(f, 'stock', 'limits', -1);
        expect(f.stock.order.stats).toEqual(['highLow', 'open', 'volume', 'limits', 'ratio']);
        expect(moveField(f, 'stock', 'highLow', -1)).toBe(f);
        // 比例條固定在最後，跌停不能換到它後面
        const idx = normalizeQuoteBoardFields(undefined);
        expect(moveField(idx, 'index', 'limitDown', 1)).toBe(idx);
        expect(moveField(idx, 'index', 'breadthBar', -1)).toBe(idx);
        f = moveSection(f, 'stock', 'stats', -1);
        expect(f.stock.sections).toEqual(['stats', 'range']);
        expect(moveSection(f, 'stock', 'stats', -1)).toBe(f);
        expect(isDefaultLayout(f, 'stock')).toBe(false);
        expect(isDefaultLayout(f, 'index')).toBe(true);
        // 只存改過的那一種
        expect(Object.keys(compactQuoteBoardFields(f)!)).toEqual(['stock']);
        expect(isDefaultLayout(resetKind(f, 'stock'), 'stock')).toBe(true);
        // 再打開一次回到原位
        expect(visibleFields(toggleField(f, 'stock', 'open').stock, 'stats')).toEqual(['highLow', 'open', 'volume', 'limits', 'ratio']);
    });

    it('彈出視窗的網址參數來回一致，壞掉的參數當成沒有', () => {
        const config = compactQuoteBoardFields(toggleField(normalizeQuoteBoardFields(undefined), 'index', 'time'));
        const raw = encodeQuoteBoardFields(config);
        expect(decodeQuoteBoardFields(raw!)).toEqual(config);
        expect(decodeQuoteBoardFields('{bad')).toBeUndefined();
        expect(decodeQuoteBoardFields(null)).toBeUndefined();
        expect(encodeQuoteBoardFields(undefined)).toBeUndefined();
    });
});
