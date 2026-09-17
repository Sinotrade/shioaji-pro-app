// src/lib/chart-drawings.ts — 圖表畫圖物件的資料模型與儲存（issue #122 二／三）
//
// 三個設計要點：
// 1. 座標一律存「時間＋價格」，不存 K 棒 index — 切換週期後同一條線
//    still 落在同一個時間／價位（幾何投影見 chart-drawing-geometry.ts）。
// 2. 依商品保存，不依面板保存 — 多開的 K 線面板與彈出視窗看同一份資料。
// 3. popout 是另一個 window，module state 不共用；跟 risk.ts 一樣靠
//    storage 事件把另一個 window 的寫入同步回來。

import { useSyncExternalStore } from 'react';
import type { ContractBase } from './types/contract';

export type DrawingTool =
    | 'horizontal' // 水平線：單一價位，橫貫整個 pane
    | 'trend' // 趨勢線：兩點之間的線段
    | 'ray' // 射線：由起點經第二點向右無限延伸
    | 'extended' // 延伸線：兩點決定斜率，向左右無限延伸
    | 'box'; // 方框：兩個對角決定的矩形

export const DRAWING_TOOLS: { tool: DrawingTool; label: string; hint: string }[] = [
    { tool: 'horizontal', label: '水平線', hint: '支撐、壓力、前高前低（點一下）' },
    { tool: 'trend', label: '趨勢線', hint: '兩點決定的線段' },
    { tool: 'ray', label: '射線', hint: '由起點經第二點向右延伸' },
    { tool: 'extended', label: '延伸線', hint: '兩點決定斜率，向左右延伸' },
    { tool: 'box', label: '方框', hint: '兩個對角決定的區域' },
];

// 需要兩個控制點的工具；水平線只要一個
export function anchorCount(tool: DrawingTool): 1 | 2 {
    return tool === 'horizontal' ? 1 : 2;
}

export interface DrawingAnchor {
    time: number; // UTC 秒（與 lightweight-charts 的 UTCTimestamp 同一刻度）
    price: number;
}

export interface DrawingStyle {
    color: string; // 線色（#rrggbb）
    width: number; // 線寬 1–4
    dash: 'solid' | 'dashed';
    fillOpacity: number; // 方框填色透明度 0–1（其他工具不使用）
}

export interface Drawing {
    id: string;
    tool: DrawingTool;
    anchors: DrawingAnchor[];
    style: DrawingStyle;
    locked: boolean; // 鎖定：不可拖曳、改價、刪除（仍可選取與改樣式）
    hidden: boolean; // 隱藏：不繪製，但仍保存
    createdAt: number;
}

// TradingView 風格的固定色盤 — 不跟主題走，使用者選什麼就是什麼，
// 換深／淺色主題不會把使用者挑的顏色換掉
export const DRAWING_PALETTE = [
    '#2962ff',
    '#00bcd4',
    '#26a69a',
    '#66bb6a',
    '#ffb300',
    '#ff7043',
    '#ef5350',
    '#ec407a',
    '#ab47bc',
    '#9e9e9e',
] as const;

// 價格軸標籤的字色。刻意照抄 lightweight-charts 內部的 generateContrastColors
// （NTSC 灰階加權、門檻 160），我們的標籤才會跟現價、委託單價格線那些
// 內建標籤長得一模一樣；自己另訂一套門檻會出現同色系標籤字色不同的怪畫面。
export function contrastTextColor(hex: string): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return '#ffffff';
    const n = parseInt(m[1]!, 16);
    const gray = 0.199 * ((n >> 16) & 255) + 0.687 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return gray > 160 ? '#000000' : '#ffffff';
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
    color: DRAWING_PALETTE[0],
    width: 2,
    dash: 'solid',
    fillOpacity: 0.12,
};

export interface DrawingSettings {
    // 期貨連續月（TXFR1）與月份合約（TXFI6）共用同一份畫圖。
    // 連續月只是近月的別名，交易者畫在 R1 上的壓力線換月後仍然有效；
    // 關掉則每個合約代碼各自獨立（TradingView 式）。
    shareContinuousMonth: boolean;
    // 下一個新物件的樣式（改樣式時記住，跟 TradingView 一樣）
    defaultStyle: DrawingStyle;
}

const DEFAULT_SETTINGS: DrawingSettings = {
    shareContinuousMonth: true,
    defaultStyle: DEFAULT_DRAWING_STYLE,
};

const STORAGE_KEY = 'sj-pro-chart-drawings';
const SETTINGS_KEY = 'sj-pro-chart-drawing-settings';

// ── 商品鍵 ───────────────────────────────────────────────────────────
//
// 期貨代碼 = 根代碼＋月份碼＋年尾數（TXFI6、CCFI6），連續月為 R1／R2
// 別名（TXFR1）。共用開啟時全部收斂到根代碼（TXF）。
// 選擇權不收斂 — TXO21000I6 與 TXO21500I6 是不同履約價，不是同一商品。
const FUT_CODE = /^([A-Z]{2,4})(?:R[12]|[A-X]\d)$/;

// TXFR1／TXFI6 → TXF；不是期貨月份代碼就原樣回傳
export function futuresRootCode(code: string): string {
    const upper = code.toUpperCase();
    const m = FUT_CODE.exec(upper);
    return m ? m[1]! : upper;
}

export function drawingSymbolKey(
    contract: Pick<ContractBase, 'code' | 'security_type'>,
    share: boolean,
): string {
    const code = contract.code.toUpperCase();
    if (!share || contract.security_type !== 'FUT') return code;
    return futuresRootCode(code);
}

// ── 儲存 ─────────────────────────────────────────────────────────────

type Store = Record<string, Drawing[]>;

function loadStore(): Store {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Store = {};
        for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(list)) {
                const clean = list.filter(isDrawing);
                if (clean.length) out[key] = clean;
            }
        }
        return out;
    } catch {
        return {}; // 壞掉的資料不能讓圖表開不起來
    }
}

// 舊版本或手改過的 localStorage 都可能餵進形狀不對的物件 — 投影時
// NaN 會整張圖畫不出來，所以在入口就擋掉
function isDrawing(v: unknown): v is Drawing {
    if (!v || typeof v !== 'object') return false;
    const d = v as Partial<Drawing>;
    if (typeof d.id !== 'string' || typeof d.tool !== 'string') return false;
    if (!DRAWING_TOOLS.some((t) => t.tool === d.tool)) return false;
    if (!Array.isArray(d.anchors) || d.anchors.length !== anchorCount(d.tool)) return false;
    if (
        !d.anchors.every(
            (a) =>
                a &&
                typeof a.time === 'number' &&
                Number.isFinite(a.time) &&
                typeof a.price === 'number' &&
                Number.isFinite(a.price),
        )
    ) {
        return false;
    }
    return !!d.style && typeof d.style.color === 'string';
}

function loadSettings(): DrawingSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        const s = JSON.parse(raw) as Partial<DrawingSettings>;
        return {
            shareContinuousMonth:
                typeof s.shareContinuousMonth === 'boolean'
                    ? s.shareContinuousMonth
                    : DEFAULT_SETTINGS.shareContinuousMonth,
            defaultStyle: { ...DEFAULT_DRAWING_STYLE, ...(s.defaultStyle ?? {}) },
        };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

let store: Store = loadStore();
let settings: DrawingSettings = loadSettings();
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

// cross-window sync — popout 與主視窗共用 localStorage 但不共用 module
// state；沒有這段，在主視窗畫的線不會出現在已開啟的彈出視窗
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            store = loadStore();
            emit();
        } else if (e.key === SETTINGS_KEY) {
            settings = loadSettings();
            emit();
        }
    });
}

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // 配額滿或隱私模式 — 本次 session 仍然可用，只是不落地
    }
    emit();
}

function persistSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // 同上
    }
    emit();
}

const EMPTY: Drawing[] = [];

export function getDrawings(key: string): Drawing[] {
    return store[key] ?? EMPTY;
}

export function getDrawingSettings(): DrawingSettings {
    return settings;
}

export function setDrawingSettings(patch: Partial<DrawingSettings>) {
    settings = { ...settings, ...patch };
    persistSettings();
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useDrawings(key: string): Drawing[] {
    return useSyncExternalStore(
        subscribe,
        () => store[key] ?? EMPTY,
        () => EMPTY,
    );
}

export function useDrawingSettings(): DrawingSettings {
    return useSyncExternalStore(
        subscribe,
        () => settings,
        () => DEFAULT_SETTINGS,
    );
}

function newId(): string {
    return `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function addDrawing(
    key: string,
    tool: DrawingTool,
    anchors: DrawingAnchor[],
    style: DrawingStyle,
): Drawing {
    const drawing: Drawing = {
        id: newId(),
        tool,
        anchors,
        style: { ...style },
        locked: false,
        hidden: false,
        createdAt: Date.now(),
    };
    store = { ...store, [key]: [...(store[key] ?? []), drawing] };
    persist();
    return drawing;
}

export function updateDrawing(key: string, id: string, patch: Partial<Omit<Drawing, 'id'>>) {
    const list = store[key];
    if (!list) return;
    const next = list.map((d) => (d.id === id ? { ...d, ...patch } : d));
    store = { ...store, [key]: next };
    persist();
}

export function removeDrawing(key: string, id: string) {
    const list = store[key];
    if (!list) return;
    const next = list.filter((d) => d.id !== id);
    store = { ...store, [key]: next };
    persist();
}

// 複製：偏移交給呼叫端決定。用畫面像素位移再換回時間／價格，水平線這種
// 「時間不影響外觀」的物件才不會複製出一條完全疊在原處、看不見的線。
export function duplicateDrawing(
    key: string,
    id: string,
    shift: (a: DrawingAnchor) => DrawingAnchor,
): Drawing | null {
    const source = (store[key] ?? []).find((d) => d.id === id);
    if (!source) return null;
    return addDrawing(key, source.tool, source.anchors.map(shift), source.style);
}

// 一鍵清除目前商品所有畫圖 — 鎖定的物件保留（鎖定的用意就是防誤刪）
export function clearDrawings(key: string) {
    const list = store[key];
    if (!list?.length) return;
    const kept = list.filter((d) => d.locked);
    store = { ...store, [key]: kept };
    persist();
}

// 測試用 — 清乾淨 module state 與 localStorage
export function __resetDrawingsForTest() {
    store = {};
    settings = DEFAULT_SETTINGS;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETTINGS_KEY);
    } catch {
        // ignore
    }
}
