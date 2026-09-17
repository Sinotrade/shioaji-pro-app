import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    __resetDrawingsForTest,
    addDrawing,
    clearDrawings,
    DEFAULT_DRAWING_STYLE,
    drawingSymbolKey,
    duplicateDrawing,
    getDrawings,
    removeDrawing,
    updateDrawing,
    type DrawingAnchor,
} from './chart-drawings';

const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    __resetDrawingsForTest();
});

afterEach(() => vi.unstubAllGlobals());

const anchors: DrawingAnchor[] = [
    { time: 1000, price: 25000 },
    { time: 2000, price: 25100 },
];

describe('商品鍵：期貨連續月與月份合約共用', () => {
    const fut = (code: string) => ({ code, security_type: 'FUT' as const });

    it('開啟共用時，連續月別名與各月份合約收斂到同一個根代碼', () => {
        expect(drawingSymbolKey(fut('TXFR1'), true)).toBe('TXF');
        expect(drawingSymbolKey(fut('TXFI6'), true)).toBe('TXF');
        expect(drawingSymbolKey(fut('TXFJ6'), true)).toBe('TXF');
        expect(drawingSymbolKey(fut('CCFI6'), true)).toBe('CCF');
    });

    it('關閉共用時每個合約代碼各自獨立', () => {
        expect(drawingSymbolKey(fut('TXFR1'), false)).toBe('TXFR1');
        expect(drawingSymbolKey(fut('TXFI6'), false)).toBe('TXFI6');
    });

    it('選擇權不收斂 — 不同履約價是不同商品', () => {
        const opt = (code: string) => ({ code, security_type: 'OPT' as const });
        expect(drawingSymbolKey(opt('TXO21000I6'), true)).toBe('TXO21000I6');
        expect(drawingSymbolKey(opt('TXO21500I6'), true)).toBe('TXO21500I6');
    });

    it('股票代碼原樣使用', () => {
        expect(drawingSymbolKey({ code: '2330', security_type: 'STK' }, true)).toBe('2330');
    });

    it('認不出月份格式的期貨代碼原樣保留，不亂切根代碼', () => {
        expect(drawingSymbolKey(fut('WEIRD'), true)).toBe('WEIRD');
        expect(drawingSymbolKey(fut('TX'), true)).toBe('TX');
    });
});

describe('畫圖物件的增刪改', () => {
    it('新增後可依商品鍵讀回，並落地到 localStorage', () => {
        const d = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        expect(getDrawings('TXF')).toEqual([d]);
        expect(JSON.parse(store.get('sj-pro-chart-drawings')!)).toEqual({ TXF: [d] });
    });

    it('不同商品各自獨立', () => {
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        addDrawing('2330', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE);
        expect(getDrawings('TXF')).toHaveLength(1);
        expect(getDrawings('2330')).toHaveLength(1);
        expect(getDrawings('2330')[0]!.tool).toBe('horizontal');
    });

    it('樣式是複本 — 之後改預設樣式不會回頭改到已建立的物件', () => {
        const style = { ...DEFAULT_DRAWING_STYLE };
        const d = addDrawing('TXF', 'trend', anchors, style);
        style.color = '#ff0000';
        expect(getDrawings('TXF')[0]!.style.color).toBe(d.style.color);
        expect(getDrawings('TXF')[0]!.style.color).not.toBe('#ff0000');
    });

    it('更新只動指定的物件，其餘保持同一個參考', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        const b = addDrawing('TXF', 'box', anchors, DEFAULT_DRAWING_STYLE);
        updateDrawing('TXF', a.id, { style: { ...a.style, color: '#ff7043' } });
        const list = getDrawings('TXF');
        expect(list[0]!.style.color).toBe('#ff7043');
        expect(list[1]).toBe(b);
    });

    it('刪除後不再讀得到', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        removeDrawing('TXF', a.id);
        expect(getDrawings('TXF')).toEqual([]);
    });

    it('複製沿用樣式、套用呼叫端給的偏移，id 不同', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        const copy = duplicateDrawing('TXF', a.id, (x) => ({ time: x.time + 300, price: x.price - 5 }))!;
        expect(copy.id).not.toBe(a.id);
        expect(copy.style).toEqual(a.style);
        expect(copy.anchors.map((x) => x.time)).toEqual([1300, 2300]);
        // 水平線這類物件只靠時間位移會完全疊在原處，所以價格也要能偏移
        expect(copy.anchors.map((x) => x.price)).toEqual([24995, 25095]);
    });

    it('一鍵清除保留鎖定的物件 — 鎖定的用意就是防誤刪', () => {
        const keep = addDrawing('TXF', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE);
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        updateDrawing('TXF', keep.id, { locked: true });
        clearDrawings('TXF');
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([keep.id]);
    });

    it('對不存在的商品或 id 操作不丟例外', () => {
        expect(() => removeDrawing('NOPE', 'x')).not.toThrow();
        expect(() => updateDrawing('NOPE', 'x', { hidden: true })).not.toThrow();
        expect(() => clearDrawings('NOPE')).not.toThrow();
        expect(duplicateDrawing('NOPE', 'x', (a) => a)).toBeNull();
    });

    it('localStorage 寫入失敗（配額滿／隱私模式）不影響本次操作', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
            removeItem: () => {},
        });
        expect(() => addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)).not.toThrow();
        expect(getDrawings('TXF')).toHaveLength(1);
    });
});
