import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartDrawingOverlays, ChartDrawingTools, ChartObjectList, DrawingSettingsDialog, isImeKey, parseLevels, placeFloatingToolbar, placeStylePopover, Popover, PriceInput, TextEditor } from './chart-drawing-tools';
import { escStackDepth } from '../hooks/use-esc-close';
import { __resetDrawingsForTest, addDrawing, DEFAULT_DRAWING_STYLE, flushDrawingWrites, getDrawings, reloadDrawingsFromStorage, takeDrawingNotices } from '../lib/chart-drawings';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';

// 瀏覽器裡 blur() 會同步觸發 onBlur — 替身照做，才重現得出「Esc 之後
// onBlur 看到舊 draft」的時序
let view!: ReactTestRenderer;
const input = () => view.root.findByType('input');
const blurNow = () => ({ blur: () => input().props.onBlur() });

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view.unmount());
    vi.unstubAllGlobals();
});

async function typeThenPress(key: string) {
    const onCommit = vi.fn();
    await act(async () => {
        view = create(createElement(PriceInput, { price: 25000, onCommit }));
    });
    await act(async () => input().props.onFocus());
    await act(async () => input().props.onChange({ target: { value: '25100' } }));
    await act(async () =>
        input().props.onKeyDown({ key, currentTarget: blurNow(), stopPropagation() {} }),
    );
    return onCommit;
}

describe('設定對話框：規則 R 與欄位 diff', () => {
    const storage = new Map<string, string>();
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(10000);
        storage.clear();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => storage.set(k, v),
            removeItem: (k: string) => storage.delete(k),
        });
        __resetDrawingsForTest();
    });
    afterEach(() => vi.useRealTimers());
    async function dialog(tool: 'text' | 'trend' = 'text') {
        const anchors = [{ time: 1000, price: 25000 }, { time: 2000, price: 25100 }];
        const d = addDrawing('TXF', tool, tool === 'text' ? anchors.slice(0, 1) : anchors, DEFAULT_DRAWING_STYLE, { text: '原文' })!;
        flushDrawingWrites();
        const api = { symbolKey: 'TXF', themeMode: 'dark', onInteraction: vi.fn(), rename: vi.fn(), setText: vi.fn(), setAnchor: vi.fn(), setFib: vi.fn(), applyStyle: vi.fn(), formatPrice: String } as unknown as ChartDrawingsApi;
        const onClose = vi.fn();
        await act(async () => { view = create(createElement(DrawingSettingsDialog, { drawing: d, api, onClose })); });
        return { d, api, onClose };
    }

    it.each(['update', 'delete'])('遠端%s同步封住舊文字、名稱、座標與樣式事件並關閉', async (kind) => {
        const { d, api, onClose } = await dialog();
        const text = view.root.findByProps({ 'aria-label': '文字內容' });
        await act(async () => text.props.onChange({ target: { value: '本地待寫文字' } }));
        const staleTextBlur = view.root.findByProps({ 'aria-label': '文字內容' }).props.onBlur;
        const staleName = view.root.findByProps({ 'aria-label': '物件名稱' }).props;
        const staleStyle = view.root.findByProps({ 'aria-label': '線寬 4' }).props.onClick;
        await act(async () => view.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
        const time = view.root.findAllByType('input').find((n) => n.props.type === 'datetime-local')!;
        const staleTime = time.props.onBlur;
        const remote = { ...d, text: '遠端', revision: '0000000000000100:remote' };
        storage.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [remote] }));
        if (kind === 'delete') storage.set('sj-pro-chart-drawing-tombstones', JSON.stringify({ TXF: { [d.id]: { revision: '0000000000000001:remote', updatedAt: 1 } } }));
        await act(async () => {
            reloadDrawingsFromStorage();
            staleTextBlur();
            staleName.onBlur({ target: { value: '本地舊名' } });
            staleName.onKeyDown({ key: 'Enter', currentTarget: { value: '本地舊名' } });
            staleTime({ target: { value: '2026-10-01T12:00' } });
            staleStyle();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        for (const fn of [api.setText, api.rename, api.setAnchor, api.applyStyle]) expect(fn).not.toHaveBeenCalled();
        expect(getDrawings('TXF')).toEqual(kind === 'delete' ? [] : [remote]);
        expect(takeDrawingNotices()).toEqual([expect.stringMatching(/其他視窗.*清除/)]);
    });

    it('文字、名稱、樣式與含秒數的時間未改動，失焦／確定都不寫', async () => {
        const { api, d } = await dialog();
        await act(async () => {
            view.root.findByProps({ 'aria-label': '文字內容' }).props.onBlur();
            const name = view.root.findByProps({ 'aria-label': '物件名稱' }).props;
            name.onBlur({ target: { value: '' } });
            name.onKeyDown({ key: 'Enter', currentTarget: { value: '' } });
            view.root.findByProps({ 'aria-label': `線寬 ${d.style.width}` }).props.onClick();
            view.root.findAllByProps({ role: 'tab' })[1]!.props.onClick();
        });
        const time = view.root.findAllByType('input').find((n) => n.props.type === 'datetime-local')!;
        await act(async () => time.props.onBlur({ target: { value: time.props.defaultValue } }));
        for (const fn of [api.setText, api.rename, api.setAnchor, api.applyStyle]) expect(fn).not.toHaveBeenCalled();
    });

    it('遠端修改別的物件，不中止目前物件的設定編輯', async () => {
        const { d, api, onClose } = await dialog();
        const y = { ...d, id: 'remote-y', text: '遠端 Y', revision: '0000000000000100:remote' };
        storage.set('sj-pro-chart-drawings', JSON.stringify({ TXF: [d, y] }));
        await act(async () => reloadDrawingsFromStorage());
        expect(onClose).not.toHaveBeenCalled();
        const text = view.root.findByProps({ 'aria-label': '文字內容' });
        await act(async () => text.props.onChange({ target: { value: '繼續編輯 X' } }));
        await act(async () => view.root.findByProps({ 'aria-label': '文字內容' }).props.onBlur());
        expect(api.setText).toHaveBeenCalledWith(d.id, '繼續編輯 X');
    });

    it('線寬可選 0.5px（原有 1–4 保留）', async () => {
        const { api } = await dialog('trend');
        for (const w of [0.5, 1, 2, 3, 4]) expect(view.root.findAllByProps({ 'aria-label': `線寬 ${w}` }).length).toBeGreaterThan(0);
        await act(async () => view.root.findByProps({ 'aria-label': '線寬 0.5' }).props.onClick());
        expect(api.applyStyle).toHaveBeenCalledWith({ width: 0.5 });
    });

    it('改價格只提交 price，改時間只提交 time', async () => {
        const { api, d } = await dialog('trend');
        await act(async () => view.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
        const price = view.root.findAllByType(PriceInput)[0]!;
        await act(async () => price.props.onCommit(25123));
        expect(api.setAnchor).toHaveBeenLastCalledWith(d.id, 0, { price: 25123 });
        const time = view.root.findAllByType('input').find((n) => n.props.type === 'datetime-local')!;
        await act(async () => time.props.onBlur({ target: { value: '2026-10-01T12:00' } }));
        expect(api.setAnchor).toHaveBeenLastCalledWith(d.id, 0, { time: new Date('2026-10-01T12:00').getTime() / 1000 });
    });
});

describe('物件列表：K 棒前方／後方與 0.5px 線寬', () => {
    const mk = (id: string, tool: 'trend' | 'text', behind?: boolean) => ({
        id, tool, anchors: [], style: DEFAULT_DRAWING_STYLE, locked: false, hidden: false, createdAt: 0, updatedAt: 0,
        ...(behind ? { behind: true } : {}),
    });
    it('線類物件有前方／後方按鈕並切換；文字註記沒有', async () => {
        const setBehind = vi.fn();
        const api = {
            objectListOpen: true, selectedIds: [], onInteraction: vi.fn(), focusChart: vi.fn(), setBehind,
            drawings: [mk('front', 'trend'), mk('back', 'trend', true), mk('note', 'text')],
        } as unknown as ChartDrawingsApi;
        await act(async () => { view = create(createElement(ChartObjectList, { api })); });
        const btn = (label: string) => view.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === label);
        const toBack = btn('趨勢線 移到 K 棒後方');
        const toFront = btn('趨勢線 移到 K 棒前方');
        expect(toBack).toHaveLength(1);
        expect(toFront).toHaveLength(1);
        expect(view.root.findAll((n) => n.type === 'button' && /文字.*K 棒/.test(String(n.props['aria-label'])))).toHaveLength(0);
        await act(async () => toBack[0]!.props.onClick({ stopPropagation() {} }));
        await act(async () => toFront[0]!.props.onClick({ stopPropagation() {} }));
        expect(setBehind.mock.calls).toEqual([['front', true], ['back', false]]);
    });
});

describe('水平線價格輸入', () => {
    it('Esc 還原，不套用打到一半的價格', async () => {
        const onCommit = await typeThenPress('Escape');
        expect(onCommit).not.toHaveBeenCalled();
        expect(input().props.value).toBe('25000');
    });

    it('Enter 只套用一次', async () => {
        const onCommit = await typeThenPress('Enter');
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(25100);
    });

    it('點別處（失焦）照常套用', async () => {
        const onCommit = vi.fn();
        await act(async () => {
            view = create(createElement(PriceInput, { price: 25000, onCommit }));
        });
        await act(async () => input().props.onFocus());
        await act(async () => input().props.onChange({ target: { value: '25100' } }));
        await act(async () => input().props.onBlur());
        expect(onCommit).toHaveBeenCalledWith(25100);
    });
});

describe('樣式面板的位置：不被 K 線面板裁切，每個控制項都點得到', () => {
    const vp = { width: 1600, height: 1000 };

    it('放得下時貼在樣式鈕右側、與它頂端對齊', () => {
        expect(placeStylePopover({ top: 200, right: 300 }, 380, vp, 240)).toMatchObject({
            position: 'fixed',
            top: 200,
            left: 306,
        });
    });

    it('樣式鈕靠近視窗下緣（預設版面、426px 矮面板）時往上推，整個面板留在視窗內', () => {
        const pos = placeStylePopover({ top: 900, right: 300 }, 380, vp, 240);
        expect(pos.top).toBe(1000 - 8 - 380);
        expect((pos.top as number) + 380).toBeLessThanOrEqual(1000 - 8);
    });

    it('視窗比面板還矮時限高（面板內捲動），頂端不跑出視窗', () => {
        const pos = placeStylePopover({ top: 300, right: 300 }, 900, { width: 1600, height: 426 }, 240);
        expect(pos.top).toBe(8);
        expect(pos.maxHeight).toBe(426 - 16);
    });

    it('右側放不下時往左收，不超出視窗', () => {
        const pos = placeStylePopover({ top: 100, right: 1500 }, 300, vp, 240);
        expect((pos.left as number) + 240).toBeLessThanOrEqual(1600 - 8);
    });
});

describe('彈出層（工具組、色盤、線寬）：Esc 與點外面關閉', () => {
    const keyListeners = new Set<(e: KeyboardEvent) => void>();
    const downListeners = new Set<(e: Event) => void>();
    let active: unknown = null;
    const popChild = { tagName: 'BUTTON' };
    const priceInput = { tagName: 'INPUT' };

    const anchorEl = { tagName: 'BUTTON' };
    const anchor = {
        contains: (n: unknown) => n === anchorEl,
        getBoundingClientRect: () => ({ top: 0, right: 0 }),
        ownerDocument: {
            get activeElement() {
                return active;
            },
            addEventListener: (t: string, l: (e: Event) => void) => {
                if (t === 'pointerdown') downListeners.add(l);
            },
            removeEventListener: (t: string, l: (e: Event) => void) => void downListeners.delete(l),
        },
    } as unknown as HTMLElement;

    beforeEach(() => {
        keyListeners.clear();
        downListeners.clear();
        active = null;
        vi.stubGlobal('window', {
            addEventListener: (t: string, l: (e: KeyboardEvent) => void) => {
                if (t === 'keydown') keyListeners.add(l);
            },
            removeEventListener: (t: string, l: (e: KeyboardEvent) => void) =>
                void keyListeners.delete(l),
        });
    });

    function esc() {
        const e = { key: 'Escape', repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const l of [...keyListeners]) l(e as unknown as KeyboardEvent);
        return e;
    }

    async function openPop() {
        const onClose = vi.fn();
        await act(async () => {
            view = create(
                createElement(Popover, { anchor, onClose, onInteraction: vi.fn(), label: '測試', children: null }),
                // popRef 需要一個 contains()：面板內的元素只有 popChild 與 priceInput
                { createNodeMock: () => ({ contains: (n: unknown) => n === popChild || n === priceInput, ownerDocument: anchor.ownerDocument, scrollHeight: 300, offsetWidth: 240 }) },
            );
        });
        return onClose;
    }

    it('開著時入 modal stack；Esc 關閉並吃掉這一下（不算進 Esc×2 全部刪單）', async () => {
        const onClose = await openPop();
        expect(escStackDepth()).toBe(1);
        let e!: ReturnType<typeof esc>;
        await act(async () => {
            e = esc();
        });
        expect(onClose).toHaveBeenCalledWith('esc');
        expect(e.defaultPrevented).toBe(true);
    });

    it('價格輸入框裡的 Esc 只還原輸入，不關面板', async () => {
        const onClose = await openPop();
        active = priceInput;
        await act(async () => {
            esc();
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('點面板或樣式鈕不關，點外面任何地方都關', async () => {
        const onClose = await openPop();
        const down = (target: unknown) => {
            for (const l of [...downListeners]) l({ target } as unknown as Event);
        };
        await act(async () => down(popChild));
        await act(async () => down(anchorEl));
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => down({ tagName: 'DIV' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        // 點外面關閉：不把焦點搶回圖表（呼叫端依 reason 決定）
        expect(onClose).toHaveBeenCalledWith('outside');
    });
});

describe('浮動物件工具列的位置：留在圖表內，放不下就翻面', () => {
    const host = { width: 800, height: 400 };
    const bar = { width: 220, height: 30 };

    it('預設在物件上方置中', () => {
        expect(placeFloatingToolbar({ left: 300, top: 200, right: 500, bottom: 260 }, bar, host)).toEqual({
            left: 290,
            top: 162,
            flipped: false,
        });
    });

    it('物件貼近上緣時翻到下方', () => {
        const p = placeFloatingToolbar({ left: 300, top: 10, right: 500, bottom: 60 }, bar, host);
        expect(p.flipped).toBe(true);
        expect(p.top).toBe(68);
    });

    it('上下都放不下（物件佔滿整個高度）時壓在圖表內', () => {
        const p = placeFloatingToolbar({ left: 300, top: 0, right: 500, bottom: 400 }, bar, host);
        expect(p.top).toBeGreaterThanOrEqual(4);
        expect(p.top + bar.height).toBeLessThanOrEqual(host.height - 4);
    });

    it('左右夾在圖表內（水平線橫跨整個畫面、物件跑出畫面）', () => {
        expect(placeFloatingToolbar({ left: -500, top: 200, right: 20, bottom: 200 }, bar, host).left).toBe(4);
        expect(placeFloatingToolbar({ left: 780, top: 200, right: 2000, bottom: 200 }, bar, host).left).toBe(800 - 220 - 4);
    });
});

describe('斐波那契比例輸入', () => {
    it('逗號、空白、全形逗號都能分隔，忽略看不懂的字', () => {
        expect(parseLevels('0, 0.236，0.382 0.5、abc, 1')).toEqual([0, 0.236, 0.382, 0.5, 1]);
        expect(parseLevels('')).toEqual([]);
    });
});

describe('輸入法組字中的 Enter／Esc 不算完成或取消', () => {
    it('isImeKey：isComposing 或 keyCode 229', () => {
        expect(isImeKey({ nativeEvent: { isComposing: true } })).toBe(true);
        expect(isImeKey({ keyCode: 229 })).toBe(true);
        expect(isImeKey({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    });

    it('文字註記：選字的 Enter 不提交，組字結束後的 Enter 才提交', async () => {
        const onCommit = vi.fn();
        await act(async () => {
            view = create(createElement(TextEditor, { initial: '', box: { left: 0, top: 0 }, onCommit, onInteraction: vi.fn() }));
        });
        const ta = () => view.root.findByType('textarea');
        await act(async () => ta().props.onChange({ target: { value: '月線' } }));
        const ev = (extra: object) => ({ key: 'Enter', shiftKey: false, preventDefault() {}, stopPropagation() {}, ...extra });
        await act(async () => ta().props.onKeyDown(ev({ nativeEvent: { isComposing: true }, keyCode: 229 })));
        expect(onCommit).not.toHaveBeenCalled();
        await act(async () => ta().props.onKeyDown(ev({ nativeEvent: { isComposing: false }, keyCode: 13 })));
        expect(onCommit).toHaveBeenCalledWith('月線');
    });
});

describe('工具列提示：按鈕消失或按下後提示跟著消失（不殘留在圖上）', () => {
    const drawing = (locked = false) => ({
        id: 'b1', tool: 'box', anchors: [], style: DEFAULT_DRAWING_STYLE, locked, hidden: false, createdAt: 0, updatedAt: 0,
    });
    const overlaysApi = (selected: ReturnType<typeof drawing> | null, extra: Partial<ChartDrawingsApi> = {}) =>
        ({
            symbolKey: 'TXF', tool: null, editingTextId: null, drawings: selected ? [selected] : [],
            selected, selectedList: selected ? [selected] : [], selectedIds: selected ? [selected.id] : [],
            selectionBox: selected ? { left: 100, top: 100, right: 200, bottom: 200 } : null,
            hostSize: { width: 800, height: 600 }, style: DEFAULT_DRAWING_STYLE,
            onInteraction: vi.fn(), focusChart: vi.fn(), remove: vi.fn(), toggleLock: vi.fn(), toggleHidden: vi.fn(),
            duplicate: vi.fn(), toggleBehind: vi.fn(), applyStyle: vi.fn(),
            ...extra,
        }) as unknown as ChartDrawingsApi;
    const target = { getBoundingClientRect: () => ({ right: 10, top: 10, height: 20 }) };
    const tooltips = () => view.root.findAll((n) => n.props.role === 'tooltip' && typeof n.type === 'string');
    const btn = (label: string) => view.root.find((n) => n.type === 'button' && n.props['aria-label'] === label);
    const hover = async (label: string) => {
        await act(async () => btn(label).props.onMouseEnter({ currentTarget: target }));
        expect(tooltips()).toHaveLength(1);
    };
    const render = async (api: ChartDrawingsApi) => {
        await act(async () => {
            if (view) view.update(createElement(ChartDrawingOverlays, { api }));
        });
    };
    beforeEach(async () => {
        await act(async () => { view = create(createElement(ChartDrawingOverlays, { api: overlaysApi(drawing()) })); });
    });

    it('hover 刪除鈕 → 點擊刪除（工具列隨選取消失）→ 提示不存在', async () => {
        await hover('刪除');
        expect(tooltips()[0]!.props.children).toBe('刪除（Delete／Backspace）');
        await act(async () => btn('刪除').props.onPointerDown?.({ button: 0 }));
        await act(async () => btn('刪除').props.onClick());
        await render(overlaysApi(null));
        expect(view.root.findAll((n) => n.props.role === 'toolbar')).toHaveLength(0);
        expect(tooltips()).toHaveLength(0);
    });

    it('hover 刪除鈕時按 Delete／Backspace 刪除（沒有 mouseleave）→ 提示不存在', async () => {
        await hover('刪除');
        await render(overlaysApi(null));
        expect(tooltips()).toHaveLength(0);
    });

    it.each(['隱藏', '複製', '設定', '顏色'])('hover %s → 工具列消失 → 提示不存在', async (label) => {
        await hover(label);
        await render(overlaysApi(null));
        expect(tooltips()).toHaveLength(0);
    });

    it('hover 鎖定 → 點擊（按鈕變成「解鎖」）→ 舊提示「鎖定」不殘留', async () => {
        await hover('鎖定');
        await act(async () => btn('鎖定').props.onPointerDown?.({ button: 0 }));
        await act(async () => btn('鎖定').props.onClick());
        await render(overlaysApi(drawing(true)));
        expect(btn('解鎖')).toBeTruthy();
        expect(tooltips()).toHaveLength(0);
    });

    it('進入畫圖或文字編輯（工具列收起）→ 提示不存在', async () => {
        await hover('複製');
        await render(overlaysApi(drawing(), { tool: 'trend' } as Partial<ChartDrawingsApi>));
        expect(tooltips()).toHaveLength(0);
    });

    it('左側工具列：hover 清除全部 → 點擊 → 提示不存在', async () => {
        const toolsApi = {
            tool: null, drawings: [drawing()], favorites: [], groupLast: {}, magnet: false, allLocked: false,
            canUndo: false, canRedo: false, objectListOpen: false,
            onInteraction: vi.fn(), focusChart: vi.fn(), clearAll: vi.fn(), setTool: vi.fn(),
        } as unknown as ChartDrawingsApi;
        await act(async () => { view.update(createElement(ChartDrawingTools, { api: toolsApi })); });
        await hover('清除全部');
        await act(async () => btn('清除全部').props.onPointerDown?.({ button: 0 }));
        await act(async () => btn('清除全部').props.onClick());
        await act(async () => { view.update(createElement(ChartDrawingTools, { api: { ...toolsApi, drawings: [] } })); });
        expect(tooltips()).toHaveLength(0);
    });

    it('點任何地方（例如開啟圖表下單設定、指標等彈出面板）→ 殘留提示收掉', async () => {
        const listeners = new Map<string, (e: unknown) => void>();
        const doc = {
            addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
            removeEventListener: (t: string) => listeners.delete(t),
        };
        await act(async () => btn('複製').props.onMouseEnter({ currentTarget: { ...target, ownerDocument: doc } }));
        expect(tooltips()).toHaveLength(1);
        await act(async () => listeners.get('pointerdown')?.({ target: {} }));
        expect(tooltips()).toHaveLength(0);
        expect(listeners.has('pointerdown')).toBe(false);
    });
});
