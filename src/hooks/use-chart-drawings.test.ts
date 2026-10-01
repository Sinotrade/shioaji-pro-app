import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartHasFocus,
    inOrderLabelArea,
    orderLineMayTakePointer,
    useChartDrawings,
    type ChartDrawingsApi,
} from './use-chart-drawings';
import {
    __resetDrawingsForTest,
    addDrawing,
    DEFAULT_DRAWING_STYLE,
    getDrawingSettings,
    TOOL_DEFAULT_COLORS,
} from '../lib/chart-drawings';
import type { ContractBase } from '../lib/types/contract';
import { useHotkeys } from './use-hotkeys';
import { AXIS_LABEL_H, axisLabelBox } from '../lib/chart-drawing-layer';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';

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
    const hostRef = createRef<HTMLDivElement>();
    (hostRef as { current: unknown }).current = host ?? null;
    receive(
        useChartDrawings({
            contract,
            hostRef,
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
        vi.stubGlobal('document', { activeElement: null });
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

    it('選取中按 Esc 取消選取並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
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
        receive(
            useChartDrawings({
                contract: { code, security_type: code === '2330' ? 'STK' : 'FUT' } as ContractBase,
                themeMode,
                hostRef: { current: host as unknown as HTMLDivElement },
                chartRef: { current: { applyOptions() {} } as never },
                seriesRef: { current: series as never },
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

    it('武裝點價買賣時，按在畫圖物件上不攔截 — 這一下要變成下單', async () => {
        const api = await setup(true);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine();
        });
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(e.stopPropagation).not.toHaveBeenCalled();
        expect(api().selected).toBeNull();
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
