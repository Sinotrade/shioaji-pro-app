import { describe, expect, it } from 'vitest';
import { applyChanges, DrawingHistory, HISTORY_LIMIT } from './chart-drawing-history';
import { DEFAULT_DRAWING_STYLE, type Drawing } from './chart-drawings';

const mk = (id: string, price = 100, extra: Partial<Drawing> = {}): Drawing => ({
    id,
    tool: 'horizontal',
    anchors: [{ time: 1, price }],
    style: DEFAULT_DRAWING_STYLE,
    locked: false,
    hidden: false,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
});

// 把 undo()/redo() 回傳的步驟套到 current
const run = (current: Drawing[], step: ReturnType<DrawingHistory['undo']> | ReturnType<DrawingHistory['redo']>) =>
    step ? applyChanges(current, step.changes, step.side, step.order) : current;
const ids = (l: Drawing[]) => l.map((d) => d.id);

describe('只退回這一步動到的物件', () => {
    it('復原新增＝移除那個物件，其他本地操作新增的物件保留', () => {
        const h = new DrawingHistory();
        const a = mk('a');
        const b = mk('b');
        h.push('TXF', [a], [a, b]);
        expect(ids(run([a, b, mk('z')], h.undo()))).toEqual(['a', 'z']);
    });

    it('復原修改＝換回修改前的版本，其他物件的後續修改不動', () => {
        const h = new DrawingHistory();
        const a1 = mk('a', 100);
        const a2 = mk('a', 110);
        const c1 = mk('c', 1);
        const c2 = mk('c', 2); // 之後另一步改的
        h.push('TXF', [a1, c1], [a2, c1]);
        expect(run([a2, c2], h.undo())).toEqual([a1, c2]);
    });

    it('只復原內容時，不移動物件而改到鄰居的圖層', () => {
        const h = new DrawingHistory();
        const [a, b, c] = [mk('a'), mk('b'), mk('c')];
        const renamed = { ...a, name: '本地' };
        h.push('TXF', [a, b, c], [renamed, b, c]);
        expect(ids(run([c, renamed, b], h.undo()))).toEqual(['c', 'a', 'b']);
        h.push('TXF', [a, b, c], [c, renamed, b], undefined, 1000, ['a']);
        expect(ids(run([c, renamed, b], h.undo()))).toEqual(['c', 'a', 'b']);
    });

    it('拖曳／文字這類跨時間的操作只記指定的物件：期間其他本地操作的改動不會被復原', () => {
        const h = new DrawingHistory();
        const a1 = mk('a', 100);
        const a2 = mk('a', 120);
        const theirs = mk('z'); // 拖曳進行中另一步新增的
        h.push('TXF', [a1], [a2, theirs], undefined, 1000, ['a']);
        expect(ids(run([a2, theirs], h.undo()))).toEqual(['a', 'z']);
        expect(h.undo()).toBeNull(); // 只有一步
    });

    it('復原刪除放回原本的圖層位置', () => {
        const h = new DrawingHistory();
        const [a, b, c] = [mk('a'), mk('b'), mk('c')];
        h.push('TXF', [a, b, c], [a, c]);
        expect(ids(run([a, c], h.undo()))).toEqual(['a', 'b', 'c']);
        // 最底層的物件刪掉再復原，仍在最底層
        const h2 = new DrawingHistory();
        h2.push('TXF', [a, b, c], [b, c]);
        expect(ids(run([b, c], h2.undo()))).toEqual(['a', 'b', 'c']);
    });

    it('調整圖層可復原，其他本地操作新增的物件位置不動', () => {
        const h = new DrawingHistory();
        const [a, b, c, z] = [mk('a'), mk('b'), mk('c'), mk('z')];
        h.push('TXF', [a, b, c], [{ ...c, updatedAt: 1 }, a, b]);
        expect(ids(run([c, a, b, z], h.undo()))).toEqual(['a', 'b', 'c', 'z']);
    });

    it('刪除或移動只記實際改動的物件，不記前驅改變的鄰居', () => {
        const [a, b, c] = [mk('a'), mk('b'), mk('c')];
        const h = new DrawingHistory();
        h.push('TXF', [a, b, c], [b, c]);
        expect(h.undo()!.changes.map((change) => change.id)).toEqual(['a']);
        h.push('TXF', [a, b, c], [{ ...c, updatedAt: 1 }, a, b]);
        expect(h.undo()!.changes.map((change) => change.id)).toEqual(['c']);
    });
});

describe('DrawingHistory', () => {
    it('清除整個商品的 undo／redo，也使等待中的步驟失效，保留其他商品', () => {
        const h = new DrawingHistory();
        const a = mk('a');
        h.push('OTHER', [a], [{ ...a, name: '另一商品' }]);
        h.push('TXF', [a], [{ ...a, name: '第一步' }]);
        h.push('TXF', [a], [{ ...a, hidden: true }]);
        const queued = h.undo()!;
        expect(h.clear('TXF')).toBe(true);
        expect(queued.changes).toEqual([]);
        expect(h.canRedo).toBe(false);
        expect(h.undo()!.key).toBe('OTHER');
        expect(h.canUndo).toBe(false);
    });
    it('復原後可重做；新的一步清掉重做', () => {
        const h = new DrawingHistory();
        const s0: Drawing[] = [];
        const s1 = [mk('a')];
        h.push('TXF', s0, s1);
        expect(h.canUndo).toBe(true);
        expect(run(s1, h.undo())).toEqual([]);
        expect(h.canRedo).toBe(true);
        expect(run([], h.redo())).toEqual(s1);
        h.undo();
        h.push('TXF', s0, [mk('b')]);
        expect(h.canRedo).toBe(false);
    });

    it('同標籤的連續操作（拉滑桿）在短時間內合併成一步', () => {
        const h = new DrawingHistory();
        const s0 = [mk('a', 1)];
        const s1 = [mk('a', 2)];
        const s2 = [mk('a', 3)];
        h.push('TXF', s0, s1, 'style:fillOpacity', 1000);
        h.push('TXF', s1, s2, 'style:fillOpacity', 1200);
        expect(run(s2, h.undo())).toEqual(s0);
        expect(h.canUndo).toBe(false);
        // 隔太久就不合併
        h.push('TXF', s0, s1, 'x', 1000);
        h.push('TXF', s1, s2, 'x', 5000);
        h.undo();
        expect(h.canUndo).toBe(true);
    });

    it('紀錄有上限，最舊的丟掉', () => {
        const h = new DrawingHistory();
        for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.push('TXF', [mk(`a${i}`)], [mk(`b${i}`)]);
        let n = 0;
        while (h.undo()) n++;
        expect(n).toBe(HISTORY_LIMIT);
    });

    it('沒有變化（同一個清單）不記', () => {
        const h = new DrawingHistory();
        const s = [mk('a')];
        h.push('TXF', s, s);
        expect(h.canUndo).toBe(false);
    });
});
