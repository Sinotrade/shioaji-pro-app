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
    drawingSymbolKey,
    duplicateDrawing,
    removeDrawing,
    setDrawingSettings,
    updateDrawing,
    useDrawings,
    useDrawingSettings,
    type Drawing,
    type DrawingAnchor,
    type DrawingStyle,
    type DrawingTool,
} from '../lib/chart-drawings';
import {
    dragPoints,
    hitTest,
    projectAnchors,
    unprojectPoint,
    type DragPlan,
    type Point,
} from '../lib/chart-drawing-geometry';
import { DrawingLayer, type DrawingDraft } from '../lib/chart-drawing-layer';
import { escStackDepth } from './use-esc-close';
import type { ContractBase } from '../lib/types/contract';
import { roundToTick } from '../lib/utils/ticksize';

// 複製出來的物件往右下偏這麼多像素 — 一眼看得出是兩個物件
const DUPLICATE_OFFSET_PX = 24;

export interface ChartDrawingsApi {
    tool: DrawingTool | null;
    setTool: (t: DrawingTool | null) => void;
    drawings: Drawing[];
    selected: Drawing | null;
    style: DrawingStyle; // 選取中物件的樣式，沒選取時是下一個新物件的預設
    applyStyle: (patch: Partial<DrawingStyle>) => void;
    toggleLock: () => void;
    toggleHidden: () => void;
    duplicate: () => void;
    remove: () => void;
    clearAll: () => void;
    // 水平線可直接輸入精確價格（拖曳只能拖到游標所在的價位）
    setSelectedPrice: (price: number) => void;
    symbolKey: string;
    shareContinuousMonth: boolean;
    setShareContinuousMonth: (v: boolean) => void;
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
}): ChartDrawingsApi {
    const { contract, hostRef, chartRef, seriesRef, getTimes, tradeArmed } = opts;

    const settings = useDrawingSettings();
    const symbolKey = drawingSymbolKey(contract, settings.shareContinuousMonth);
    const drawings = useDrawings(symbolKey);
    const [tool, setTool] = useState<DrawingTool | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // 高頻狀態（繪製中的第二點跟著游標跑）走 ref 直接推給 layer，
    // 不經過 React state — 每次 mousemove 重繪整棵樹太貴
    const draftRef = useRef<DrawingDraft | null>(null);
    const layerRef = useRef<DrawingLayer | null>(null);

    // 事件處理器裡要讀的最新值
    const stateRef = useRef({ tool, selectedId, drawings, symbolKey, settings, tradeArmed, contract });
    stateRef.current = { tool, selectedId, drawings, symbolKey, settings, tradeArmed, contract };

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

    // 切換商品時清掉選取與繪製中的物件 — 殘留的 draft 會被畫到新商品上
    useEffect(() => {
        draftRef.current = null;
        setSelectedId(null);
        setTool(null);
    }, [symbolKey]);

    // ── 滑鼠 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const layerOf = () => layerRef.current;

        // 水平線是使用者會拿來讀價的線 — 吸附到合法跳動價位；
        // 趨勢線／方框這種造型物件不吸附，免得斜率被量化得歪掉
        const snapPrice = (which: DrawingTool, price: number) =>
            which === 'horizontal' ? roundToTick(stateRef.current.contract, price) : price;

        const anchorAt = (pt: Point, t: DrawingTool): DrawingAnchor | null => {
            const layer = layerOf();
            const projector = layer?.projector();
            if (!projector) return null;
            const anchor = unprojectPoint(projector, pt);
            if (!anchor) return null;
            return { time: anchor.time, price: snapPrice(t, anchor.price) };
        };

        // 後畫的疊在上面 — 命中判定就要從最上面開始找
        const pick = (pt: Point) => {
            const layer = layerOf();
            const projector = layer?.projector();
            if (!layer || !projector) return null;
            const list = stateRef.current.drawings;
            for (let i = list.length - 1; i >= 0; i--) {
                const d = list[i]!;
                if (d.hidden || d.locked) continue;
                const pts = projectAnchors(projector, d.anchors);
                if (!pts) continue;
                const hit = hitTest(d.tool, pts, layer.paneSize, pt);
                if (hit) return { drawing: d, hit, pts };
            }
            return null;
        };

        let drag: { id: string; tool: DrawingTool; plan: DragPlan } | null = null;
        let activeMove: ((e: MouseEvent) => void) | null = null;
        let activeUp: ((e: MouseEvent) => void) | null = null;

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
                const a = anchorAt(p, drag.tool);
                if (!a) return; // 投影不出來就整筆放棄，不寫半套座標
                anchors.push(a);
            }
            updateDrawing(stateRef.current.symbolKey, drag.id, { anchors });
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0) return;
            // 委託線拖曳（同一個 host 上先註冊的 handler）已經吃掉這一下
            if (e.defaultPrevented) return;
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            if (!layer || !pt) return;
            const armed = stateRef.current.tool;

            if (armed) {
                e.preventDefault();
                e.stopPropagation(); // 這一下屬於畫圖，不要變成平移或點價
                const anchor = anchorAt(pt, armed);
                if (!anchor) return;
                const draft = draftRef.current;
                if (armed === 'horizontal') {
                    const created = addDrawing(
                        stateRef.current.symbolKey,
                        armed,
                        [anchor],
                        stateRef.current.settings.defaultStyle,
                    );
                    draftRef.current = null;
                    setTool(null); // 與圖表既有的交易模式一樣是一次性
                    setSelectedId(created.id);
                    return;
                }
                if (!draft) {
                    // 第一點：第二點先跟第一點重合，之後跟著游標跑
                    draftRef.current = {
                        tool: armed,
                        anchors: [anchor, { ...anchor }],
                        style: stateRef.current.settings.defaultStyle,
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
                setSelectedId(created.id);
                return;
            }

            const picked = pick(pt);
            if (!picked) {
                // 空白處按下 = 取消選取，但不攔截 — 圖表照常可以平移
                if (stateRef.current.selectedId) setSelectedId(null);
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            setSelectedId(picked.drawing.id);
            setChartInteractive(false);
            drag = {
                id: picked.drawing.id,
                tool: picked.drawing.tool,
                plan: { hit: picked.hit, startPoints: picked.pts, startAt: pt },
            };

            const move = (ev: MouseEvent) => {
                const p = layerOf()?.pointOf(ev);
                if (p) commitDrag(p);
            };
            const up = (ev: MouseEvent) => {
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                activeMove = null;
                activeUp = null;
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
            if (drag) return;
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            if (!layer || !pt) return;
            const draft = draftRef.current;
            if (draft) {
                // 繪製中：第二點跟著游標
                const anchor = anchorAt(pt, draft.tool);
                if (anchor) {
                    draftRef.current = { ...draft, anchors: [draft.anchors[0]!, anchor] };
                    pushState();
                }
                return;
            }
            if (stateRef.current.tool) {
                host.style.cursor = 'crosshair';
                return;
            }
            // 委託線拖曳的 handler 先跑且在 mousedown 有優先權（它會
            // preventDefault）。它把游標設成 ns-resize 時就別蓋掉，不然
            // 游標顯示的是畫圖、按下去卻是改價
            if (host.style.cursor === 'ns-resize') return;
            const picked = pick(pt);
            if (picked) host.style.cursor = picked.hit.kind === 'anchor' ? 'grab' : 'move';
            else if (host.style.cursor === 'grab' || host.style.cursor === 'move') {
                host.style.cursor = '';
            }
        };

        host.addEventListener('mousedown', down, true);
        host.addEventListener('mousemove', hover, true);
        return () => {
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
            if (activeMove) document.removeEventListener('mousemove', activeMove, true);
            if (activeUp) document.removeEventListener('mouseup', activeUp, true);
            if (drag) setChartInteractive(true); // 拖曳中被卸載 — 別讓圖表卡住
        };
    }, [hostRef, chartRef, pushState]);

    // 交易模式武裝時收起畫圖工具，兩者不會同時吃同一下點擊
    useEffect(() => {
        if (tradeArmed && (tool || draftRef.current)) {
            draftRef.current = null;
            setTool(null);
            pushState();
        }
    }, [tradeArmed, tool, pushState]);

    // ── 鍵盤 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
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
                if (draftRef.current || stateRef.current.tool) {
                    draftRef.current = null;
                    setTool(null);
                    pushState();
                    // 吃掉這一下 — use-hotkeys 靠 defaultPrevented 判斷
                    // 要不要武裝 Esc×2 全刪單，取消繪製不該武裝刪單
                    e.preventDefault();
                } else if (stateRef.current.selectedId) {
                    setSelectedId(null);
                    e.preventDefault();
                }
                return;
            }
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
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
        // bubble 註冊的話它會先跑，我們的 preventDefault 來不及阻止
        // 「取消繪製」那一下順便武裝刪單視窗。
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [pushState]);

    // ── 對外操作 ─────────────────────────────────────────────────────
    const selected = useMemo(
        () => drawings.find((d) => d.id === selectedId) ?? null,
        [drawings, selectedId],
    );

    const style = selected?.style ?? settings.defaultStyle;

    const applyStyle = useCallback(
        (patch: Partial<DrawingStyle>) => {
            const current = stateRef.current;
            const target = current.drawings.find((d) => d.id === current.selectedId);
            if (target && !target.locked) {
                updateDrawing(current.symbolKey, target.id, {
                    style: { ...target.style, ...patch },
                });
            }
            // 沒選取就是在設定「下一個物件」的樣式；有選取時也一併記住，
            // 跟 TradingView 一樣接著畫的物件沿用剛剛挑的顏色
            setDrawingSettings({
                defaultStyle: { ...current.settings.defaultStyle, ...patch },
            });
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
        const { symbolKey: key, selectedId: id } = stateRef.current;
        if (!id) return;
        removeDrawing(key, id);
        setSelectedId(null);
    }, []);

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

    const setShareContinuousMonth = useCallback((v: boolean) => {
        setDrawingSettings({ shareContinuousMonth: v });
    }, []);

    const setToolChecked = useCallback((t: DrawingTool | null) => {
        draftRef.current = null; // 換工具丟掉畫到一半的物件
        setTool(t);
        if (t) setSelectedId(null);
    }, []);

    return {
        tool,
        setTool: setToolChecked,
        drawings,
        selected,
        style,
        applyStyle,
        toggleLock,
        toggleHidden,
        duplicate,
        remove,
        clearAll,
        setSelectedPrice,
        symbolKey,
        shareContinuousMonth: settings.shareContinuousMonth,
        setShareContinuousMonth,
    };
}
