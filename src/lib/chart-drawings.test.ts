import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_LINE_OPACITY,
    anchorCount,
    drawingLabel,
    fibOptionsOf,
    MAX_TEXT_LENGTH,
    moveDrawing,
    removeDrawings,
    replaceDrawings,
    setDrawingsLocked,
    HARD_MAX_DRAWINGS_PER_SYMBOL,
    takeDrawingNotices,
    writeDrawingJournal,
    __setDrawingLocksForTest,
    __resetDrawingsForTest,
    addDrawing,
    applyDrawingHistory,
    getDrawingHistoryStart,
    createDrawingWriter,
    withDrawingWriter,
    subscribeDrawingRemoteChanges,
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
import { defaultFibLevels, defaultFibOptions } from './chart-drawing-fib';
import { drawingRevision } from './chart-drawing-revision';
import { DrawingHistory } from './chart-drawing-history';

const store = new Map<string, string>();

describe('圖表實例 writer', () => {
    it.each(['new-version', 'foreign-union', 'wrong-writer'] as const)('獨立撤銷紀錄不能撤銷不符合原 writer／版本的墓碑（%s）', async (path) => {
        const { d, history } = withDrawingWriter('chart-a', deletedDrawing);
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
            if (!k.startsWith('sj-chart-drawings-pending:')) throw new Error('QuotaExceededError');
            originalSet(k, v);
        });
        withDrawingWriter('chart-a', () => applyDrawingHistory(history.undo()!, vi.fn()));
        withDrawingWriter('chart-b', () => updateDrawing('TXF', d.id, { name: 'B 的後續編輯' }));
        writeDrawingJournal();
        write.mockRestore();
        const tombs = JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!);
        if (path === 'new-version') tombs.TXF[d.id].revision = '0000000000000100:chart-a';
        if (path === 'foreign-union') tombs.TXF[d.id].writers.push('chart-b');
        store.set('sj-pro-chart-drawing-tombstones', JSON.stringify(tombs));
        if (path === 'wrong-writer') {
            const [name, raw] = [...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))!;
            const journal = JSON.parse(raw);
            (Object.values(journal.restores.TXF[d.id])[0] as { writer: string }).writer = 'chart-b';
            store.set(name, JSON.stringify(journal));
        }
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        fresh.__setDrawingLocksForTest(null);
        try {
            expect(fresh.getDrawings('TXF')).toEqual([]);
            fresh.flushDrawingWrites();
            expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF[d.id]).toEqual(tombs.TXF[d.id]);
        } finally { fresh.__resetDrawingsForTest(); }
    });

    it('B 的較新內容已落地主項目，淘汰 A 的待寫內容後仍保留 A 的墓碑撤銷日誌', async () => {
        const { d, history } = withDrawingWriter('chart-a', deletedDrawing);
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
            if (!k.startsWith('sj-chart-drawings-pending:')) throw new Error('QuotaExceededError');
            originalSet(k, v);
        });
        withDrawingWriter('chart-a', () => applyDrawingHistory(history.undo()!, vi.fn()));
        // B 已寫入內容，但墓碑寫入仍失敗；A 的內容將依 revision 被淘汰。
        const remote = { ...getDrawings('TXF')[0]!, name: 'B 已落地的編輯', revision: '0000000000000100:chart-b' };
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([remote]);
        writeDrawingJournal();
        const journal = JSON.parse([...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1]);
        expect(journal.ops.TXF?.[d.id]).toBeUndefined();
        expect(Object.values(journal.restores.TXF[d.id])[0]).toMatchObject({ writer: 'chart-a' });
        write.mockRestore();
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        fresh.__setDrawingLocksForTest(null);
        try {
            expect(fresh.getDrawings('TXF')).toEqual([remote]);
            fresh.flushDrawingWrites();
            expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
            fresh.reloadDrawingsFromStorage();
            expect(fresh.getDrawings('TXF')).toEqual([remote]);
        } finally { fresh.__resetDrawingsForTest(); }
    });

    it.each(['same-window', 'other-window', 'legacy-journal'] as const)('A 復原寫入失敗，B 再編輯後關窗日誌重開仍保留物件（%s）', async (path) => {
        const a = 'chart-a';
        const b = 'chart-b';
        const { d, history } = withDrawingWriter(a, deletedDrawing);
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
            if (!k.startsWith('sj-chart-drawings-pending:')) throw new Error('QuotaExceededError');
            originalSet(k, v);
        });
        const applied = vi.fn();
        withDrawingWriter(a, () => applyDrawingHistory(history.undo()!, applied));
        expect(applied).toHaveBeenCalledWith(true);
        let other: typeof import('./chart-drawings') | undefined;
        if (path === 'other-window') {
            writeDrawingJournal();
            vi.resetModules();
            other = await import('./chart-drawings');
            other.__setDrawingLocksForTest(null);
        }
        const api = other ?? { withDrawingWriter, updateDrawing, writeDrawingJournal, getDrawings };
        api.withDrawingWriter(b, () => api.updateDrawing('TXF', d.id, { name: 'B 的後續編輯' }));
        expect(api.getDrawings('TXF')[0]?.name).toBe('B 的後續編輯');
        api.writeDrawingJournal();
        write.mockRestore();
        if (path === 'legacy-journal') {
            const [name, raw] = [...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))!;
            const journal = JSON.parse(raw);
            journal.restores.TXF[d.id] = Object.values(journal.restores.TXF[d.id])[0];
            store.set(name, JSON.stringify(journal));
        }
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        fresh.__setDrawingLocksForTest(null);
        try {
            expect(fresh.getDrawings('TXF')).toHaveLength(1);
            expect(fresh.getDrawings('TXF')[0]).toMatchObject({ id: d.id, name: 'B 的後續編輯' });
            expect(drawingRevision(fresh.getDrawings('TXF')[0]!).split(':')[1]).toBe(b);
            fresh.flushDrawingWrites();
            expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
            fresh.reloadDrawingsFromStorage();
            expect(fresh.getDrawings('TXF')[0]?.name).toBe('B 的後續編輯');
        } finally { other?.__resetDrawingsForTest(); fresh.__resetDrawingsForTest(); }
    });

    function deletedDrawing() {
        const d = addDrawing('TXF', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        const history = new DrawingHistory();
        history.begin('TXF', getDrawingHistoryStart());
        const before = getDrawings('TXF');
        removeDrawing('TXF', d.id);
        history.push('TXF', before, getDrawings('TXF'));
        flushDrawingWrites();
        return { d, history };
    }

    it.each(['sj-pro-chart-drawings', 'sj-pro-chart-drawing-tombstones'].flatMap(failKey =>
        ['retry', 'journal'].map(path => ({ failKey, path }))))
    ('持續 $failKey 寫入失敗時復原→重做→復原，$path 後仍撤銷原墓碑', async ({ failKey, path }) => {
        const { d, history } = deletedDrawing();
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
            if (k === failKey) throw new Error('QuotaExceededError');
            originalSet(k, v);
        });
        try {
            for (const side of ['undo', 'redo', 'undo'] as const) {
                const applied = vi.fn();
                applyDrawingHistory(history[side]()!, applied);
                expect(applied).toHaveBeenCalledWith(true);
                flushDrawingWrites();
                expect(drawingsSaveFailed()).toBe(true);
                expect(getDrawings('TXF').map(x => x.id)).toEqual(side === 'redo' ? [] : [d.id]);
            }
            if (path === 'journal') {
                writeDrawingJournal();
                const journal = JSON.parse([...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1]);
                expect(Object.keys(journal.restores.TXF[d.id])).toHaveLength(2);
            }
        } finally { write.mockRestore(); }
        let fresh: typeof import('./chart-drawings') | undefined;
        if (path === 'journal') {
            vi.resetModules();
            fresh = await import('./chart-drawings');
            fresh.__setDrawingLocksForTest(null);
        }
        const api = fresh ?? { flushDrawingWrites, reloadDrawingsFromStorage, getDrawings };
        try {
            api.flushDrawingWrites();
            api.reloadDrawingsFromStorage();
            expect(api.getDrawings('TXF').map(x => x.id)).toEqual([d.id]);
            expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
        } finally { fresh?.__resetDrawingsForTest(); }
    });

    it.each(['sj-pro-chart-drawings', 'sj-pro-chart-drawing-tombstones'] as const)('復原刪除寫入 %s 配額失敗後，物件與墓碑撤銷一起保留並重試', (failKey) => {
        const { d, history } = deletedDrawing();
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((k, v) => {
            if (k === failKey) throw new Error('QuotaExceededError');
            originalSet(k, v);
        });
        const applied = vi.fn();
        applyDrawingHistory(history.undo()!, applied);
        expect(applied).toHaveBeenCalledWith(true);
        expect(getDrawings('TXF').map((x) => x.id)).toEqual([d.id]);
        expect(drawingsSaveFailed()).toBe(true);
        reloadDrawingsFromStorage();
        flushDrawingWrites();
        expect(getDrawings('TXF').map((x) => x.id)).toEqual([d.id]);
        expect(drawingsSaveFailed()).toBe(true);
        write.mockRestore();
        flushDrawingWrites();
        expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF.map((x: { id: string }) => x.id)).toEqual([d.id]);
        expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
        expect(drawingsSaveFailed()).toBe(false);
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((x) => x.id)).toEqual([d.id]);
    });

    it.each(['edit', 'journal', 'foreign-delete'] as const)('失敗的復原仍可 %s；獨立撤銷紀錄持續保留', async (path) => {
        const { d, history } = deletedDrawing();
        const originalSet = localStorage.setItem;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
        applyDrawingHistory(history.undo()!, vi.fn());
        expect(drawingsSaveFailed()).toBe(true);
        if (path === 'edit') {
            updateDrawing('TXF', d.id, { name: '復原後編輯' });
            expect(getDrawings('TXF')[0]?.name).toBe('復原後編輯');
        } else if (path === 'foreign-delete') {
            const tombs = JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!);
            tombs.TXF[d.id].writers.push('foreign'); // 同一 revision 的遠端刪除聯集仍否決復原
            store.set('sj-pro-chart-drawing-tombstones', JSON.stringify(tombs));
        } else {
            write.mockImplementation((k, v) => {
                if (!k.startsWith('sj-chart-drawings-pending:')) throw new Error('QuotaExceededError');
                originalSet(k, v);
            });
            writeDrawingJournal();
            expect(drawingsSaveFailed()).toBe(true);
            const journal = JSON.parse([...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1]);
            expect(journal.ops.TXF[d.id]).toMatchObject({ id: d.id });
            expect(journal.ops.TXF[d.id].restoreTombstone).toBeUndefined();
            expect(Object.values(journal.restores.TXF[d.id])[0]).toMatchObject({ writer: expect.any(String), tombstone: { revision: expect.any(String) } });
        }
        write.mockRestore();
        if (path === 'journal') {
            vi.resetModules();
            const fresh = await import('./chart-drawings');
            fresh.__setDrawingLocksForTest(null);
            try {
                expect(fresh.getDrawings('TXF').map((x) => x.id)).toEqual([d.id]);
                fresh.flushDrawingWrites();
                expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF[0].id).toBe(d.id);
                expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
            } finally { fresh.__resetDrawingsForTest(); }
        } else {
            reloadDrawingsFromStorage();
            flushDrawingWrites();
            if (path === 'edit') {
                expect(getDrawings('TXF')[0]?.name).toBe('復原後編輯');
                expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[d.id]).toBeUndefined();
                expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF[0].restoreTombstone).toBeUndefined();
                expect(drawingsSaveFailed()).toBe(false);
            } else {
                expect(getDrawings('TXF')).toEqual([]);
                expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF[d.id].writers).toContain('foreign');
            }
        }
    });

    it('排隊的歷史保留原圖表 writer；復原／重做也通知其他圖表', () => {
        const a = createDrawingWriter();
        const b = createDrawingWriter();
        const history = new DrawingHistory();
        const before = getDrawings('TXF');
        history.begin('TXF', getDrawingHistoryStart());
        const drawing = withDrawingWriter(a, () => addDrawing('TXF', 'horizontal', [{ time: 1, price: 25000 }], DEFAULT_DRAWING_STYLE))!;
        history.push('TXF', before, getDrawings('TXF'));
        flushDrawingWrites();
        const remote = vi.fn();
        const own = vi.fn();
        const stopRemote = subscribeDrawingRemoteChanges(remote, b);
        const stopOwn = subscribeDrawingRemoteChanges(own, a);
        const queue: (() => unknown)[] = [];
        __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
        const applied = vi.fn();
        try {
            withDrawingWriter(a, () => applyDrawingHistory(history.undo()!, applied));
            expect(remote).not.toHaveBeenCalled();
            queue.shift()!();
            expect(applied).toHaveBeenLastCalledWith(true);
            const tomb = JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF[drawing.id];
            expect(tomb.writers).toEqual([a]);
            expect(remote).toHaveBeenCalledExactlyOnceWith('TXF', new Set([drawing.id]));
            remote.mockClear();
            withDrawingWriter(a, () => applyDrawingHistory(history.redo()!, applied));
            queue.shift()!();
            expect(drawingRevision(getDrawings('TXF')[0]!).split(':')[1]).toBe(a);
            expect(remote).toHaveBeenCalledExactlyOnceWith('TXF', new Set([drawing.id]));
            expect(own).not.toHaveBeenCalled();
        } finally { stopRemote(); stopOwn(); }
    });
});

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
        expect(s.defaultStyle).toEqual({ width: 1, dash: 'solid', fillOpacity: 1 });
        expect(s.toolColors).toEqual({ trend: '#ABCDEF' });
        expect(s.shareContinuousMonth).toBe(true);
        expect(sanitizeSettings(null).defaultStyle.width).toBe(1);
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

describe('第一期：新物件類型、舊資料相容、圖層順序', () => {
    const KEY = 'sj-pro-chart-drawings';
    const saved = () => JSON.parse(store.get(KEY)!) as Record<string, { id: string }[]>;

    it('#218 存下來的舊物件（沒有 name／text／levels）照常載入', () => {
        store.set(
            KEY,
            JSON.stringify({
                TXF: [
                    {
                        id: 'old',
                        tool: 'trend',
                        anchors: [
                            { time: 1, price: 2 },
                            { time: 3, price: 4 },
                        ],
                        style: { color: '#2962ff', width: 2, dash: 'solid', fillOpacity: 0.12 },
                        locked: false,
                        hidden: false,
                        createdAt: 1,
                    },
                ],
            }),
        );
        reloadDrawingsFromStorage();
        const d = getDrawings('TXF')[0]!;
        expect(d).toMatchObject({ id: 'old', tool: 'trend', style: { color: '#2962ff' } });
        expect(d.name).toBeUndefined();
        expect(drawingLabel(d)).toBe('趨勢線');
    });

    it('新工具的控制點數：垂直線／文字 1、平行通道 3、斐波那契 2', () => {
        expect(anchorCount('vertical')).toBe(1);
        expect(anchorCount('text')).toBe(1);
        expect(anchorCount('channel')).toBe(3);
        expect(anchorCount('fib')).toBe(2);
        expect(sanitizeDrawing({ id: 'c', tool: 'channel', anchors: [{ time: 1, price: 1 }, { time: 2, price: 2 }] })).toBeNull();
    });

    it('文字截斷、斐波那契比例清理、名稱修剪；非文字物件不帶 text', () => {
        const t = sanitizeDrawing({
            id: 't',
            tool: 'text',
            anchors: [{ time: 1, price: 1 }],
            text: 'x'.repeat(MAX_TEXT_LENGTH + 50),
            name: '  支撐  ',
        })!;
        expect(t.text).toHaveLength(MAX_TEXT_LENGTH);
        expect(t.name).toBe('支撐');
        const f = sanitizeDrawing({
            id: 'f',
            tool: 'fib',
            anchors: [
                { time: 1, price: 1 },
                { time: 2, price: 2 },
            ],
            levels: [1, 0.5, 'x', 0.5, 99, NaN, 0],
        })!;
        // #224 第一版的數字陣列轉成新格式，顏色沿用 TradingView 預設順序
        expect(f.fib!.levels.map((l) => [l.value, l.token, l.visible])).toEqual([
            [0, 'grey', true],
            [0.5, 'green', true],
            [1, 'grey', true],
        ]);
        expect(fibOptionsOf(sanitizeDrawing({ ...f, fib: undefined, levels: 'bad' })!).levels).toHaveLength(7);
        expect(sanitizeDrawing({ id: 'h', tool: 'horizontal', anchors: [{ time: 1, price: 1 }], text: 'no' })!.text).toBeUndefined();
    });

    it('設定：收藏、每組最後用的工具、磁吸、物件列表都驗證過', () => {
        const s = sanitizeSettings({
            favorites: ['trend', 'bogus', 'measure', 'trend'],
            groupLast: { lines: 'vertical', shapes: 'trend', measure: 'measure' },
            magnet: 'yes',
            objectListOpen: true,
        });
        expect(s.favorites).toEqual(['trend', 'measure']);
        expect(s.groupLast).toEqual({ lines: 'vertical', measure: 'measure' });
        expect(s.magnet).toBe(false);
        expect(s.objectListOpen).toBe(true);
        expect(sanitizeSettings({}).favorites).toEqual([]);
    });

    it('調整圖層：移動後寫出新順序；對方同時新增的物件保留在後面', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const c = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        moveDrawing('TXF', c.id, 0);
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([c.id, a.id, b.id]);
        // 對方視窗（還是舊順序）加了 z
        store.set(KEY, JSON.stringify({ TXF: [...saved().TXF!, { ...a, id: 'z' }] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([c.id, a.id, b.id, 'z']);
        flushDrawingWrites();
        expect(saved().TXF!.map((d) => d.id)).toEqual([c.id, a.id, b.id, 'z']);
    });

    it('多選刪除保留鎖定的；全部鎖定／解鎖；整份換掉依物件記差異', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        updateDrawing('TXF', b.id, { locked: true });
        removeDrawings('TXF', [a.id, b.id]);
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([b.id]);
        setDrawingsLocked('TXF', false);
        expect(getDrawings('TXF')[0]!.locked).toBe(false);
        setDrawingsLocked('TXF', true);
        expect(getDrawings('TXF')[0]!.locked).toBe(true);
        const c = { ...getDrawings('TXF')[0]!, id: 'c' };
        replaceDrawings('TXF', [...getDrawings('TXF'), c]);
        flushDrawingWrites();
        expect(saved().TXF!.map((d) => d.id)).toEqual([b.id, 'c']);
    });

    it('複製保留文字與斐波那契比例', () => {
        const t = addDrawing('TXF', 'text', [anchors[0]!], DEFAULT_DRAWING_STYLE, { text: '支撐' })!;
        const f = addDrawing('TXF', 'fib', anchors, DEFAULT_DRAWING_STYLE, {
            fib: { ...defaultFibOptions(), labelH: 'right', levels: defaultFibLevels().slice(0, 3) },
        })!;
        expect(duplicateDrawing('TXF', t.id, (a) => a)!.text).toBe('支撐');
        const copy = duplicateDrawing('TXF', f.id, (a) => a)!;
        expect(copy.fib!.labelH).toBe('right');
        expect(copy.fib!.levels.map((l) => l.value)).toEqual([0, 0.236, 0.382]);
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

    it('刪除墓碑寫出後永久保留：任何 revision 的同 id 都不能復活', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        removeDrawing('TXF', a.id);
        flushDrawingWrites();
        const tombs = JSON.parse(store.get(TKEY)!);
        expect(tombs.TXF[a.id]).toMatchObject({ revision: expect.any(String), updatedAt: expect.any(Number) });
        // 別的視窗還拿著 a 的舊版本，整份寫回
        store.set(KEY, JSON.stringify({ TXF: [{ ...a }] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
        // 刪除之後的 revision 也不得復活。
        const counter = Number(tombs.TXF[a.id].revision.split(':')[0]) + 1;
        store.set(KEY, JSON.stringify({ TXF: [{ ...a, revision: `${counter.toString().padStart(16, '0')}:remote` }] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
    });

    it('舊墓碑不過期，長期離線視窗也不得復活同 id', () => {
        store.set(TKEY, JSON.stringify({ TXF: { gone: 1, fresh: 10000 } }));
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        flushDrawingWrites();
        expect(Object.keys(JSON.parse(store.get(TKEY)!).TXF)).toEqual(['gone', 'fresh']);
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

describe('線條不透明度', () => {
    it('舊資料沒有 opacity → 1（外觀不變）；壞值夾在 0.1～1', () => {
        const base = { id: 'x', tool: 'horizontal', anchors: [{ time: 1, price: 2 }] };
        expect(sanitizeDrawing({ ...base, style: { color: '#123456' } })!.style.opacity).toBe(1);
        expect(sanitizeDrawing({ ...base, style: { opacity: 0 } })!.style.opacity).toBe(0.1);
        expect(sanitizeDrawing({ ...base, style: { opacity: 'x' } })!.style.opacity).toBe(1);
    });

    it('新物件預設略透明、依主題；使用者挑過的不透明度優先', () => {
        const s = sanitizeSettings({});
        expect(defaultStyleFor(s, 'trend', 'dark').opacity).toBe(DEFAULT_LINE_OPACITY.dark);
        expect(defaultStyleFor(s, 'trend', 'light').opacity).toBe(DEFAULT_LINE_OPACITY.light);
        expect(DEFAULT_LINE_OPACITY.dark).toBeLessThan(1);
        const picked = sanitizeSettings({ lineOpacity: 0.5 });
        expect(defaultStyleFor(picked, 'box', 'dark').opacity).toBe(0.5);
        expect(sanitizeSettings({ lineOpacity: 7 }).lineOpacity).toBe(1);
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

describe('設定 revision：舊關窗日誌不能覆蓋新設定', () => {
    const KEY = 'sj-pro-chart-drawing-settings';
    const cases = [
        ['shareContinuousMonth', false, true],
        ['defaultStyle', { width: 1, dash: 'solid', fillOpacity: 0.1 }, { width: 4, dash: 'dashed', fillOpacity: 0.4 }],
        ['toolColors', { trend: '#111111' }, { trend: '#222222' }],
        ['magnet', true, false],
        ['favorites', ['trend'], ['box']],
        ['groupLast', { lines: 'trend' }, { lines: 'ray' }],
        ['objectListOpen', true, false],
        ['lineOpacity', 0.2, 0.8],
    ] as const;

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each(cases)('無 revision 的晚關日誌只補缺漏欄位，不能覆蓋主資料 %s', (field, old, newer) => {
        store.set(KEY, JSON.stringify({ [field]: newer, settingRevisions: { [field]: '0000000000000001:new' } }));
        store.set('sj-chart-drawings-pending:legacy', JSON.stringify({ at: 9999999999999, settings: { [field]: old } }));
        reloadDrawingSettingsFromStorage();
        expect(getDrawingSettings()[field]).toEqual(newer);
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!)[field]).toEqual(newer);
    });

    it('無 revision 的日誌不能覆蓋同樣無 revision 的主欄位，但可補缺漏', () => {
        store.set(KEY, JSON.stringify({ magnet: false }));
        store.set('sj-chart-drawings-pending:legacy', JSON.stringify({ at: 9999999999999, settings: { magnet: true, favorites: ['box'] } }));
        reloadDrawingSettingsFromStorage();
        expect(getDrawingSettings()).toMatchObject({ magnet: false, favorites: ['box'] });
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!)).toMatchObject({ magnet: false, favorites: ['box'] });
    });

    it('舊格式日誌物件沿用 updatedAt 相容規則，關窗 at 不影響物件勝負', () => {
        const main = { id: 'legacy', tool: 'horizontal', anchors: [{ time: 1, price: 100 }], style: DEFAULT_DRAWING_STYLE, createdAt: 1, updatedAt: 100, name: '主資料' };
        const old = { ...main, updatedAt: 50, name: '舊日誌' };
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [main] }));
        store.set('sj-chart-drawings-pending:legacy', JSON.stringify({ at: 9999999999999, ops: { TXF: { legacy: old, missing: { ...old, id: 'missing' } } } }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => [d.id, d.name])).toEqual([['legacy', '主資料'], ['missing', '舊日誌']]);
        flushDrawingWrites();
        expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF.map((d: { id: string; name: string }) => [d.id, d.name])).toEqual([['legacy', '主資料'], ['missing', '舊日誌']]);
    });

    it.each(cases)('A 留下 %s 舊設定日誌，B 改同欄位後，讀取與合併都保留 B', async (field, old, newer) => {
        addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
        flushDrawingWrites();
        setDrawingSettings({ [field]: old });
        writeDrawingJournal();
        vi.resetModules();
        const other = await import('./chart-drawings');
        other.__setDrawingLocksForTest(null);
        try {
            expect(other.getDrawingSettings()[field]).toEqual(old);
            other.setDrawingSettings({ [field]: newer });
            other.flushDrawingSettings();
            reloadDrawingSettingsFromStorage();
            expect(getDrawingSettings()[field]).toEqual(newer);
            flushDrawingWrites();
            expect(JSON.parse(store.get(KEY)!)[field]).toEqual(newer);
            other.reloadDrawingSettingsFromStorage();
            expect(other.getDrawingSettings()[field]).toEqual(newer);
            expect([...store.keys()].filter((k) => k.startsWith('sj-chart-drawings-pending:'))).toEqual([]);
            if (field === 'shareContinuousMonth') {
                expect(getDrawings(drawingSymbolKey({ code: 'TXFR1', security_type: 'FUT' }, getDrawingSettings().shareContinuousMonth))).toHaveLength(1);
            }
        } finally { other.__resetDrawingsForTest(); }
    });

    it.each(['reload', 'flush', 'journal'] as const)('同 counter 依 writer 全序，較舊的待寫入設定晚到也不能回退（%s）', async (path) => {
        vi.resetModules();
        const other = await import('./chart-drawings');
        other.__setDrawingLocksForTest(null);
        try {
            withDrawingWriter('writer-z', () => setDrawingSettings({ magnet: true }));
            other.withDrawingWriter('writer-a', () => other.setDrawingSettings({ magnet: false }));
            flushDrawingSettings();
            const winner = JSON.parse(store.get(KEY)!).settingRevisions.magnet;
            expect(winner).toBe('0000000000000001:writer-z');
            if (path === 'reload') other.reloadDrawingSettingsFromStorage();
            else if (path === 'journal') {
                other.writeDrawingJournal();
                const raw = [...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1];
                expect(JSON.parse(raw).settingRevisions.magnet).toBe('0000000000000001:writer-a');
                flushDrawingWrites();
            }
            other.flushDrawingSettings();
            expect(JSON.parse(store.get(KEY)!)).toMatchObject({ magnet: true, settingRevisions: { magnet: winner } });
            other.reloadDrawingSettingsFromStorage();
            expect(other.getDrawingSettings().magnet).toBe(true);
        } finally { other.__resetDrawingsForTest(); }
    });

    it.each([false, true])('逐欄位合併所有日誌；名稱、at 與插入順序不影響 revision 勝負（反序 %s）', async (reverse) => {
        store.set(KEY, JSON.stringify({
            shareContinuousMonth: true, magnet: true,
            settingRevisions: { shareContinuousMonth: '0000000000000010:main', magnet: '0000000000000010:main' },
        }));
        const entries = [
            ['sj-chart-drawings-pending:0000-new', { at: 1, settings: { shareContinuousMonth: false, favorites: ['box'] },
                settingRevisions: { shareContinuousMonth: '0000000000000011:new', favorites: '0000000000000012:new' } }],
            ['sj-chart-drawings-pending:9999-old', { at: 999999, settings: { shareContinuousMonth: true, favorites: ['trend'], magnet: false },
                settingRevisions: { shareContinuousMonth: '0000000000000009:old', favorites: '0000000000000009:old', magnet: '0000000000000009:old' } }],
        ] as const;
        for (const [key, value] of reverse ? [...entries].reverse() : entries) store.set(key, JSON.stringify(value));
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        fresh.__setDrawingLocksForTest(null);
        try {
            expect(fresh.getDrawingSettings()).toMatchObject({ shareContinuousMonth: false, magnet: true, favorites: ['box'] });
            fresh.flushDrawingWrites();
            expect(JSON.parse(store.get(KEY)!)).toMatchObject({ shareContinuousMonth: false, magnet: true, favorites: ['box'],
                settingRevisions: { shareContinuousMonth: '0000000000000011:new', magnet: '0000000000000010:main', favorites: '0000000000000012:new' } });
            fresh.withDrawingWriter('next', () => fresh.setDrawingSettings({ magnet: false }));
            fresh.flushDrawingSettings();
            expect(JSON.parse(store.get(KEY)!).settingRevisions.magnet).toBe('0000000000000013:next');
        } finally { fresh.__resetDrawingsForTest(); }
    });

    it('舊格式設定與日誌可載入；新修改升級版本後舊日誌不能回退', async () => {
        store.set(KEY, JSON.stringify({ defaultStyle: { width: 4, dash: 'dashed', fillOpacity: 0.3 } }));
        store.set('sj-chart-drawings-pending:legacy', JSON.stringify({ at: 100, settings: { magnet: true } }));
        reloadDrawingSettingsFromStorage();
        expect(getDrawingSettings()).toMatchObject({ magnet: true, defaultStyle: { width: 4 } });
        withDrawingWriter('upgrade', () => setDrawingSettings({ magnet: false }));
        flushDrawingSettings();
        expect(JSON.parse(store.get(KEY)!).settingRevisions.magnet).toBe('0000000000000001:upgrade');
        flushDrawingWrites();
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        try {
            expect(fresh.getDrawingSettings()).toMatchObject({ magnet: false, defaultStyle: { width: 4 } });
        } finally { fresh.__resetDrawingsForTest(); }
    });

    it.each(['main', 'journal'] as const)('清除可選設定仍保留 revision，舊日誌不能復活 lineOpacity（%s）', async (path) => {
        setDrawingSettings({ lineOpacity: 0.2 });
        writeDrawingJournal();
        setDrawingSettings({ lineOpacity: undefined });
        if (path === 'main') flushDrawingSettings();
        else writeDrawingJournal();
        vi.resetModules();
        const fresh = await import('./chart-drawings');
        fresh.__setDrawingLocksForTest(null);
        try {
            expect(fresh.getDrawingSettings().lineOpacity).toBeUndefined();
            fresh.flushDrawingWrites();
            const persisted = JSON.parse(store.get(KEY)!);
            expect(persisted.lineOpacity).toBeUndefined();
            expect(persisted.settingRevisions.lineOpacity).toBeDefined();
        } finally { fresh.__resetDrawingsForTest(); }
    });
});

describe('關窗日誌也帶圖層順序', () => {
    it('關窗前調整的圖層順序，下一個寫入者照樣套用', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        moveDrawing('TXF', b.id, 0);
        writeDrawingJournal();
        flushDrawingWrites();
        const saved = JSON.parse(store.get('sj-pro-chart-drawings')!).TXF.map((d: { id: string }) => d.id);
        expect(saved).toEqual([b.id, a.id]);
    });
});

describe('本視窗墓碑的歷史操作', () => {
    it.each(['pending', 'persisted', 'journal'] as const)(
        '兩視窗同刪，較小 revision 的 writer 取聯集後，兩邊都不能復原（本地 %s）', async (path) => {
            const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            flushDrawingWrites();
            vi.resetModules();
            const time = vi.spyOn(Date, 'now').mockReturnValue(1);
            const other = await import('./chart-drawings');
            time.mockRestore();
            other.__setDrawingLocksForTest(null);
            const history = new DrawingHistory();
            const otherHistory = new DrawingHistory();
            history.begin('TXF', getDrawingHistoryStart());
            otherHistory.begin('TXF', other.getDrawingHistoryStart());
            const before = getDrawings('TXF');
            removeDrawing('TXF', a.id);
            history.push('TXF', before, getDrawings('TXF'));
            const otherBefore = other.getDrawings('TXF');
            other.removeDrawing('TXF', a.id);
            otherHistory.push('TXF', otherBefore, other.getDrawings('TXF'));
            if (path === 'persisted') flushDrawingWrites();
            if (path === 'journal') writeDrawingJournal();
            other.flushDrawingWrites();
            const ownWriter = drawingRevision(a).split(':')[1]!;
            const ownRevision = `0000000000000002:${ownWriter}`;
            const undo = history.undo()!;
            applyDrawingHistory(undo, (success) => { if (!success) history.clear('TXF'); });
            flushDrawingWrites();
            const tomb = JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF[a.id];
            expect(tomb.writers).toHaveLength(2);
            expect(tomb.writers).toContain(ownWriter);
            expect(tomb.revision).toBe(ownRevision);
            expect(tomb.writers.find((w: string) => w !== ownWriter) < ownWriter).toBe(true);
            const otherUndo = otherHistory.undo()!;
            other.applyDrawingHistory(otherUndo, (success) => { if (!success) otherHistory.clear('TXF'); });
            expect(history.canRedo).toBe(false);
            expect(otherHistory.canRedo).toBe(false);
            expect(getDrawings('TXF')).toEqual([]);
            expect(other.getDrawings('TXF')).toEqual([]);
            expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF ?? []).toEqual([]);
            expect(takeDrawingNotices()).toEqual(['其他視窗修改了畫圖，復原紀錄已清除']);
            other.__resetDrawingsForTest();
        },
    );

    it('新增→復原→重做，另一視窗將還原的物件合併為正常新版本', async () => {
        const history = new DrawingHistory(100);
        history.begin('TXF', getDrawingHistoryStart());
        const before = getDrawings('TXF');
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        history.push('TXF', before, getDrawings('TXF'));
        flushDrawingWrites();
        vi.resetModules();
        const other = await import('./chart-drawings');
        other.__setDrawingLocksForTest(null);
        const undo = history.undo()!;
        applyDrawingHistory(undo, (success) => { if (!success) history.clear('TXF'); });
        expect(getDrawings('TXF')).toEqual([]);
        other.reloadDrawingsFromStorage();
        expect(other.getDrawings('TXF')).toEqual([]);
        const redo = history.redo()!;
        applyDrawingHistory(redo, (success) => { if (!success) history.clear('TXF'); });
        const restored = getDrawings('TXF')[0]!;
        expect(restored.id).toBe(a.id);
        expect(drawingRevision(restored) > drawingRevision(a)).toBe(true);
        expect(JSON.parse(store.get('sj-pro-chart-drawing-tombstones')!).TXF?.[a.id]).toBeUndefined();
        other.reloadDrawingsFromStorage();
        expect(other.getDrawings('TXF')).toEqual([restored]);
        other.updateDrawing('TXF', a.id, { name: '另一視窗正常編輯' });
        other.flushDrawingWrites();
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')[0]!.name).toBe('另一視窗正常編輯');
        expect(takeDrawingNotices()).toEqual([]);
        other.__resetDrawingsForTest();
    });
});

describe('revision 與相對圖層移動的跨視窗合併', () => {
    it.each([false, true])('關窗日誌的舊移動／修改遇到較新版本或墓碑均作廢（墓碑=%s）', (deleted) => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        const old = { ...a, revision: '0000000000000010:old' };
        const remote = { ...a, name: '遠端', revision: '0000000000000100:remote' };
        store.set('sj-chart-drawings-pending:1-old', JSON.stringify({ ops: { TXF: { [a.id]: old } }, order: { TXF: [{ id: a.id, after: b.id, revision: old.revision }] } }));
        store.set('sj-chart-drawings-pending:2-remote', JSON.stringify({ ops: { TXF: { [a.id]: deleted ? { revision: '0000000000000001:remote', updatedAt: 1 } : remote } } }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF').map((d) => d.id)).toEqual(deleted ? [b.id] : [a.id, b.id]);
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!).TXF.map((d: { id: string }) => d.id)).toEqual(deleted ? [b.id] : [a.id, b.id]);
    });

    it('尚未落地的本地墓碑與自己的關窗墓碑均不能被替換清單復活', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        removeDrawing('TXF', a.id);
        replaceDrawings('TXF', [{ ...a, revision: '0000000000000100:stale' }]);
        expect(getDrawings('TXF')).toEqual([]);
        writeDrawingJournal();
        replaceDrawings('TXF', [{ ...a, revision: '0000000000000200:stale' }]);
        expect(getDrawings('TXF')).toEqual([]);
        flushDrawingWrites();
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
    });

    it('圖層移動只在建立時取得 revision，後續編輯不改寫舊移動', () => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        try {
            const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE);
            flushDrawingWrites();
            moveDrawing('TXF', a.id, 1);
            const revision = drawingRevision(getDrawings('TXF')[1]!);
            updateDrawing('TXF', a.id, { name: '移動後改名' });
            expect(drawingRevision(getDrawings('TXF')[1]!)).not.toBe(revision);
            writeDrawingJournal();
            const journal = JSON.parse([...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1]);
            expect(journal.order.TXF[0].revision).toBe(revision);
            reloadDrawingsFromStorage();
            expect(getDrawings('TXF')[1]!.id).toBe(a.id);
        } finally { vi.useRealTimers(); }
    });

    it.each(['update', 'delete'])('規則 R：遠端勝出後舊圖層移動永久作廢（%s）', (kind) => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        try {
            const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            const b = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
            flushDrawingWrites();
            moveDrawing('TXF', a.id, 1);
            const remote = { ...a, name: '遠端', revision: '0000000000000100:remote' };
            store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote, b] }));
            if (kind === 'delete') store.set('sj-pro-chart-drawing-tombstones', JSON.stringify({ TXF: { [a.id]: { revision: '0000000000000001:remote', updatedAt: 1 } } }));
            reloadDrawingsFromStorage();
            updateDrawing('TXF', a.id, { name: '新本地編輯' });
            flushDrawingWrites();
            expect(getDrawings('TXF').map((d) => d.id)).toEqual(kind === 'delete' ? [b.id] : [a.id, b.id]);
            replaceDrawings('TXF', [remote, b]);
            flushDrawingWrites();
            if (kind === 'delete') expect(getDrawings('TXF').map((d) => d.id)).toEqual([b.id]);
        } finally { vi.useRealTimers(); }
    });

    const KEY = 'sj-pro-chart-drawings';
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
    afterEach(() => vi.useRealTimers());

    it.each(['flush', 'reload', 'journal'] as const)('兩視窗各移不同物件，兩個移動都保留（%s）', async (path) => {
        const [a, b, c, d] = Array.from({ length: 4 }, () => addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!);
        flushDrawingWrites();
        vi.resetModules();
        const other = await import('./chart-drawings');
        other.__setDrawingLocksForTest(null);
        // 初始 A B C D；本視窗 A 到頂，另一視窗 C 到底。
        moveDrawing('TXF', a!.id, 3);
        other.moveDrawing('TXF', c!.id, 0);
        other.flushDrawingWrites();
        const expected = [c!.id, b!.id, d!.id, a!.id];
        if (path === 'reload') {
            reloadDrawingsFromStorage();
            expect(getDrawings('TXF').map((x) => x.id)).toEqual(expected);
        } else if (path === 'journal') {
            writeDrawingJournal();
            const name = [...store.keys()].find((k) => k.startsWith('sj-chart-drawings-pending:'))!;
            const journal = JSON.parse(store.get(name)!);
            expect(journal.order.TXF).toEqual([{ id: a!.id, after: d!.id, revision: expect.any(String) }]);
        }
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!).TXF.map((x: { id: string }) => x.id)).toEqual(expected);
        other.reloadDrawingsFromStorage();
        expect(other.getDrawings('TXF').map((x) => x.id)).toEqual(expected);
        other.__resetDrawingsForTest();
    });

    it('同 counter 的兩個 writer 仍有全序，後落地的較小 revision 不會蓋掉較大 revision', async () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        vi.resetModules();
        const other = await import('./chart-drawings');
        other.__setDrawingLocksForTest(null);
        updateDrawing('TXF', a.id, { name: 'A' });
        other.updateDrawing('TXF', a.id, { name: 'B' });
        const mine = getDrawings('TXF')[0]!;
        const theirs = other.getDrawings('TXF')[0]!;
        expect(drawingRevision(mine).split(':')[0]).toBe(drawingRevision(theirs).split(':')[0]);
        expect(drawingRevision(mine)).not.toBe(drawingRevision(theirs));
        const winner = drawingRevision(mine) > drawingRevision(theirs) ? mine : theirs;
        const first = winner === mine ? flushDrawingWrites : other.flushDrawingWrites;
        const second = winner === mine ? other.flushDrawingWrites : flushDrawingWrites;
        first();
        second();
        expect(JSON.parse(store.get(KEY)!).TXF[0]).toMatchObject({ name: winner.name, revision: winner.revision });
        other.__resetDrawingsForTest();
    });

    it('同一時間的遠端更新由 revision 決定，時鐘倒退也不影響後續版本', () => {
        const a = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        const remote = { ...a, name: '遠端', revision: '0000000000000100:remote' };
        store.set(KEY, JSON.stringify({ TXF: [remote] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')[0]).toMatchObject(remote);
        vi.setSystemTime(1);
        updateDrawing('TXF', a.id, { name: '本地新操作' });
        expect(drawingRevision(getDrawings('TXF')[0]!) > remote.revision).toBe(true);
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!).TXF[0].name).toBe('本地新操作');
    });

    it('節流期間多次移動同物件，依操作順序重放，保留其他移動', () => {
        const [a, b, c, d] = Array.from({ length: 4 }, () => addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!);
        flushDrawingWrites();
        moveDrawing('TXF', a!.id, 3);
        moveDrawing('TXF', b!.id, 3);
        moveDrawing('TXF', a!.id, 0);
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!).TXF.map((x: { id: string }) => x.id)).toEqual([a!.id, c!.id, d!.id, b!.id]);
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

describe('規則 R：墓碑刪除任何版本、合併不默默丟其他物件', () => {
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

    it('墓碑否決 pending 與主項目裡較新的同 id 版本', () => {
        const x = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!; // 本視窗待寫的修改（較舊）
        const deletedAt = x.updatedAt + 10;
        store.set(TKEY, JSON.stringify({ TXF: { [x.id]: deletedAt } }));
        // 別的視窗在刪除之後又重建了同 id 的物件（例如復原）
        store.set(KEY, JSON.stringify({ TXF: [obj(x.id, deletedAt + 10)] }));
        reloadDrawingsFromStorage();
        expect(getDrawings('TXF')).toEqual([]);
        const fresh = addDrawing('TXF', 'trend', anchors, DEFAULT_DRAWING_STYLE)!;
        flushDrawingWrites();
        expect(JSON.parse(store.get(KEY)!).TXF.map((d: { id: string }) => d.id)).toEqual([fresh.id]);
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
