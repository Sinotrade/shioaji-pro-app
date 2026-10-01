// src/hooks/use-chart-drawings.ts — K 線圖畫圖工具的互動控制
//
// 把「畫、選、拖、刪」的滑鼠與鍵盤處理從 candle-chart.tsx 拉出來；
// 幾何與儲存分別在 lib/chart-drawing-geometry.ts 與 lib/chart-drawings.ts，
// 這裡只負責把兩者接上圖表與事件。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import {
    addDrawing,
    clearDrawings,
    defaultStyleFor,
    drawingSymbolKey,
    duplicateDrawing,
    removeDrawing,
    setDrawingSettings,
    showAllDrawings,
    updateDrawing,
    useDrawings,
    useDrawingSettings,
    type Drawing,
    type DrawingAnchor,
    type DrawingStyle,
    DRAWING_TOOLS,
    type DrawingSettings,
    type DrawingThemeMode,
    type DrawingTool,
} from '../lib/chart-drawings';
import {
    dragPoints,
    pickDrawing,
    unprojectPoint,
    type DragPlan,
    type Point,
    type Projector,
} from '../lib/chart-drawing-geometry';
import { DrawingLayer, type DrawingDraft } from '../lib/chart-drawing-layer';
import { escStackDepth } from './use-esc-close';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import type { ContractBase } from '../lib/types/contract';
import { roundToTick } from '../lib/utils/ticksize';

// 複製出來的物件往右下偏這麼多像素 — 一眼看得出是兩個物件
const DUPLICATE_OFFSET_PX = 24;

// 鍵盤（Delete／Esc）同一時間只歸一張圖：最後被點、或最後選取／武裝工具
// 的那張。每個 K 線面板都在 window 上聽 keydown，不這樣做的話按一下
// Delete，每張圖都會刪掉自己選取中的物件。失去鍵盤的圖同時放掉選取與
// 工具，畫面上不會出現「看起來選著、按鍵卻不歸它」的物件。
let keyOwner: object | null = null;
const keyOwnerListeners = new Set<() => void>();

function claimKeyboard(token: object) {
    if (keyOwner === token) return;
    keyOwner = token;
    for (const l of keyOwnerListeners) l();
}

// 委託線（改價拖曳）可不可以接手這一下滑鼠。只有瀏覽模式才讓委託線
// 優先：武裝畫圖工具時，使用者要的是在那個價位畫線，按住稍微移動就
// 送出改價會直接動到真實委託。
//
// 瀏覽模式下畫圖物件與委託線重疊時，使用者以為在拖畫圖、放開卻送出
// 改價 — 所以：
// - 游標下是「選取中」的畫圖物件：委託線絕不接手
// - 游標下有畫圖物件，或有物件選取中：委託線只能從它自己的價格標籤
//   （價格軸上的「買1 47,000」標籤）拖；繪圖區裡的任何一段都交給畫圖 —
//   繪圖區內不設把手帶，畫圖物件延伸到那裡時一樣不會被委託線搶走
// - 游標下什麼畫圖都沒有、也沒選取：照舊整條線都能拖
export type DrawingHit = 'selected' | 'other' | null;

export function orderLineMayTakePointer(opts: {
    drawingArmed: boolean;
    defaultPrevented: boolean;
    drawingHit?: DrawingHit;
    drawingBusy?: boolean; // 有畫圖物件選取中（第二版還含顯示中的量測）
    inGrip?: boolean; // 游標在委託線的價格標籤上（價格軸區，見 inOrderLabelArea）
    // 價格軸上：游標在畫圖物件自己畫的價格標籤範圍內（範圍確切已知，
    // 見 DrawingLayer.axisLabelRects；標籤不參與函式庫的防重疊，不會被推走）
    drawingLabelAtPointer?: boolean;
}): boolean {
    if (opts.drawingArmed || opts.defaultPrevented) return false;
    if (opts.drawingHit === 'selected') return false;
    if (opts.inGrip) return !opts.drawingLabelAtPointer;
    return !opts.drawingHit && !opts.drawingBusy;
}

// 游標是否在委託線價格標籤所在的價格軸區（host 內 x 座標）。只有價格軸
// 本身，不含繪圖區 — 畫圖物件只畫在繪圖區，兩者不會重疊
export function inOrderLabelArea(xInHost: number, hostWidth: number, axisWidth: number): boolean {
    return axisWidth > 0 && xInHost >= hostWidth - axisWidth;
}

// 鍵盤焦點是否在這張圖（圖表本體或它的左側工具列）上。Delete／Backspace
// 只在這時作用 — 「最後操作的圖表」不夠：選取物件後點了別的面板的按鈕，
// 按 Delete 不該刪掉圖上的物件。
export function chartHasFocus(scope: { contains(n: Node | null): boolean } | null): boolean {
    if (!scope || typeof document === 'undefined') return false;
    const active = document.activeElement;
    return !!active && scope.contains(active);
}

export interface ChartDrawingsApi {
    tool: DrawingTool | null;
    setTool: (t: DrawingTool | null) => void;
    drawings: Drawing[];
    selected: Drawing | null;
    select: (id: string | null) => void;
    style: DrawingStyle; // 選取中物件的樣式，沒選取時是下一個新物件的預設
    applyStyle: (patch: Partial<DrawingStyle>) => void;
    toggleLock: () => void;
    toggleHidden: () => void;
    duplicate: () => void;
    remove: () => void;
    clearAll: () => void;
    showAll: () => void;
    // 水平線可直接輸入精確價格（拖曳只能拖到游標所在的價位）
    setSelectedPrice: (price: number) => void;
    symbolKey: string;
    shareContinuousMonth: boolean;
    setShareContinuousMonth: (v: boolean) => void;
    // 點工具列時把鍵盤焦點交回圖表（WebKit 點按鈕不會給它焦點）
    focusChart: () => void;
    // 委託線拖曳判斷用：游標下有沒有畫圖物件（選取中／其他）、有沒有
    // 物件選取中
    drawingAt: (ev: { clientX: number; clientY: number }) => DrawingHit;
    drawingBusy: () => boolean;
    // 游標（clientY）是否在畫圖物件的價格軸標籤範圍內
    drawingLabelAt: (clientY: number) => boolean;
}

export function useChartDrawings(opts: {
    contract: ContractBase;
    hostRef: React.RefObject<HTMLDivElement | null>;
    chartRef: React.RefObject<IChartApi | null>;
    seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
    getTimes: () => number[];
    // 交易模式（點價買賣／停損／停利／警示）武裝時交出滑鼠 — 那一下
    // 點擊屬於下單，畫圖不能攔截
    tradeArmed: boolean;
    // 使用者動了左側工具列 = 要回畫圖／瀏覽模式，請頂端解除交易模式。
    // 兩種模式一次只能有一種生效。
    onEnterDrawingMode: () => void;
    // 新物件的預設色依主題挑（深色底與淺色底同一色相的深淺不同）
    themeMode?: DrawingThemeMode;
}): ChartDrawingsApi {
    const { contract, hostRef, chartRef, seriesRef, getTimes, tradeArmed } = opts;
    const themeMode = opts.themeMode ?? 'dark';

    const settings = useDrawingSettings();
    const symbolKey = drawingSymbolKey(contract, settings.shareContinuousMonth);
    const drawings = useDrawings(symbolKey);
    const [tool, setTool] = useState<DrawingTool | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [token] = useState(() => ({}));

    // 高頻狀態（繪製中的第二點跟著游標跑）走 ref 直接推給 layer，
    // 不經過 React state — 每次 mousemove 重繪整棵樹太貴
    const draftRef = useRef<DrawingDraft | null>(null);
    const layerRef = useRef<DrawingLayer | null>(null);

    // 事件處理器裡要讀的最新值
    const stateRef = useRef({ tool, selectedId, drawings, symbolKey, settings, tradeArmed, contract, themeMode });
    stateRef.current = { tool, selectedId, drawings, symbolKey, settings, tradeArmed, contract, themeMode };

    const getTimesRef = useRef(getTimes);
    getTimesRef.current = getTimes;

    // ── layer 掛載 ───────────────────────────────────────────────────
    // 注意：這個 effect 必須在 candle-chart 建立圖表的 effect 之後註冊
    // （同一個元件內 effect 依宣告順序執行），seriesRef 才已經有值。
    useEffect(() => {
        const series = seriesRef.current;
        if (!series) return;
        const layer = new DrawingLayer(() => getTimesRef.current());
        series.attachPrimitive(layer);
        layerRef.current = layer;
        return () => {
            // 卸載時建立圖表的 effect 先清理（effect cleanup 同樣依宣告
            // 順序），chart.remove() 已經把 series 連同 primitive 一起丟掉，
            // 這時再 detach 會對已釋放的物件丟例外 — 整個面板會卸不掉
            try {
                series.detachPrimitive(layer);
            } catch {
                // 圖表已銷毀，primitive 也隨之消失
            }
            layerRef.current = null;
        };
    }, [seriesRef]);

    const pushState = useCallback(() => {
        layerRef.current?.setState({
            drawings: stateRef.current.drawings,
            draft: draftRef.current,
            selectedId: stateRef.current.selectedId,
            hoverId: null,
        });
    }, []);

    // 資料／選取變動時重繪；draft 變動時由事件處理器自己呼叫 pushState
    useEffect(pushState, [pushState, drawings, selectedId]);

    // 切換商品時清掉選取與繪製中的物件 — 殘留的 draft 會被畫到新商品上。
    // 立刻重繪：選取／工具本來就是 null 時 state 不變，不會再觸發上面的
    // 重繪 effect，畫到一半的草稿就會留在新商品的圖上
    useEffect(() => {
        draftRef.current = null;
        setSelectedId(null);
        setTool(null);
        pushState();
    }, [symbolKey, pushState]);

    // ── 滑鼠 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const layerOf = () => layerRef.current;

        // 水平線是使用者會拿來讀價的線 — 吸附到合法跳動價位；
        // 趨勢線／方框這種造型物件不吸附，免得斜率被量化得歪掉
        const snapPrice = (which: DrawingTool, price: number) =>
            which === 'horizontal' ? roundToTick(stateRef.current.contract, price) : price;

        // 每個事件只建一次 projector（呼叫端傳進來），不在每個小函式裡重建
        const anchorAt = (projector: Projector, pt: Point, t: DrawingTool): DrawingAnchor | null => {
            const anchor = unprojectPoint(projector, pt);
            if (!anchor) return null;
            return { time: anchor.time, price: snapPrice(t, anchor.price) };
        };

        const pick = (projector: Projector, pt: Point) => {
            const layer = layerOf();
            if (!layer) return null;
            return pickDrawing(stateRef.current.drawings, projector, layer.paneSize, pt);
        };

        let drag: { id: string; tool: DrawingTool; plan: DragPlan } | null = null;
        let activeMove: ((e: MouseEvent) => void) | null = null;
        let activeUp: ((e: MouseEvent) => void) | null = null;
        // 拖曳中的 mousemove 合併到下一個 animation frame 才寫進 store —
        // 每寫一次所有訂閱的圖都要重繪，滑鼠事件頻率遠高於畫面更新率
        let pendingPt: Point | null = null;
        let frame: number | null = null;
        const raf =
            typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (cb: FrameRequestCallback) => (cb(0), 0);
        const cancelRaf = (id: number) => {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
        };

        // 只收回自己設的游標（委託線的 ns-resize 由它自己管）
        const resetHoverCursor = () => {
            const c = host.style.cursor;
            if (c === 'grab' || c === 'move' || c === 'pointer' || c === 'crosshair') {
                host.style.cursor = '';
            }
        };

        const focusHost = () => {
            if (typeof host.focus !== 'function') return;
            if (host.tabIndex < 0 && !host.hasAttribute?.('tabindex')) host.tabIndex = -1;
            host.focus({ preventScroll: true });
        };

        const setChartInteractive = (on: boolean) =>
            chartRef.current?.applyOptions({ handleScroll: on, handleScale: on });

        const commitDrag = (pt: Point) => {
            if (!drag) return;
            const layer = layerOf();
            const projector = layer?.projector();
            if (!projector) return;
            const moved = dragPoints(drag.plan, pt);
            const anchors: DrawingAnchor[] = [];
            for (const p of moved) {
                const a = anchorAt(projector, p, drag.tool);
                if (!a) return; // 投影不出來就整筆放棄，不寫半套座標
                anchors.push(a);
            }
            updateDrawing(stateRef.current.symbolKey, drag.id, { anchors });
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0) return;
            claimKeyboard(token);
            // 圖表本體取得鍵盤焦點 — Delete 只在焦點還在這張圖時作用
            focusHost();
            // 交易模式武裝中：這一下是點價下單，畫圖物件不能攔（選取、拖曳
            // 都會吃掉事件，圖表的 click 就不會觸發）
            if (stateRef.current.tradeArmed) return;
            // 委託線拖曳（同一個 host 上先註冊的 handler）已經吃掉這一下
            if (e.defaultPrevented) return;
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            const projector = layer?.projector();
            if (!layer || !pt || !projector) return;
            const armed = stateRef.current.tool;

            if (armed) {
                e.preventDefault();
                e.stopPropagation(); // 這一下屬於畫圖，不要變成平移或點價
                const anchor = anchorAt(projector, pt, armed);
                if (!anchor) return;
                const draft = draftRef.current;
                const style = defaultStyleFor(
                    stateRef.current.settings,
                    armed,
                    stateRef.current.themeMode,
                );
                if (armed === 'horizontal') {
                    const created = addDrawing(stateRef.current.symbolKey, armed, [anchor], style);
                    draftRef.current = null;
                    setTool(null); // 與圖表既有的交易模式一樣是一次性
                    if (created) setSelectedId(created.id);
                    return;
                }
                if (!draft) {
                    // 第一點：第二點先跟第一點重合，之後跟著游標跑
                    draftRef.current = {
                        tool: armed,
                        anchors: [anchor, { ...anchor }],
                        style,
                    };
                    pushState();
                    return;
                }
                const created = addDrawing(
                    stateRef.current.symbolKey,
                    draft.tool,
                    [draft.anchors[0]!, anchor],
                    draft.style,
                );
                draftRef.current = null;
                setTool(null);
                if (created) setSelectedId(created.id);
                return;
            }

            const picked = pick(projector, pt);
            if (!picked) {
                // 空白處按下 = 取消選取，但不攔截 — 圖表照常可以平移
                if (stateRef.current.selectedId) setSelectedId(null);
                return;
            }
            setSelectedId(picked.drawing.id);
            if (picked.drawing.locked) {
                // 選起來就好，不攔截這一下 — 大面積的鎖定方框若吃掉事件，
                // 在它上面就再也拖不動圖表了。鎖定＝不能動它，不是不能
                // 動圖表
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            setChartInteractive(false);
            drag = {
                id: picked.drawing.id,
                tool: picked.drawing.tool,
                plan: { hit: picked.hit, startPoints: picked.points, startAt: pt },
            };

            const move = (ev: MouseEvent) => {
                const p = layerOf()?.pointOf(ev);
                if (!p) return;
                pendingPt = p;
                frame ??= raf(() => {
                    frame = null;
                    const at = pendingPt;
                    pendingPt = null;
                    if (at) commitDrag(at);
                });
            };
            const up = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                activeMove = null;
                activeUp = null;
                if (frame !== null) cancelRaf(frame);
                frame = null;
                pendingPt = null;
                const p = layerOf()?.pointOf(ev);
                if (p) commitDrag(p);
                drag = null;
                setChartInteractive(true);
            };
            document.addEventListener('mousemove', move, true);
            document.addEventListener('mouseup', up, true);
            activeMove = move;
            activeUp = up;
        };

        const hover = (e: MouseEvent) => {
            if (drag || stateRef.current.tradeArmed) return;
            const draft = draftRef.current;
            const armed = stateRef.current.tool;
            // 熱路徑：沒有草稿、沒武裝工具、也沒有看得到的物件時什麼都
            // 不用算（hover 游標只跟物件有關）
            if (!draft && !armed && !stateRef.current.drawings.some((d) => !d.hidden)) {
                resetHoverCursor();
                return;
            }
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            const projector = layer?.projector();
            if (!layer || !pt || !projector) return;
            if (draft) {
                // 繪製中：第二點跟著游標
                const anchor = anchorAt(projector, pt, draft.tool);
                if (anchor) {
                    draftRef.current = { ...draft, anchors: [draft.anchors[0]!, anchor] };
                    pushState();
                }
                return;
            }
            if (armed) {
                host.style.cursor = 'crosshair';
                return;
            }
            // 委託線拖曳的 handler 先跑且在 mousedown 有優先權（它會
            // preventDefault）。它把游標設成 ns-resize 時就別蓋掉，不然
            // 游標顯示的是畫圖、按下去卻是改價
            if (host.style.cursor === 'ns-resize') return;
            const picked = pick(projector, pt);
            if (picked) {
                // 鎖定的物件點得到但拖不動 — 游標用 pointer 表示「可選取」，
                // 不要用 move／grab 暗示可以拖
                host.style.cursor = picked.drawing.locked
                    ? 'pointer'
                    : picked.hit.kind === 'anchor'
                      ? 'grab'
                      : 'move';
            } else {
                resetHoverCursor();
            }
        };

        host.addEventListener('mousedown', down, true);
        host.addEventListener('mousemove', hover, true);
        return () => {
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
            if (activeMove) document.removeEventListener('mousemove', activeMove, true);
            if (activeUp) document.removeEventListener('mouseup', activeUp, true);
            if (frame !== null) cancelRaf(frame);
            if (drag) setChartInteractive(true); // 拖曳中被卸載 — 別讓圖表卡住
        };
    }, [hostRef, chartRef, pushState, token]);

    // 交易模式武裝時收起畫圖工具並取消選取：兩者不會同時吃同一下點擊，
    // 武裝點價買賣時按 Delete 也不會刪到剛才選著的畫圖物件
    useEffect(() => {
        if (!tradeArmed) return;
        if (tool || draftRef.current) {
            draftRef.current = null;
            setTool(null);
            pushState();
        }
        if (selectedId) setSelectedId(null);
    }, [tradeArmed, tool, selectedId, pushState]);

    // ── 鍵盤 ─────────────────────────────────────────────────────────
    const hasFocusState = !!(tool || selectedId);

    // 選取或武裝工具（含從左側工具列）就接手鍵盤
    useEffect(() => {
        if (hasFocusState) claimKeyboard(token);
    }, [hasFocusState, token]);

    // 別張圖接手時放掉自己的選取與工具
    useEffect(() => {
        const onOwnerChange = () => {
            if (keyOwner === token) return;
            draftRef.current = null;
            setTool(null);
            setSelectedId(null);
            pushState();
        };
        keyOwnerListeners.add(onOwnerChange);
        return () => {
            keyOwnerListeners.delete(onOwnerChange);
            if (keyOwner === token) keyOwner = null;
        };
    }, [token, pushState]);

    // 沒有選取也沒有工具時不掛 listener — 鍵盤完全不經過這張圖
    useEffect(() => {
        if (!hasFocusState) return;
        const onKey = (e: KeyboardEvent) => {
            if (keyOwner !== token) return;
            // modal 開著時鍵盤歸 modal — Esc 關視窗、Delete 不該穿透到
            // 後面圖上的畫圖物件
            if (escStackDepth() > 0) return;
            const target = e.target as HTMLElement | null;
            // 在輸入框裡的 Backspace 是刪字，不是刪物件
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable)
            ) {
                return;
            }
            if (e.key === 'Escape') {
                // 已被 modal 的 Esc 收走就不重複處理
                if (e.defaultPrevented) return;
                // 畫圖 UI 用掉的 Esc 一律吃掉（preventDefault）並清掉 Esc×2
                // 的「第一下」：use-hotkeys 看到 defaultPrevented 就不算、
                // 也不會跟更早的一下湊成兩下。連按兩下 Esc 確保取消畫圖／
                // 取消選取是很自然的習慣，這兩下絕不能變成撤掉全部委託。
                if (draftRef.current || stateRef.current.tool) {
                    draftRef.current = null;
                    setTool(null);
                    pushState();
                } else if (stateRef.current.selectedId) {
                    setSelectedId(null);
                } else {
                    return;
                }
                e.preventDefault();
                resetEscCancelArm();
                return;
            }
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            // 焦點必須真的在這張圖上（圖表本體或它的工具列）
            const host = hostRef.current;
            if (!chartHasFocus(host?.parentElement ?? host)) return;
            const id = stateRef.current.selectedId;
            if (!id) return;
            const d = stateRef.current.drawings.find((x) => x.id === id);
            if (!d || d.locked) return;
            e.preventDefault();
            removeDrawing(stateRef.current.symbolKey, id);
            setSelectedId(null);
        };
        // capture：use-hotkeys 的 Esc×2 全刪單是 window 上的 bubble
        // listener，而且在 App 掛載時就註冊（早於任何 K 線面板）。用
        // bubble 註冊的話它會先跑，取消畫圖的 preventDefault 來不及阻止
        // 它武裝刪單視窗；Delete 也要先於其他面板處理
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [hasFocusState, pushState, token, hostRef]);

    // ── 對外操作 ─────────────────────────────────────────────────────
    const selected = useMemo(
        () => drawings.find((d) => d.id === selectedId) ?? null,
        [drawings, selectedId],
    );

    const style = selected?.style ?? defaultStyleFor(settings, tool ?? 'trend', themeMode);

    const applyStyle = useCallback(
        (patch: Partial<DrawingStyle>) => {
            const current = stateRef.current;
            const target = current.drawings.find((d) => d.id === current.selectedId);
            // 鎖定的物件仍可改樣式 — 鎖定擋的是「位置被誤拖」，顏色線寬
            // 改了不會弄丟任何東西
            if (target) {
                updateDrawing(current.symbolKey, target.id, {
                    style: { ...target.style, ...patch },
                });
            }
            // 沒選取就是在設定「下一個物件」的樣式；有選取時也一併記住，
            // 跟 TradingView 一樣接著畫的物件沿用剛剛挑的顏色。顏色依工具
            // 記：選取中／武裝中的那種工具；兩者皆無時套用到所有工具
            const { color, ...base } = patch;
            const next: Partial<DrawingSettings> = {
                defaultStyle: { ...current.settings.defaultStyle, ...base },
            };
            if (color !== undefined) {
                const tools: DrawingTool[] = target
                    ? [target.tool]
                    : current.tool
                      ? [current.tool]
                      : DRAWING_TOOLS.map((t) => t.tool);
                const toolColors = { ...current.settings.toolColors };
                for (const t of tools) toolColors[t] = color;
                next.toolColors = toolColors;
            }
            setDrawingSettings(next);
        },
        [],
    );

    const patchSelected = useCallback((patch: Partial<Omit<Drawing, 'id'>>) => {
        const { symbolKey: key, selectedId: id } = stateRef.current;
        if (id) updateDrawing(key, id, patch);
    }, []);

    const toggleLock = useCallback(() => {
        const d = stateRef.current.drawings.find((x) => x.id === stateRef.current.selectedId);
        if (d) patchSelected({ locked: !d.locked });
    }, [patchSelected]);

    const toggleHidden = useCallback(() => {
        const d = stateRef.current.drawings.find((x) => x.id === stateRef.current.selectedId);
        if (d) patchSelected({ hidden: !d.hidden });
    }, [patchSelected]);

    const duplicate = useCallback(() => {
        const { symbolKey: key, selectedId: id } = stateRef.current;
        if (!id) return;
        const projector = layerRef.current?.projector();
        if (!projector) return;
        // 位移在畫面座標做 — 時間軸有缺口、價格軸可能是對數，直接加
        // 時間或價格會偏掉，而且水平線加時間根本看不出位移
        const copy = duplicateDrawing(key, id, (a) => {
            const x = projector.xOfTime(a.time);
            const y = projector.yOfPrice(a.price);
            if (x === null || y === null) return a;
            const moved = unprojectPoint(projector, {
                x: x + DUPLICATE_OFFSET_PX,
                y: y + DUPLICATE_OFFSET_PX,
            });
            return moved ?? a;
        });
        if (copy) setSelectedId(copy.id);
    }, []);

    const remove = useCallback(() => {
        const { symbolKey: key, selectedId: id, drawings: list } = stateRef.current;
        if (!id) return;
        // 鎖定＝防誤刪（一鍵清除也留著它們），要刪先解鎖
        if (list.find((d) => d.id === id)?.locked) return;
        removeDrawing(key, id);
        setSelectedId(null);
    }, []);

    const select = useCallback((id: string | null) => setSelectedId(id), []);

    // 輸入框改價：同樣吸附到合法跳動價位，與拖曳的結果一致
    const setSelectedPrice = useCallback((price: number) => {
        const { symbolKey: key, selectedId: id, drawings: list, contract: c } = stateRef.current;
        const target = list.find((d) => d.id === id);
        if (!target || target.locked || !Number.isFinite(price)) return;
        const snapped = roundToTick(c, price);
        updateDrawing(key, target.id, {
            anchors: target.anchors.map((a) => ({ ...a, price: snapped })),
        });
    }, []);

    const clearAll = useCallback(() => {
        clearDrawings(stateRef.current.symbolKey);
        setSelectedId(null);
    }, []);

    const showAll = useCallback(() => showAllDrawings(stateRef.current.symbolKey), []);

    const setShareContinuousMonth = useCallback((v: boolean) => {
        setDrawingSettings({ shareContinuousMonth: v });
    }, []);

    const onEnterDrawingModeRef = useRef(opts.onEnterDrawingMode);
    onEnterDrawingModeRef.current = opts.onEnterDrawingMode;

    const setToolChecked = useCallback((t: DrawingTool | null) => {
        draftRef.current = null; // 換工具丟掉畫到一半的物件
        // 動到左側工具列就離開交易模式 — 包含按「游標」，那是這一側的
        // 中性狀態，也是從交易模式脫身的方式之一
        onEnterDrawingModeRef.current();
        setTool(t);
        if (t) setSelectedId(null);
    }, []);

    const drawingAt = useCallback((ev: { clientX: number; clientY: number }): DrawingHit => {
        const layer = layerRef.current;
        const pt = layer?.pointOf(ev);
        const projector = layer?.projector();
        if (!layer || !pt || !projector) return null;
        const { drawings: list, selectedId: sel } = stateRef.current;
        if (!list.length) return null;
        const picked = pickDrawing(list, projector, layer.paneSize, pt);
        if (!picked) return null;
        return picked.drawing.id === sel ? 'selected' : 'other';
    }, []);
    const drawingLabelAt = useCallback((clientY: number) => {
        const layer = layerRef.current;
        const pt = layer?.pointOf({ clientX: 0, clientY });
        if (!layer || !pt) return false;
        return layer.axisLabelRects().some((r) => pt.y >= r.top && pt.y <= r.bottom);
    }, []);
    const drawingBusy = useCallback(() => !!stateRef.current.selectedId, []);

    const focusChart = useCallback(() => {
        const host = hostRef.current;
        if (!host || typeof host.focus !== 'function') return;
        if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
        host.focus({ preventScroll: true });
    }, [hostRef]);

    return {
        tool,
        setTool: setToolChecked,
        focusChart,
        drawingAt,
        drawingBusy,
        drawingLabelAt,
        drawings,
        selected,
        select,
        style,
        applyStyle,
        toggleLock,
        toggleHidden,
        duplicate,
        remove,
        clearAll,
        showAll,
        setSelectedPrice,
        symbolKey,
        shareContinuousMonth: settings.shareContinuousMonth,
        setShareContinuousMonth,
    };
}
