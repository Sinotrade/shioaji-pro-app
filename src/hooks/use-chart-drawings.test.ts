import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartDrawings, type ChartDrawingsApi } from './use-chart-drawings';
import { __resetDrawingsForTest, addDrawing, DEFAULT_DRAWING_STYLE } from '../lib/chart-drawings';
import type { ContractBase } from '../lib/types/contract';

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
}: {
    receive: (v: ChartDrawingsApi) => void;
    tradeArmed: boolean;
    onEnterDrawingMode: () => void;
}) {
    receive(
        useChartDrawings({
            contract,
            hostRef: createRef<HTMLDivElement>(),
            chartRef: createRef(),
            seriesRef: createRef(),
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

describe('交易模式與畫圖模式一次只有一種', () => {
    it('選畫圖工具會請頂端解除交易模式', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode });
        await act(async () => api.setTool('trend'));
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
        );
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
