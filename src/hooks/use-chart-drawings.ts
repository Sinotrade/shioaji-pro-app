// src/hooks/use-chart-drawings.ts — K 線圖畫圖工具的互動控制
//
// 把「畫、選、拖、刪、復原」的滑鼠與鍵盤處理從 candle-chart.tsx 拉出來；
// 幾何與儲存分別在 lib/chart-drawing-geometry.ts 與 lib/chart-drawings.ts，
// 這裡只負責把兩者接上圖表與事件。
//
// 交易安全（#218 review）：
// - 畫圖 UI 用掉的 Esc（取消工具／草稿、清量測、取消選取＝關浮動工具列）
//   一律 preventDefault，不算進 Esc×2 全部刪單
// - 武裝畫圖工具時委託線不接手滑鼠（orderLineMayTakePointer）
// - Delete／復原只在鍵盤焦點真的在這張圖上時作用

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import {
    addDrawing,
    applyDrawingHistory,
    anchorCount,
    clearDrawings,
    defaultStyleFor,
    drawingSymbolKey,
    duplicateDrawing,
    getDrawings,
    getDrawingHistoryStart,
    cancelDrawingChanges,
    captureDrawingWrites,
    createDrawingWriter,
    withDrawingWriter,
    subscribeDrawingRemoteChanges,
    noteDrawingHistoryConflict,
    MAX_NAME_LENGTH,
    MAX_TEXT_LENGTH,
    MEASURE_COLORS,
    moveDrawing,
    removeDrawings,
    replaceDrawings,
    setDrawingSettings as saveDrawingSettings,
    setDrawingsLocked,
    showAllDrawings,
    toolDef,
    updateDrawing,
    useDrawings,
    useDrawingSettings,
    DRAWING_TOOL_DEFS,
    DRAWING_TOOLS,
    type Drawing,
    type DrawingAnchor,
    type DrawingSettings,
    type DrawingStyle,
    type DrawingThemeMode,
    type DrawingTool,
    type DrawingToolId,
} from '../lib/chart-drawings';
import {
    dragPoints,
    formatSpan,
    magnetAnchor,
    nearestDrawingAnchor,
    measureStats,
    pickDrawing,
    projectAnchors,
    shapeOf,
    unprojectPoint,
    type DragPlan,
    type OhlcBar,
    type Point,
    type Projector,
} from '../lib/chart-drawing-geometry';
import { DrawingHistory, type HistoryStep } from '../lib/chart-drawing-history';
import { sanitizeFibOptions, type FibOptions } from '../lib/chart-drawing-fib';
import { DrawingLayer, type DrawingDraft, type MeasureOverlay } from '../lib/chart-drawing-layer';
import { escStackDepth } from './use-esc-close';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import type { ContractBase } from '../lib/types/contract';
import { formatToTick, roundToTick } from '../lib/utils/ticksize';

// 複製出來的物件往右下偏這麼多像素 — 一眼看得出是兩個物件
const DUPLICATE_OFFSET_PX = 24;

// 鍵盤（Delete／Esc／復原）同一時間只歸一張圖：最後被點、或最後選取／
// 武裝工具的那張。每個 K 線面板都在 window 上聽 keydown，不這樣做的話
// 按一下 Delete，每張圖都會刪掉自己選取中的物件。失去鍵盤的圖同時放掉
// 選取與工具，畫面上不會出現「看起來選著、按鍵卻不歸它」的物件。
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
// - 游標下有畫圖物件，或有物件選取中／量測顯示中：委託線只能從它自己
//   的價格標籤（價格軸上的「買1 47,000」標籤）拖；繪圖區裡的任何一段都
//   交給畫圖 — 繪圖區內不設把手帶，畫圖物件延伸到那裡時一樣不會被搶走
// - 游標下什麼畫圖都沒有、也沒選取：照舊整條線都能拖
export type DrawingHit = 'selected' | 'other' | null;

export function orderLineMayTakePointer(opts: {
    drawingArmed: boolean;
    defaultPrevented: boolean;
    drawingHit?: DrawingHit;
    drawingBusy?: boolean; // 有畫圖物件選取中，或量測結果顯示中
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

// 在輸入框、文字區裡的按鍵是打字，不是快捷鍵
function isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return (
        !!el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            !!el.isContentEditable)
    );
}

// 復原／重做的快捷鍵：Ctrl/Cmd+Z 復原；Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做
export function undoKeyOf(
    e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): 'undo' | 'redo' | null {
    if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
    const key = (e.key ?? '').toLowerCase();
    const k = e.code === 'KeyZ' || key === 'z' ? 'z' : e.code === 'KeyY' || key === 'y' ? 'y' : null;
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' && !e.shiftKey) return 'redo';
    return null;
}

// Alt＋字母切換工具（用 code：macOS 的 Option 會把 e.key 變成特殊符號）
export function toolShortcutOf(
    e: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): DrawingToolId | null {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
    const m = /^Key([A-Z])$/.exec(e.code ?? '');
    if (!m) return null;
    return DRAWING_TOOL_DEFS.find((d) => d.shortcut === m[1])?.tool ?? null;
}

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ChartDrawingsApi {
    // UI 根節點的 capture 防線；序號也供下單入口核對本次武裝。
    onInteraction: () => void;
    interactionSequence: () => number;
    // 委託線接手前，同步結束畫圖互動並接手鍵盤。
    prepareOrderDrag: () => void;
    tool: DrawingToolId | null;
    setTool: (t: DrawingToolId | null) => void;
    drawings: Drawing[];
    selectedIds: readonly string[];
    selected: Drawing | null; // 主要選取（最後選的那個）
    selectedList: Drawing[];
    select: (id: string | null, additive?: boolean) => void;
    style: DrawingStyle; // 選取中物件的樣式，沒選取時是下一個新物件的預設
    applyStyle: (patch: Partial<DrawingStyle>) => void;
    toggleLock: () => void;
    toggleHidden: () => void;
    setLocked: (id: string, v: boolean) => void;
    setHidden: (id: string, v: boolean) => void;
    rename: (id: string, name: string) => void;
    reorder: (id: string, toIndex: number) => void;
    duplicate: () => void;
    remove: () => void;
    removeOne: (id: string) => void;
    clearAll: () => void;
    showAll: () => void;
    lockAll: () => void; // 有未鎖定的就全部鎖定，否則全部解鎖
    allLocked: boolean;
    // 水平線可直接輸入精確價格（拖曳只能拖到游標所在的價位）
    setSelectedPrice: (price: number) => void;
    // 設定視窗「座標」分頁
    setAnchor: (id: string, index: number, anchor: Partial<DrawingAnchor>) => void;
    // 斐波那契選項（比例、色帶、標籤、延伸、反轉…）
    setFib: (id: string, patch: Partial<FibOptions>) => void;
    // 文字註記
    editingTextId: string | null;
    editText: (id: string) => void;
    commitText: (text: string | null) => void;
    updateTextDraft: (text: string) => void;
    setText: (id: string, text: string) => void;
    // 復原／重做
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    // 磁吸、收藏、物件列表
    magnet: boolean;
    setMagnet: (v: boolean) => void;
    favorites: DrawingToolId[];
    toggleFavorite: (t: DrawingToolId) => void;
    groupLast: DrawingSettings['groupLast'];
    objectListOpen: boolean;
    setObjectListOpen: (v: boolean) => void;
    // 價差量測是否顯示中（Esc 或點一下清除）
    measuring: boolean;
    // 浮動工具列、文字輸入框的定位：選取物件在 host 內的外框
    selectionBox: Box | null;
    editBox: Box | null;
    hostSize: { width: number; height: number };
    themeMode: DrawingThemeMode;
    symbolKey: string;
    shareContinuousMonth: boolean;
    setShareContinuousMonth: (v: boolean) => void;
    // 點工具列時把鍵盤焦點交回圖表（WebKit 點按鈕不會給它焦點）
    focusChart: () => void;
    // 依商品跳動價位顯示價格（grouping：千分位，輸入框用 false）
    formatPrice: (price: number, grouping?: boolean) => string;
    // 委託線拖曳判斷用：游標下有沒有畫圖物件（選取中／其他）、畫圖是否
    // 正在用滑鼠（有選取、量測顯示中）
    drawingAt: (ev: { clientX: number; clientY: number }) => DrawingHit;
    drawingBusy: () => boolean;
    // 游標（clientY）是否在畫圖物件的價格軸標籤範圍內
    drawingLabelAt: (clientY: number) => boolean;
}

const sameBox = (a: Box | null, b: Box | null) =>
    a === b ||
    (!!a &&
        !!b &&
        Math.round(a.left) === Math.round(b.left) &&
        Math.round(a.top) === Math.round(b.top) &&
        Math.round(a.right) === Math.round(b.right) &&
        Math.round(a.bottom) === Math.round(b.bottom));

export function useChartDrawings(opts: {
    contract: ContractBase;
    // 週期／交易時段等會替換投影資料的 context。
    contextKey?: string;
    hostRef: React.RefObject<HTMLDivElement | null>;
    chartRef: React.RefObject<IChartApi | null>;
    seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
    getTimes: () => number[];
    // 磁吸用的 K 棒（開高低收）
    getBars?: () => readonly OhlcBar[];
    // 交易模式（點價買賣／停損／停利／警示）武裝時交出滑鼠 — 那一下
    // 點擊屬於下單，畫圖不能攔截
    tradeArmed: boolean;
    // 使用者動了左側工具列 = 要回畫圖／瀏覽模式，請頂端解除交易模式。
    // 兩種模式一次只能有一種生效。
    onEnterDrawingMode: () => void;
    // 所有互動失效入口（含 context／失焦）同步取消委託線拖曳；
    // 回傳是否取消了拖曳，供 Esc 吃掉本次取消按鍵。
    onInvalidateInteraction?: () => boolean;
    // 新物件的預設色依主題挑（深色底與淺色底同一色相的深淺不同）
    themeMode?: DrawingThemeMode;
    // 量測換算損益：每一點價差值多少錢（目前下單數量 × 乘數），不知道就 null
    pnlPerPoint?: number | null;
    // 圖表背景色：畫圖標籤的描邊（halo）用
    chartBackground?: string;
}): ChartDrawingsApi {
    const { contract, hostRef, chartRef, seriesRef, getTimes, tradeArmed } = opts;
    const themeMode = opts.themeMode ?? 'dark';

    const settings = useDrawingSettings();
    const symbolKey = drawingSymbolKey(contract, settings.shareContinuousMonth);
    const contextKey = `${contract.security_type}:${contract.code}:${symbolKey}:${opts.contextKey ?? ''}`;
    const drawings = useDrawings(symbolKey);
    const [tool, setTool] = useState<DrawingToolId | null>(null);
    const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [measuring, setMeasuring] = useState(false);
    const [selectionBox, setSelectionBox] = useState<Box | null>(null);
    const [editBox, setEditBox] = useState<Box | null>(null);
    const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
    const [, setHistoryVer] = useState(0);
    const [token] = useState(() => ({}));
    const [writer] = useState(createDrawingWriter);
    // 這張圖目前是否握有鍵盤（最後被點的圖）— 握有時才掛 keydown listener
    const [isOwner, setIsOwner] = useState(false);
    const historyRef = useRef(new DrawingHistory());

    // 高頻狀態（繪製中的點、量測跟著游標跑）走 ref 直接推給 layer，
    // 不經過 React state — 每次 mousemove 重繪整棵樹太貴
    const draftRef = useRef<DrawingDraft | null>(null);
    const toolContextRef = useRef(contextKey);
    const measureRef = useRef<MeasureOverlay | null>(null);
    const measureDoneRef = useRef(false); // 量測第二點已定（再點一下清除）
    const layerRef = useRef<DrawingLayer | null>(null);
    // 文字編輯開始前的清單；新建的文字取消＝整筆不留、也不進復原
    const textTxRef = useRef<{ id: string; key: string; context: string; before: Drawing[]; created: boolean; value?: string; invalidated?: boolean } | null>(null);
    const cancelDragRef = useRef<((remoteIds?: ReadonlySet<string>) => void) | null>(null);
    const dragIdsRef = useRef<readonly string[]>([]);
    const finishTextRef = useRef<() => void>(() => {});
    const cancelTextRef = useRef<(remoteIds?: ReadonlySet<string>) => void>(() => {});
    const cancelInteractionsRef = useRef<(submitText?: boolean, invalidate?: boolean) => void>(() => {});
    const historyBusyRef = useRef(false);
    const operationSequenceRef = useRef(0);
    const pendingHistoryRef = useRef<{ sequence: number; step: HistoryStep } | null>(null);

    // 事件處理器裡要讀的最新值
    const live = {
        tool,
        selectedIds,
        drawings,
        symbolKey,
        contextKey,
        settings,
        tradeArmed,
        contract,
        themeMode,
        editingTextId,
        pnlPerPoint: opts.pnlPerPoint ?? null,
        chartBackground: opts.chartBackground ?? (themeMode === 'light' ? '#f7f8fa' : '#10131a'),
    };
    const stateRef = useRef(live);
    stateRef.current = live;

    const getTimesRef = useRef(getTimes);
    getTimesRef.current = getTimes;
    const getBarsRef = useRef(opts.getBars);
    getBarsRef.current = opts.getBars;
    const onEnterDrawingModeRef = useRef(opts.onEnterDrawingMode);
    onEnterDrawingModeRef.current = opts.onEnterDrawingMode;
    const interactionSequenceRef = useRef(0);
    const onInvalidateInteractionRef = useRef(opts.onInvalidateInteraction);
    onInvalidateInteractionRef.current = opts.onInvalidateInteraction;
    const invalidateInteraction = useCallback(() => {
        interactionSequenceRef.current++;
        return onInvalidateInteractionRef.current?.() ?? false;
    }, []);
    const enterDrawingMode = useCallback(() => {
        const canceledOrderDrag = invalidateInteraction();
        // 同一個滑鼠／鍵盤事件內的 chart click 不能等 React render 才解除武裝。
        stateRef.current.tradeArmed = false;
        onEnterDrawingModeRef.current();
        return canceledOrderDrag;
    }, [invalidateInteraction]);
    const interactionSequence = useCallback(() => interactionSequenceRef.current, []);
    // 設定與物件交易各有單一入口，程式呼叫也一律使武裝序號失效。
    const setDrawingSettings = useCallback((patch: Partial<DrawingSettings>) => {
        enterDrawingMode();
        saveDrawingSettings(patch);
    }, [enterDrawingMode]);

    // ── 復原 ─────────────────────────────────────────────────────────
    const bumpHistory = useCallback(() => setHistoryVer((v) => v + 1), []);
    const beginOperation = useCallback(() => {
        // 待套用步驟已移入另一個 stack；新操作接手時移除這一步。
        const pending = pendingHistoryRef.current;
        if (pending?.sequence === operationSequenceRef.current) {
            historyRef.current.discard(pending.step);
            bumpHistory();
        }
        operationSequenceRef.current++;
    }, [bumpHistory]);
    useEffect(() => subscribeDrawingRemoteChanges((key, ids) => {
        if (key === stateRef.current.symbolKey) operationSequenceRef.current++;
        const changed = historyRef.current.clear(key);
        const info = textTxRef.current;
        if (key === info?.key && ids.has(info.id)) {
            cancelTextRef.current(ids);
            noteDrawingHistoryConflict();
        }
        if (key === stateRef.current.symbolKey && dragIdsRef.current.some((id) => ids.has(id))) {
            cancelDragRef.current?.(ids);
        }
        // 未受影響的互動繼續；完成後的新一步以已觀察遠端改動為歷史起點。
        if (key === stateRef.current.symbolKey && (cancelDragRef.current || textTxRef.current)) {
            historyRef.current.begin(key, getDrawingHistoryStart());
        }
        if (changed) {
            noteDrawingHistoryConflict();
            bumpHistory();
        }
    }, writer), [bumpHistory, writer]);
    // 包一次操作：只記這個 writer 實際寫入的物件。
    const tx = useCallback(
        (fn: () => void, tag?: string) => {
            enterDrawingMode();
            beginOperation();
            // 物件列表／樣式／刪除等操作接手時，先撤回尚未結束的拖曳。
            cancelDragRef.current?.();
            const key = stateRef.current.symbolKey;
            const { before, after, ids, conflicted } = withDrawingWriter(writer, () => captureDrawingWrites(key, fn));
            // 同步回呼中的遠端取消已被觀察；新歷史從這個起點開始。
            historyRef.current.begin(key, getDrawingHistoryStart());
            // 同步期間才發現同物件的遠端版本，仍不能建立跨越該版本的歷史。
            if (ids.size && !conflicted) {
                historyRef.current.push(key, before, after, tag, undefined, ids, true);
                bumpHistory();
            }
        },
        [beginOperation, bumpHistory, writer, enterDrawingMode],
    );

    const applyHistory = useCallback(
        (step: HistoryStep | null) => {
            if (!step) return;
            // 鎖內檢查整個商品與操作序號；保留等待期間新建的歷史。
            historyBusyRef.current = true;
            const sequence = operationSequenceRef.current;
            pendingHistoryRef.current = { sequence, step };
            withDrawingWriter(writer, () => applyDrawingHistory(step, (success) => {
                if (!success && sequence === operationSequenceRef.current) historyRef.current.clear(step.key);
                // 選取裡已經不存在的物件拿掉
                const ids = new Set(getDrawings(step.key).map((d) => d.id));
                setSelectedIds((cur) =>
                    cur.every((id) => ids.has(id)) ? cur : cur.filter((id) => ids.has(id)),
                );
                bumpHistory();
                historyBusyRef.current = false;
                pendingHistoryRef.current = null;
            }, () => sequence === operationSequenceRef.current));
        },
        [bumpHistory, writer],
    );
    const undo = useCallback(() => {
        if (historyBusyRef.current) return;
        enterDrawingMode();
        cancelInteractionsRef.current(true);
        applyHistory(historyRef.current.undo());
    }, [applyHistory, enterDrawingMode]);
    const redo = useCallback(() => {
        if (historyBusyRef.current) return;
        enterDrawingMode();
        cancelInteractionsRef.current(true);
        applyHistory(historyRef.current.redo());
    }, [applyHistory, enterDrawingMode]);

    // ── layer 掛載 ───────────────────────────────────────────────────
    // 注意：這個 effect 必須在 candle-chart 建立圖表的 effect 之後註冊
    // （同一個元件內 effect 依宣告順序執行），seriesRef 才已經有值。
    // 每次重繪完成後要做的事（見下方），layer 掛上時接上
    const onDrawnRef = useRef<() => void>(() => {});
    useEffect(() => {
        const series = seriesRef.current;
        if (!series) return;
        const layer = new DrawingLayer(() => getTimesRef.current());
        series.attachPrimitive(layer);
        layerRef.current = layer;
        layer.onDrawn = () => onDrawnRef.current();
        return () => {
            cancelInteractionsRef.current();
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
        const layer = layerRef.current;
        if (layer) {
            layer.themeMode = stateRef.current.themeMode;
            layer.background = stateRef.current.chartBackground;
            // 標籤依商品的跳動價位與小數位數顯示（TXF 1 點 → 48,692）；存的
            // 是原始值，只有顯示取整
            layer.formatPrice = (p) => formatToTick(stateRef.current.contract, p);
            layer.formatAxis = (p) => formatToTick(stateRef.current.contract, p, { grouping: false });
        }
        layerRef.current?.setState({
            drawings: stateRef.current.drawings,
            draft: draftRef.current,
            selectedIds: stateRef.current.selectedIds,
            hoverId: null,
            measure: measureRef.current,
            editingId: stateRef.current.editingTextId,
        });
    }, []);

    // 資料／選取變動時重繪；draft 變動時由事件處理器自己呼叫 pushState
    useEffect(pushState, [pushState, drawings, selectedIds, editingTextId, themeMode, live.chartBackground]);

    // 每次重繪後重新算浮動工具列與文字框的位置（物件跟著平移縮放移動）
    useEffect(() => {
        onDrawnRef.current = () => {
            const layer = layerRef.current;
            if (!layer) return;
            const host = hostRef.current;
            const projector = layer.projector();
            const canvasRect = layer.canvasRect();
            if (!host || !projector || !canvasRect) return;
            const hostRect = host.getBoundingClientRect();
            const ox = canvasRect.left - hostRect.left;
            const oy = canvasRect.top - hostRect.top;
            setHostSize((s) =>
                s.width === hostRect.width && s.height === hostRect.height
                    ? s
                    : { width: hostRect.width, height: hostRect.height },
            );
            const { selectedIds: ids, drawings: list, editingTextId: editing } = stateRef.current;
            const boxOf = (d: Drawing): Box | null => {
                const pts = projectAnchors(projector, d.anchors);
                if (!pts) return null;
                const shape = shapeOf(d.tool, pts, layer.paneSize, d);
                if (!shape) return null;
                let xs: number[];
                let ys: number[];
                switch (shape.kind) {
                    case 'line':
                        xs = [shape.a.x, shape.b.x];
                        ys = [shape.a.y, shape.b.y];
                        break;
                    case 'channel':
                        xs = shape.fill.map((p) => p.x);
                        ys = shape.fill.map((p) => p.y);
                        break;
                    case 'fib':
                        xs = [shape.left, shape.right];
                        ys = shape.levels.map((l) => l.y);
                        break;
                    default:
                        xs = [shape.left, shape.right];
                        ys = [shape.top, shape.bottom];
                }
                return {
                    left: Math.min(...xs) + ox,
                    right: Math.max(...xs) + ox,
                    top: Math.min(...ys) + oy,
                    bottom: Math.max(...ys) + oy,
                };
            };
            let box: Box | null = null;
            for (const id of ids) {
                const d = list.find((x) => x.id === id);
                const b = d && !d.hidden ? boxOf(d) : null;
                if (!b) continue;
                box = box
                    ? {
                          left: Math.min(box.left, b.left),
                          top: Math.min(box.top, b.top),
                          right: Math.max(box.right, b.right),
                          bottom: Math.max(box.bottom, b.bottom),
                      }
                    : b;
            }
            setSelectionBox((cur) => (sameBox(cur, box) ? cur : box));
            const ed = editing ? list.find((x) => x.id === editing) : null;
            const eb = ed ? boxOf(ed) : null;
            setEditBox((cur) => (sameBox(cur, eb) ? cur : eb));
        };
    }, [hostRef]);

    const clearMeasure = useCallback(() => {
        if (!measureRef.current) return false;
        measureRef.current = null;
        measureDoneRef.current = false;
        setMeasuring(false);
        pushState();
        return true;
    }, [pushState]);

    const cancelText = useCallback((remoteIds?: ReadonlySet<string>) => {
        const info = textTxRef.current;
        textTxRef.current = null;
        stateRef.current.editingTextId = null;
        setEditingTextId(null);
        if (!info || info.invalidated) return;
        beginOperation();
        withDrawingWriter(writer, () => {
            if (remoteIds?.has(info.id)) {
                const original = info.before.find((d) => d.id === info.id) ?? getDrawings(info.key).find((d) => d.id === info.id);
                if (original) cancelDrawingChanges(info.key, [original], remoteIds);
            } else if (info.created) removeDrawings(info.key, [info.id]);
            else {
                const original = info.before.find((d) => d.id === info.id);
                if (!original) return;
                const restored = cancelDrawingChanges(info.key, [original]).find((d) => d.id === info.id);
                if (restored) historyRef.current.rebase(info.key, original, restored);
            }
        });
    }, [beginOperation, writer]);
    cancelTextRef.current = cancelText;

    const cancelInteractions = useCallback((submitText = false, invalidate = true) => {
        if (invalidate) invalidateInteraction();
        else onInvalidateInteractionRef.current?.();
        beginOperation();
        cancelDragRef.current?.();
        if (submitText) finishTextRef.current();
        else cancelText();
        draftRef.current = null;
        clearMeasure();
        stateRef.current.tool = null;
        stateRef.current.selectedIds = [];
        setTool(null);
        setSelectedIds((ids) => ids.length ? [] : ids);
        setSelectionBox(null);
        setEditBox(null);
        const host = hostRef.current;
        if (host && ['grab', 'move', 'pointer', 'crosshair'].includes(host.style.cursor)) host.style.cursor = '';
        pushState();
    }, [beginOperation, cancelText, clearMeasure, hostRef, pushState, invalidateInteraction]);
    cancelInteractionsRef.current = cancelInteractions;

    // 切換商品時清掉選取、繪製中的物件、量測與復原紀錄 — 殘留的 draft
    // 會被畫到新商品上；復原紀錄屬於舊商品，在新商品上按復原會改到看
    // 不見的物件。立刻重繪：選取／工具本來就是空的時 state 不變，不會
    // 再觸發上面的重繪 effect
    useLayoutEffect(() => {
        cancelInteractionsRef.current();
        historyRef.current.clear();
        bumpHistory();
        return () => cancelInteractionsRef.current();
    }, [contextKey, bumpHistory]);

    useEffect(() => {
        const cancel = () => cancelInteractionsRef.current(true);
        const eventDocument = typeof document === 'undefined' ? null : document;
        const hidden = () => { if (eventDocument?.hidden) cancel(); };
        window.addEventListener('blur', cancel);
        window.addEventListener('pagehide', cancel, true); // 先取消，再由儲存層寫關窗日誌。
        eventDocument?.addEventListener('pointercancel', cancel, true);
        eventDocument?.addEventListener('visibilitychange', hidden);
        return () => {
            window.removeEventListener('blur', cancel);
            window.removeEventListener('pagehide', cancel, true);
            eventDocument?.removeEventListener('pointercancel', cancel, true);
            eventDocument?.removeEventListener('visibilitychange', hidden);
        };
    }, []);

    // ── 滑鼠 ─────────────────────────────────────────────────────────
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const layerOf = () => layerRef.current;

        // 水平線是使用者會拿來讀價的線 — 吸附到合法跳動價位；
        // 趨勢線／方框這種造型物件不吸附，免得斜率被量化得歪掉
        const snapPrice = (which: DrawingToolId, price: number) =>
            which === 'horizontal' || which === 'measure'
                ? roundToTick(stateRef.current.contract, price)
                : price;

        // 每個事件只建一次 projector（呼叫端傳進來），不在每個小函式裡重建
        const anchorAt = (
            projector: Projector,
            pt: Point,
            t: DrawingToolId,
            excludeDrawingId?: string,
        ): DrawingAnchor | null => {
            const anchor = unprojectPoint(projector, pt);
            if (!anchor) return null;
            const bars = getBarsRef.current?.();
            if (stateRef.current.settings.magnet) {
                // 既有端點優先，才能在相同位置精確接續另一條線。
                const existing = nearestDrawingAnchor(
                    stateRef.current.drawings,
                    projector,
                    pt,
                    20,
                    excludeDrawingId,
                );
                if (existing) return existing;
                if (bars?.length) {
                    // 再貼齊最近 K 棒的開高低收（本來就是合法價位）。
                    return magnetAnchor(anchor, bars, (p) => projector.yOfPrice(p), pt.y);
                }
            }
            return { time: anchor.time, price: snapPrice(t, anchor.price) };
        };

        const pick = (projector: Projector, pt: Point) => {
            const layer = layerOf();
            if (!layer) return null;
            return pickDrawing(stateRef.current.drawings, projector, layer.paneSize, pt, undefined, layer.formatPrice);
        };

        const measureLabel = (a: DrawingAnchor, b: DrawingAnchor) => {
            const layer = layerOf();
            const times = getTimesRef.current();
            const st = measureStats(
                a,
                b,
                times,
                layer?.barSecondsOf(times) ?? 60,
                stateRef.current.pnlPerPoint,
            );
            // 點數依起點價位的跳動價位取整顯示
            const fmt = (v: number) => formatToTick(stateRef.current.contract, v, { at: a.price });
            const sign = st.points > 0 ? '+' : st.points < 0 ? '−' : '';
            const parts = [
                `${sign}${fmt(Math.abs(st.points))} 點 (${sign}${Math.abs(st.pct).toFixed(2)}%)`,
                `${st.bars} 根`,
                formatSpan(st.seconds),
            ];
            if (st.pnl !== null) {
                parts.push(`損益 ${sign}${Math.round(Math.abs(st.pnl)).toLocaleString('en-US')}`);
            }
            return { stats: st, label: parts.join(' · ') };
        };

        const setMeasure = (a: DrawingAnchor, b: DrawingAnchor) => {
            measureRef.current = {
                a,
                b,
                color: MEASURE_COLORS[stateRef.current.themeMode],
                ...measureLabel(a, b),
            };
            pushState();
        };

        // startAnchors：按下當下的時間／價格 — 拖單一控制點時，其他點原樣保留
        type DragItem = { id: string; tool: DrawingTool; plan: DragPlan; startAnchors: DrawingAnchor[] };
        let drag: { items: DragItem[]; before: Drawing[]; key: string; context: string } | null = null;
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
            if (!host.hasAttribute?.('tabindex')) host.tabIndex = -1;
            host.focus({ preventScroll: true });
        };

        // 浮動工具列、文字輸入框也在 host 裡：按在它們上面的那一下屬於
        // 它們，不是圖表（否則會先被當成點空白處而取消選取）
        const onOverlay = (e: Event) =>
            !!(e.target as HTMLElement | null)?.closest?.('[data-drawing-overlay]');

        const setChartInteractive = (on: boolean) =>
            chartRef.current?.applyOptions({ handleScroll: on, handleScale: on });

        const commitDrag = (pt: Point) => {
            if (!drag) return;
            // 寫回前再核對物件商品與投影 context，攔下 context effect 前的遲到事件。
            if (drag.key !== stateRef.current.symbolKey || drag.context !== stateRef.current.contextKey || stateRef.current.tradeArmed) {
                cancelDragRef.current?.();
                return;
            }
            const layer = layerOf();
            const projector = layer?.projector();
            if (!projector) return;
            const key = drag.key;
            const changed = new Map<string, DrawingAnchor[]>();
            for (const item of drag.items) {
                const moved = dragPoints(item.plan, pt);
                const anchors: DrawingAnchor[] = [];
                const hit = item.plan.hit;
                for (let i = 0; i < moved.length; i++) {
                    // 拖單一控制點：只有被拖的那一點重算（含磁吸），其他點維持
                    // 原本的時間／價格 — 不然磁吸會把沒動的點也吸到 OHLC
                    if (hit.kind === 'anchor' && hit.index !== i) {
                        anchors.push(item.startAnchors[i]!);
                        continue;
                    }
                    // 整體平移不磁吸（會把形狀扭掉）
                    const a =
                        hit.kind === 'anchor'
                            ? anchorAt(projector, moved[i]!, item.tool, item.id)
                            : unprojectPoint(projector, moved[i]!);
                    if (!a) return; // 投影不出來就整筆放棄，不寫半套座標
                    anchors.push(
                        hit.kind === 'anchor' ? a : { time: a.time, price: snapPrice(item.tool, a.price) },
                    );
                }
                changed.set(item.id, anchors);
            }
            withDrawingWriter(writer, () => replaceDrawings(
                key,
                getDrawings(key).map((d) =>
                    changed.has(d.id) ? { ...d, anchors: changed.get(d.id)! } : d,
                ),
            ));
        };

        const finishCreate = (created: Drawing | null, before: Drawing[]) => {
            draftRef.current = null;
            setTool(null); // 與圖表既有的交易模式一樣是一次性
            stateRef.current.tool = null;
            pushState();
            if (!created) return;
            setSelectedIds([created.id]);
            stateRef.current.selectedIds = [created.id];
            if (created.tool === 'text') {
                // 文字：先開輸入框，確定後才算一步（取消＝整筆不留）
                textTxRef.current = { id: created.id, key: stateRef.current.symbolKey, context: stateRef.current.contextKey, before, created: true };
                setEditingTextId(created.id);
                return;
            }
            const key = stateRef.current.symbolKey;
            historyRef.current.push(key, before, getDrawings(key), undefined, undefined, [created.id]);
            bumpHistory();
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0 || onOverlay(e)) return;
            beginOperation();
            claimKeyboard(token);
            cancelDragRef.current?.();
            // 先提交最新草稿，再移動焦點；後續 blur 只能看到已結束的交易。
            finishTextRef.current();
            // 圖表本體取得鍵盤焦點 — Delete 只在焦點還在這張圖時作用
            focusHost();
            // 委託線拖曳（同一個 host 上先註冊的 handler）已經吃掉這一下
            if (e.defaultPrevented) return;
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            const projector = layer?.projector();
            if (!layer || !pt || !projector) return;
            const armed = stateRef.current.tool;
            if (armed && toolContextRef.current !== stateRef.current.contextKey) {
                cancelInteractionsRef.current();
                return;
            }

            // 量測已量完、還顯示著：點一下清除，這一下不做別的事
            if (!armed && measureRef.current && measureDoneRef.current) {
                e.preventDefault();
                e.stopPropagation();
                clearMeasure();
                return;
            }

            if (armed) {
                enterDrawingMode();
                e.preventDefault();
                e.stopPropagation(); // 這一下屬於畫圖，不要變成平移或點價
                const anchor = anchorAt(projector, pt, armed);
                if (!anchor) return;
                const key = stateRef.current.symbolKey;

                if (armed === 'measure') {
                    const m = measureRef.current;
                    if (!m || measureDoneRef.current) {
                        measureDoneRef.current = false;
                        setMeasuring(true);
                        setMeasure(anchor, { ...anchor });
                    } else {
                        setMeasure(m.a, anchor);
                        measureDoneRef.current = true;
                        setTool(null);
                    }
                    return;
                }

                const style = defaultStyleFor(
                    stateRef.current.settings,
                    armed,
                    stateRef.current.themeMode,
                );
                const need = anchorCount(armed);
                const before = getDrawings(key);
                historyRef.current.begin(key, getDrawingHistoryStart());
                if (need === 1) {
                    finishCreate(withDrawingWriter(writer, () => addDrawing(key, armed, [anchor], style)), before);
                    return;
                }
                const draft = draftRef.current;
                if (!draft) {
                    // 第一點：下一點先跟第一點重合，之後跟著游標跑
                    draftRef.current = { tool: armed, anchors: [anchor, { ...anchor }], style };
                    pushState();
                    return;
                }
                const fixed = [...draft.anchors.slice(0, -1), anchor];
                if (fixed.length < need) {
                    // 平行通道：第二點定了，第三點（通道寬度）跟著游標
                    draftRef.current = { ...draft, anchors: [...fixed, { ...anchor }] };
                    pushState();
                    return;
                }
                finishCreate(withDrawingWriter(writer, () => addDrawing(key, draft.tool, fixed, draft.style)), before);
                return;
            }

            const picked = pick(projector, pt);
            const cur = stateRef.current.selectedIds;
            if (!picked) {
                // 空白處按下 = 取消選取，但不攔截 — 圖表照常可以平移
                if (cur.length && !e.shiftKey) setSelectedIds([]);
                return;
            }
            const id = picked.drawing.id;
            enterDrawingMode();
            let nextSel: readonly string[];
            if (e.shiftKey) {
                // Shift：加入／移出多選
                nextSel = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
                stateRef.current.selectedIds = nextSel;
                setSelectedIds(nextSel);
                if (!nextSel.includes(id)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            } else {
                nextSel = cur.includes(id) ? cur : [id];
                if (nextSel !== cur) setSelectedIds(nextSel);
            }
            stateRef.current.selectedIds = nextSel;
            if (picked.drawing.locked) {
                // 選起來就好，不攔截這一下 — 大面積的鎖定方框若吃掉事件，
                // 在它上面就再也拖不動圖表了。鎖定＝不能動它，不是不能
                // 動圖表
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            setChartInteractive(false);
            const list = stateRef.current.drawings;
            const multi = nextSel.length > 1;
            const items: DragItem[] = [];
            for (const sid of nextSel) {
                const d = list.find((x) => x.id === sid);
                if (!d || d.locked) continue;
                const pts = sid === id ? picked.points : projectAnchors(projector, d.anchors);
                if (!pts) continue;
                items.push({
                    id: sid,
                    tool: d.tool,
                    startAnchors: d.anchors,
                    // 多選一律整體平移；單選時按在控制點上就只拖那一點
                    plan: {
                        hit: multi || sid !== id ? { kind: 'body' } : picked.hit,
                        startPoints: pts,
                        startAt: pt,
                    },
                });
            }
            const key = stateRef.current.symbolKey;
            historyRef.current.begin(key, getDrawingHistoryStart());
            drag = { items, before: getDrawings(key), key, context: stateRef.current.contextKey };
            dragIdsRef.current = items.map((item) => item.id);

            const move = (ev: MouseEvent) => {
                if (!drag) return;
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
                if (!drag) return;
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                activeMove = null;
                activeUp = null;
                if (frame !== null) cancelRaf(frame);
                frame = null;
                pendingPt = null;
                const p = layerOf()?.pointOf(ev);
                if (p) commitDrag(p);
                if (drag) {
                    const after = getDrawings(drag.key);
                    if (after !== drag.before) {
                        // 只記拖到的物件：拖曳期間別的視窗的改動不算這一步
                        historyRef.current.push(
                            drag.key,
                            drag.before,
                            after,
                            undefined,
                            undefined,
                            drag.items.map((it) => it.id),
                        );
                        bumpHistory();
                    }
                }
                drag = null;
                dragIdsRef.current = [];
                cancelDragRef.current = null;
                setChartInteractive(true);
            };
            document.addEventListener('mousemove', move, true);
            document.addEventListener('mouseup', up, true);
            activeMove = move;
            activeUp = up;
            cancelDragRef.current = (remoteIds) => {
                const session = drag;
                drag = null;
                dragIdsRef.current = [];
                cancelDragRef.current = null;
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                activeMove = null;
                activeUp = null;
                if (frame !== null) cancelRaf(frame);
                frame = null;
                pendingPt = null;
                if (session) {
                    const originals = session.before.filter((d) => session.items.some((item) => item.id === d.id));
                    if (originals.length) {
                        const restored = withDrawingWriter(writer, () => cancelDrawingChanges(session.key, originals, remoteIds));
                        for (const original of originals) {
                            const d = restored.find((x) => x.id === original.id);
                            if (d) historyRef.current.rebase(session.key, original, d);
                        }
                    }
                }
                setChartInteractive(true);
            };
        };

        // 雙擊文字註記 = 編輯文字
        const dbl = (e: MouseEvent) => {
            if (stateRef.current.tool || onOverlay(e)) return;
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            const projector = layer?.projector();
            if (!layer || !pt || !projector) return;
            const picked = pick(projector, pt);
            if (picked?.drawing.tool !== 'text' || picked.drawing.locked) return;
            enterDrawingMode();
            beginOperation();
            e.preventDefault();
            e.stopPropagation();
            historyRef.current.begin(stateRef.current.symbolKey, getDrawingHistoryStart());
            cancelInteractionsRef.current(true);
            textTxRef.current = { id: picked.drawing.id, key: stateRef.current.symbolKey, context: stateRef.current.contextKey, before: getDrawings(stateRef.current.symbolKey), created: false };
            setSelectedIds([picked.drawing.id]);
            stateRef.current.selectedIds = [picked.drawing.id];
            setEditingTextId(picked.drawing.id);
        };

        const hover = (e: MouseEvent) => {
            if (drag || stateRef.current.tradeArmed || onOverlay(e)) return;
            if (stateRef.current.tool && toolContextRef.current !== stateRef.current.contextKey) {
                cancelInteractionsRef.current();
                return;
            }
            const draft = draftRef.current;
            const armed = stateRef.current.tool;
            const m = measureRef.current;
            const measureLive = !!m && !measureDoneRef.current;
            // 熱路徑：沒有草稿、沒武裝工具、沒在量測、也沒有看得到的物件
            // 時什麼都不用算（hover 游標只跟物件有關）
            if (
                !draft &&
                !armed &&
                !measureLive &&
                !stateRef.current.drawings.some((d) => !d.hidden)
            ) {
                resetHoverCursor();
                return;
            }
            const layer = layerOf();
            const pt = layer?.pointOf(e);
            const projector = layer?.projector();
            if (!layer || !pt || !projector) return;
            if (measureLive && m) {
                const b = anchorAt(projector, pt, 'measure');
                if (b) setMeasure(m.a, b);
                host.style.cursor = 'crosshair';
                return;
            }
            if (draft) {
                // 繪製中：最後一點跟著游標
                const anchor = anchorAt(projector, pt, draft.tool);
                if (anchor) {
                    draftRef.current = {
                        ...draft,
                        anchors: [...draft.anchors.slice(0, -1), anchor],
                    };
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
        host.addEventListener('dblclick', dbl, true);
        return () => {
            cancelInteractionsRef.current();
            cancelDragRef.current = null;
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
            host.removeEventListener('dblclick', dbl, true);
            if (activeMove) document.removeEventListener('mousemove', activeMove, true);
            if (activeUp) document.removeEventListener('mouseup', activeUp, true);
            if (frame !== null) cancelRaf(frame);
            if (drag) setChartInteractive(true); // 拖曳中被卸載 — 別讓圖表卡住
        };
    }, [hostRef, chartRef, pushState, token, clearMeasure, beginOperation, bumpHistory, writer, cancelText, enterDrawingMode]);

    // 交易模式武裝時收起畫圖工具、量測並取消選取：兩者不會同時吃同一下
    // 點擊，武裝點價買賣時按 Delete 也不會刪到剛才選著的畫圖物件
    useLayoutEffect(() => {
        if (!tradeArmed) return;
        // 交易模式已用目前畫圖序號武裝；收起畫圖不是另一次畫圖操作。
        // 委託拖曳仍要取消，但不能使剛建立的點價武裝失效。
        cancelInteractionsRef.current(true, false);
    }, [tradeArmed]);

    // ── 鍵盤 ─────────────────────────────────────────────────────────
    const hasFocusState = !!(tool || selectedIds.length || measuring);

    // 選取或武裝工具（含從左側工具列）就接手鍵盤
    useEffect(() => {
        if (hasFocusState) claimKeyboard(token);
    }, [hasFocusState, token]);

    // 別張圖接手時放掉自己的選取、工具與量測
    useEffect(() => {
        const onOwnerChange = () => {
            setIsOwner(keyOwner === token);
            if (keyOwner === token) return;
            cancelInteractionsRef.current(true);
        };
        keyOwnerListeners.add(onOwnerChange);
        return () => {
            keyOwnerListeners.delete(onOwnerChange);
            if (keyOwner === token) keyOwner = null;
        };
    }, [token, pushState, clearMeasure]);

    const setToolChecked = useCallback(
        (t: DrawingToolId | null) => {
            enterDrawingMode();
            cancelInteractionsRef.current(true);
            toolContextRef.current = stateRef.current.contextKey;
            // 動到左側工具列就離開交易模式 — 包含按「游標」，那是這一側的
            // 中性狀態，也是從交易模式脫身的方式之一
            if (t) {
                clearMeasure();
                setSelectedIds([]);
                claimKeyboard(token);
                const group = toolDef(t).group;
                const last = stateRef.current.settings.groupLast;
                if (last[group] !== t) saveDrawingSettings({ groupLast: { ...last, [group]: t } });
            }
            setTool(t);
            stateRef.current.tool = t;
            pushState();
        },
        [clearMeasure, pushState, token, enterDrawingMode],
    );

    const removeSelected = useCallback(() => {
        const { symbolKey: key, selectedIds: ids } = stateRef.current;
        if (!ids.length) return;
        tx(() => removeDrawings(key, ids));
        // 鎖定的留下並保持選取
        const left = new Set(getDrawings(key).map((d) => d.id));
        setSelectedIds(ids.filter((id) => left.has(id)));
    }, [tx]);

    // 沒有選取、工具、量測，也不是最後被點的圖時不掛 listener — 鍵盤
    // 完全不經過這張圖
    const listening = hasFocusState || isOwner;
    useEffect(() => {
        if (!listening) return;
        const onKey = (e: KeyboardEvent) => {
            if (keyOwner !== token) return;
            // modal 開著時鍵盤歸 modal — Esc 關視窗、Delete 不該穿透到
            // 後面圖上的畫圖物件
            if (escStackDepth() > 0) return;
            // 在輸入框裡的 Backspace 是刪字、Ctrl+Z 是復原打字
            if (isTypingTarget(e.target)) return;
            const s = stateRef.current;
            if (e.key === 'Escape') {
                // 已被 modal 的 Esc 收走就不重複處理
                if (e.defaultPrevented) return;
                const canceledOrderDrag = enterDrawingMode();
                // 若本 listener 早於委託拖曳的 Esc listener，取消時會移除
                // 後者；這裡仍須吃掉 Esc，不能流入 Esc×2 全刪單。
                if (canceledOrderDrag) {
                    e.preventDefault();
                    resetEscCancelArm();
                }
                // 畫圖 UI 用掉的 Esc 一律吃掉（preventDefault）並清掉 Esc×2
                // 的「第一下」：use-hotkeys 看到 defaultPrevented 就不算，也
                // 不會跟更早的一下湊成兩下。連按兩下 Esc 確保取消畫圖是很
                // 自然的習慣，這兩下絕不能變成撤掉全部委託。
                if (cancelDragRef.current) {
                    cancelDragRef.current();
                } else if (measureRef.current) {
                    clearMeasure();
                    if (s.tool === 'measure') setTool(null);
                } else if (draftRef.current || s.tool) {
                    draftRef.current = null;
                    setTool(null);
                    pushState();
                } else if (s.selectedIds.length) {
                    // 取消選取＝關閉浮動工具列，同樣吃掉
                    setSelectedIds([]);
                } else {
                    return;
                }
                e.preventDefault();
                resetEscCancelArm();
                return;
            }
            const host = hostRef.current;
            const focused = chartHasFocus(host?.parentElement ?? host);
            const undoKey = undoKeyOf(e);
            if (undoKey) {
                if (!focused) return;
                e.preventDefault();
                if (undoKey === 'undo') undo();
                else redo();
                return;
            }
            const shortcut = toolShortcutOf(e);
            if (shortcut) {
                if (!focused) return;
                e.preventDefault();
                setToolChecked(s.tool === shortcut ? null : shortcut);
                return;
            }
            if (e.key !== 'Delete' && e.key !== 'Backspace') return;
            // 焦點必須真的在這張圖上（圖表本體或它的工具列）
            if (!focused) return;
            enterDrawingMode();
            if (!s.selectedIds.length) return;
            if (!s.drawings.some((d) => s.selectedIds.includes(d.id) && !d.locked)) return;
            e.preventDefault();
            removeSelected();
        };
        // capture：use-hotkeys 的 Esc×2 全刪單是 window 上的 bubble
        // listener，而且在 App 掛載時就註冊（早於任何 K 線面板）。用
        // bubble 註冊的話它會先跑，取消畫圖的 preventDefault 來不及阻止
        // 它武裝刪單視窗；Delete 也要先於其他面板處理
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [listening, pushState, token, hostRef, undo, redo, clearMeasure, setToolChecked, removeSelected, enterDrawingMode]);

    // ── 對外操作 ─────────────────────────────────────────────────────
    const selectedList = useMemo(
        () => drawings.filter((d) => selectedIds.includes(d.id)),
        [drawings, selectedIds],
    );
    const selected = useMemo(() => {
        const last = selectedIds[selectedIds.length - 1];
        return drawings.find((d) => d.id === last) ?? null;
    }, [drawings, selectedIds]);

    const style =
        selected?.style ??
        defaultStyleFor(settings, tool && tool !== 'measure' ? tool : 'trend', themeMode);

    const applyStyle = useCallback(
        (patch: Partial<DrawingStyle>) => {
            const current = stateRef.current;
            const targets = current.drawings.filter((d) => current.selectedIds.includes(d.id));
            // 鎖定的物件仍可改樣式 — 鎖定擋的是「位置被誤拖」，顏色線寬
            // 改了不會弄丟任何東西
            if (targets.length) {
                const ids = new Set(targets.map((t) => t.id));
                tx(
                    () =>
                        replaceDrawings(
                            current.symbolKey,
                            getDrawings(current.symbolKey).map((d) =>
                                ids.has(d.id) ? { ...d, style: { ...d.style, ...patch } } : d,
                            ),
                        ),
                    `style:${Object.keys(patch).sort().join(',')}`,
                );
            }
            // 也記成下一個新物件的樣式（TradingView 式）。顏色依工具記：
            // 選取中／武裝中的那種工具；兩者皆無時套用到所有工具
            const { color, opacity, ...base } = patch;
            const next: Partial<DrawingSettings> = {
                defaultStyle: { ...current.settings.defaultStyle, ...base },
                ...(opacity !== undefined ? { lineOpacity: opacity } : {}),
            };
            if (color !== undefined) {
                const tools: DrawingTool[] = targets.length
                    ? [...new Set(targets.map((t) => t.tool))]
                    : current.tool && current.tool !== 'measure'
                      ? [current.tool]
                      : DRAWING_TOOLS.map((t) => t.tool);
                const toolColors = { ...current.settings.toolColors };
                for (const t of tools) toolColors[t] = color;
                next.toolColors = toolColors;
            }
            setDrawingSettings(next);
        },
        [tx],
    );

    const patchOne = useCallback(
        (id: string, patch: Partial<Omit<Drawing, 'id'>>, tag?: string) =>
            tx(() => updateDrawing(stateRef.current.symbolKey, id, patch), tag),
        [tx],
    );

    const setLocked = useCallback(
        (id: string, v: boolean) => patchOne(id, { locked: v }),
        [patchOne],
    );
    const setHidden = useCallback(
        (id: string, v: boolean) => patchOne(id, { hidden: v }),
        [patchOne],
    );

    const toggleLock = useCallback(() => {
        const { selectedIds: ids, drawings: list, symbolKey: key } = stateRef.current;
        const sel = list.filter((d) => ids.includes(d.id));
        if (!sel.length) return;
        const lock = sel.some((d) => !d.locked);
        tx(() => setDrawingsLocked(key, lock, ids));
    }, [tx]);

    const toggleHidden = useCallback(() => {
        const { selectedIds: ids, drawings: list, symbolKey: key } = stateRef.current;
        const sel = list.filter((d) => ids.includes(d.id));
        if (!sel.length) return;
        const hide = sel.some((d) => !d.hidden);
        tx(() =>
            replaceDrawings(
                key,
                getDrawings(key).map((d) => (ids.includes(d.id) ? { ...d, hidden: hide } : d)),
            ),
        );
    }, [tx]);

    const rename = useCallback(
        (id: string, name: string) => {
            const n = name.trim().slice(0, MAX_NAME_LENGTH);
            const d = getDrawings(stateRef.current.symbolKey).find((x) => x.id === id);
            if (!d || n === (d.name ?? '')) return;
            patchOne(id, { name: n || undefined });
        },
        [patchOne],
    );

    const reorder = useCallback(
        (id: string, toIndex: number) =>
            tx(() => moveDrawing(stateRef.current.symbolKey, id, toIndex)),
        [tx],
    );

    const duplicate = useCallback(() => {
        const { symbolKey: key, selectedIds: ids } = stateRef.current;
        if (!ids.length) return;
        const projector = layerRef.current?.projector();
        if (!projector) return;
        // 位移在畫面座標做 — 時間軸有缺口、價格軸可能是對數，直接加
        // 時間或價格會偏掉，而且水平線加時間根本看不出位移
        const shift = (a: DrawingAnchor) => {
            const x = projector.xOfTime(a.time);
            const y = projector.yOfPrice(a.price);
            if (x === null || y === null) return a;
            return (
                unprojectPoint(projector, {
                    x: x + DUPLICATE_OFFSET_PX,
                    y: y + DUPLICATE_OFFSET_PX,
                }) ?? a
            );
        };
        const copies: string[] = [];
        tx(() => {
            for (const id of ids) {
                const copy = duplicateDrawing(key, id, shift);
                if (copy) copies.push(copy.id);
            }
        });
        if (copies.length) setSelectedIds(copies);
    }, [tx]);

    const removeOne = useCallback(
        (id: string) => {
            const { symbolKey: key, drawings: list } = stateRef.current;
            if (list.find((d) => d.id === id)?.locked) return;
            tx(() => removeDrawings(key, [id]));
            setSelectedIds((cur) => cur.filter((x) => x !== id));
        },
        [tx],
    );

    const select = useCallback(
        (id: string | null, additive = false) => {
            if (id) {
                enterDrawingMode();
                claimKeyboard(token);
            }
            const cur = stateRef.current.selectedIds;
            const next = !id ? [] : !additive ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
            stateRef.current.selectedIds = next;
            setSelectedIds(next);
        },
        [token, enterDrawingMode],
    );

    // 輸入框改價：同樣吸附到合法跳動價位，與拖曳的結果一致
    const setSelectedPrice = useCallback(
        (price: number) => {
            const { selectedIds: ids, drawings: list, contract: c } = stateRef.current;
            const target = list.find((d) => d.id === ids[ids.length - 1]);
            if (!target || target.locked || !Number.isFinite(price)) return;
            const snapped = roundToTick(c, price);
            patchOne(target.id, {
                anchors: target.anchors.map((a) => ({ ...a, price: snapped })),
            });
        },
        [patchOne],
    );

    const setAnchor = useCallback(
        (id: string, index: number, patch: Partial<DrawingAnchor>) => {
            const d = getDrawings(stateRef.current.symbolKey).find((x) => x.id === id);
            if (!d || d.locked || !d.anchors[index]) return;
            const anchor = { ...d.anchors[index]!, ...patch };
            if (!Number.isFinite(anchor.time) || !Number.isFinite(anchor.price)) return;
            const price =
                d.tool === 'horizontal'
                    ? roundToTick(stateRef.current.contract, anchor.price)
                    : anchor.price;
            if (anchor.time === d.anchors[index]!.time && price === d.anchors[index]!.price) return;
            patchOne(id, {
                anchors: d.anchors.map((a, i) => (i === index ? { time: anchor.time, price } : a)),
            });
        },
        [patchOne],
    );

    const setFib = useCallback(
        (id: string, patch: Partial<FibOptions>) => {
            const d = getDrawings(stateRef.current.symbolKey).find((x) => x.id === id);
            if (!d || d.tool !== 'fib') return;
            // 整份過一次驗證：比例去重排序、範圍夾住
            const fib = sanitizeFibOptions({ ...d.fib, ...patch });
            if (JSON.stringify(fib) === JSON.stringify(d.fib)) return;
            // 連續拉滑桿（色帶透明度）合併成一步復原
            patchOne(id, { fib }, `fib:${Object.keys(patch).sort().join(',')}`);
        },
        [patchOne],
    );

    const editText = useCallback((id: string) => {
        const d = stateRef.current.drawings.find((x) => x.id === id);
        if (!d || d.tool !== 'text' || d.locked) return;
        enterDrawingMode();
        cancelInteractionsRef.current(true);
        historyRef.current.begin(stateRef.current.symbolKey, getDrawingHistoryStart());
        textTxRef.current = { id, key: stateRef.current.symbolKey, context: stateRef.current.contextKey, before: getDrawings(stateRef.current.symbolKey), created: false };
        setSelectedIds([id]);
        stateRef.current.selectedIds = [id];
        setEditingTextId(id);
    }, [enterDrawingMode]);

    // text＝null：取消編輯（新建的文字整筆不留）
    const commitText = useCallback(
        (text: string | null) => {
            // 舊輸入框的 blur／提交 callback 不可接手新 context 或新的編輯物件。
            if (symbolKey !== stateRef.current.symbolKey || contextKey !== stateRef.current.contextKey ||
                editingTextId !== stateRef.current.editingTextId) return;
            const { editingTextId: id, symbolKey: key } = stateRef.current;
            const info = textTxRef.current;
            textTxRef.current = null;
            stateRef.current.editingTextId = null;
            setEditingTextId(null);
            if (!id) return;
            if (!info || info.invalidated || info.key !== key || info.context !== stateRef.current.contextKey) return;
            beginOperation();
            const value = text === null ? null : text.slice(0, MAX_TEXT_LENGTH).replace(/\s+$/, '');
            if (info?.created && !value) {
                // 新建後沒打字（或取消）：不留下空的文字框，也不進復原
                withDrawingWriter(writer, () => removeDrawings(key, [id]));
                setSelectedIds([]);
                return;
            }
            if (text === null) {
                const original = info?.before.find((d) => d.id === id);
                if (original) {
                    const restored = withDrawingWriter(writer, () => cancelDrawingChanges(key, [original])).find((d) => d.id === id);
                    if (restored) historyRef.current.rebase(key, original, restored);
                }
                return;
            }
            if (value) withDrawingWriter(writer, () => updateDrawing(key, id, { text: value }));
            if (info) {
                const after = getDrawings(key);
                if (after !== info.before) {
                    // 只記這個文字物件：編輯期間別處的改動不算這一步
                    historyRef.current.push(key, info.before, after, undefined, undefined, [id]);
                    bumpHistory();
                }
            }
            const host = hostRef.current;
            if (host && typeof host.focus === 'function') host.focus({ preventScroll: true });
        },
        [beginOperation, bumpHistory, hostRef, writer, symbolKey, contextKey, editingTextId],
    );

    const updateTextDraft = useCallback((text: string) => {
        const info = textTxRef.current;
        if (info && info.key === symbolKey && info.context === contextKey && info.id === editingTextId) {
            beginOperation();
            info.value = text;
        }
    }, [beginOperation, symbolKey, contextKey, editingTextId]);
    finishTextRef.current = () => {
        const info = textTxRef.current;
        if (info && (info.key !== stateRef.current.symbolKey || info.context !== stateRef.current.contextKey)) {
            cancelText();
            return;
        }
        if (info) commitText(info.value ?? info.before.find((d) => d.id === info.id)?.text ?? '');
    };

    const setText = useCallback(
        (id: string, text: string) => {
            const v = text.slice(0, MAX_TEXT_LENGTH).replace(/\s+$/, '');
            const d = stateRef.current.drawings.find((x) => x.id === id);
            if (!d || d.tool !== 'text' || d.locked || !v || v === d.text) return;
            patchOne(id, { text: v });
        },
        [patchOne],
    );

    const clearAll = useCallback(() => {
        tx(() => clearDrawings(stateRef.current.symbolKey));
        setSelectedIds([]);
    }, [tx]);

    const showAll = useCallback(
        () => tx(() => showAllDrawings(stateRef.current.symbolKey)),
        [tx],
    );

    const allLocked = drawings.length > 0 && drawings.every((d) => d.locked);
    const lockAll = useCallback(() => {
        const lock = stateRef.current.drawings.some((d) => !d.locked);
        tx(() => setDrawingsLocked(stateRef.current.symbolKey, lock));
    }, [tx]);

    const setShareContinuousMonth = useCallback((v: boolean) => {
        setDrawingSettings({ shareContinuousMonth: v });
    }, []);
    const setMagnet = useCallback((v: boolean) => setDrawingSettings({ magnet: v }), []);
    const setObjectListOpen = useCallback(
        (v: boolean) => setDrawingSettings({ objectListOpen: v }),
        [],
    );
    const toggleFavorite = useCallback((t: DrawingToolId) => {
        const favs = stateRef.current.settings.favorites;
        setDrawingSettings({
            favorites: favs.includes(t) ? favs.filter((x) => x !== t) : [...favs, t],
        });
    }, []);

    const formatPrice = useCallback(
        (price: number, grouping = true) =>
            formatToTick(stateRef.current.contract, price, { grouping }),
        [],
    );

    const drawingAt = useCallback((ev: { clientX: number; clientY: number }): DrawingHit => {
        const layer = layerRef.current;
        const pt = layer?.pointOf(ev);
        const projector = layer?.projector();
        if (!layer || !pt || !projector) return null;
        const { drawings: list, selectedIds: sel } = stateRef.current;
        if (!list.length) return null;
        const picked = pickDrawing(list, projector, layer.paneSize, pt, undefined, layer.formatPrice);
        if (!picked) return null;
        return sel.includes(picked.drawing.id) ? 'selected' : 'other';
    }, []);
    // 量測完成後還顯示著的那段時間也算：這時點一下是「清除量測」，
    // 不能被委託線接去改價
    const drawingBusy = useCallback(
        () => !!(stateRef.current.tool || stateRef.current.selectedIds.length || draftRef.current ||
            measureRef.current || cancelDragRef.current || textTxRef.current),
        [],
    );
    const drawingLabelAt = useCallback((clientY: number) => {
        const layer = layerRef.current;
        const pt = layer?.pointOf({ clientX: 0, clientY });
        if (!layer || !pt) return false;
        return layer.axisLabelRects().some((r) => pt.y >= r.top && pt.y <= r.bottom);
    }, []);

    const focusChart = useCallback(() => {
        const host = hostRef.current;
        if (!host || typeof host.focus !== 'function') return;
        if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
        host.focus({ preventScroll: true });
    }, [hostRef]);
    const prepareOrderDrag = useCallback(() => {
        cancelInteractionsRef.current(true);
        claimKeyboard(token);
        focusChart();
    }, [token, focusChart]);

    return {
        onInteraction: enterDrawingMode,
        interactionSequence,
        prepareOrderDrag,
        tool,
        setTool: setToolChecked,
        drawings,
        selectedIds,
        selected,
        selectedList,
        select,
        style,
        applyStyle,
        toggleLock,
        toggleHidden,
        setLocked,
        setHidden,
        rename,
        reorder,
        duplicate,
        remove: removeSelected,
        removeOne,
        clearAll,
        showAll,
        lockAll,
        allLocked,
        setSelectedPrice,
        setAnchor,
        setFib,
        editingTextId,
        updateTextDraft,
        editText,
        commitText,
        setText,
        undo,
        redo,
        canUndo: historyRef.current.canUndo,
        canRedo: historyRef.current.canRedo,
        magnet: settings.magnet,
        setMagnet,
        favorites: settings.favorites,
        toggleFavorite,
        groupLast: settings.groupLast,
        objectListOpen: settings.objectListOpen,
        setObjectListOpen,
        measuring,
        selectionBox,
        editBox,
        hostSize,
        themeMode,
        symbolKey,
        shareContinuousMonth: settings.shareContinuousMonth,
        setShareContinuousMonth,
        focusChart,
        formatPrice,
        drawingAt,
        drawingBusy,
        drawingLabelAt,
    };
}
