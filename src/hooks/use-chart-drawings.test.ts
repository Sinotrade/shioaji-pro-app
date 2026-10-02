import { createElement, useLayoutEffect, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartHasFocus,
    inOrderLabelArea,
    orderLineMayTakePointer,
    toolShortcutOf,
    undoKeyOf,
    useChartDrawings,
    type ChartDrawingsApi,
} from './use-chart-drawings';
import {
    __resetDrawingsForTest,
    __setDrawingLocksForTest,
    addDrawing,
    DEFAULT_DRAWING_STYLE,
    getDrawingSettings,
    getDrawings,
    flushDrawingWrites,
    reloadDrawingsFromStorage,
    takeDrawingNotices,
    TOOL_DEFAULT_COLORS,
    writeDrawingJournal,
    type Drawing,
} from '../lib/chart-drawings';
import type { ContractBase } from '../lib/types/contract';
import { useHotkeys } from './use-hotkeys';
import { AXIS_LABEL_H, axisLabelBox } from '../lib/chart-drawing-layer';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { drawingRevision } from '../lib/chart-drawing-revision';
import { ChartDrawingOverlays } from '../components/chart-drawing-tools';

const remoteRevision = (d: Drawing) => `${(Number(drawingRevision(d).split(':')[0]) + 100).toString().padStart(16, '0')}:remote`;

// Esc×2 全部刪單的整合測試：開啟風控設定、攔下刪單
const hk = vi.hoisted(() => ({ cancelAll: vi.fn(async () => {}), notify: vi.fn() }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: hk.cancelAll, notify: hk.notify }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: true }) }));

// 圖表相關的 ref 一律給 null：本檔只驗模式互斥與對外操作，不碰 canvas。
// hook 的滑鼠 effect 在 hostRef 為 null 時直接跳出，鍵盤 effect 需要
// window，所以補一個最小的替身。
const store = new Map<string, string>();
const roots: ReactTestRenderer[] = [];

const contract = { code: 'TXFR1', security_type: 'FUT' } as ContractBase;

function Probe({
    receive,
    tradeArmed,
    onEnterDrawingMode,
    host,
}: {
    receive: (v: ChartDrawingsApi) => void;
    tradeArmed: boolean;
    onEnterDrawingMode: () => void;
    host?: unknown;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef(null);
    const seriesRef = useRef(null);
    (hostRef as { current: unknown }).current = host ?? null;
    receive(
        useChartDrawings({
            contract,
            hostRef,
            chartRef,
            seriesRef,
            getTimes: () => [],
            tradeArmed,
            onEnterDrawingMode,
        }),
    );
    return null;
}

async function mount(props: Parameters<typeof Probe>[0]) {
    let root!: ReactTestRenderer;
    await act(async () => {
        root = create(createElement(Probe, props));
    });
    roots.push(root);
    return root;
}

beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        get length() { return store.size; },
        key: (i: number) => [...store.keys()][i] ?? null,
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    __resetDrawingsForTest();
});

afterEach(async () => {
    await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
    });
    vi.unstubAllGlobals();
});

describe('跨視窗改動後的復原／重做', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
    afterEach(() => vi.useRealTimers());
    const KEY = 'sj-pro-chart-drawings';
    const TKEY = 'sj-pro-chart-drawing-tombstones';
    async function setup() {
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        let a!: Drawing;
        let b!: Drawing;
        await act(async () => {
            a = addDrawing('TXF', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!;
            b = addDrawing('TXF', 'horizontal', [{ time: 1, price: 200 }], DEFAULT_DRAWING_STYLE)!;
            flushDrawingWrites();
        });
        return { api: () => api, a, b };
    }
    const saved = (): Drawing[] => JSON.parse(store.get(KEY)!).TXF ?? [];

    it.each(['pending', 'persisted', 'journal'] as const)('同視窗另一張圖刪除後，復原不可撤銷對方墓碑（%s）', async (path) => {
        const { api: a, a: drawing } = await setup();
        let b!: ChartDrawingsApi;
        await mount({ receive: (v) => (b = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        await act(async () => a().rename(drawing.id, 'A 修改'));
        await act(async () => {
            b.removeOne(drawing.id);
            if (path === 'persisted') flushDrawingWrites();
            if (path === 'journal') writeDrawingJournal();
        });
        expect(a().canUndo).toBe(false);
        expect(b.canUndo).toBe(true);
        await act(async () => a().undo());
        await act(async () => flushDrawingWrites());
        expect(saved().some((d) => d.id === drawing.id)).toBe(false);
        await act(async () => b.undo());
        expect(saved().some((d) => d.id === drawing.id)).toBe(true);
    });

    it.each(['update', 'move', 'delete'] as const)('另一圖表 %s 清空 undo 與 redo，writer 包含不同圖表實例 id', async (operation) => {
        const { api: a, a: first, b: second } = await setup();
        let b!: ChartDrawingsApi;
        await mount({ receive: (v) => (b = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        await act(async () => b.rename(second.id, 'B'));
        const writerB = drawingRevision(getDrawings('TXF')[1]!).split(':')[1]!;
        await act(async () => a().rename(first.id, 'A1'));
        const writerA = drawingRevision(getDrawings('TXF')[0]!).split(':')[1]!;
        expect(writerA).not.toBe(writerB);
        expect(writerA.replace(/-chart-\d+$/, '')).toBe(writerB.replace(/-chart-\d+$/, ''));
        await act(async () => a().setHidden(first.id, true));
        await act(async () => a().undo());
        expect(a().canUndo).toBe(true);
        expect(a().canRedo).toBe(true);
        await act(async () => {
            if (operation === 'update') b.rename(second.id, 'B 更新');
            if (operation === 'move') b.reorder(second.id, 0);
            if (operation === 'delete') b.removeOne(second.id);
        });
        expect(a().canUndo).toBe(false);
        expect(a().canRedo).toBe(false);
    });

    it.each(['pending', 'persisted', 'journal'] as const)('本地刪除→復原原子地撤銷自己的墓碑並持久化（%s）', async (path) => {
        const { api, a, b } = await setup();
        await act(async () => {
            api().removeOne(a.id);
            if (path === 'persisted') flushDrawingWrites();
            if (path === 'journal') writeDrawingJournal();
        });
        const queue: (() => unknown)[] = [];
        __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
        const before = store.get(KEY);
        const tombsBefore = store.get(TKEY);
        await act(async () => api().undo());
        expect(store.get(KEY)).toBe(before);
        expect(store.get(TKEY)).toBe(tombsBefore);
        await act(async () => { queue.shift()!(); });
        expect(saved().map((d) => d.id)).toEqual([a.id, b.id]);
        expect(saved()[0]).toMatchObject({ anchors: a.anchors, style: a.style });
        expect(drawingRevision(saved()[0]!) > drawingRevision(a)).toBe(true);
        expect(JSON.parse(store.get(TKEY)!).TXF?.[a.id]).toBeUndefined();
        expect(api().drawings).toEqual(saved());
        expect(takeDrawingNotices()).toEqual([]);
        expect(queue).toHaveLength(0);
    });

    it('清除全部→一次復原所有仍有效的本地墓碑，亦可重做再復原', async () => {
        const { api, a, b } = await setup();
        await act(async () => { api().clearAll(); flushDrawingWrites(); });
        expect(saved()).toEqual([]);
        await act(async () => api().undo());
        expect(saved().map((d) => d.id)).toEqual([a.id, b.id]);
        await act(async () => api().redo());
        expect(saved()).toEqual([]);
        await act(async () => api().undo());
        expect(saved().map((d) => d.id)).toEqual([a.id, b.id]);
        expect(takeDrawingNotices()).toEqual([]);
    });

    it.each(['add', 'update', 'delete', 'move', 'journal-update', 'journal-delete'] as const)(
        '同商品遠端 %s 清空整份 undo／redo，notice 只提示一次', async (kind) => {
            const { api, a, b } = await setup();
            await act(async () => api().rename(a.id, '第一步'));
            await act(async () => api().setHidden(a.id, true));
            await act(async () => api().undo());
            expect(api().canUndo).toBe(true);
            expect(api().canRedo).toBe(true);
            const remote = { ...b, name: '遠端', revision: remoteRevision(b) };
            if (kind.startsWith('journal')) {
                // 自己的 pagehide 日誌較新，仍須看到主項目／別份日誌的遠端寫入。
                await act(async () => { api().rename(b.id, '本地較新'); writeDrawingJournal(); });
                const op = kind === 'journal-delete'
                    ? { revision: '0000000000000001:remote', updatedAt: 1, writers: ['remote'] }
                    : { ...remote, revision: '0000000000000001:remote' };
                store.set('sj-chart-drawings-pending:remote', JSON.stringify({ ops: { TXF: { [b.id]: op } } }));
            } else if (kind === 'delete') {
                store.set(TKEY, JSON.stringify({ TXF: { [b.id]: { revision: '0000000000000001:remote', updatedAt: 1, writers: ['remote'] } } }));
            } else {
                const list = saved();
                store.set(KEY, JSON.stringify({ TXF: kind === 'add' ? [...list, { ...remote, id: 'remote-new' }]
                    : kind === 'move' ? [remote, list[0]] : [list[0], remote] }));
            }
            await act(async () => reloadDrawingsFromStorage());
            expect(api().canUndo).toBe(false);
            expect(api().canRedo).toBe(false);
            const current = api().drawings;
            await act(async () => { api().undo(); api().redo(); reloadDrawingsFromStorage(); });
            expect(api().drawings).toEqual(current);
            expect(takeDrawingNotices()).toEqual(['其他視窗修改了畫圖，復原紀錄已清除']);
            await act(async () => reloadDrawingsFromStorage());
            expect(takeDrawingNotices()).toEqual([]);
        },
    );

    it('其他商品的遠端寫入保留本商品歷史', async () => {
        const { api, a, b } = await setup();
        await act(async () => api().rename(a.id, '本地'));
        store.set(KEY, JSON.stringify({ TXF: saved(), OTHER: [{ ...b, revision: remoteRevision(b) }] }));
        await act(async () => reloadDrawingsFromStorage());
        expect(api().canUndo).toBe(true);
        await act(async () => api().undo());
        expect(api().drawings[0]!.name).toBeUndefined();
        expect(takeDrawingNotices()).toEqual([]);
    });

    it.each(['pending', 'persisted', 'journal'] as const)(
        '兩視窗同刪，較小 revision 的遠端墓碑仍勝出（本地 %s）', async (path) => {
            const { api, a, b } = await setup();
            await act(async () => {
                api().removeOne(a.id);
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
            });
            const ownRevision = path === 'persisted' ? JSON.parse(store.get(TKEY)!).TXF[a.id].revision
                : path === 'journal' ? JSON.parse([...store.entries()].find(([k]) => k.startsWith('sj-chart-drawings-pending:'))![1]).ops.TXF[a.id].revision
                : null;
            const writers = path === 'persisted' ? ['remote', ownRevision!.split(':')[1]] : ['remote'];
            store.set(TKEY, JSON.stringify({ TXF: { [a.id]: { revision: path === 'persisted' ? ownRevision : '0000000000000001:remote', updatedAt: 1, writers } } }));
            await act(async () => { flushDrawingWrites(); api().undo(); });
            const tomb = JSON.parse(store.get(TKEY)!).TXF[a.id];
            if (ownRevision) expect(tomb.revision).toBe(ownRevision);
            expect(Number(tomb.revision.split(':')[0])).toBe(Number(drawingRevision(b).split(':')[0]) + 1);
            expect(tomb.revision.split(':')[1]).toMatch(/-chart-\d+$/);
            expect(tomb.writers).toEqual(expect.arrayContaining(['remote', tomb.revision.split(':')[1]]));
            expect(api().drawings.some((d) => d.id === a.id)).toBe(false);
            expect(api().canUndo).toBe(false);
            expect(api().canRedo).toBe(false);
            expect(takeDrawingNotices()).toEqual(['其他視窗修改了畫圖，復原紀錄已清除']);
        },
    );

    it.each(['undo', 'redo'] as const)(
        '等鎖時本地刪除，排隊的 %s 整步作廢且保留新刪除歷史', async (action) => {
            const { api, a } = await setup();
            await act(async () => { api().rename(a.id, '本地'); flushDrawingWrites(); });
            if (action === 'redo') await act(async () => api().undo());
            const queue: (() => unknown)[] = [];
            __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
            await act(async () => api()[action]());
            await act(async () => api().removeOne(a.id));
            await act(async () => { queue.shift()!(); });
            expect(getDrawings('TXF').some((d) => d.id === a.id)).toBe(false);
            expect(api().canUndo).toBe(true);
            expect(api().canRedo).toBe(false);
            __setDrawingLocksForTest(null);
            await act(async () => api().undo());
            expect(getDrawings('TXF').find((d) => d.id === a.id)?.name).toBe(action === 'undo' ? '本地' : undefined);
        },
    );

    it('同步操作才讀到同物件遠端修改，不可建立跨越遠端版本的歷史', async () => {
        const { api, a, b } = await setup();
        const remote = { ...a, name: '遠端版本', revision: remoteRevision(a) };
        store.set(KEY, JSON.stringify({ TXF: [remote, b] }));
        await act(async () => api().setHidden(a.id, true));
        await act(async () => api().undo());
        expect(getDrawings('TXF').find((d) => d.id === a.id)?.hidden).toBe(true);
        expect(api().canUndo).toBe(false);
        expect(api().canRedo).toBe(false);
    });

    it.each(['undo', 'redo'] as const)(
        '等鎖時本地提交文字，排隊的 %s 不可覆蓋新文字', async (action) => {
            const { api } = await setup();
            let text!: Drawing;
            await act(async () => {
                text = addDrawing('TXF', 'text', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
            });
            await act(async () => api().editText(text.id));
            await act(async () => { api().commitText('第一版'); flushDrawingWrites(); });
            if (action === 'redo') await act(async () => api().undo());
            const queue: (() => unknown)[] = [];
            __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
            await act(async () => api()[action]());
            await act(async () => api().editText(text.id));
            await act(async () => api().commitText('新文字'));
            await act(async () => { queue.shift()!(); });
            expect(getDrawings('TXF').find((d) => d.id === text.id)?.text).toBe('新文字');
            expect(api().canUndo).toBe(true);
            expect(api().canRedo).toBe(false);
        },
    );

    it.each(['undo', 'redo'] as const)('等鎖時開始文字編輯即作廢 %s，不必等到寫入', async (action) => {
        const { api, a } = await setup();
        let text!: Drawing;
        await act(async () => {
            text = addDrawing('TXF', 'text', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
            api().rename(a.id, '本地');
            flushDrawingWrites();
        });
        if (action === 'redo') await act(async () => api().undo());
        const queue: (() => unknown)[] = [];
        __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
        await act(async () => api()[action]());
        await act(async () => api().editText(text.id));
        await act(async () => api().updateTextDraft('未提交'));
        await act(async () => { queue.shift()!(); });
        expect(getDrawings('TXF').find((d) => d.id === a.id)?.name).toBe(action === 'undo' ? '本地' : undefined);
        expect(api().editingTextId).toBe(text.id);
        expect(api().canUndo).toBe(false);
        expect(api().canRedo).toBe(false);
        await act(async () => api().commitText('未提交'));
        expect(getDrawings('TXF').find((d) => d.id === text.id)?.text).toBe('未提交');
        expect(api().canUndo).toBe(true);
    });

    it.each(['undo', 'redo'] as const)('等鎖時連續新操作，作廢 %s 後仍可逐步復原新歷史', async (action) => {
        const { api, a, b } = await setup();
        await act(async () => api().rename(b.id, '前一步'));
        await act(async () => { api().rename(a.id, '本地'); flushDrawingWrites(); });
        if (action === 'redo') await act(async () => api().undo());
        const queue: (() => unknown)[] = [];
        __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
        await act(async () => api()[action]());
        await act(async () => api().removeOne(a.id));
        await act(async () => api().rename(b.id, '新的改名'));
        await act(async () => { queue.shift()!(); });
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([b.id]);
        __setDrawingLocksForTest(null);
        await act(async () => api().undo());
        expect(getDrawings('TXF')[0]!.name).toBe('前一步');
        expect(api().canUndo).toBe(true);
        await act(async () => api().undo());
        expect(getDrawings('TXF').map((d) => d.id)).toEqual([a.id, b.id]);
        expect(api().canUndo).toBe(true);
        await act(async () => api().undo());
        expect(getDrawings('TXF').find((d) => d.id === b.id)?.name).toBeUndefined();
        expect(api().canUndo).toBe(false);
        expect(takeDrawingNotices()).toEqual([]);
    });

    it.each(['undo', 'redo'] as const)(
        '等鎖時另一物件先被遠端改動，%s 在鎖內重讀後整份作廢', async (action) => {
            const { api, a, b } = await setup();
            await act(async () => { api().rename(a.id, '本地'); flushDrawingWrites(); });
            if (action === 'redo') await act(async () => api().undo());
            const queue: (() => unknown)[] = [];
            __setDrawingLocksForTest({ request: (_name, cb) => { queue.push(cb); return Promise.resolve(); } });
            const before = store.get(KEY);
            await act(async () => api()[action]());
            expect(store.get(KEY)).toBe(before);
            const remote = { ...b, name: 'B 先落地', revision: remoteRevision(b) };
            store.set(KEY, JSON.stringify({ TXF: [saved()[0], remote] }));
            await act(async () => { queue.shift()!(); });
            expect(saved()[0]!.name).toBe(action === 'undo' ? '本地' : undefined);
            expect(api().drawings[1]).toEqual(remote);
            expect(api().canUndo).toBe(false);
            expect(api().canRedo).toBe(false);
            expect(takeDrawingNotices()).toEqual(['其他視窗修改了畫圖，復原紀錄已清除']);
            expect(queue).toHaveLength(0);
        },
    );

    it('自己的 pagehide 日誌不能遮蔽主項目中的遠端墓碑', async () => {
        const { api, a, b } = await setup();
        await act(async () => { api().removeOne(a.id); writeDrawingJournal(); });
        store.set(TKEY, JSON.stringify({ TXF: { [a.id]: { revision: '0000000000000001:remote', updatedAt: 1, writers: ['remote'] } } }));
        await act(async () => api().undo());
        expect(api().drawings.map((d) => d.id)).toEqual([b.id]);
        expect(api().canRedo).toBe(false);
        expect(takeDrawingNotices()).toEqual(['其他視窗修改了畫圖，復原紀錄已清除']);
    });

    it('遠端同步後的新歷史可復原，不能回到遠端修改前', async () => {
        const { api, a, b } = await setup();
        await act(async () => api().rename(a.id, '本地'));
        const remote = { ...a, name: '遠端', revision: remoteRevision(a) };
        store.set(KEY, JSON.stringify({ TXF: [remote, b] }));
        await act(async () => reloadDrawingsFromStorage());
        await act(async () => api().setHidden(a.id, true));
        await act(async () => api().undo());
        expect(api().drawings[0]).toMatchObject({ name: '遠端', hidden: false });
        expect(api().canUndo).toBe(false);
    });

    it('本視窗刪除可復原並連續復原／重做先前操作', async () => {
        const { api, a, b } = await setup();
        await act(async () => api().rename(a.id, '第一步'));
        await act(async () => api().setHidden(a.id, true));
        await act(async () => api().removeOne(a.id));
        await act(async () => api().undo());
        await act(async () => api().undo());
        await act(async () => api().undo());
        expect(api().drawings[0]).toMatchObject({ hidden: false });
        expect(api().drawings[0]!.name).toBeUndefined();
        await act(async () => api().redo());
        await act(async () => api().redo());
        expect(api().drawings.map((d) => d.id)).toEqual([a.id, b.id]);
        expect(api().drawings[0]).toMatchObject({ name: '第一步', hidden: true });
        expect(takeDrawingNotices()).toEqual([]);
    });

    it('圖層移動可復原／重做，鄰居不取得新 revision', async () => {
        const { api, a, b } = await setup();
        await act(async () => api().reorder(b.id, 0));
        await act(async () => api().undo());
        expect(api().drawings.map((d) => d.id)).toEqual([a.id, b.id]);
        expect(drawingRevision(api().drawings[0]!)).toBe(drawingRevision(a));
        await act(async () => api().redo());
        expect(api().drawings.map((d) => d.id)).toEqual([b.id, a.id]);
        expect(drawingRevision(api().drawings[1]!)).toBe(drawingRevision(a));
    });
});

describe('交易模式與畫圖模式一次只有一種', () => {
    it.each([false, true])('武裝交易後從物件列表選取（多選=%s），同步解除交易並阻擋下單', async (additive) => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: true, onEnterDrawingMode });
        const d = addDrawing('TXF', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {
            api.select(d.id, additive);
            expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
            expect(api.drawingBusy()).toBe(true); // React 尚未 render 的同一事件
        });
        expect(api.selected?.id).toBe(d.id);
    });

    it.each(['undo', 'redo'] as const)('武裝交易後進入畫圖歷史 %s，也解除交易', async (operation) => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        const props = { receive: (v: ChartDrawingsApi) => (api = v), onEnterDrawingMode };
        const root = await mount({ ...props, tradeArmed: false });
        const d = addDrawing('TXF', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => api.rename(d.id, '新名稱'));
        if (operation === 'redo') await act(async () => api.undo());
        await act(async () => root.update(createElement(Probe, { ...props, tradeArmed: true })));
        onEnterDrawingMode.mockClear();
        await act(async () => api[operation]());
        expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
        expect(api.drawings[0]?.name).toBe(operation === 'redo' ? '新名稱' : undefined);
    });

    it('選畫圖工具會請頂端解除交易模式', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode });
        await act(async () => {
            api.setTool('trend');
            expect(api.drawingBusy()).toBe(true);
        });
        expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
        expect(api.tool).toBe('trend');
    });

    it('按「游標」同樣解除交易模式 — 那是從交易模式脫身的方式之一', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode });
        await act(async () => api.setTool(null));
        expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
        expect(api.tool).toBeNull();
    });

    it('頂端武裝交易模式時，已選的畫圖工具自動收起', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        const root = await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode,
        });
        await act(async () => api.setTool('box'));
        expect(api.tool).toBe('box');
        await act(async () => {
            root.update(
                createElement(Probe, {
                    receive: (v: ChartDrawingsApi) => (api = v),
                    tradeArmed: true,
                    onEnterDrawingMode,
                }),
            );
        });
        expect(api.tool).toBeNull();
    });

    it('交易模式收起畫圖工具時不會反過來再解除交易模式（避免互踢）', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        const root = await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode,
        });
        await act(async () => api.setTool('ray'));
        onEnterDrawingMode.mockClear();
        await act(async () => {
            root.update(
                createElement(Probe, {
                    receive: (v: ChartDrawingsApi) => (api = v),
                    tradeArmed: true,
                    onEnterDrawingMode,
                }),
            );
        });
        expect(api.tool).toBeNull();
        expect(onEnterDrawingMode).not.toHaveBeenCalled();
    });
});

describe('鎖定只擋移動，不擋選取與編輯', () => {
    async function mountWithLocked() {
        let api!: ChartDrawingsApi;
        await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode: vi.fn(),
        });
        const created = addDrawing(
            api.symbolKey,
            'trend',
            [
                { time: 1000, price: 25000 },
                { time: 2000, price: 25100 },
            ],
            DEFAULT_DRAWING_STYLE,
        )!;
        await act(async () => api.select(created.id));
        await act(async () => api.toggleLock());
        return { api: () => api, id: created.id };
    }

    it('鎖定後仍選得到，且能解鎖 — 不會永遠黏在圖上', async () => {
        const { api, id } = await mountWithLocked();
        expect(api().selected?.locked).toBe(true);
        await act(async () => api().toggleLock());
        expect(api().selected?.id).toBe(id);
        expect(api().selected?.locked).toBe(false);
    });

    it('鎖定中仍可改樣式 — 鎖的是位置，不是顏色', async () => {
        const { api } = await mountWithLocked();
        await act(async () => api().applyStyle({ color: '#ef5350', width: 4 }));
        expect(api().selected?.locked).toBe(true);
        expect(api().selected?.style.color).toBe('#ef5350');
        expect(api().selected?.style.width).toBe(4);
    });

    it('鎖定中不可刪除也不可改價，解鎖後才可以', async () => {
        const { api, id } = await mountWithLocked();
        await act(async () => api().setSelectedPrice(24000));
        await act(async () => api().remove());
        expect(api().drawings.map((d) => d.id)).toEqual([id]);
        expect(api().selected?.anchors[0]!.price).toBe(25000);

        await act(async () => api().toggleLock());
        await act(async () => api().remove());
        expect(api().drawings).toEqual([]);
    });

    it('隱藏的物件不影響鎖定語意，兩者各自獨立', async () => {
        const { api } = await mountWithLocked();
        await act(async () => api().toggleHidden());
        expect(api().selected?.hidden).toBe(true);
        expect(api().selected?.locked).toBe(true);
    });
});

describe('商品鍵隨設定切換', () => {
    it('預設期貨收斂到根代碼，關閉共用後改用完整合約代碼', async () => {
        let api!: ChartDrawingsApi;
        await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode: vi.fn(),
        });
        expect(api.symbolKey).toBe('TXF');
        await act(async () => api.setShareContinuousMonth(false));
        expect(api.symbolKey).toBe('TXFR1');
    });
});

describe('鍵盤只歸一張圖，且不擋 Esc×2 全部刪單', () => {
    // 這組需要真的派送 keydown：把 window 換成記錄 listener 的替身
    // capture listener 先於 bubble listener — 與瀏覽器派送 window 事件的順序一致
    const keyListeners = new Map<(e: KeyboardEvent) => void, boolean>();
    beforeEach(() => {
        keyListeners.clear();
        hk.cancelAll.mockClear();
        hk.notify.mockClear();
        resetEscCancelArm(); // 前一個測試留下的「第一下」不能帶過來
        vi.stubGlobal('window', {
            addEventListener: (type: string, l: (e: KeyboardEvent) => void, capture?: boolean) => {
                if (type === 'keydown') keyListeners.set(l, !!capture);
            },
            removeEventListener: (type: string, l: (e: KeyboardEvent) => void) => {
                if (type === 'keydown') keyListeners.delete(l);
            },
        });
        vi.stubGlobal('performance', { now: () => 1000 });
        vi.stubGlobal('document', { activeElement: null, addEventListener() {}, removeEventListener() {} });
    });

    // stopAtTarget：目標元件（例如價格輸入框）在 Esc 上 stopPropagation —
    // window 的 capture listener 照樣收到，bubble listener 收不到
    function press(key: string, opts: { stopAtTarget?: boolean } = {}) {
        const e = {
            key,
            target: null,
            repeat: false,
            metaKey: false,
            ctrlKey: false,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };
        const all = [...keyListeners];
        for (const [l, capture] of all) if (capture) l(e as unknown as KeyboardEvent);
        if (opts.stopAtTarget) return e;
        for (const [l, capture] of all) if (!capture) l(e as unknown as KeyboardEvent);
        return e;
    }

    // 圖表 host 的替身：scope（host 的父元素＝圖表列）含有哪些「元素」
    function fakeHost() {
        const inside = { tagName: 'DIV' };
        const scope = { contains: (n: unknown) => n === inside || n === host };
        const host: Record<string, unknown> = {
            parentElement: scope,
            style: { cursor: '' },
            addEventListener() {},
            removeEventListener() {},
        };
        return { host, inside };
    }
    function focus(el: unknown) {
        vi.stubGlobal('document', { activeElement: el });
    }

    function HotkeysProbe() {
        useHotkeys({ onOpenPalette: () => {}, onAfterCancelAll: () => {} });
        return null;
    }

    const line = (price: number) =>
        addDrawing('TXF', 'horizontal', [{ time: 1000, price }], DEFAULT_DRAWING_STYLE)!;

    async function mountChart() {
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        return () => api;
    }

    it('沒有選取也沒有工具時不聽鍵盤', async () => {
        await mountChart();
        expect(keyListeners.size).toBe(0);
    });

    it('選取中按 Esc 取消選取（關閉浮動工具列）並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
        const api = await mountChart();
        const d = line(25000);
        await act(async () => api().select(d.id));
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Escape');
        });
        expect(api().selected).toBeNull();
        expect(e.defaultPrevented).toBe(true);
    });

    it('武裝畫圖工具時按 Esc 退出工具並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
        const api = await mountChart();
        await act(async () => api().setTool('trend'));
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Escape');
        });
        expect(api().tool).toBeNull();
        expect(e.defaultPrevented).toBe(true);
    });

    it('開啟 Esc×2 全部刪單時：畫圖中連按兩下 Esc 不會撤掉委託', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        const api = await mountChart();
        await act(async () => api().setTool('ray'));
        await act(async () => {
            press('Escape'); // 退出畫圖（被吃掉）
        });
        await act(async () => {
            press('Escape'); // 0.6 秒內第二下 — 只當成全刪單的第一下
        });
        expect(api().tool).toBeNull();
        expect(hk.cancelAll).not.toHaveBeenCalled();
        // 沒有畫圖狀態時，Esc×2 照常作用（快捷鍵本身沒被弄壞）
        await act(async () => {
            press('Escape');
        });
        expect(hk.cancelAll).toHaveBeenCalledTimes(1);
    });

    it('Esc（武裝全刪單）→ 畫圖 UI 用掉的 Esc → Esc：第三下不會跟第一下湊成 Esc×2', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        const api = await mountChart();
        const d = line(25000);
        await act(async () => {
            press('Escape'); // 什麼都沒選：算第一下（武裝）
        });
        expect(hk.notify).toHaveBeenCalledTimes(1);
        await act(async () => api().select(d.id));
        await act(async () => {
            press('Escape'); // 取消選取：被畫圖吃掉，並清掉第一下
        });
        await act(async () => {
            press('Escape'); // 0.6 秒內 — 只能算新的第一下
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
        expect(hk.notify).toHaveBeenCalledTimes(2);
    });

    it('Esc（武裝）→ 焦點在樣式面板勾選框上的 Esc → 點外面 → Esc：不會全部刪單', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        await act(async () => {
            press('Escape'); // 第一下：武裝
        });
        expect(hk.notify).toHaveBeenCalledTimes(1);
        vi.stubGlobal('document', { activeElement: { tagName: 'INPUT' } }); // 勾選框
        await act(async () => {
            press('Escape'); // 控制項上的 Esc：清掉等待中的第一下
        });
        vi.stubGlobal('document', { activeElement: null }); // 點外面，焦點離開
        await act(async () => {
            press('Escape'); // 0.6 秒內，但只能算新的第一下
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
        expect(hk.notify).toHaveBeenCalledTimes(2);
    });

    // 讓 use-hotkeys 在派送結束後排的 setTimeout 跑完
    const settle = () => new Promise((r) => setTimeout(r, 5));

    it('任何元件在 Esc 上 stopPropagation（全域 handler 收不到）也會清除武裝', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        await act(async () => {
            press('Escape'); // 第一下：武裝
            await settle();
        });
        expect(hk.notify).toHaveBeenCalledTimes(1);
        await act(async () => {
            press('Escape', { stopAtTarget: true }); // 某個元件吃掉並擋下傳遞
            await settle();
        });
        await act(async () => {
            press('Escape'); // 0.6 秒內 — 只能算新的第一下
            await settle();
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
        expect(hk.notify).toHaveBeenCalledTimes(2);
    });

    it('Esc（武裝）→ 價格輸入框 Esc（還原並 stopPropagation）→ 點圖取消選取 → Esc：不會全部刪單', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        const api = await mountChart();
        const d = line(25000);
        await act(async () => {
            press('Escape');
            await settle();
        });
        await act(async () => api().select(d.id));
        await act(async () => {
            press('Escape', { stopAtTarget: true }); // PriceInput 的 onKeyDown 會 stopPropagation
            await settle();
        });
        await act(async () => api().select(null)); // 點圖取消選取
        await act(async () => {
            press('Escape');
            await settle();
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
    });

    it('Esc（武裝）→ 被元件擋下的 Esc → 下一個 Esc 緊接著到（中間沒有計時器）：不會全部刪單', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        await act(async () => {
            press('Escape'); // 第一下：武裝
            press('Escape', { stopAtTarget: true }); // 被元件吃掉
            press('Escape'); // 緊接著：在捕獲階段先結清上一下 → 只算新的第一下
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
        expect(hk.notify).toHaveBeenCalledTimes(2);
    });

    it('被算成第一下的 Esc 不會被自己的保險計時器清掉：Esc、Esc 照常全部刪單', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        await act(async () => {
            press('Escape');
            await settle();
        });
        await act(async () => {
            press('Escape');
            await settle();
        });
        expect(hk.cancelAll).toHaveBeenCalledTimes(1);
    });

    it('兩張圖：後選取的那張接手鍵盤，Delete 只刪它的物件，前一張放掉選取', async () => {
        const ha = fakeHost();
        const hb = fakeHost();
        let a!: ChartDrawingsApi;
        let b!: ChartDrawingsApi;
        await mount({ receive: (v) => (a = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: ha.host });
        await mount({ receive: (v) => (b = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: hb.host });
        const la = line(25000);
        const lb = line(25100);
        await act(async () => a.select(la.id));
        await act(async () => b.select(lb.id));
        expect(a.selected).toBeNull();
        expect(b.selected?.id).toBe(lb.id);
        focus(hb.inside);
        await act(async () => {
            press('Delete');
        });
        expect(b.drawings.map((d) => d.id)).toEqual([la.id]);
    });

    it('焦點已移到別的面板（按鈕）時，Delete 不刪圖上選取的物件', async () => {
        const h = fakeHost();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: h.host });
        const d = line(25000);
        await act(async () => api.select(d.id));
        focus({ tagName: 'BUTTON' }); // 別的面板的按鈕
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Delete');
        });
        expect(api.drawings.map((x) => x.id)).toEqual([d.id]);
        expect(e.defaultPrevented).toBe(false);
        // 焦點回到圖上才刪
        focus(h.inside);
        await act(async () => {
            press('Backspace');
        });
        expect(api.drawings).toEqual([]);
    });

    it('chartHasFocus：沒有 scope 或焦點在外面都算沒有焦點', () => {
        const h = fakeHost();
        focus(h.inside);
        expect(chartHasFocus(h.host.parentElement as never)).toBe(true);
        expect(chartHasFocus(null)).toBe(false);
        focus(null);
        expect(chartHasFocus(h.host.parentElement as never)).toBe(false);
    });

    it('武裝點價買賣時清掉畫圖選取 — Delete 不會刪到剛才選著的物件', async () => {
        const h = fakeHost();
        let api!: ChartDrawingsApi;
        const props = { receive: (v: ChartDrawingsApi) => (api = v), onEnterDrawingMode: vi.fn(), host: h.host };
        const root = await mount({ ...props, tradeArmed: false });
        const d = line(25000);
        await act(async () => api.select(d.id));
        expect(api.selected?.id).toBe(d.id);
        await act(async () => root.update(createElement(Probe, { ...props, tradeArmed: true })));
        expect(api.selected).toBeNull();
        focus(h.inside);
        await act(async () => {
            press('Delete');
        });
        expect(api.drawings.map((x) => x.id)).toEqual([d.id]);
    });
});

describe('滑鼠：交易模式與委託線優先於畫圖物件', () => {
    // 最小的圖表替身：y = 25200 - price，時間軸每根 10px
    type L = (e: MouseEvent) => void;
    const hostListeners = new Map<string, L>();
    let axisCalls = 0;
    let attachedLayer: { state: { draft: unknown } } | null = null;
    const host = {
        style: { cursor: '' },
        dataset: {},
        addEventListener: (t: string, l: L) => hostListeners.set(t, l),
        removeEventListener: (t: string) => hostListeners.delete(t),
    };
    const series = {
        priceToCoordinate: (p: number) => 25200 - p,
        coordinateToPrice: (y: number) => 25200 - y,
        priceFormatter: () => ({ format: String }),
        attachPrimitive(layer: {
            attached: (p: unknown) => void;
            noteCanvas: (c: unknown, s: unknown) => void;
            state: { draft: unknown };
        }) {
            attachedLayer = layer;
            layer.attached({
                series,
                chart: {
                    timeScale: () => ({
                        logicalToCoordinate: (l: number) => (axisCalls++, l * 10),
                    }),
                },
                requestUpdate() {},
            });
            layer.noteCanvas(
                { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) },
                { width: 800, height: 400 },
            );
        },
        detachPrimitive() {},
    };

    function DrawProbe({
        tradeArmed,
        receive,
        code = 'TXFR1',
        themeMode = 'dark',
    }: {
        tradeArmed: boolean;
        receive: (v: ChartDrawingsApi) => void;
        code?: string;
        themeMode?: 'dark' | 'light';
    }) {
        const hostRef = useRef(host as unknown as HTMLDivElement);
        const chartRef = useRef({ applyOptions() {} } as never);
        const seriesRef = useRef(series as never);
        receive(
            useChartDrawings({
                contract: { code, security_type: code === '2330' ? 'STK' : 'FUT' } as ContractBase,
                themeMode,
                hostRef,
                chartRef,
                seriesRef,
                getTimes: () => [1000, 1060, 1120, 1180],
                tradeArmed,
                onEnterDrawingMode: vi.fn(),
            }),
        );
        return null;
    }

    beforeEach(() => {
        hostListeners.clear();
        vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    });

    // 在水平線（25000 → y=200）上按下
    function pressOnLine(prevented = false, x = 20, y = 200) {
        const e = {
            button: 0,
            clientX: x,
            clientY: y,
            defaultPrevented: prevented,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        hostListeners.get('mousedown')!(e as unknown as MouseEvent);
        return e;
    }

    async function setup(tradeArmed: boolean, withLine = true, themeMode: 'dark' | 'light' = 'dark') {
        let api!: ChartDrawingsApi;
        let root!: ReactTestRenderer;
        await act(async () => {
            root = create(
                createElement(DrawProbe, { tradeArmed, themeMode, receive: (v) => (api = v) }),
            );
        });
        roots.push(root);
        if (withLine) {
            addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        }
        await act(async () => {});
        return Object.assign(() => api, { root });
    }

    it('委託線只在瀏覽模式接手滑鼠 — 武裝畫圖工具時不接手，不會誤改委託價', () => {
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false })).toBe(true);
        expect(orderLineMayTakePointer({ drawingArmed: true, defaultPrevented: false })).toBe(false);
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: true })).toBe(false);
    });

    it('武裝趨勢線時在委託線附近按下：這一下由畫圖接手（開始繪製），不是改價', async () => {
        const api = await setup(false, false);
        await act(async () => api().setTool('trend'));
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine(false, 40, 200);
        });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(attachedLayer?.state.draft).not.toBeNull();
    });

    it('換商品時立刻清掉畫到一半的草稿（不等下一次重繪）', async () => {
        const api = await setup(false, false);
        await act(async () => api().setTool('trend'));
        await act(async () => {
            pressOnLine(false, 40, 200);
        });
        expect(attachedLayer?.state.draft).not.toBeNull();
        await act(async () =>
            api.root.update(
                createElement(DrawProbe, {
                    tradeArmed: false,
                    code: '2330',
                    receive: () => {},
                }),
            ),
        );
        expect(attachedLayer?.state.draft).toBeNull();
    });

    it('沒有任何畫圖物件時，hover 不建 projector、不做任何投影', async () => {
        await setup(false, false);
        axisCalls = 0;
        hostListeners.get('mousemove')!({ clientX: 50, clientY: 50 } as MouseEvent);
        expect(axisCalls).toBe(0);
    });

    it('新物件的預設色依工具與主題；使用者挑過的顏色只覆蓋那種工具', async () => {
        const dark = await setup(false, false, 'dark');
        await act(async () => dark().setTool('horizontal'));
        await act(async () => {
            pressOnLine(false, 40, 150);
        });
        expect(dark().selected?.style.color).toBe(TOOL_DEFAULT_COLORS.dark.horizontal);
        // 選著水平線改色 → 只記住水平線的顏色
        await act(async () => dark().applyStyle({ color: '#26a69a' }));
        expect(getDrawingSettings().toolColors).toEqual({ horizontal: '#26a69a' });
        await act(async () => dark().setTool('box'));
        expect(dark().style.color).toBe(TOOL_DEFAULT_COLORS.dark.box);
        await act(async () => dark().setTool('horizontal'));
        expect(dark().style.color).toBe('#26a69a');
    });

    it('淺色主題用較深的預設色', async () => {
        const light = await setup(false, false, 'light');
        await act(async () => light().setTool('trend'));
        expect(light().style.color).toBe(TOOL_DEFAULT_COLORS.light.trend);
        expect(TOOL_DEFAULT_COLORS.light.trend).not.toBe(TOOL_DEFAULT_COLORS.dark.trend);
    });

    it('委託線與畫圖物件重疊：選取中的物件絕不讓；有畫圖時只能從右側把手區拖委託線', () => {
        const base = { drawingArmed: false, defaultPrevented: false };
        expect(orderLineMayTakePointer({ ...base })).toBe(true);
        expect(orderLineMayTakePointer({ ...base, drawingArmed: true, inGrip: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'selected', inGrip: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'other' })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'other', inGrip: true })).toBe(true);
        expect(orderLineMayTakePointer({ ...base, drawingBusy: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingBusy: true, inGrip: true })).toBe(true);
    });

    it('未選取的畫圖物件延伸到價格軸前的繪圖區、與委託線重疊：委託線不接手；只有價格軸上的委託標籤可以拖', () => {
        const hostWidth = 1000;
        const axis = 70;
        const base = { drawingArmed: false, defaultPrevented: false, drawingHit: 'other' as const };
        // 舊版的 90px 把手帶（價格軸左邊）現在屬於繪圖區
        for (const x of [hostWidth - axis - 89, hostWidth - axis - 30, hostWidth - axis - 1]) {
            expect(inOrderLabelArea(x, hostWidth, axis)).toBe(false);
            expect(orderLineMayTakePointer({ ...base, inGrip: inOrderLabelArea(x, hostWidth, axis) })).toBe(false);
        }
        // 價格軸上的委託標籤
        expect(inOrderLabelArea(hostWidth - axis + 5, hostWidth, axis)).toBe(true);
        expect(orderLineMayTakePointer({ ...base, inGrip: true })).toBe(true);
        // 沒有畫圖時照舊整條線都能拖
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false, drawingHit: null })).toBe(true);
    });

    it('標籤連鎖防重疊：現價 100、兩筆委託 101／102、水平線 103，另一筆委託在 143 — 拖畫圖標籤不改任何委託價', async () => {
        // 畫圖標籤自己畫在價格軸上、固定在線的價位（不參與函式庫的防重疊
        // 連鎖推移），範圍確切已知
        const api = await setup(false, false);
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25200 - 103 }], DEFAULT_DRAWING_STYLE); // y=103
        await act(async () => {});
        expect((attachedLayer as unknown as { priceAxisViews?: unknown }).priceAxisViews).toBeUndefined();
        const orders = [101, 102, 143]; // 各委託原價位的 y
        const findNear = (y: number) => orders.find((o) => Math.abs(o - y) <= 6);
        const take = (clientY: number) =>
            findNear(clientY) !== undefined &&
            orderLineMayTakePointer({
                drawingArmed: false,
                defaultPrevented: false,
                drawingHit: null,
                inGrip: true,
                drawingLabelAtPointer: api().drawingLabelAt(clientY),
            });
        // 按在水平線自己的標籤上（y=103，離兩筆委託 1～2px）：屬於畫圖
        expect(take(103)).toBe(false);
        expect(take(96)).toBe(false); // 標籤上緣
        // 舊做法下標籤會被推到 142.5 撞上 143 的委託；現在那裡不是畫圖標籤，
        // 143 的委託標籤照常可拖
        expect(api().drawingLabelAt(142.5)).toBe(false);
        expect(take(143)).toBe(true);
    });

    it('小數 y：畫出來的色塊邊緣與保護範圍一致，並往外各多 1px', async () => {
        const api = await setup(false, false);
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25200 - 31.49 }], DEFAULT_DRAWING_STYLE); // y=31.49
        await act(async () => {});
        const box = axisLabelBox(31.49);
        expect(box).toEqual({ top: 22, bottom: 41 }); // 色塊從 22 畫起（DPR=1）
        // 按在看得到的上緣 y=22、下緣 y=41，以及外擴的 1px 都屬於畫圖標籤
        for (const y of [21, 22, 22.2, 41, 42]) expect(api().drawingLabelAt(y)).toBe(true);
        expect(api().drawingLabelAt(20.5)).toBe(false);
        expect(api().drawingLabelAt(42.5)).toBe(false);
        // 繪製用的也是同一個矩形
        const fills: number[][] = [];
        const ctx = {
            save() {},
            restore() {},
            fillRect: (...a: number[]) => void fills.push(a),
            fillText() {},
            set font(_v: string) {},
            set textBaseline(_v: string) {},
            set textAlign(_v: string) {},
            set fillStyle(_v: string) {},
        };
        const view = (attachedLayer as unknown as { priceAxisPaneViews(): { renderer(): { draw(t: unknown): void } }[] })
            .priceAxisPaneViews()[0]!;
        view.renderer().draw({
            useBitmapCoordinateSpace: (fn: (s: unknown) => void) =>
                fn({ context: ctx, horizontalPixelRatio: 1, verticalPixelRatio: 1, mediaSize: { width: 60, height: 400 } }),
        });
        expect(fills[0]!.slice(1)).toEqual([22, 60, 19]);
    });

    it('drawingLabelAt：標籤範圍＝線的價位上下各半個標籤高，選取中也一樣', async () => {
        const api = await setup(false); // 水平線 25000 → y=200
        expect(api().drawingLabelAt(200 + AXIS_LABEL_H / 2)).toBe(true);
        expect(api().drawingLabelAt(200 - AXIS_LABEL_H / 2 - 1)).toBe(true); // 外擴 1px
        expect(api().drawingLabelAt(200 - AXIS_LABEL_H / 2 - 1.5)).toBe(false);
        await act(async () => {
            pressOnLine();
        });
        expect(api().selected?.tool).toBe('horizontal');
        expect(api().drawingLabelAt(195)).toBe(true);
    });

    it('drawingAt：游標下的畫圖物件是選取中的還是其他的', async () => {
        const api = await setup(false);
        expect(api().drawingAt({ clientX: 20, clientY: 200 })).toBe('other');
        expect(api().drawingAt({ clientX: 20, clientY: 350 })).toBeNull();
        expect(api().drawingBusy()).toBe(false);
        await act(async () => {
            pressOnLine();
        });
        expect(api().drawingAt({ clientX: 20, clientY: 200 })).toBe('selected');
        expect(api().drawingBusy()).toBe(true);
    });

    it('沒武裝交易時，按在畫圖物件上會選取並接手這一下', async () => {
        const api = await setup(false);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine();
        });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(api().selected?.tool).toBe('horizontal');
    });

    it('武裝點價買賣時，按在畫圖物件上解除武裝並選取', async () => {
        const api = await setup(true);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine();
        });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(e.stopPropagation).toHaveBeenCalled();
        expect(api().selected?.tool).toBe('horizontal');
    });

    it('委託線已接手的一下（defaultPrevented），畫圖物件不跟著拖', async () => {
        const api = await setup(false);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine(true);
        });
        expect(e.stopPropagation).not.toHaveBeenCalled();
        expect(api().selected).toBeNull();
    });
});

describe('第一期：多選、平行通道、量測、文字、復原、快捷鍵', () => {
    type L = (e: unknown) => void;
    const hostL = new Map<string, L>();
    const docL = new Map<string, L>();
    const keyL = new Set<L>();
    const windowL = new Map<string, Set<L>>();
    let currentContract = contract;
    let priceBase = 25200;
    let currentContext = '1:false';
    let tradeArmed = false;
    const enterMode = vi.fn();
    let beforeContextEffect: (() => void) | null = null;
    let renderEditor = false;
    let receiveApi: (v: ChartDrawingsApi) => void;
    const inside = { tagName: 'CANVAS' };
    const scope = { contains: (n: unknown) => n === inside };
    const host = {
        style: { cursor: '' },
        dataset: {},
        parentElement: scope,
        addEventListener: (t: string, l: L) => hostL.set(t, l),
        removeEventListener: (t: string) => hostL.delete(t),
    };
    let layer: { state: { draft: unknown; measure: unknown } } | null = null;
    const series = {
        priceToCoordinate: (p: number) => priceBase - p,
        coordinateToPrice: (y: number) => priceBase - y,
        priceFormatter: () => ({ format: String }),
        attachPrimitive(l: {
            attached: (p: unknown) => void;
            noteCanvas: (c: unknown, s: unknown) => void;
            state: { draft: unknown; measure: unknown };
        }) {
            layer = l;
            l.attached({
                series,
                chart: { timeScale: () => ({ logicalToCoordinate: (x: number) => x * 10 }) },
                requestUpdate() {},
            });
            l.noteCanvas(
                { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) },
                { width: 800, height: 400 },
            );
        },
        detachPrimitive() {},
    };

    // 與真實元件一樣用穩定的 ref（每次 render 換新物件會讓 effect 重掛）
    const refs = {
        host: { current: host as unknown as HTMLDivElement },
        chart: { current: { applyOptions() {} } as never },
        series: { current: series as never },
    };
    const v2Bars = [
        { time: 1000, open: 24990, high: 25010, low: 24980, close: 25005 },
        { time: 1060, open: 25005, high: 25050, low: 25000, close: 25040 },
        { time: 1120, open: 25090, high: 25110, low: 25080, close: 25100 },
        { time: 1180, open: 25100, high: 25130, low: 25090, close: 25120 },
    ];
    function V2Probe({ receive }: { receive: (v: ChartDrawingsApi) => void }) {
        useLayoutEffect(() => { beforeContextEffect?.(); }, [currentContract, currentContext]);
        const api = useChartDrawings({
                contract: currentContract,
                contextKey: currentContext,
                hostRef: refs.host,
                chartRef: refs.chart,
                seriesRef: refs.series,
                getTimes: () => [1000, 1060, 1120, 1180],
                tradeArmed,
                onEnterDrawingMode: enterMode,
                pnlPerPoint: 200,
                getBars: () => v2Bars,
            });
        receive(api);
        return renderEditor ? createElement(ChartDrawingOverlays, {
            api: { ...api, editBox: api.editingTextId ? { left: 0, top: 0, right: 10, bottom: 10 } : null },
        }) : null;
    }

    beforeEach(() => {
        hostL.clear();
        docL.clear();
        keyL.clear();
        windowL.clear();
        currentContract = contract;
        priceBase = 25200;
        currentContext = '1:false';
        tradeArmed = false;
        enterMode.mockClear();
        beforeContextEffect = null;
        renderEditor = false;
        vi.stubGlobal('document', {
            activeElement: inside,
            addEventListener: (t: string, l: L) => docL.set(t, l),
            removeEventListener: (t: string) => docL.delete(t),
        });
        vi.stubGlobal('window', {
            addEventListener: (t: string, l: L) => {
                if (t === 'keydown') keyL.add(l);
                else { const ls = windowL.get(t) ?? new Set<L>(); ls.add(l); windowL.set(t, ls); }
            },
            removeEventListener: (t: string, l: L) => { keyL.delete(l); windowL.get(t)?.delete(l); },
        });
    });

    async function setup() {
        let api!: ChartDrawingsApi;
        receiveApi = (v) => (api = v);
        await act(async () => {
            roots.push(create(createElement(V2Probe, { receive: receiveApi })));
        });
        return () => api;
    }

    it.each(['body', 'anchor', 'shift', 'locked', 'text', 'double-text', 'shortcut', 'list-multi'] as const)(
        '武裝交易後進入畫圖 %s，先解除交易且同步擋住圖表 click', async (entry) => {
            const api = await setup();
            let drawing!: Drawing;
            await act(async () => {
                drawing = addDrawing('TXF', entry.includes('text') ? 'text' : 'trend',
                    entry.includes('text') ? [{ time: 1000, price: 25000 }] : [{ time: 1000, price: 25000 }, { time: 1120, price: 25100 }], DEFAULT_DRAWING_STYLE)!;
                if (entry === 'locked') api().select(drawing.id);
            });
            if (entry === 'locked') await act(async () => api().toggleLock());
            await down(300, 300); // 取得鍵盤，但不選物件
            tradeArmed = true;
            await act(async () => roots.at(-1)!.update(createElement(V2Probe, { receive: receiveApi })));
            expect(api().selectedIds).toEqual([]);
            enterMode.mockClear();
            await act(async () => {
                if (entry === 'shortcut') {
                    keyL.forEach((l) => l({ key: 't', code: 'KeyT', altKey: true, preventDefault: vi.fn() }));
                } else if (entry === 'text') api().editText(drawing.id);
                else if (entry === 'list-multi') api().select(drawing.id, true);
                else if (entry === 'double-text') hostL.get('dblclick')!(ev(0, 200));
                else hostL.get('mousedown')!(ev(entry === 'body' || entry === 'locked' ? 10 : 0, entry === 'body' || entry === 'locked' ? 150 : 200, { shiftKey: entry === 'shift' }));
                expect(enterMode).toHaveBeenCalled();
                expect(api().drawingBusy()).toBe(true);
            });
            if (entry === 'shortcut') expect(api().tool).toBe('trend');
            else expect(api().selectedIds).toContain(drawing.id);
        },
    );

    const ev = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
        button: 0,
        clientX: x,
        clientY: y,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...extra,
    });
    const down = async (x: number, y: number, extra: Record<string, unknown> = {}) => {
        const e = ev(x, y, extra);
        await act(async () => hostL.get('mousedown')!(e));
        return e;
    };
    const up = async (x: number, y: number) => {
        await act(async () => docL.get('mouseup')?.(ev(x, y)));
    };

    it.each(['draft', 'drag', 'text', 'measure'] as const)('下單防線在沒有選取時仍辨識畫圖 %s，取消後才解除', async (interaction) => {
        const api = await setup();
        if (interaction === 'drag') {
            await act(async () => { addDrawing('TXF', 'trend', [{ time: 1000, price: 25000 }, { time: 1120, price: 25100 }], DEFAULT_DRAWING_STYLE); });
            await down(0, 200);
        } else {
            await act(async () => api().setTool(interaction === 'draft' ? 'trend' : interaction));
            await down(0, 200);
            if (interaction === 'measure') await down(20, 100); // 量完仍顯示
        }
        await act(async () => api().select(null));
        expect(api().selectedIds).toEqual([]);
        expect(api().drawingBusy()).toBe(true);
        await act(async () => api().setTool(null));
        expect(api().drawingBusy()).toBe(false);
    });

    it.each(['draft', 'drag', 'text', 'measure'] as const)('委託線接手前同步結束畫圖 %s，兩種互動不可共存', async (interaction) => {
        const api = await setup();
        if (interaction === 'drag') {
            await act(async () => { addDrawing('TXF', 'trend', [{ time: 1000, price: 25000 }, { time: 1120, price: 25100 }], DEFAULT_DRAWING_STYLE); });
            await down(0, 200);
        } else {
            await act(async () => api().setTool(interaction === 'draft' ? 'trend' : interaction));
            await down(0, 200);
            if (interaction === 'measure') await down(20, 100);
        }
        expect(api().drawingBusy()).toBe(true);
        const sequence = api().interactionSequence();
        await act(async () => {
            api().prepareOrderDrag();
            expect(api().drawingBusy()).toBe(false);
            expect(api().interactionSequence()).toBeGreaterThan(sequence);
        });
        expect(api().tool).toBeNull();
        expect(api().editingTextId).toBeNull();
        expect(api().selectedIds).toEqual([]);
        expect(docL.has('mouseup')).toBe(false);
    });
    const key = async (k: Record<string, unknown>) => {
        const e = {
            key: '',
            code: '',
            target: null,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            ...k,
        };
        await act(async () => {
            for (const l of [...keyL]) l(e);
        });
        return e;
    };
    const contexts = ['symbol', 'shared-symbol', 'period', 'session', 'refresh', 'blur', 'pointercancel', 'unmount', 'tool', 'trade', 'pagehide', 'hidden'] as const;
    const changeContext = async (change: typeof contexts[number], api: () => ChartDrawingsApi) => {
        await act(async () => {
            if (change === 'symbol' || change === 'shared-symbol') {
                currentContract = { code: change === 'symbol' ? 'MXFR1' : 'TXFR2', security_type: 'FUT' } as ContractBase;
                priceBase = 1200;
            } else if (change === 'period') currentContext = '5:false';
            else if (change === 'session') currentContext = '1:true';
            else if (change === 'refresh') currentContext = '1:false:refresh';
            else if (change === 'trade') tradeArmed = true;
            else if (change === 'unmount') roots.at(-1)!.unmount();
            else if (change === 'tool') api().setTool('vertical');
            else if (change === 'pointercancel') docL.get('pointercancel')?.({});
            else if (change === 'hidden') {
                Object.assign(document, { hidden: true });
                docL.get('visibilitychange')?.({});
            } else for (const l of windowL.get(change) ?? []) l({});
            if (['symbol', 'shared-symbol', 'period', 'session', 'refresh', 'trade'].includes(change)) {
                roots.at(-1)!.update(createElement(V2Probe, { receive: receiveApi }));
            }
        });
    };

    it('拖曳前的 R2 尚未落地，Esc 後重載仍保留 R2', async () => {
        vi.useFakeTimers();
        try {
            const api = await setup();
            await act(async () => api().setTool('horizontal'));
            await down(50, 200);
            await act(async () => flushDrawingWrites());
            await act(async () => api().setSelectedPrice(25020));
            const r2 = api().drawings[0]!;
            await down(50, 180);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            await key({ key: 'Escape' });
            expect(api().drawings[0]).toBe(r2);
            await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(api().drawings[0]!.anchors).toEqual(r2.anchors);
        } finally { vi.useRealTimers(); }
    });

    it.each(contexts.flatMap((change) => ['pending', 'persisted', 'journal'].map((path) => [change, path] as const)))('拖曳途中 %s（%s）回到開始狀態，遲到事件不可再寫入', async (change, path) => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 200);
        const original = api().drawings[0]!;
        await act(async () => flushDrawingWrites());
        await down(50, 200);
        const lateUp = docL.get('mouseup')!;
        await act(async () => docL.get('mousemove')?.(ev(50, 150)));
        expect(getDrawings('TXF')[0]!.anchors[0]!.price).toBe(25050);
        await act(async () => {
            if (path === 'persisted') flushDrawingWrites();
            if (path === 'journal') writeDrawingJournal();
        });
        await changeContext(change, api);
        await act(async () => lateUp(ev(50, 100)));
        await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF')[0]!.anchors).toEqual(original.anchors);
        expect(docL.has('mousemove')).toBe(false);
        expect(docL.has('mouseup')).toBe(false);
    });

    it.each(contexts.flatMap((change) => ['draft', 'measure', 'new-text', 'edit-text'].map((interaction) => [change, interaction] as const)))('%s 中止 %s，不留下草稿或文字編輯', async (change, interaction) => {
        const api = await setup();
        let original: Drawing | undefined;
        if (interaction === 'edit-text') {
            await act(async () => {
                original = addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
                flushDrawingWrites();
            });
            await act(async () => api().editText(original!.id));
            await act(async () => api().setText(original!.id, '互動中'));
            await act(async () => flushDrawingWrites());
        } else {
            await act(async () => api().setTool(interaction === 'draft' ? 'channel' : interaction === 'measure' ? 'measure' : 'text'));
            await down(50, 200);
            await act(async () => flushDrawingWrites());
        }
        const lateCommit = api().commitText;
        await changeContext(change, api);
        await act(async () => { lateCommit('遲到文字'); flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF').map((d) => d.text)).toEqual(original ? ['原文'] : []);
        expect(layer?.state.draft).toBeNull();
        expect(layer?.state.measure).toBeNull();
        if (change !== 'unmount') expect(api().editingTextId).toBeNull();
    });

    it.each(['symbol', 'period', 'blur', 'pointercancel', 'unmount'] as const)('%s 清除待寫 RAF，已排程 callback 也不能污染儲存', async (change) => {
        let queued!: FrameRequestCallback;
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queued = cb; return 17; });
        vi.stubGlobal('cancelAnimationFrame', cancel);
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 200);
        const original = api().drawings[0]!;
        await act(async () => flushDrawingWrites());
        await down(50, 200);
        const lateMove = docL.get('mousemove')!;
        const lateUp = docL.get('mouseup')!;
        await act(async () => lateMove(ev(50, 150)));
        await changeContext(change, api);
        expect(cancel).toHaveBeenCalledWith(17);
        await act(async () => { queued(0); lateMove(ev(50, 100)); lateUp(ev(50, 100)); flushDrawingWrites(); });
        expect(getDrawings('TXF')[0]).toBe(original);
        expect(docL.has('mousemove')).toBe(false);
        expect(docL.has('mouseup')).toBe(false);
    });

    it('context 清理 effect 前放開滑鼠，商品核對仍攔下錯誤投影', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 200);
        const original = api().drawings[0]!;
        await act(async () => flushDrawingWrites());
        await down(50, 200);
        const lateUp = docL.get('mouseup')!;
        beforeContextEffect = () => lateUp(ev(50, 100));
        await changeContext('symbol', api);
        expect(getDrawings('TXF')[0]).toBe(original);
        expect(getDrawings('MXF')).toEqual([]);
    });

    it.each(['draft', 'measure', 'text'] as const)('context 清理 effect 前的 %s 遲到事件不可混用新投影', async (interaction) => {
        const api = await setup();
        await act(async () => api().setTool(interaction === 'draft' ? 'trend' : interaction));
        await down(50, 200);
        const lateCommit = api().commitText;
        beforeContextEffect = () => {
            if (interaction === 'text') lateCommit('不應提交');
            else hostL.get('mousedown')!(ev(70, 100));
        };
        await changeContext('symbol', api);
        await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF')).toEqual([]);
        expect(getDrawings('MXF')).toEqual([]);
        expect(layer?.state.draft).toBeNull();
        expect(layer?.state.measure).toBeNull();
    });

    it('取消拖曳時才讀到遠端寫入，清理不重入且保留遠端版本', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 200);
        const original = api().drawings[0]!;
        await act(async () => flushDrawingWrites());
        await down(50, 200);
        await act(async () => docL.get('mousemove')?.(ev(50, 150)));
        const remote = { ...original, anchors: [{ time: 1000, price: 24900 }], revision: remoteRevision(original) };
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
        await key({ key: 'Escape' });
        expect(getDrawings('TXF')).toEqual([remote]);
        expect(docL.has('mouseup')).toBe(false);
        expect(api().canUndo).toBe(false);
    });

    it('舊文字框的 callback 不可提交新 context 中的文字物件', async () => {
        const api = await setup();
        await act(async () => api().setTool('text'));
        await down(50, 200);
        const stale = api().commitText;
        await changeContext('symbol', api);
        await act(async () => api().setTool('text'));
        await down(50, 200);
        const id = api().editingTextId;
        await act(async () => stale('舊文字'));
        expect(api().editingTextId).toBe(id);
        expect(getDrawings('MXF')[0]!.text).toBe('');
        await act(async () => api().commitText('新文字'));
        expect(getDrawings('MXF')[0]!.text).toBe('新文字');
    });

    it('平行通道點三下：基準線兩點＋決定寬度的第三點', async () => {
        const api = await setup();
        await act(async () => api().setTool('channel'));
        await down(100, 200);
        await down(300, 100);
        expect(api().drawings).toHaveLength(0); // 還在等第三點
        await down(200, 250);
        expect(api().drawings).toHaveLength(1);
        expect(api().drawings[0]!.tool).toBe('channel');
        expect(api().drawings[0]!.anchors).toHaveLength(3);
        expect(api().tool).toBeNull();
    });

    it('Shift 點選多選，一起拖曳、一起刪除', async () => {
        const api = await setup();
        const a = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24900 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(50, 200); // a（y=200）
        await up(50, 200);
        await down(50, 300, { shiftKey: true }); // b（y=300）
        expect(api().selectedIds).toEqual([a.id, b.id]);
        await up(50, 280); // 往上拖 20px
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25020, 24920]);
        const e = await key({ key: 'Delete' });
        expect(e.defaultPrevented).toBe(true);
        expect(api().drawings).toEqual([]);
    });

    it('復原／重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y；焦點不在圖上時不作用', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 150);
        expect(api().drawings).toHaveLength(1);
        expect(api().canUndo).toBe(true);
        let e = await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(api().drawings).toHaveLength(0);
        await key({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true });
        expect(api().drawings).toHaveLength(1);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        await key({ key: 'y', code: 'KeyY', ctrlKey: true });
        expect(api().drawings).toHaveLength(1);
        // 焦點在別的面板
        vi.stubGlobal('document', { activeElement: { tagName: 'BUTTON' }, addEventListener() {}, removeEventListener() {} });
        e = await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(e.defaultPrevented).toBe(false);
        expect(api().drawings).toHaveLength(1);
    });

    it('拖曳結束算一步，可復原回原位', async () => {
        const api = await setup();
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        await act(async () => {});
        await down(50, 200);
        await up(50, 150);
        expect(api().drawings[0]!.anchors[0]!.price).toBe(25050);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.anchors[0]!.price).toBe(25000);
    });

    it('Alt＋字母切換工具（依 code，不看 Option 產生的符號）', async () => {
        const api = await setup();
        await down(700, 50); // 點圖：握有鍵盤
        const e = await key({ key: '†', code: 'KeyT', altKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(api().tool).toBe('trend');
        await key({ key: '˙', code: 'KeyH', altKey: true });
        expect(api().tool).toBe('horizontal');
        expect(toolShortcutOf({ code: 'KeyF', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe('fib');
        expect(undoKeyOf({ key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
    });

    it('價差量測：點兩下量完、Esc 清除且吃掉這一下（不算進 Esc×2）', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        expect(api().measuring).toBe(true);
        expect(api().tool).toBeNull();
        const m = layer!.state.measure as { label: string; stats: { points: number; bars: number; pnl: number } };
        expect(m.stats.points).toBe(120);
        expect(m.stats.bars).toBe(2);
        expect(m.stats.pnl).toBe(24000);
        expect(m.label).toContain('+120 點');
        expect(api().drawings).toEqual([]); // 量測不存檔
        const e = await key({ key: 'Escape' });
        expect(e.defaultPrevented).toBe(true);
        expect(api().measuring).toBe(false);
    });

    it('量完後點一下圖表就清除量測，這一下不做別的事', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        const e = await down(300, 300);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(api().measuring).toBe(false);
    });

    it('文字註記：放下後開輸入框，確定才存；空白取消整筆不留、也不進復原', async () => {
        const api = await setup();
        await act(async () => api().setTool('text'));
        await down(100, 100);
        const id = api().editingTextId!;
        expect(id).toBeTruthy();
        await act(async () => api().commitText('月線支撐'));
        expect(api().drawings.find((d) => d.id === id)?.text).toBe('月線支撐');
        expect(api().canUndo).toBe(true);

        await act(async () => api().setTool('text'));
        await down(200, 100);
        expect(api().drawings).toHaveLength(2);
        await act(async () => api().commitText(null));
        expect(api().drawings).toHaveLength(1);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings).toHaveLength(0); // 復原的是第一筆文字
    });

    it.each([false, true])('圖表 mousedown 先於文字失焦，仍提交輸入且只記一步（新建=%s）', async (created) => {
        const api = await setup();
        if (created) {
            await act(async () => api().setTool('text'));
            await down(50, 200);
        } else {
            await act(async () => { addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' }); });
            await act(async () => api().editText(api().drawings[0]!.id));
        }
        const id = api().editingTextId!;
        const blur = api().commitText;
        await act(async () => api().updateTextDraft('修改後的文字'));
        // 真實瀏覽器 focus() 同步觸發輸入框 blur；mousedown handler 先執行。
        Object.assign(host, { focus: () => blur('修改後的文字') });
        try {
            await down(700, 350);
            await act(async () => { blur('修改後的文字'); flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(api().editingTextId).toBeNull();
            expect(getDrawings('TXF').find((d) => d.id === id)?.text).toBe('修改後的文字');
            expect(api().canUndo).toBe(true);
            await act(async () => api().undo());
            expect(getDrawings('TXF').map((d) => d.text)).toEqual(created ? [] : ['原文']);
            expect(api().canUndo).toBe(false);
        } finally { delete (host as typeof host & { focus?: () => void }).focus; }
    });

    const textEndings = ['chart', 'tool', 'trade', 'blur', 'pointercancel', 'pagehide', 'hidden', 'symbol', 'shared-symbol', 'period', 'session', 'refresh', 'unmount'] as const;
    it.each(textEndings.flatMap((ending) => [false, true].map((created) => [ending, created] as const)))(
        '真實文字框輸入後 %s：使用者結束提交、context／卸載取消（新建=%s）', async (ending, created) => {
            renderEditor = true;
            const api = await setup();
            if (created) {
                await act(async () => api().setTool('text'));
                await down(50, 200);
            } else {
                await act(async () => { addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' }); });
                await act(async () => api().editText(api().drawings[0]!.id));
            }
            await act(async () => roots.at(-1)!.root.findByType('textarea').props.onChange({ target: { value: '使用者輸入' } }));
            const staleBlur = roots.at(-1)!.root.findByType('textarea').props.onBlur;
            if (ending === 'chart') await down(700, 350);
            else await changeContext(ending, api);
            await act(async () => { staleBlur(); flushDrawingWrites(); reloadDrawingsFromStorage(); });
            const canceled = ['symbol', 'shared-symbol', 'period', 'session', 'refresh', 'unmount'].includes(ending);
            expect(getDrawings('TXF').map((d) => d.text)).toEqual(canceled ? created ? [] : ['原文'] : ['使用者輸入']);
        },
    );

    it.each(['update', 'delete', 'move'] as const)('另一圖表 %s Y，X 的文字框仍可提交', async (operation) => {
        renderEditor = true;
        const api = await setup();
        let other!: ChartDrawingsApi;
        await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        let x!: Drawing;
        let y!: Drawing;
        await act(async () => {
            x = addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
            y = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
            flushDrawingWrites();
            api().rename(x.id, 'X');
        });
        await act(async () => api().editText(x.id));
        const editor = roots[roots.length - 2]!;
        await act(async () => editor.root.findByType('textarea').props.onChange({ target: { value: '繼續輸入' } }));
        await act(async () => {
            if (operation === 'update') other.rename(y.id, '遠端 Y');
            if (operation === 'delete') other.removeOne(y.id);
            if (operation === 'move') other.reorder(y.id, 0);
        });
        expect(api().editingTextId).toBe(x.id);
        expect(api().canUndo).toBe(false);
        await act(async () => editor.root.findByType('textarea').props.onBlur());
        expect(getDrawings('TXF').find((d) => d.id === x.id)?.text).toBe('繼續輸入');
        await act(async () => api().undo());
        expect(getDrawings('TXF').find((d) => d.id === x.id)?.text).toBe('原文');
        if (operation === 'update') expect(getDrawings('TXF').find((d) => d.id === y.id)?.name).toBe('遠端 Y');
        if (operation === 'delete') expect(getDrawings('TXF').some((d) => d.id === y.id)).toBe(false);
        if (operation === 'move') expect(getDrawings('TXF')[0]!.id).toBe(y.id);
    });

    it.each([false, true])('另一圖表修改同一文字物件，舊文字框失焦不得蓋掉對方待寫版本（新建=%s）', async (created) => {
        renderEditor = true;
        const api = await setup();
        let other!: ChartDrawingsApi;
        await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        if (created) {
            await act(async () => api().setTool('text'));
            await down(50, 200);
        } else {
            await act(async () => { addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' }); });
            await act(async () => api().editText(api().drawings[0]!.id));
        }
        const id = api().editingTextId!;
        const editor = roots[roots.length - 2]!;
        await act(async () => editor.root.findByType('textarea').props.onChange({ target: { value: '本地草稿' } }));
        const staleBlur = editor.root.findByType('textarea').props.onBlur;
        await act(async () => other.setText(id, '另一圖表的文字'));
        expect(api().editingTextId).toBeNull();
        await act(async () => { staleBlur(); flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF').find((d) => d.id === id)?.text).toBe('另一圖表的文字');
        expect(api().canUndo).toBe(false);
    });

    it('斐波那契設定：改選項會驗證、連續拉色帶合併成一步復原', async () => {
        const api = await setup();
        const f = addDrawing('TXF', 'fib', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(700, 350); // 取得鍵盤
        await act(async () => api().setFib(f.id, { labelH: 'right', fontSize: 99 }));
        expect(api().drawings[0]!.fib).toMatchObject({ labelH: 'right', fontSize: 16 });
        for (const o of [0.1, 0.2, 0.3]) await act(async () => api().setFib(f.id, { bandOpacity: o }));
        expect(api().drawings[0]!.fib!.bandOpacity).toBe(0.3);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.fib!.bandOpacity).toBe(0.12); // 三次拉動算一步
        expect(api().drawings[0]!.fib!.labelH).toBe('right');
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.fib!.labelH).toBe('left');
    });

    it('磁吸只作用在被拖的那一點，其他控制點維持原本的時間與價格', async () => {
        const api = await setup();
        const t = addDrawing('TXF', 'trend', [{ time: 1000, price: 25000 }, { time: 1180, price: 25100 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => api().setMagnet(true));
        await down(30, 100); // 第二點（x=30, y=100）
        await up(20, 95); // 拖到第三根 K 棒附近
        const d = api().drawings.find((x) => x.id === t.id)!;
        expect(d.anchors[0]).toEqual({ time: 1000, price: 25000 }); // 沒被吸走
        expect(d.anchors[1]!.time).toBe(1120);
        expect([25090, 25110, 25080, 25100]).toContain(d.anchors[1]!.price);
    });

    it('拖曳期間其他 writer 新增物件，拖曳繼續並保留新增物件', async () => {
        const api = await setup();
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        await act(async () => {});
        await down(50, 200);
        // 拖曳中另一個本地操作新增了一條線
        const theirs = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
        await up(50, 150);
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25050, 24800]);
        expect(api().canUndo).toBe(true);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25000, 24800]);
        expect(api().drawings.some((d) => d.id === theirs.id)).toBe(true);
    });

    it.each(['pending', 'persisted', 'journal'] as const)('另一圖表修改 Y 不中止正在拖曳的 X（%s）', async (path) => {
        vi.useFakeTimers();
        try {
            const api = await setup();
            let other!: ChartDrawingsApi;
            await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
            await act(async () => {
                api().setTool('horizontal');
            });
            await down(50, 200);
            const x = api().drawings[0]!;
            let y!: Drawing;
            await act(async () => {
                y = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
                flushDrawingWrites();
                api().rename(x.id, 'X');
            });
            expect(api().canUndo).toBe(true);
            await down(50, 200);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            expect(getDrawings('TXF')[0]!.anchors[0]!.price).toBe(25050);
            await act(async () => {
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
                other.rename(y.id, 'Y 遠端修改');
            });
            expect(api().canUndo).toBe(false);
            expect(docL.has('mousemove')).toBe(true);
            expect(docL.has('mouseup')).toBe(true);
            await up(50, 100);
            expect(getDrawings('TXF')[0]!.anchors[0]!.price).toBe(25100);
            await act(async () => api().undo());
            await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(getDrawings('TXF')[0]!.anchors).toEqual(x.anchors);
            expect(getDrawings('TXF')[1]!.name).toBe('Y 遠端修改');
        } finally { vi.useRealTimers(); }
    });

    it.each(['pending', 'persisted', 'journal'] as const)('Esc 取消 X 時才讀到遠端 Y，仍撤銷 X 中途座標（%s）', async (path) => {
        const api = await setup();
        let x!: Drawing;
        let y!: Drawing;
        await act(async () => {
            x = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
            y = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
            flushDrawingWrites();
        });
        await down(50, 200);
        await act(async () => docL.get('mousemove')?.(ev(50, 150)));
        await act(async () => {
            if (path === 'persisted') flushDrawingWrites();
            if (path === 'journal') writeDrawingJournal();
        });
        const remoteY = { ...y, name: '遠端 Y', revision: remoteRevision(y) };
        const savedX = JSON.parse(store.get('sj-pro-chart-drawings')!).TXF[0];
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [savedX, remoteY] }));
        await key({ key: 'Escape' });
        await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF')[0]!.anchors).toEqual(x.anchors);
        expect(getDrawings('TXF')[1]).toMatchObject(remoteY);
    });

    it.each(['chart', 'edit-text', 'rename', 'undo', 'redo', 'owner', 'order'] as const)('%s 接手拖曳會撤回中途座標並封住遲到事件', async (ending) => {
        const api = await setup();
        let x!: Drawing;
        let text!: Drawing;
        await act(async () => {
            x = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
            text = addDrawing('TXF', 'text', [{ time: 1000, price: 24900 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
            flushDrawingWrites();
        });
        await down(50, 200);
        const lateUp = docL.get('mouseup')!;
        await act(async () => docL.get('mousemove')?.(ev(50, 150)));
        if (ending === 'chart') await down(700, 350);
        else if (ending === 'owner') {
            let other!: ChartDrawingsApi;
            await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
            await act(async () => other.setTool('vertical'));
        } else await act(async () => {
            if (ending === 'edit-text') api().editText(text.id);
            if (ending === 'rename') api().rename(x.id, '改名');
            if (ending === 'undo') api().undo();
            if (ending === 'redo') api().redo();
            if (ending === 'order') api().prepareOrderDrag();
        });
        await act(async () => { lateUp(ev(50, 100)); flushDrawingWrites(); reloadDrawingsFromStorage(); });
        expect(getDrawings('TXF').find((d) => d.id === x.id)!.anchors).toEqual(x.anchors);
        expect(docL.has('mouseup')).toBe(false);
    });

    it('遠端低 revision 改 X，本地拖曳日誌不能讓中途座標留下', async () => {
        vi.useFakeTimers();
        try {
            const api = await setup();
            let x!: Drawing;
            await act(async () => {
                x = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
                flushDrawingWrites();
            });
            await down(50, 200);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            await act(async () => writeDrawingJournal());
            const remote = { ...x, name: '低 revision 遠端', revision: '0000000000000001:remote' };
            store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
            await act(async () => reloadDrawingsFromStorage());
            await up(50, 100);
            await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(getDrawings('TXF')[0]!.anchors).toEqual(x.anchors);
            expect(docL.has('mouseup')).toBe(false);
            expect(api().canUndo).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it.each(['pending', 'persisted', 'journal'] as const)('多選拖曳 X、Y，另一圖表刪 X 時也撤回 Y 的中途座標（%s）', async (path) => {
        vi.useFakeTimers();
        try {
            const api = await setup();
            let other!: ChartDrawingsApi;
            await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
            let x!: Drawing;
            let y!: Drawing;
            await act(async () => {
                x = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
                y = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
                flushDrawingWrites();
            });
            await down(50, 200);
            await up(50, 200);
            await down(50, 400, { shiftKey: true });
            expect(api().selectedIds).toEqual([x.id, y.id]);
            const lateUp = docL.get('mouseup')!;
            await act(async () => docL.get('mousemove')?.(ev(50, 350)));
            expect(getDrawings('TXF').map((d) => d.anchors[0]!.price)).toEqual([25050, 24850]);
            await act(async () => {
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
                other.removeOne(x.id);
            });
            expect(docL.has('mouseup')).toBe(false);
            await act(async () => { lateUp(ev(50, 300)); flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(getDrawings('TXF').map((d) => d.id)).toEqual([y.id]);
            expect(getDrawings('TXF')[0]!.anchors).toEqual(y.anchors);
            expect(api().canUndo).toBe(false);
            expect(other.canUndo).toBe(true);
            await act(async () => other.undo());
            await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(getDrawings('TXF').map((d) => d.id)).toEqual([x.id, y.id]);
            expect(getDrawings('TXF').find((d) => d.id === y.id)!.anchors).toEqual(y.anchors);
            await act(async () => other.redo());
            expect(getDrawings('TXF').map((d) => d.id)).toEqual([y.id]);
            expect(getDrawings('TXF')[0]!.anchors).toEqual(y.anchors);
        } finally { vi.useRealTimers(); }
    });

    it.each(['pending', 'persisted', 'journal'] as const)('另一圖表尚未落地地修改同一個 X，取消拖曳保留對方版本（%s）', async (path) => {
        vi.useFakeTimers();
        try {
            const api = await setup();
            let other!: ChartDrawingsApi;
            await mount({ receive: (v) => (other = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
            let x!: Drawing;
            await act(async () => {
                x = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
                flushDrawingWrites();
            });
            await down(50, 200);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            await act(async () => {
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
                other.setAnchor(x.id, 0, { price: 24900 });
            });
            expect(docL.has('mouseup')).toBe(false);
            await up(50, 100);
            await act(async () => { flushDrawingWrites(); reloadDrawingsFromStorage(); });
            expect(getDrawings('TXF')[0]!.anchors[0]!.price).toBe(24900);
            expect(api().canUndo).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it.each([false, true])('拖曳途中遠端改同物件，不再寫入或建立歷史（墓碑=%s）', async (deleted) => {
        const api = await setup();
        const d = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => flushDrawingWrites());
        await down(50, 200);
        const remote = { ...d, anchors: [{ time: 1000, price: 24900 }], revision: remoteRevision(d) };
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: deleted ? [] : [remote] }));
        if (deleted) store.set('sj-pro-chart-drawing-tombstones', JSON.stringify({ TXF: { [d.id]: { revision: remoteRevision(d), updatedAt: d.updatedAt } } }));
        await act(async () => reloadDrawingsFromStorage());
        await up(50, 150);
        expect(api().canUndo).toBe(false);
        expect(api().canRedo).toBe(false);
        if (deleted) expect(api().drawings).toEqual([]);
        else expect(api().drawings[0]).toMatchObject(remote);
    });

    it.each([false, true])('規則 R 中止拖曳事件與待寫 RAF（低 revision 墓碑=%s）', async (deleted) => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        let queued!: FrameRequestCallback;
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queued = cb; return 7; });
        vi.stubGlobal('cancelAnimationFrame', cancel);
        try {
            const api = await setup();
            const d = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
            await act(async () => flushDrawingWrites());
            await down(50, 200);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            const remote = { ...d, name: '遠端', revision: '0000000000000100:remote' };
            store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
            if (deleted) store.set('sj-pro-chart-drawing-tombstones', JSON.stringify({ TXF: { [d.id]: { revision: '0000000000000001:remote', updatedAt: 1 } } }));
            await act(async () => reloadDrawingsFromStorage());
            expect(cancel).toHaveBeenCalledWith(7);
            expect(docL.has('mousemove')).toBe(false);
            expect(docL.has('mouseup')).toBe(false);
            await act(async () => queued(0));
            await up(50, 100);
            expect(api().drawings).toEqual(deleted ? [] : [remote]);
            expect(api().canUndo).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it.each([
        ['fib', 170, 280], // 左側價位標籤
        ['fib', 70, 220], // 色帶內部
        ['channel', 70, 210], // 通道色帶
        ['text', 70, 209], // 文字框
        ['vertical', 50, 350], // 全高度線段
    ] as const)('未選取 %s 可見區域（%s,%s）阻止委託線接手', async (tool, x, y) => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        try {
            const api = await setup();
            const anchors = tool === 'text' || tool === 'vertical'
                ? [{ time: 1300, price: 25000 }]
                : [{ time: 2200, price: 25100 }, { time: 3400, price: 24900 }, { time: 2200, price: 25050 }];
            const d = addDrawing('TXF', tool, tool === 'fib' ? anchors.slice(0, 2) : anchors, DEFAULT_DRAWING_STYLE, { text: '文字註記測試' })!;
            await act(async () => {});
            // fib 的標籤在錨點 x=200 左邊；其餘工具依各自幾何取點。
            const px = tool === 'fib' && x === 70 ? 260 : tool === 'channel' ? 260 : x;
            expect(api().drawingAt({ clientX: px, clientY: y })).toBe('other');
            expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false, drawingHit: api().drawingAt({ clientX: px, clientY: y }), drawingBusy: api().drawingBusy() })).toBe(false);
            await down(px, y);
            expect(api().selectedIds).toEqual([d.id]);
        } finally { vi.useRealTimers(); }
    });

    it.each(['pending', 'persisted', 'journal'] as const)(
        'Esc 取消拖曳後仍可復原新增／重做（中途 %s）', async (path) => {
            const api = await setup();
            await act(async () => api().setTool('horizontal'));
            await down(50, 200);
            const original = api().drawings[0]!;
            await act(async () => flushDrawingWrites());
            await down(50, 200);
            await act(async () => docL.get('mousemove')?.(ev(50, 150)));
            expect(api().drawings[0]!.anchors[0]!.price).toBe(25050);
            await act(async () => {
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
            });
            const writtenRevision = drawingRevision(api().drawings[0]!);
            const write = vi.spyOn(localStorage, 'setItem');
            write.mockClear();
            const e = await key({ key: 'Escape' });
            expect(e.defaultPrevented).toBe(true);
            await up(50, 100);
            expect(api().drawings[0]!.anchors).toEqual(original.anchors);
            if (path === 'pending') {
                expect(drawingRevision(api().drawings[0]!)).toBe(drawingRevision(original));
                await act(async () => flushDrawingWrites());
                expect(write).not.toHaveBeenCalled();
            } else {
                expect(drawingRevision(api().drawings[0]!) > writtenRevision).toBe(true);
                await act(async () => flushDrawingWrites());
                expect(JSON.parse(store.get('sj-pro-chart-drawings')!).TXF[0].anchors).toEqual(original.anchors);
            }
            expect(api().canUndo).toBe(true);
            await act(async () => api().undo());
            expect(api().drawings).toEqual([]);
            await act(async () => api().redo());
            expect(api().drawings[0]!.anchors).toEqual(original.anchors);
            expect(takeDrawingNotices()).toEqual([]);
            write.mockRestore();
        },
    );

    it('Esc 取消尚未移動的拖曳不產生 revision 或寫入', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 200);
        const original = api().drawings[0]!;
        await act(async () => flushDrawingWrites());
        const write = vi.spyOn(localStorage, 'setItem');
        await down(50, 200);
        await key({ key: 'Escape' });
        await act(async () => flushDrawingWrites());
        expect(api().drawings[0]).toBe(original);
        expect(write).not.toHaveBeenCalled();
        await act(async () => api().undo());
        expect(api().drawings).toEqual([]);
        write.mockRestore();
    });

    it.each(['none', 'pending', 'persisted', 'journal'] as const)(
        'Esc 取消文字編輯恢復原文，仍可復原新增（中途 %s）', async (path) => {
            const api = await setup();
            await act(async () => api().setTool('text'));
            await down(50, 200);
            await act(async () => api().commitText('原文'));
            const original = api().drawings[0]!;
            await act(async () => flushDrawingWrites());
            await act(async () => api().editText(original.id));
            await act(async () => {
                if (path !== 'none') api().setText(original.id, '中途寫入');
                if (path === 'persisted') flushDrawingWrites();
                if (path === 'journal') writeDrawingJournal();
            });
            const midRevision = drawingRevision(api().drawings[0]!);
            const write = vi.spyOn(localStorage, 'setItem');
            await act(async () => api().commitText(null));
            await act(async () => flushDrawingWrites());
            expect(api().drawings[0]!.text).toBe('原文');
            if (path === 'none' || path === 'pending') {
                expect(drawingRevision(api().drawings[0]!)).toBe(drawingRevision(original));
                expect(write).not.toHaveBeenCalled();
            } else {
                expect(drawingRevision(api().drawings[0]!) > midRevision).toBe(true);
            }
            // setText 是另一個本地操作，本輪取消後不會讓它誤判為遠端衝突。
            while (api().canUndo) await act(async () => api().undo());
            expect(api().drawings).toEqual([]);
            expect(takeDrawingNotices()).toEqual([]);
            write.mockRestore();
        },
    );

    it.each([null, '本地輸入'])('文字編輯途中遠端改同物件，結束（%s）不建立歷史或蓋掉遠端', async (value) => {
        const api = await setup();
        const d = addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
        await act(async () => flushDrawingWrites());
        await act(async () => api().editText(d.id));
        const remote = { ...d, text: '遠端輸入', revision: remoteRevision(d) };
        store.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
        await act(async () => reloadDrawingsFromStorage());
        await act(async () => api().commitText(value));
        expect(api().drawings[0]).toMatchObject(remote);
        expect(api().canUndo).toBe(false);
    });

    it('取消既有文字編輯時，期間其他物件的改動不會建立文字歷史', async () => {
        const api = await setup();
        const d = addDrawing('TXF', 'text', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!;
        await act(async () => api().editText(d.id));
        await act(async () => { addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24900 }], DEFAULT_DRAWING_STYLE); });
        await act(async () => api().commitText(null));
        expect(api().drawings[0]!.text).toBe('原文');
        expect(api().canUndo).toBe(false);
    });

    it('量測結果顯示中算「畫圖佔用滑鼠」：委託線只能從把手區拖', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        expect(api().tool).toBeNull();
        expect(api().drawingBusy()).toBe(true);
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false, drawingBusy: true })).toBe(false);
        await key({ key: 'Escape' });
        expect(api().drawingBusy()).toBe(false);
    });

    it('價格標籤依商品跳動價位顯示（TXF 1 點），存的仍是原始值', async () => {
        const api = await setup();
        expect(api().formatPrice(48692.46)).toBe('48,692');
        expect(api().formatPrice(48692.46, false)).toBe('48692');
        await act(async () => api().setTool('trend'));
        await act(async () => api().setTool(null)); // 觸發一次 pushState
        const l = layer as unknown as { formatPrice: (p: number) => string; formatAxis: (p: number) => string };
        expect(l.formatPrice(48692.46)).toBe('48,692');
        expect(l.formatAxis(48692.46)).toBe('48692');
        const f = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000.4 }], DEFAULT_DRAWING_STYLE)!;
        expect(f.anchors[0]!.price).toBe(25000.4);
    });

    it('不透明度：套到選取的物件、記成下一個物件的預設，連續拖動合併成一步復原', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 150);
        expect(api().selected!.style.opacity).toBe(0.85); // 深色主題預設略透明
        for (const o of [0.7, 0.6, 0.5]) await act(async () => api().applyStyle({ opacity: o }));
        expect(api().selected!.style.opacity).toBe(0.5);
        expect(getDrawingSettings().lineOpacity).toBe(0.5);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.style.opacity).toBe(0.85);
    });

    it('物件列表操作：改名、隱藏、鎖定、調整圖層都可復原', async () => {
        const api = await setup();
        const a = addDrawing('TXF', 'trend', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(700, 350); // 取得鍵盤（空白處）
        await act(async () => api().rename(a.id, '  壓力線 '));
        expect(api().drawings[0]!.name).toBe('壓力線');
        await act(async () => api().reorder(b.id, 0));
        expect(api().drawings.map((d) => d.id)).toEqual([b.id, a.id]);
        await act(async () => api().setHidden(a.id, true));
        await act(async () => api().setLocked(a.id, true));
        expect(api().allLocked).toBe(false);
        for (let i = 0; i < 4; i++) await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings.map((d) => d.id)).toEqual([a.id, b.id]);
        expect(api().drawings[0]).toMatchObject({ hidden: false, locked: false });
        expect(api().drawings[0]!.name).toBeUndefined();
    });
});
