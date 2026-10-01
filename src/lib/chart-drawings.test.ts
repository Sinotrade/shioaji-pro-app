import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HARD_MAX_DRAWINGS_PER_SYMBOL,
    takeDrawingNotices,
    writeDrawingJournal,
    __setDrawingLocksForTest,
    TOMBSTONE_TTL_MS,
    __resetDrawingsForTest,
    addDrawing,
    clearDrawings,
    contrastTextColor,
    DEFAULT_DRAWING_STYLE,
    defaultStyleFor,
    drawingSymbolKey,
    DRAWING_PALETTE,
    drawingsSaveFailed,
    duplicateDrawing,
    flushDrawingSettings,
    flushDrawingWrites,
    getDrawingSettings,
    getDrawings,
    sanitizeDrawing,
    sanitizeSettings,
    setDrawingSettings,
    takeDrawingSaveErrorNotice,
    MAX_DRAWINGS_PER_SYMBOL,
    reloadDrawingSettingsFromStorage,
    reloadDrawingsFromStorage,
    removeDrawing,
    showAllDrawings,
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
        get length() {
            return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
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
        const d = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        expect(getDrawings('TXF')).toEqual([d]);
        flushDrawingWrites();
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
        const d = addDrawing('TXF', 'trend', anchors, style)!;
        style.color = '#ff0000';
        expect(getDrawings('TXF')[0]!.style.color).toBe(d.style.color);
        expect(getDrawings('TXF')[0]!.style.color).not.toBe('#ff0000');
    });

    it('更新只動指定的物件，其餘保持同一個參考', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'box', anchors, DEFAULT_DRAWING_STYLE)!;
        updateDrawing('TXF', a.id, { style: { ...a.style, color: '#ff7043' } });
        const list = getDrawings('TXF');
        expect(list[0]!.style.color).toBe('#ff7043');
        expect(list[1]).toBe(b);
    });

    it('刪除後不再讀得到', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        removeDrawing('TXF', a.id);
        expect(getDrawings('TXF')).toEqual([]);
    });

    it('複製沿用樣式、套用呼叫端給的偏移，id 不同', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const copy = duplicateDrawing('TXF', a.id, (x) => ({ time: x.time + 300, price: x.price - 5 }))!;
        expect(copy.id).not.toBe(a.id);
        expect(copy.style).toEqual(a.style);
        expect(copy.anchors.map((x) => x.time)).toEqual([1300, 2300]);
        // 水平線這類物件只靠時間位移會完全疊在原處，所以價格也要能偏移
        expect(copy.anchors.map((x) => x.price)).toEqual([24995, 25095]);
    });

    it('一鍵清除保留鎖定的物件 — 鎖定的用意就是防誤刪', () => {
        const keep = addDrawing('TXF', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE)!;
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
        expect(() => flushDrawingWrites()).not.toThrow();
        expect(getDrawings('TXF')).toHaveLength(1);
    });

    it('拖曳時連續改動只在節流窗結束寫一次 localStorage，畫面仍即時更新', () => {
        vi.useFakeTimers();
        try {
            const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
            vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: () => {} });
            const d = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            for (let i = 1; i <= 50; i++) {
                updateDrawing('TXF', d.id, { anchors: [anchors[0]!, { time: 2000, price: 25100 + i }] });
            }
            expect(getDrawings('TXF')[0]!.anchors[1]!.price).toBe(25150);
            expect(setItem).not.toHaveBeenCalled();
            vi.runAllTimers();
            // 畫圖一次（另加墓碑項目一次）
            expect(setItem.mock.calls.filter((c) => c[0] === 'sj-pro-chart-drawings')).toHaveLength(1);
            expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF[0].anchors[1].price).toBe(25150);
        } finally {
            vi.useRealTimers();
        }
    });

    it('每個商品有數量上限，超過就不再新增（複製也一樣）', () => {
        for (let i = 0; i < MAX_DRAWINGS_PER_SYMBOL; i++) {
            addDrawing('TXF', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE);
        }
        const first = getDrawings('TXF')[0]!;
        expect(addDrawing('TXF', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE)).toBeNull();
        expect(duplicateDrawing('TXF', first.id, (a) => a)).toBeNull();
        expect(getDrawings('TXF')).toHaveLength(MAX_DRAWINGS_PER_SYMBOL);
        // 其他商品不受影響
        expect(addDrawing('2330', 'horizontal', [anchors[0]!], DEFAULT_DRAWING_STYLE)).not.toBeNull();
    });
});

describe('價格軸標籤的字色', () => {
    it('跟著 lightweight-charts 的門檻走 — 深色底白字、亮色底黑字', () => {
        expect(contrastTextColor('#2962ff')).toBe('#ffffff'); // 藍
        expect(contrastTextColor('#ef5350')).toBe('#ffffff'); // 紅
        expect(contrastTextColor('#ffb300')).toBe('#000000'); // 黃 — 白字會糊掉
        expect(contrastTextColor('#00bcd4')).toBe('#ffffff'); // 青
    });

    it('色盤裡每個顏色都挑得到字色，不會因格式落到預設值', () => {
        for (const c of DRAWING_PALETTE) {
            expect(['#000000', '#ffffff']).toContain(contrastTextColor(c));
        }
    });

    it('看不懂的色值退回白字，不丟例外', () => {
        expect(contrastTextColor('rgba(0,0,0,.5)')).toBe('#ffffff');
        expect(contrastTextColor('')).toBe('#ffffff');
    });
});

describe('跨視窗同步', () => {
    it('節流窗內收到別的視窗寫入：本視窗未寫出的商品保留，其他商品採用對方版本', () => {
        vi.useFakeTimers();
        try {
            const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            // 另一個視窗寫入了 2330（它看不到本視窗還沒落地的 TXF）
            const theirs = { ...mine, id: 'other', tool: 'horizontal' as const, anchors: [anchors[0]!] };
            store.set('sj-pro-chart-drawings', JSON.stringify({ '2330': [theirs] }));
            reloadDrawingsFromStorage();
            expect(getDrawings('TXF').map((d) => d.id)).toEqual([mine.id]);
            expect(getDrawings('2330').map((d) => d.id)).toEqual(['other']);
            vi.runAllTimers();
            const saved = JSON.parse(store.get('sj-pro-chart-drawings')!);
            expect(Object.keys(saved).sort()).toEqual(['2330', 'TXF']);
        } finally {
            vi.useRealTimers();
        }
    });

    const KEY = 'sj-pro-chart-drawings';
    const saved = () => JSON.parse(store.get(KEY)!) as Record<string, { id: string }[]>;
    const other = (id: string, price = 25000) => ({
        id,
        tool: 'horizontal',
        anchors: [{ time: 1000, price }],
        style: DEFAULT_DRAWING_STYLE,
        locked: false,
        hidden: false,
        createdAt: 1,
    });

    it('同商品兩個視窗在節流窗內各自新增：依物件合併，兩邊的物件都留下', () => {
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        // 另一個視窗在同一商品寫入了自己的物件（它看不到本視窗還沒落地的）
        store.set(KEY, JSON.stringify({ TXF: [other('theirs')] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id).sort()).toEqual([mine.id, 'theirs'].sort());
        flushDrawingWrites();
        expect(saved().TXF!.map((d) => d.id).sort()).toEqual([mine.id, 'theirs'].sort());
    });

    it('寫出前才讀最新版本 — storage 事件還沒送到時也不會蓋掉對方剛寫的物件', () => {
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        store.set(KEY, JSON.stringify({ TXF: [other('theirs')] })); // 事件尚未送達
        flushDrawingWrites();
        expect(saved().TXF!.map((d) => d.id).sort()).toEqual([mine.id, 'theirs'].sort());
    });

    it('本視窗刪除的物件（墓碑）不會被對方較舊的版本帶回來，對方新增的照留', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        removeDrawing('TXF', a.id);
        // 對方還看得到 a，又新增了 c
        store.set(KEY, JSON.stringify({ TXF: [...saved().TXF!, other('c')] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([b.id, 'c']);
        flushDrawingWrites();
        expect(saved().TXF!.map((d) => d.id)).toEqual([b.id, 'c']);
    });

    it('對方刪掉的物件，本視窗沒動過就跟著消失', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        updateDrawing('TXF', b.id, { hidden: true });
        store.set(KEY, JSON.stringify({ TXF: saved().TXF!.filter((d) => d.id !== a.id) }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => [d.id, d.hidden])).toEqual([[b.id, true]]);
    });

    it('寫入失敗（配額滿）：待寫改動保留、同步不會蓋掉、提示一次，之後寫得進去就補寫', () => {
        let fail = true;
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => {
                if (fail) throw new Error('QuotaExceededError');
                store.set(k, v);
            },
            removeItem: (k: string) => void store.delete(k),
        });
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        expect(drawingsSaveFailed()).toBe(true);
        expect(takeDrawingSaveErrorNotice()).toBe(true);
        expect(takeDrawingSaveErrorNotice()).toBe(false); // 只提示一次
        // 另一個視窗寫入 — 本視窗還沒存成功的物件不能被蓋掉
        store.set(KEY, JSON.stringify({ TXF: [other('theirs')] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id).sort()).toEqual([mine.id, 'theirs'].sort());
        // 空間回來了：下一次寫出補上
        fail = false;
        updateDrawing('TXF', mine.id, { locked: true });
        flushDrawingWrites();
        expect(drawingsSaveFailed()).toBe(false);
        expect(saved().TXF!.map((d) => d.id).sort()).toEqual([mine.id, 'theirs'].sort());
    });

    it('本視窗沒有待寫入的改動時，整份採用對方版本', () => {
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        flushDrawingWrites();
        store.set('sj-pro-chart-drawings', JSON.stringify({}));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
    });
});

describe('顯示全部', () => {
    it('把隱藏的物件全部顯示回來，其餘屬性不變', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        updateDrawing('TXF', a.id, { hidden: true, locked: true });
        showAllDrawings('TXF');
        expect(getDrawings('TXF')[0]).toMatchObject({ id: a.id, hidden: false, locked: true });
    });
});

describe('載入資料的驗證', () => {
    it('設定裡的顏色是 null、線寬是字串等壞值都退回預設，不丟例外', () => {
        const s = sanitizeSettings({
            defaultStyle: { color: null, width: 'x', dash: 'dotted', fillOpacity: 9 },
            toolColors: { horizontal: null, trend: '#ABCDEF', box: 'red' },
            shareContinuousMonth: 'yes',
        });
        expect(s.defaultStyle).toEqual({ width: 2, dash: 'solid', fillOpacity: 1 });
        expect(s.toolColors).toEqual({ trend: '#ABCDEF' });
        expect(s.shareContinuousMonth).toBe(true);
        expect(sanitizeSettings(null).defaultStyle.width).toBe(2);
        expect(sanitizeSettings([1, 2]).toolColors).toEqual({});
    });

    it('localStorage 裡的 {"defaultStyle":{"color":null}} 不會讓讀取或價格軸標籤出錯', () => {
        store.set('sj-pro-chart-drawing-settings', JSON.stringify({ defaultStyle: { color: null } }));
        expect(() => reloadDrawingSettingsFromStorage()).not.toThrow();
        const style = defaultStyleFor(getDrawingSettings(), 'horizontal', 'dark');
        expect(typeof style.color).toBe('string');
        expect(() => contrastTextColor(style.color)).not.toThrow();
        expect(() => contrastTextColor(null as unknown as string)).not.toThrow();
        store.set('sj-pro-chart-drawing-settings', 'null');
        expect(() => reloadDrawingSettingsFromStorage()).not.toThrow();
    });

    it('物件的樣式與旗標逐欄修正：顏色格式、線寬範圍、透明度、布林值', () => {
        const d = sanitizeDrawing({
            id: 'x',
            tool: 'box',
            anchors: [
                { time: 1, price: 2 },
                { time: 3, price: 4 },
            ],
            style: { color: 'rgb(1,2,3)', width: 99, dash: 1, fillOpacity: -1 },
            locked: 'true',
            hidden: 1,
        })!;
        expect(d.style.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(d.style.width).toBe(4);
        expect(d.style.dash).toBe('solid');
        expect(d.style.fillOpacity).toBe(0);
        expect(d.locked).toBe(false);
        expect(d.hidden).toBe(false);
        expect(d.createdAt).toBe(0);
    });

    it('形狀不對的物件整筆丟掉', () => {
        expect(sanitizeDrawing({ id: 'x', tool: 'trend', anchors: [{ time: 1, price: 2 }], style: {} })).toBeNull();
        expect(sanitizeDrawing({ id: 'x', tool: 'fib', anchors: [], style: {} })).toBeNull();
        expect(sanitizeDrawing({ id: 'x', tool: 'horizontal', anchors: [{ time: NaN, price: 2 }] })).toBeNull();
        expect(sanitizeDrawing({ id: 'x', tool: 'horizontal', anchors: [null] })).toBeNull();
        expect(sanitizeDrawing(null)).toBeNull();
        // 沒有 style 的物件修成預設樣式，不丟掉
        expect(sanitizeDrawing({ id: 'x', tool: 'horizontal', anchors: [{ time: 1, price: 2 }] })).not.toBeNull();
    });

    it('載入時把壞物件濾掉、其餘修正後保留', () => {
        store.set(
            'sj-pro-chart-drawings',
            JSON.stringify({
                TXF: [
                    { id: 'ok', tool: 'horizontal', anchors: [{ time: 1, price: 2 }], style: { color: null } },
                    { id: 'bad', tool: 'trend', anchors: [] },
                ],
                X: 'not-a-list',
            }),
        );
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id)).toEqual(['ok']);
        expect(typeof getDrawings('TXF')[0]!.style.color).toBe('string');
        expect(getDrawings('X')).toEqual([]);
    });
});

describe('設定寫入節流', () => {
    it('拉填色滑桿連續改預設樣式，只在節流窗結束寫一次 localStorage', () => {
        vi.useFakeTimers();
        try {
            const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
            vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: () => {} });
            for (let i = 0; i <= 50; i += 2) {
                setDrawingSettings({
                    defaultStyle: { ...getDrawingSettings().defaultStyle, fillOpacity: i / 100 },
                });
            }
            expect(getDrawingSettings().defaultStyle.fillOpacity).toBe(0.5); // 畫面即時
            expect(setItem).not.toHaveBeenCalled();
            vi.runAllTimers();
            expect(setItem).toHaveBeenCalledTimes(1);
            expect(JSON.parse(store.get('sj-pro-chart-drawing-settings')!).defaultStyle.fillOpacity).toBe(0.5);
            flushDrawingSettings(); // 沒有待寫入時不重寫
            expect(setItem).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('review 修正：跨視窗鎖、墓碑、上限、設定合併', () => {
    const KEY = 'sj-pro-chart-drawings';
    const TKEY = 'sj-pro-chart-drawing-tombstones';
    const saved = () => JSON.parse(store.get(KEY) ?? '{}') as Record<string, { id: string }[]>;
    const theirs = (id: string, updatedAt = 1) => ({
        id,
        tool: 'horizontal',
        anchors: [{ time: 1000, price: 25000 }],
        style: DEFAULT_DRAWING_STYLE,
        locked: false,
        hidden: false,
        createdAt: 1,
        updatedAt,
    });

    it('讀→合併→寫在 Web Lock 裡做：拿到鎖之前別的視窗寫入的物件不會被蓋掉', () => {
        const queue: (() => unknown)[] = [];
        const request = vi.fn((name: string, cb: () => unknown) => {
            expect(name).toBe('sj-chart-drawings');
            queue.push(cb);
            return Promise.resolve();
        });
        __setDrawingLocksForTest({ request });
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        expect(request).toHaveBeenCalledTimes(1);
        expect(store.get(KEY)).toBeUndefined(); // 還在等鎖
        // 鎖被另一個視窗拿著時，它寫入了自己的物件
        store.set(KEY, JSON.stringify({ TXF: [theirs('other')] }));
        // 等鎖期間本視窗又改了一次
        updateDrawing('TXF', mine.id, { locked: true });
        queue.shift()!();
        const ids = saved().TXF!.map((d) => d.id).sort();
        expect(ids).toEqual([mine.id, 'other'].sort());
        expect((saved().TXF!.find((d) => d.id === mine.id) as unknown as { locked: boolean }).locked).toBe(true);
    });

    it('刪除墓碑寫出後仍保留：別的視窗較舊的寫入不會讓物件復活；比刪除更晚的修改才算數', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        removeDrawing('TXF', a.id);
        flushDrawingWrites();
        const tombs = JSON.parse(store.get(TKEY)!);
        expect(typeof tombs.TXF[a.id]).toBe('number');
        // 別的視窗還拿著 a 的舊版本，整份寫回
        store.set(KEY, JSON.stringify({ TXF: [{ ...a }] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
        // 刪除之後才修改的版本（updatedAt 較新）才會留下
        store.set(KEY, JSON.stringify({ TXF: [{ ...a, updatedAt: tombs.TXF[a.id] + 10 }] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([a.id]);
    });

    it('過期（超過 TTL）的墓碑在寫出時清掉', () => {
        const old = Date.now() - TOMBSTONE_TTL_MS - 1000;
        store.set(TKEY, JSON.stringify({ TXF: { gone: old, fresh: Date.now() } }));
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        flushDrawingWrites();
        expect(Object.keys(JSON.parse(store.get(TKEY)!).TXF)).toEqual(['fresh']);
    });

    it('載入時只有異常巨大的資料才截斷（硬上限 1000，保留最新的、順序不變），並通知', () => {
        const list = Array.from({ length: HARD_MAX_DRAWINGS_PER_SYMBOL + 50 }, (_, i) => ({
            ...theirs(`d${i}`),
            createdAt: i,
            updatedAt: i,
        }));
        store.set(KEY, JSON.stringify({ TXF: list }));
        takeDrawingNotices();
        reloadDrawingsFromStorage();
        const got = getDrawings('TXF');
        expect(got).toHaveLength(HARD_MAX_DRAWINGS_PER_SYMBOL);
        expect(got[0]!.id).toBe('d50');
        expect(got.at(-1)!.id).toBe(`d${HARD_MAX_DRAWINGS_PER_SYMBOL + 49}`);
        expect(takeDrawingNotices()).toHaveLength(1);
        // 同一則不重複通知
        reloadDrawingsFromStorage();
        expect(takeDrawingNotices()).toHaveLength(0);
    });

    it('軟上限（200）超量的正常資料載入時不刪', () => {
        const list = Array.from({ length: MAX_DRAWINGS_PER_SYMBOL + 5 }, (_, i) => theirs(`d${i}`));
        store.set(KEY, JSON.stringify({ TXF: list }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toHaveLength(MAX_DRAWINGS_PER_SYMBOL + 5);
    });

    it('設定依欄位合併：兩個視窗各改不同欄位，兩邊都留下', () => {
        setDrawingSettings({ shareContinuousMonth: false }); // 本視窗（尚未寫出）
        store.set(
            'sj-pro-chart-drawing-settings',
            JSON.stringify({ shareContinuousMonth: true, defaultStyle: { width: 4, dash: 'dashed', fillOpacity: 0.2 } }),
        );
        reloadDrawingSettingsFromStorage();
        expect(getDrawingSettings().shareContinuousMonth).toBe(false);
        expect(getDrawingSettings().defaultStyle.width).toBe(4);
        flushDrawingSettings();
        const s = JSON.parse(store.get('sj-pro-chart-drawing-settings')!);
        expect(s.shareContinuousMonth).toBe(false);
        expect(s.defaultStyle.width).toBe(4);
    });
});

describe('關窗日誌：pagehide 不在鎖外動主項目', () => {
    const KEY = 'sj-pro-chart-drawings';
    const journals = () => [...store.keys()].filter((k) => k.startsWith('sj-chart-drawings-pending:'));
    const ids = () => (JSON.parse(store.get(KEY) ?? '{}').TXF ?? []).map((d: { id: string }) => d.id).sort();
    const theirs = (id: string) => ({
        id,
        tool: 'horizontal',
        anchors: [{ time: 1000, price: 25000 }],
        style: DEFAULT_DRAWING_STYLE,
        locked: false,
        hidden: false,
        createdAt: 1,
        updatedAt: 1,
    });

    it('A 在鎖內寫入時 B 關窗：B 只寫日誌、不碰主項目；下一次鎖內寫入把兩邊都併進去', () => {
        // 本 module 當 B：有還沒寫出的物件
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        // A 正在鎖內寫入主項目（它看不到 B 的物件）
        store.set(KEY, JSON.stringify({ TXF: [theirs('a-obj')] }));
        // B 關窗
        writeDrawingJournal();
        expect(ids()).toEqual(['a-obj']); // 主項目沒被 B 在鎖外改寫
        expect(journals()).toHaveLength(1);
        // A 的寫入晚於 B 的日誌完成、整份蓋掉主項目 — 日誌仍在，B 的物件不會遺失
        store.set(KEY, JSON.stringify({ TXF: [theirs('a-obj')] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id).sort()).toEqual(['a-obj', mine.id].sort());
        // 下一個寫入者（鎖內）合併日誌並刪掉
        flushDrawingWrites();
        expect(ids()).toEqual(['a-obj', mine.id].sort());
        expect(journals()).toHaveLength(0);
    });

    it('本視窗在等鎖時別的視窗關窗留下日誌：拿到鎖後一起寫進去', () => {
        const queue: (() => unknown)[] = [];
        __setDrawingLocksForTest({ request: (_n, cb) => (queue.push(cb), Promise.resolve()) });
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        store.set(
            'sj-chart-drawings-pending:other-window',
            JSON.stringify({ at: 1, ops: { TXF: { closed: theirs('closed') } }, settings: {} }),
        );
        queue.shift()!();
        expect(ids()).toEqual(['closed', mine.id].sort());
        expect(journals()).toHaveLength(0);
    });

    it('日誌裡的刪除與設定也會套用；沒改動時關窗不留日誌', () => {
        writeDrawingJournal();
        expect(journals()).toHaveLength(0);
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        removeDrawing('TXF', a.id);
        setDrawingSettings({ shareContinuousMonth: false });
        writeDrawingJournal();
        expect(journals()).toHaveLength(1);
        // 另一個視窗（模擬重新載入後）讀到的畫面已套用日誌
        reloadDrawingsFromStorage();
        reloadDrawingSettingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
        expect(getDrawingSettings().shareContinuousMonth).toBe(false);
        flushDrawingWrites();
        expect(ids()).toEqual([]);
        expect(JSON.parse(store.get('sj-pro-chart-drawing-settings')!).shareContinuousMonth).toBe(false);
    });
});

describe('round 4：初始化順序、日誌只刪合併過的那一版', () => {
    const journal = (id: string) =>
        JSON.stringify({
            at: 1,
            ops: {
                TXF: {
                    [id]: {
                        id,
                        tool: 'horizontal',
                        anchors: [{ time: 1000, price: 25000 }],
                        style: DEFAULT_DRAWING_STYLE,
                        locked: false,
                        hidden: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                },
            },
            settings: {},
        });

    it('storage 裡已有含物件的關窗日誌時，module 初始化不會丟 ReferenceError（TDZ），畫面看得到它', async () => {
        store.set('sj-chart-drawings-pending:0000:w1:1', journal('from-journal'));
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [JSON.parse(journal('main')).ops.TXF.main] }));
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        expect(fresh.getDrawings('TXF').map((d) => d.id).sort()).toEqual(['from-journal', 'main']);
    });

    it('合併期間同一視窗又寫了新日誌（bfcache 回來後再關）：新日誌不會被刪掉', () => {
        store.set('sj-chart-drawings-pending:0000:w1:1', journal('old'));
        const realSet = localStorage.setItem.bind(localStorage);
        let injected = false;
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            removeItem: (k: string) => void store.delete(k),
            get length() {
                return store.size;
            },
            key: (i: number) => [...store.keys()][i] ?? null,
            setItem: (k: string, v: string) => {
                realSet(k, v);
                // 鎖內合併寫主項目的同時，那個視窗又關了一次
                if (k === 'sj-pro-chart-drawings' && !injected) {
                    injected = true;
                    store.set('sj-chart-drawings-pending:0001:w1:2', journal('newer'));
                    // 同名覆寫（舊寫法）也要擋：內容變了就不刪
                    store.set('sj-chart-drawings-pending:0000:w1:1', journal('old-rewritten'));
                }
            },
        });
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        flushDrawingWrites();
        const left = [...store.keys()].filter((k) => k.startsWith('sj-chart-drawings-pending:')).sort();
        expect(left).toEqual(['sj-chart-drawings-pending:0000:w1:1', 'sj-chart-drawings-pending:0001:w1:2']);
        // 下一次寫入把它們併進去
        flushDrawingWrites();
        const ids = JSON.parse(store.get('sj-pro-chart-drawings')!).TXF.map((d: { id: string }) => d.id);
        expect(ids).toEqual(expect.arrayContaining(['old', 'old-rewritten', 'newer']));
        expect([...store.keys()].filter((k) => k.startsWith('sj-chart-drawings-pending:'))).toEqual([]);
    });

    it('關窗兩次寫的是兩個不同的日誌項目', () => {
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        writeDrawingJournal();
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        writeDrawingJournal();
        expect([...store.keys()].filter((k) => k.startsWith('sj-chart-drawings-pending:'))).toHaveLength(2);
    });
});

describe('round 5：墓碑不刪較新的版本、合併不默默丟物件', () => {
    const KEY = 'sj-pro-chart-drawings';
    const TKEY = 'sj-pro-chart-drawing-tombstones';
    const obj = (id: string, updatedAt: number) => ({
        id,
        tool: 'horizontal',
        anchors: [{ time: 1000, price: 25000 }],
        style: DEFAULT_DRAWING_STYLE,
        locked: false,
        hidden: false,
        createdAt: 1,
        updatedAt,
    });

    it('被墓碑否決的舊修改，不會連帶刪掉主項目裡比墓碑新的同 id 版本（刪除後重建）', () => {
        const x = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!; // 本視窗待寫的修改（較舊）
        const deletedAt = x.updatedAt + 10;
        store.set(TKEY, JSON.stringify({ TXF: { [x.id]: deletedAt } }));
        // 別的視窗在刪除之後又重建了同 id 的物件（例如復原）
        store.set(KEY, JSON.stringify({ TXF: [obj(x.id, deletedAt + 10)] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.updatedAt)).toEqual([deletedAt + 10]);
        flushDrawingWrites();
        const saved = JSON.parse(store.get(KEY)!).TXF;
        expect(saved).toHaveLength(1);
        expect(saved[0].updatedAt).toBe(deletedAt + 10);
    });

    it('兩個視窗各自在上限附近新增：合併後全部保留（暫時超過上限）並通知，之後新增被擋', () => {
        const mine = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        // 另一個視窗已有 200 個（它看不到本視窗這一個）
        store.set(KEY, JSON.stringify({ TXF: Array.from({ length: MAX_DRAWINGS_PER_SYMBOL }, (_, i) => obj(`o${i}`, 1)) }));
        takeDrawingNotices();
        flushDrawingWrites();
        const saved = JSON.parse(store.get(KEY)!).TXF;
        expect(saved).toHaveLength(MAX_DRAWINGS_PER_SYMBOL + 1);
        expect(saved.some((d: { id: string }) => d.id === mine.id)).toBe(true);
        expect(takeDrawingNotices()).toHaveLength(1);
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toHaveLength(MAX_DRAWINGS_PER_SYMBOL + 1);
        expect(addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)).toBeNull();
    });
});
