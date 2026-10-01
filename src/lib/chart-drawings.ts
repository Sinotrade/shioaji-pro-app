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
    // 最後修改時間：跨視窗合併時與刪除墓碑比較，較舊的修改不能讓已刪除
    // 的物件復活
    updatedAt: number;
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
    const m = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex.trim()) : null;
    if (!m) return '#ffffff';
    const n = parseInt(m[1]!, 16);
    const gray = 0.199 * ((n >> 16) & 255) + 0.687 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return gray > 160 ? '#000000' : '#ffffff';
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
    color: DRAWING_PALETTE[0],
    width: 2,
    dash: 'solid',
    fillOpacity: 0.08,
};

export type DrawingThemeMode = 'dark' | 'light';

// 各工具的預設色（使用者沒挑過顏色時）。刻意避開圖上已有語意的顏色：
// 委託線的紅／綠（買賣）、停損觸價線與 MA 的琥珀 #e0a43c、警示線的灰
// #8b94a7、MACD／KD 的藍 #3d8bff。水平線用偏紅的橘（讀價位用，要醒目），
// 斜線類用紫，方框用中性灰描邊＋淡填色（框的是區域，不該搶 K 棒）。
// 深／淺主題各一組：淺色底上同一個色相要更深才看得清楚。
export const TOOL_DEFAULT_COLORS: Record<DrawingThemeMode, Record<DrawingTool, string>> = {
    dark: {
        horizontal: '#ff7a2f',
        trend: '#9b87f5',
        ray: '#9b87f5',
        extended: '#9b87f5',
        box: '#9aa3b5',
    },
    light: {
        horizontal: '#e8590c',
        trend: '#6741d9',
        ray: '#6741d9',
        extended: '#6741d9',
        box: '#6b7280',
    },
};

// 新物件除了顏色以外的預設（線寬、線型、方框填色）
export type DrawingBaseStyle = Omit<DrawingStyle, 'color'>;

export interface DrawingSettings {
    // 期貨連續月（TXFR1）與月份合約（TXFI6）共用同一份畫圖。
    // 連續月只是近月的別名，交易者畫在 R1 上的壓力線換月後仍然有效；
    // 關掉則每個合約代碼各自獨立（TradingView 式）。
    shareContinuousMonth: boolean;
    // 下一個新物件的樣式（改樣式時記住，跟 TradingView 一樣）
    defaultStyle: DrawingBaseStyle;
    // 使用者挑過的顏色，依工具記住；沒挑過的工具用 TOOL_DEFAULT_COLORS
    toolColors: Partial<Record<DrawingTool, string>>;
}

const DEFAULT_SETTINGS: DrawingSettings = {
    shareContinuousMonth: true,
    defaultStyle: {
        width: DEFAULT_DRAWING_STYLE.width,
        dash: DEFAULT_DRAWING_STYLE.dash,
        fillOpacity: DEFAULT_DRAWING_STYLE.fillOpacity,
    },
    toolColors: {},
};

// 某個工具的下一個新物件樣式：使用者挑過的顏色優先，否則依主題取預設色
export function defaultStyleFor(
    s: DrawingSettings,
    tool: DrawingTool,
    mode: DrawingThemeMode,
): DrawingStyle {
    return { ...s.defaultStyle, color: s.toolColors[tool] ?? TOOL_DEFAULT_COLORS[mode][tool] };
}

const STORAGE_KEY = 'sj-pro-chart-drawings';

// 每個商品鍵的上限。整份 store 是一個 localStorage 項目，無上限地長下去
// 每次寫入與跨視窗解析都會變慢，也會吃掉其他設定的配額。
// （放在檔案前段：module 初始化載入資料時 capDrawings 就要用到）
export const MAX_DRAWINGS_PER_SYMBOL = 200;
const SETTINGS_KEY = 'sj-pro-chart-drawing-settings';

// ── 商品鍵 ───────────────────────────────────────────────────────────
//
// 期貨代碼 = 根代碼＋月份碼＋年尾數（TXFI6、CCFI6），連續月為 R1／R2
// 別名（TXFR1）。共用開啟時全部收斂到根代碼（TXF）。
// 選擇權不收斂 — TXO21000I6 與 TXO21500I6 是不同履約價，不是同一商品。
const FUT_CODE = /^([A-Z]{2,4})(?:R[12]|[A-X]\d)$/;

export function drawingSymbolKey(
    contract: Pick<ContractBase, 'code' | 'security_type'>,
    share: boolean,
): string {
    const code = contract.code.toUpperCase();
    if (!share || contract.security_type !== 'FUT') return code;
    const m = FUT_CODE.exec(code);
    return m ? m[1]! : code;
}

// ── 驗證 ─────────────────────────────────────────────────────────────
//
// 舊版本或手改過的 localStorage 都可能餵進形狀不對的資料 — 投影時 NaN
// 會整張圖畫不出來、非字串的顏色會讓價格軸標籤 .trim() 拋錯，所以每個
// 欄位都在入口驗過；看不懂的樣式欄位退回預設，而不是整筆丟掉。

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isDrawingColor(v: unknown): v is string {
    return typeof v === 'string' && HEX_COLOR.test(v);
}

function sanitizeBaseStyle(v: unknown, fallback: DrawingBaseStyle): DrawingBaseStyle {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const width =
        typeof o.width === 'number' && Number.isFinite(o.width)
            ? Math.min(4, Math.max(1, Math.round(o.width)))
            : fallback.width;
    const dash = o.dash === 'solid' || o.dash === 'dashed' ? o.dash : fallback.dash;
    const fillOpacity =
        typeof o.fillOpacity === 'number' && Number.isFinite(o.fillOpacity)
            ? Math.min(1, Math.max(0, o.fillOpacity))
            : fallback.fillOpacity;
    return { width, dash, fillOpacity };
}

export function sanitizeStyle(v: unknown, fallbackColor: string): DrawingStyle {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        color: isDrawingColor(o.color) ? o.color : fallbackColor,
        ...sanitizeBaseStyle(o, DEFAULT_SETTINGS.defaultStyle),
    };
}

// 形狀不對（工具、控制點）就整筆丟掉；樣式與旗標則修成合法值
export function sanitizeDrawing(v: unknown): Drawing | null {
    if (!v || typeof v !== 'object') return null;
    const d = v as Record<string, unknown>;
    if (typeof d.id !== 'string' || !d.id || typeof d.tool !== 'string') return null;
    const tool = DRAWING_TOOLS.find((t) => t.tool === d.tool)?.tool;
    if (!tool) return null;
    if (!Array.isArray(d.anchors) || d.anchors.length !== anchorCount(tool)) return null;
    const anchors: DrawingAnchor[] = [];
    for (const a of d.anchors as unknown[]) {
        const o = (a && typeof a === 'object' ? a : null) as Record<string, unknown> | null;
        if (
            !o ||
            typeof o.time !== 'number' ||
            !Number.isFinite(o.time) ||
            typeof o.price !== 'number' ||
            !Number.isFinite(o.price)
        ) {
            return null;
        }
        anchors.push({ time: o.time, price: o.price });
    }
    return {
        id: d.id,
        tool,
        anchors,
        style: sanitizeStyle(d.style, TOOL_DEFAULT_COLORS.dark[tool]),
        locked: d.locked === true,
        hidden: d.hidden === true,
        createdAt: typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? d.createdAt : 0,
        updatedAt:
            typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt)
                ? d.updatedAt
                : typeof d.createdAt === 'number' && Number.isFinite(d.createdAt)
                  ? d.createdAt
                  : 0,
    };
}

export function sanitizeSettings(v: unknown): DrawingSettings {
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const toolColors: Partial<Record<DrawingTool, string>> = {};
    const rawColors = o.toolColors;
    if (rawColors && typeof rawColors === 'object') {
        for (const { tool } of DRAWING_TOOLS) {
            const c = (rawColors as Record<string, unknown>)[tool];
            if (isDrawingColor(c)) toolColors[tool] = c;
        }
    }
    return {
        shareContinuousMonth:
            typeof o.shareContinuousMonth === 'boolean'
                ? o.shareContinuousMonth
                : DEFAULT_SETTINGS.shareContinuousMonth,
        defaultStyle: sanitizeBaseStyle(o.defaultStyle, DEFAULT_SETTINGS.defaultStyle),
        toolColors,
    };
}

// ── 儲存 ─────────────────────────────────────────────────────────────

type Store = Record<string, Drawing[]>;

// 刪除墓碑：{ 商品鍵: { 物件 id: 刪除時間 } }，另存一個項目。別的視窗
// 手上還有這個物件的舊版本時，寫出或同步都不會讓它復活；超過 TTL 的
// 墓碑在寫出時清掉，不會無限長大。
type Tombs = Record<string, Record<string, number>>;
const TOMB_KEY = 'sj-pro-chart-drawing-tombstones';
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;

function loadTombs(): Tombs {
    try {
        const raw = localStorage.getItem(TOMB_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Tombs = {};
        for (const [key, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!ids || typeof ids !== 'object') continue;
            for (const [id, at] of Object.entries(ids as Record<string, unknown>)) {
                if (typeof at === 'number' && Number.isFinite(at)) (out[key] ??= {})[id] = at;
            }
        }
        return out;
    } catch {
        return {};
    }
}

// 墓碑不比物件的最後修改舊 → 物件已被刪除（時間戳嚴格遞增，見 stamp）
function buried(tombs: Tombs, key: string, d: Drawing): boolean {
    const at = tombs[key]?.[d.id];
    return at !== undefined && at >= d.updatedAt;
}

// 嚴格遞增的時間戳：同一毫秒內的「修改」與「刪除」也分得出先後
let lastStamp = 0;
export function stamp(): number {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
}

// 載入時的硬上限：只擋損壞或異常巨大的資料（正常使用最多到軟上限
// MAX_DRAWINGS_PER_SYMBOL 附近）。超過時保留最新的 HARD_MAX 個並通知
export const HARD_MAX_DRAWINGS_PER_SYMBOL = 1000;

export function capDrawings(list: Drawing[], max = HARD_MAX_DRAWINGS_PER_SYMBOL): Drawing[] {
    if (list.length <= max) return list;
    const keep = new Set(
        [...list]
            .sort((x, y) => y.createdAt - x.createdAt)
            .slice(0, max)
            .map((d) => d.id),
    );
    return list.filter((d) => keep.has(d.id));
}

// 給 UI 顯示的通知（合併後超過上限、載入時截斷異常資料）
let notices: string[] = [];
const noticed = new Set<string>(); // 同一則只通知一次（載入／同步會重跑）
function noteDrawings(msg: string) {
    if (noticed.has(msg)) return;
    noticed.add(msg);
    notices = [...notices, msg];
    // 在 module 初始化期間 listeners 還是空的，emit 無副作用
    for (const l of listeners) l();
}
export function takeDrawingNotices(): string[] {
    const out = notices;
    if (out.length) notices = [];
    return out;
}
export function useDrawingNotices(): readonly string[] {
    return useSyncExternalStore(subscribe, () => notices, () => EMPTY_NOTICES);
}
const EMPTY_NOTICES: string[] = [];

function loadStore(tombs: Tombs = loadTombs()): Store {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Store = {};
        for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            const clean: Drawing[] = [];
            const seen = new Set<string>();
            for (const item of list) {
                const d = sanitizeDrawing(item);
                if (!d || seen.has(d.id) || buried(tombs, key, d)) continue;
                seen.add(d.id);
                clean.push(d);
            }
            // 硬上限只擋損壞／異常巨大的資料；正常的軟上限超量不在這裡刪
            if (clean.length > HARD_MAX_DRAWINGS_PER_SYMBOL) {
                noteDrawings(
                    `${key} 的畫圖資料有 ${clean.length} 筆，超過 ${HARD_MAX_DRAWINGS_PER_SYMBOL} 筆，已只載入最新的 ${HARD_MAX_DRAWINGS_PER_SYMBOL} 筆。`,
                );
            }
            if (clean.length) out[key] = capDrawings(clean);
        }
        return out;
    } catch {
        return {}; // 壞掉的資料不能讓圖表開不起來
    }
}

function loadSettings(): DrawingSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        return sanitizeSettings(JSON.parse(raw));
    } catch {
        return DEFAULT_SETTINGS;
    }
}

// ── 關窗日誌 ─────────────────────────────────────────────────────────
//
// 關視窗（pagehide）時等不到非同步的 Web Lock，但也不能在鎖外做「讀→
// 合併→寫」主項目 — 會蓋掉正在鎖內寫入的視窗，或被它蓋掉而永久遺失。
// 所以關窗時只把本視窗還沒寫出去的改動（逐物件、設定逐欄位）同步寫到
// 自己專屬的日誌項目 sj-chart-drawings-pending:<視窗 id>，不碰主項目。
// 之後任何一個視窗在鎖內寫入時把所有日誌併進主項目並刪掉日誌；讀取時
// 也把日誌疊上去，還沒被併進去之前畫面就看得到。
const JOURNAL_PREFIX = 'sj-chart-drawings-pending:';
const WINDOW_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let journalSeq = 0;

interface Journal {
    name: string; // localStorage 項目名稱
    raw: string; // 讀到的原始內容：刪除前比對，只刪「併進去的那一版」
    ops: Map<string, Map<string, Drawing | number>>;
    settings: Partial<DrawingSettings>;
}

function journalNames(): string[] {
    try {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(JOURNAL_PREFIX)) out.push(k);
        }
        return out.sort();
    } catch {
        return [];
    }
}

function loadJournals(): Journal[] {
    const out: Journal[] = [];
    for (const name of journalNames()) {
        try {
            const text = localStorage.getItem(name);
            if (text === null) continue;
            const raw = JSON.parse(text) as {
                ops?: Record<string, Record<string, unknown>>;
                settings?: Record<string, unknown>;
            } | null;
            if (!raw || typeof raw !== 'object') continue;
            const ops = new Map<string, Map<string, Drawing | number>>();
            for (const [key, byId] of Object.entries(raw.ops ?? {})) {
                if (!byId || typeof byId !== 'object') continue;
                const m = new Map<string, Drawing | number>();
                for (const [id, v] of Object.entries(byId)) {
                    if (typeof v === 'number' && Number.isFinite(v)) m.set(id, v);
                    else {
                        const d = sanitizeDrawing(v);
                        if (d && d.id === id) m.set(id, d);
                    }
                }
                if (m.size) ops.set(key, m);
            }
            const settingsPatch =
                raw.settings && typeof raw.settings === 'object' ? (raw.settings as Partial<DrawingSettings>) : {};
            out.push({ name, raw: text, ops, settings: settingsPatch });
        } catch {
            // 壞掉的日誌略過（寫入者會把它刪掉）
        }
    }
    return out;
}

function applyJournals(base: Store, tombs: Tombs, journals: Journal[]): Store {
    return journals.reduce((acc, j) => applyOps(acc, j.ops, tombs), base);
}

// 主項目＋所有日誌（讀取時看到的樣子）
function loadView(tombs: Tombs = loadTombs(), journals: Journal[] = loadJournals()): Store {
    return applyJournals(loadStore(tombs), tombs, journals);
}

function loadSettingsView(journals: Journal[] = loadJournals()): DrawingSettings {
    if (!journals.some((j) => Object.keys(j.settings).length)) return loadSettings();
    return sanitizeSettings(Object.assign({}, loadSettings(), ...journals.map((j) => j.settings)));
}

// 實際的初始載入在檔案最後面（所有常數都初始化之後才讀 localStorage，
// 不會碰到尚未初始化的 const — TDZ）
let store: Store = {};
let settings: DrawingSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

// ── 待寫入的改動（依物件 id）──────────────────────────────────────────
//
// popout 是另一個 window，module state 不共用，靠同一個 localStorage 項目
// 與 storage 事件同步。本視窗的改動先記成「每個物件 id 的最新版本」，
// 刪除記成刪除時間（墓碑）。寫出時一律「讀最新的 localStorage → 疊上本
// 視窗的改動 → 寫回」，而且整段在跨視窗的 Web Lock 裡做（見 withLock），
// 兩個視窗不會同時讀到同一份舊資料再各自寫回。收到別的視窗寫入時也是
// 「對方版本 → 疊上本視窗還沒寫出去的改動」。同一個物件兩邊都改時，
// 較晚修改（updatedAt）的一方勝出；刪除比修改晚就維持刪除。
type Op = Drawing | number; // number＝刪除時間
const pending = new Map<string, Map<string, Op>>();

function record(key: string, id: string, op: Op) {
    let ops = pending.get(key);
    if (!ops) {
        ops = new Map();
        pending.set(key, ops);
    }
    ops.set(id, op);
}

function applyOps(base: Store, ops: Map<string, Map<string, Op>>, tombs: Tombs): Store {
    if (!ops.size) return base;
    const out: Store = { ...base };
    for (const [key, byId] of ops) {
        const list = [...(out[key] ?? [])];
        for (const [id, op] of byId) {
            const i = list.findIndex((x) => x.id === id);
            if (typeof op === 'number') {
                if (i >= 0 && list[i]!.updatedAt <= op) list.splice(i, 1);
                const t = (tombs[key] ??= {});
                t[id] = Math.max(t[id] ?? 0, op);
            } else if (buried(tombs, key, op)) {
                // 別的視窗在本視窗修改之後刪掉了它 — 這筆（較舊的）修改作廢。
                // 主項目裡同 id 的版本只有「不比刪除新」時才跟著移除；比刪除
                // 還新的版本是刪除之後重建／復原的，要保留
                const at = tombs[key]![id]!;
                if (i >= 0 && list[i]!.updatedAt <= at) list.splice(i, 1);
            } else if (i >= 0) {
                if (list[i]!.updatedAt <= op.updatedAt) list[i] = op;
            } else {
                list.push(op);
            }
        }
        // 合併時不刪使用者的物件：兩個視窗各自在 199 個時再加一個，合併
        // 後暫時超過上限（軟上限）— 通知使用者，新增在 UI 端擋住
        if (list.length > MAX_DRAWINGS_PER_SYMBOL && (base[key]?.length ?? 0) <= MAX_DRAWINGS_PER_SYMBOL) {
            noteDrawings(
                `${key} 的畫圖物件合併後有 ${list.length} 個，超過 ${MAX_DRAWINGS_PER_SYMBOL} 個上限；刪除部分物件之前無法再新增。`,
            );
        }
        if (list.length) out[key] = list;
        else delete out[key];
    }
    return out;
}

function applyPending(base: Store, tombs: Tombs = loadTombs()): Store {
    return applyOps(base, pending, tombs);
}

// 儲存失敗（多半是配額滿）— 畫面上的物件還在，但關掉就沒了，要讓
// 使用者知道。saveError 給 UI 顯示；notice 每一段連續失敗只發一次。
let saveError = false;
let saveErrorNoticePending = false;

// cross-window sync — 沒有這段，在主視窗畫的線不會出現在已開啟的彈出視窗
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY || e.key === TOMB_KEY) {
            reloadDrawingsFromStorage();
        } else if (e.key === SETTINGS_KEY) {
            reloadDrawingSettingsFromStorage();
        } else if (e.key?.startsWith(JOURNAL_PREFIX) && e.newValue) {
            // 別的視窗關掉時留下日誌：先顯示出來，再排一次（鎖內的）寫入把它併進主項目
            reloadDrawingsFromStorage();
            reloadDrawingSettingsFromStorage();
            writeTimer ??= setTimeout(flushDrawingWrites, WRITE_THROTTLE_MS);
        }
    });
}

// ── 跨視窗鎖 ─────────────────────────────────────────────────────────
//
// localStorage 沒有跨視窗鎖（HTML 規範明說不能假設有），「讀→合併→寫」
// 要自己序列化。Web Locks API（Chromium／WebView2、WebKit 都有）以同一個
// origin 為範圍排隊；沒有這個 API 的環境直接同步做（至少同一視窗內仍是
// 原子的）。
const LOCK_NAME = 'sj-chart-drawings';
type LockManagerLike = { request: (name: string, cb: () => unknown) => Promise<unknown> };
let lockOverride: LockManagerLike | null | undefined; // 測試用；undefined＝用 navigator.locks

function lockManager(): LockManagerLike | null {
    if (lockOverride !== undefined) return lockOverride;
    const nav = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }) : undefined;
    return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

function withLock(fn: () => void) {
    const locks = lockManager();
    if (!locks) {
        fn();
        return;
    }
    locks.request(LOCK_NAME, () => fn()).catch(() => fn());
}

export function __setDrawingLocksForTest(locks: LockManagerLike | null | undefined) {
    lockOverride = locks;
}

// 落地節流：拖曳、拉透明度滑桿時每個 mousemove 都會改 store。畫面照常
// 即時更新（emit），localStorage 最多每 WRITE_THROTTLE_MS 寫一次 — 每寫
// 一次其他視窗就要重新解析整份 JSON。
const WRITE_THROTTLE_MS = 300;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | null = null;

// 讀→合併→寫（在鎖內呼叫）。寫出的是「當下」的 pending；寫出期間又有
// 新改動的物件保留在 pending，下一輪再寫
function writeDrawingsNow() {
    const journals = loadJournals();
    if (!pending.size && !journals.length) return;
    const snapshot = new Map([...pending].map(([k, ops]) => [k, new Map(ops)]));
    const tombs = loadTombs();
    const next = applyOps(loadView(tombs, journals), snapshot, tombs);
    const journalSettings = journals.filter((j) => Object.keys(j.settings).length);
    const now = Date.now();
    for (const [key, ids] of Object.entries(tombs)) {
        for (const [id, at] of Object.entries(ids)) if (now - at > TOMBSTONE_TTL_MS) delete ids[id];
        if (!Object.keys(ids).length) delete tombs[key];
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        localStorage.setItem(TOMB_KEY, JSON.stringify(tombs));
        if (journalSettings.length) {
            // 關窗日誌裡的設定也併進主設定（本視窗還沒寫出的欄位之後照常寫）
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(loadSettingsView(journalSettings)));
        }
        // 已併進主項目的日誌刪掉 — 只刪內容與讀到時相同的那一版（每次
        // 關窗寫的是新的項目名稱，照理不會變；比對內容是第二道保險）
        for (const j of journals) {
            if (localStorage.getItem(j.name) === j.raw) localStorage.removeItem(j.name);
        }
    } catch {
        // 配額滿或隱私模式：改動留在 pending（跨視窗同步不會把它們蓋掉，
        // 下一次改動會再試著寫出），並讓 UI 提示使用者
        if (!saveError) {
            saveError = true;
            saveErrorNoticePending = true;
            emit();
        }
        return;
    }
    for (const [key, ops] of snapshot) {
        const cur = pending.get(key);
        if (!cur) continue;
        for (const [id, op] of ops) if (cur.get(id) === op) cur.delete(id);
        if (!cur.size) pending.delete(key);
    }
    if (saveError) {
        saveError = false;
        emit();
    }
}

export function flushDrawingWrites() {
    if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (!pending.size && !journalNames().length) return;
    withLock(writeDrawingsNow);
}

// 設定依欄位合併：本視窗改過哪幾個欄位就只寫那幾個，別的視窗同時改的
// 其他欄位（例如一邊開共用、一邊改樣式）都留下
const pendingSettingKeys = new Set<keyof DrawingSettings>();

function pickSettings(from: DrawingSettings, keys: Iterable<keyof DrawingSettings>): Partial<DrawingSettings> {
    const out: Partial<DrawingSettings> = {};
    for (const k of keys) (out as Record<string, unknown>)[k] = from[k];
    return out;
}

function writeSettingsNow() {
    if (!pendingSettingKeys.size) return;
    const keys = [...pendingSettingKeys];
    const written = pickSettings(settings, keys);
    const merged = { ...loadSettingsView(), ...written };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch {
        return; // 設定寫不進去只影響下次開啟的預設樣式，不另外提示
    }
    for (const k of keys) if (settings[k] === written[k]) pendingSettingKeys.delete(k);
}

export function flushDrawingSettings() {
    if (settingsTimer !== null) {
        clearTimeout(settingsTimer);
        settingsTimer = null;
    }
    if (!pendingSettingKeys.size) return;
    withLock(writeSettingsNow);
}

if (typeof window !== 'undefined') {
    // 還在節流窗內就關視窗 — 最後一筆不能丟。pagehide 裡等不到非同步
    // 的鎖：只寫本視窗的日誌（見「關窗日誌」），不在鎖外動主項目
    window.addEventListener('pagehide', writeDrawingJournal);
}

// pagehide：本視窗還沒寫出去的改動同步寫進自己的日誌項目
export function writeDrawingJournal() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    if (settingsTimer !== null) clearTimeout(settingsTimer);
    writeTimer = null;
    settingsTimer = null;
    if (!pending.size && !pendingSettingKeys.size) return;
    // 每次都寫新的項目名稱（時間＋視窗＋序號）：bfcache 回來後又改了東西
    // 再關一次時，另一個視窗正在合併、準備刪除的舊日誌不會連新內容一起
    // 被刪掉。名稱以時間開頭，依名稱排序就是寫入順序
    const name = `${JOURNAL_PREFIX}${Date.now().toString(36).padStart(9, '0')}:${WINDOW_ID}:${++journalSeq}`;
    const ops: Record<string, Record<string, Drawing | number>> = {};
    for (const [key, byId] of pending) ops[key] = Object.fromEntries(byId);
    const journal = {
        at: Date.now(),
        ops,
        settings: pickSettings(settings, pendingSettingKeys),
    };
    try {
        localStorage.setItem(name, JSON.stringify(journal));
    } catch {
        return; // 配額滿：已經在關窗，沒有別的地方可放
    }
    pending.clear();
    pendingSettingKeys.clear();
}

function persist() {
    writeTimer ??= setTimeout(flushDrawingWrites, WRITE_THROTTLE_MS);
    emit();
}

// 別的視窗寫入了 — 以它的版本為準，再疊上本視窗還沒寫出去的改動
export function reloadDrawingsFromStorage() {
    const tombs = loadTombs();
    store = applyPending(loadView(tombs), tombs);
    emit();
}

export function reloadDrawingSettingsFromStorage() {
    // 本視窗還沒寫出去的欄位保留自己的
    settings = { ...loadSettingsView(), ...pickSettings(settings, pendingSettingKeys) };
    emit();
}

// 儲存是否失敗中（UI 顯示警示）
export function drawingsSaveFailed(): boolean {
    return saveError;
}

// 本段連續失敗還沒提示過就回 true（只回一次）— 多張圖同時訂閱時只會
// 有一張圖發出通知
export function takeDrawingSaveErrorNotice(): boolean {
    if (!saveErrorNoticePending) return false;
    saveErrorNoticePending = false;
    return true;
}

// 設定變動（改預設樣式、拉填色滑桿）同樣節流落地，畫面即時更新
function persistSettings() {
    settingsTimer ??= setTimeout(flushDrawingSettings, WRITE_THROTTLE_MS);
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
    for (const k of Object.keys(patch) as (keyof DrawingSettings)[]) pendingSettingKeys.add(k);
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

export function useDrawingsSaveFailed(): boolean {
    return useSyncExternalStore(subscribe, drawingsSaveFailed, () => false);
}

function newId(): string {
    return `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}


// 已達上限回傳 null — 呼叫端的工具列會先把畫圖按鈕停用
export function addDrawing(
    key: string,
    tool: DrawingTool,
    anchors: DrawingAnchor[],
    style: DrawingStyle,
): Drawing | null {
    if ((store[key]?.length ?? 0) >= MAX_DRAWINGS_PER_SYMBOL) return null;
    const now = stamp();
    const drawing: Drawing = {
        id: newId(),
        tool,
        anchors,
        style: { ...style },
        locked: false,
        hidden: false,
        createdAt: now,
        updatedAt: now,
    };
    store = { ...store, [key]: [...(store[key] ?? []), drawing] };
    record(key, drawing.id, drawing);
    persist();
    return drawing;
}

// 把 key 的清單換成 next，並把有變動的物件記進待寫入（依 id）
function commit(key: string, nextIn: Drawing[]) {
    const before = store[key] ?? EMPTY;
    const now = stamp();
    const ids = new Set(nextIn.map((d) => d.id));
    for (const d of before) if (!ids.has(d.id)) record(key, d.id, now);
    const prev = new Map(before.map((d) => [d.id, d]));
    // 有變動的物件蓋上修改時間（跨視窗合併、與墓碑比較用）
    const next = nextIn.map((d) => {
        if (prev.get(d.id) === d) return d;
        const stamped = d.updatedAt >= now ? d : { ...d, updatedAt: now };
        record(key, d.id, stamped);
        return stamped;
    });
    store = { ...store, [key]: next };
    persist();
}

export function updateDrawing(key: string, id: string, patch: Partial<Omit<Drawing, 'id'>>) {
    const list = store[key];
    if (!list?.some((d) => d.id === id)) return;
    commit(
        key,
        list.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
}

export function removeDrawing(key: string, id: string) {
    const list = store[key];
    if (!list?.some((d) => d.id === id)) return;
    commit(
        key,
        list.filter((d) => d.id !== id),
    );
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

// 隱藏的物件點不到，取消選取後就只能從這裡找回來
export function showAllDrawings(key: string) {
    const list = store[key];
    if (!list?.some((d) => d.hidden)) return;
    commit(
        key,
        list.map((d) => (d.hidden ? { ...d, hidden: false } : d)),
    );
}

// 一鍵清除目前商品所有畫圖 — 鎖定的物件保留（鎖定的用意就是防誤刪）
export function clearDrawings(key: string) {
    const list = store[key];
    if (!list?.length) return;
    commit(
        key,
        list.filter((d) => d.locked),
    );
}

// 測試用 — 清乾淨 module state 與 localStorage
export function __resetDrawingsForTest() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    if (settingsTimer !== null) clearTimeout(settingsTimer);
    writeTimer = null;
    settingsTimer = null;
    pending.clear();
    pendingSettingKeys.clear();
    notices = [];
    noticed.clear();
    lockOverride = null;
    saveError = false;
    saveErrorNoticePending = false;
    store = {};
    settings = DEFAULT_SETTINGS;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETTINGS_KEY);
        localStorage.removeItem(TOMB_KEY);
        for (const name of journalNames()) localStorage.removeItem(name);
    } catch {
        // ignore
    }
}

// ── 初始載入 ─────────────────────────────────────────────────────────
// 放在最後：loadView／loadSettingsView 會用到上面所有常數與函式
store = loadView();
settings = loadSettingsView();
