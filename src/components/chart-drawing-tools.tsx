// src/components/chart-drawing-tools.tsx — K 線圖畫圖工具的畫面
//
// - ChartDrawingTools：左側分組工具列（組＋小三角展開、★ 收藏、磁吸／
//   全部鎖定／全部顯示／復原／重做／物件列表／清除）
// - ChartDrawingOverlays：浮動物件工具列、文字註記輸入框（畫在圖表 host 內）
// - ChartObjectList：右側物件列表（顯示／鎖定／改名／刪除／拖曳排序）
// - DrawingSettingsDialog：樣式／座標兩個分頁的設定視窗
//
// 互動邏輯全部在 hooks/use-chart-drawings.ts。圖示一律用 lucide。

import {
    ChartNoAxesGantt,
    Copy,
    Equal,
    Eye,
    EyeOff,
    GripVertical,
    Layers,
    Lock,
    LockOpen,
    Magnet,
    Minus,
    MousePointer2,
    MoveDiagonal,
    MoveUpRight,
    Redo2,
    Ruler,
    SeparatorVertical,
    Settings2,
    Slash,
    Square,
    Star,
    Trash2,
    Type,
    Undo2,
    X,
} from 'lucide-react';
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentType,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';
import { useEscClose } from '../hooks/use-esc-close';
import {
    DRAWING_GROUPS,
    DRAWING_PALETTE,
    DRAWING_TOOL_DEFS,
    drawingLabel,
    fibOptionsOf,
    MAX_DRAWINGS_PER_SYMBOL,
    MAX_TEXT_LENGTH,
    subscribeDrawingRemoteChanges,
    noteDrawingHistoryConflict,
    toolDef,
    type Drawing,
    type DrawingStyle,
    type DrawingGroup,
    type DrawingToolId,
} from '../lib/chart-drawings';
import {
    defaultFibLevels,
    FIB_FONT_SIZES,
    FIB_TOKEN_COLORS,
    fibLevelColor,
    MAX_FIB_LEVELS,
    tokenForValue,
    type FibLevel,
    type FibOptions,
} from '../lib/chart-drawing-fib';
import * as styles from './chart-drawing-tools.css';

const WIDTHS = [1, 2, 3, 4];

export const TOOL_ICON: Record<DrawingToolId, ComponentType<{ size?: number }>> = {
    horizontal: Minus,
    vertical: SeparatorVertical,
    trend: Slash,
    ray: MoveUpRight,
    extended: MoveDiagonal,
    channel: Equal,
    box: Square,
    fib: ChartNoAxesGantt,
    text: Type,
    measure: Ruler,
};

// 彈出層離視窗邊緣至少留這麼多
const EDGE = 8;

// 彈出層的位置：預設貼在錨點右側、與它頂端對齊；下方放不下就往上推，
// 整個視窗都放不下就限制高度讓它自己捲動；右側放不下往左收。portal 到
// body、以視窗座標定位 — 不受 K 線面板邊界裁切，矮面板裡每個控制項
// 都點得到。
export function placeStylePopover(
    anchor: { top: number; right: number },
    popHeight: number,
    viewport: { width: number; height: number },
    popWidth = 0,
): CSSProperties {
    const maxHeight = Math.max(120, viewport.height - EDGE * 2);
    const h = Math.min(popHeight, maxHeight);
    const top = Math.max(EDGE, Math.min(anchor.top, viewport.height - EDGE - h));
    const left = Math.max(EDGE, Math.min(anchor.right + 6, viewport.width - EDGE - popWidth));
    return { position: 'fixed', top, left, maxHeight };
}

// 浮動物件工具列的位置（host 內座標）：預設在物件上方置中；上方放不下
// 翻到下方；兩邊都放不下就壓在圖表內緣。左右一律夾在圖表內。
export function placeFloatingToolbar(
    box: { left: number; top: number; right: number; bottom: number },
    bar: { width: number; height: number },
    host: { width: number; height: number },
    gap = 8,
): { left: number; top: number; flipped: boolean } {
    const cx = (Math.max(0, box.left) + Math.min(host.width, box.right)) / 2;
    const left = Math.max(4, Math.min(cx - bar.width / 2, host.width - bar.width - 4));
    const above = box.top - gap - bar.height;
    if (above >= 4) return { left, top: above, flipped: false };
    const below = box.bottom + gap;
    if (below + bar.height <= host.height - 4) return { left, top: below, flipped: true };
    return { left, top: Math.max(4, Math.min(box.top, host.height - bar.height - 4)), flipped: true };
}

// 左側工具列的滑鼠按下：把鍵盤焦點留在（或交回）這張圖，Delete 才認得
// 這張圖。輸入框、滑桿、勾選框要自己的焦點，不攔。
function keepChartFocus(api: ChartDrawingsApi) {
    return (e: ReactMouseEvent) => {
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('input, label, textarea, select')) return;
        e.preventDefault(); // 按鈕不搶焦點（WebKit 點按鈕本來就不給焦點）
        api.focusChart();
    };
}

// 所有可互動的畫圖 UI（包含 portal）在根節點先解除武裝。
// capture 早於子元件 stopPropagation，亦涵蓋沒有資料變更的按鍵／點擊。
function drawingCapture(onInteraction: () => void) {
    return { onPointerDownCapture: onInteraction, onKeyDownCapture: onInteraction };
}

// 輸入法（注音、倉頡…）組字中的按鍵：確認候選字的 Enter、取消組字的
// Esc 都屬於輸入法，不能當成「完成」或「取消」
export function isImeKey(e: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
    return !!e.nativeEvent?.isComposing || e.keyCode === 229;
}

// 文字類輸入框（Esc 是還原輸入，不是關彈出層）；滑桿、勾選框不算
function isTextInput(el: Element | null | undefined): boolean {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = (el as HTMLInputElement).type;
    return type !== 'range' && type !== 'checkbox';
}

// ── 通用彈出層：portal、依空間定位、Esc／點外面關閉 ─────────────────────

export function Popover({
    anchor,
    onClose,
    children,
    label,
    onMouseDown,
    onInteraction,
}: {
    anchor: HTMLElement | null;
    // esc：Esc 關閉；outside：點外面關閉（焦點留在點到的地方，不搶回圖表）
    onClose: (reason: 'esc' | 'outside') => void;
    children: ReactNode;
    label: string;
    onMouseDown?: (e: ReactMouseEvent) => void;
    onInteraction: () => void;
}) {
    const popRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
    const closeRef = useRef(onClose);
    closeRef.current = (reason) => { onInteraction(); onClose(reason); };

    // Esc 關閉：useEscClose 一律 preventDefault，這一下不會算進 Esc×2
    // 全部刪單，也不會穿透去取消圖上的選取。輸入框裡的 Esc 由輸入框自己
    // 處理（還原輸入），不關彈出層。
    useEscClose(() => {
        const active = popRef.current?.ownerDocument?.activeElement;
        if (isTextInput(active) && popRef.current?.contains(active!)) return;
        closeRef.current('esc');
    });

    useLayoutEffect(() => {
        const win = anchor?.ownerDocument?.defaultView;
        if (!anchor || !win) return;
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const pop = popRef.current;
            setPos(
                placeStylePopover(
                    r,
                    pop ? pop.scrollHeight : 0,
                    { width: win.innerWidth, height: win.innerHeight },
                    pop ? pop.offsetWidth : 0,
                ),
            );
        };
        place();
        win.addEventListener('resize', place);
        win.addEventListener('scroll', place, true);
        return () => {
            win.removeEventListener('resize', place);
            win.removeEventListener('scroll', place, true);
        };
    }, [anchor]);

    // 點彈出層與錨點以外的任何地方就關閉（不吃掉那一下）
    useEffect(() => {
        const doc = anchor?.ownerDocument;
        if (!doc) return;
        const onDown = (ev: Event) => {
            const t = ev.target as Node | null;
            if (t && (popRef.current?.contains(t) || anchor.contains(t))) return;
            closeRef.current('outside');
        };
        doc.addEventListener('pointerdown', onDown, true);
        return () => doc.removeEventListener('pointerdown', onDown, true);
    }, [anchor]);

    const pop = (
        <div
            ref={popRef}
            className={styles.pop}
            style={pos}
            role='dialog'
            aria-label={label}
            onMouseDown={onMouseDown}
            {...drawingCapture(onInteraction)}
        >
            {children}
        </div>
    );
    // 測試（無 DOM）時就地渲染；瀏覽器中 portal 到錨點所在文件的 body
    const host = anchor?.ownerDocument?.body;
    return host ? createPortal(pop, host) : pop;
}

// 工具列按鈕的提示 — 立即顯示、畫在 body 上（直排工具列會捲動，絕對
// 定位的提示會被它裁掉）；原生 title 在桌面版 WebView 裡要停很久才出現
interface Tip {
    text: string;
    x: number;
    y: number;
}

function useTips() {
    const [tip, setTip] = useState<Tip | null>(null);
    const docRef = useRef<Document | null>(null);
    const tipProps = (text: string, aria?: string) => ({
        'aria-label': aria ?? text.split(' — ')[0]!.split('（')[0]!,
        onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            docRef.current = e.currentTarget.ownerDocument;
            setTip({ text, x: r.right + 6, y: r.top + r.height / 2 });
        },
        onMouseLeave: () => setTip(null),
    });
    const node =
        tip && docRef.current?.body
            ? createPortal(
                  <span role='tooltip' className={styles.tip} style={{ left: tip.x, top: tip.y }}>
                      {tip.text}
                  </span>,
                  docRef.current.body,
              )
            : null;
    return { tipProps, tipNode: node, hideTip: () => setTip(null) };
}

function shortcutText(tool: DrawingToolId): string | null {
    const s = toolDef(tool).shortcut;
    return s ? `Alt+${s}` : null;
}

function toolTip(tool: DrawingToolId, armed: boolean): string {
    const d = toolDef(tool);
    const sc = shortcutText(tool);
    return `${d.label} — ${d.hint}（${[sc, armed ? '畫圖中，Esc 取消' : 'Esc 取消'].filter(Boolean).join('，')}）`;
}

// ── 左側工具列 ───────────────────────────────────────────────────────

export function ChartDrawingTools({ api }: { api: ChartDrawingsApi }) {
    const { tipProps, tipNode, hideTip } = useTips();
    const [flyout, setFlyout] = useState<{ group: DrawingGroup; anchor: HTMLElement } | null>(null);
    const full = api.drawings.length >= MAX_DRAWINGS_PER_SYMBOL;
    const fullHint = `此商品已達 ${MAX_DRAWINGS_PER_SYMBOL} 個畫圖物件上限，請先刪除部分物件`;
    const anyHidden = api.drawings.some((d) => d.hidden);

    // 只顯示有工具的組（部位工具第二期才有）
    const groups = DRAWING_GROUPS.filter((g) => DRAWING_TOOL_DEFS.some((d) => d.group === g.group));

    const arm = (t: DrawingToolId) => {
        hideTip();
        const blocked = full && t !== 'measure' && api.tool !== t;
        if (blocked) return;
        api.setTool(api.tool === t ? null : t);
    };

    const toolButton = (t: DrawingToolId, key?: string) => {
        const Icon = TOOL_ICON[t];
        const armed = api.tool === t;
        const blocked = full && t !== 'measure' && !armed;
        return (
            <button
                key={key ?? t}
                className={styles.railBtn[armed ? 'armed' : blocked ? 'disabled' : 'normal']}
                aria-pressed={armed}
                {...tipProps(blocked ? `${toolDef(t).label} — ${fullHint}` : toolTip(t, armed), toolDef(t).label)}
                disabled={blocked}
                onClick={() => arm(t)}
            >
                <Icon size={13} />
            </button>
        );
    };

    return (
        <div className={styles.rail} {...drawingCapture(api.onInteraction)} onMouseDown={keepChartFocus(api)} onScroll={hideTip}>
            <button
                className={styles.railBtn[api.tool === null ? 'active' : 'normal']}
                aria-pressed={api.tool === null}
                {...tipProps('游標 — 瀏覽模式：選取、拖曳既有物件；Shift 點選可多選（Esc 退出畫圖工具）', '游標')}
                onClick={() => api.setTool(null)}
            >
                <MousePointer2 size={13} />
            </button>

            <span className={styles.railDivider} />

            {groups.map((g) => {
                const tools = DRAWING_TOOL_DEFS.filter((d) => d.group === g.group);
                const current = api.groupLast[g.group] ?? tools[0]!.tool;
                const inGroup = tools.some((d) => d.tool === api.tool);
                const shown = inGroup ? api.tool! : current;
                const Icon = TOOL_ICON[shown];
                const armed = inGroup;
                const blocked = full && shown !== 'measure' && !armed;
                return (
                    <span key={g.group} className={styles.groupWrap}>
                        <button
                            className={styles.railBtn[armed ? 'armed' : blocked ? 'disabled' : 'normal']}
                            aria-pressed={armed}
                            {...tipProps(
                                blocked ? `${g.label} — ${fullHint}` : `${g.label}：${toolTip(shown, armed)}`,
                                `${g.label}：${toolDef(shown).label}`,
                            )}
                            disabled={blocked}
                            onClick={() => arm(shown)}
                        >
                            <Icon size={13} />
                        </button>
                        {tools.length > 1 && (
                            <button
                                className={styles.caret}
                                aria-label={`${g.label}：更多工具`}
                                aria-expanded={flyout?.group === g.group}
                                onClick={(e) => {
                                    hideTip();
                                    const anchor = e.currentTarget.parentElement as HTMLElement;
                                    setFlyout((f) => (f?.group === g.group ? null : { group: g.group, anchor }));
                                }}
                            />
                        )}
                    </span>
                );
            })}

            {api.favorites.length > 0 && <span className={styles.railDivider} />}
            {api.favorites.map((t) => toolButton(t, `fav-${t}`))}

            <span className={styles.railSpacer} />
            <span className={styles.railDivider} />

            <button
                className={styles.railBtn[api.magnet ? 'on' : 'normal']}
                aria-pressed={api.magnet}
                {...tipProps(`磁吸 — 畫點與拖曳控制點時貼齊 K 棒開高低收（${api.magnet ? '開' : '關'}）`, '磁吸')}
                onClick={() => api.setMagnet(!api.magnet)}
            >
                <Magnet size={13} />
            </button>
            <button
                className={styles.railBtn[api.allLocked ? 'on' : api.drawings.length ? 'normal' : 'disabled']}
                aria-pressed={api.allLocked}
                disabled={!api.drawings.length}
                {...tipProps(api.allLocked ? '全部解鎖' : '全部鎖定 — 不可拖曳、刪除', api.allLocked ? '全部解鎖' : '全部鎖定')}
                onClick={api.lockAll}
            >
                {api.allLocked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
            <button
                className={styles.railBtn[anyHidden ? 'normal' : 'disabled']}
                disabled={!anyHidden}
                {...tipProps('全部顯示 — 把隱藏的物件顯示回來', '全部顯示')}
                onClick={api.showAll}
            >
                <Eye size={13} />
            </button>
            <button
                className={styles.railBtn[api.canUndo ? 'normal' : 'disabled']}
                disabled={!api.canUndo}
                {...tipProps('復原（Ctrl/Cmd+Z）', '復原')}
                onClick={api.undo}
            >
                <Undo2 size={13} />
            </button>
            <button
                className={styles.railBtn[api.canRedo ? 'normal' : 'disabled']}
                disabled={!api.canRedo}
                {...tipProps('重做（Ctrl/Cmd+Shift+Z 或 Ctrl+Y）', '重做')}
                onClick={api.redo}
            >
                <Redo2 size={13} />
            </button>
            <button
                className={styles.railBtn[api.objectListOpen ? 'on' : 'normal']}
                aria-pressed={api.objectListOpen}
                {...tipProps('物件列表 — 顯示／隱藏、鎖定、改名、調整圖層', '物件列表')}
                onClick={() => api.setObjectListOpen(!api.objectListOpen)}
            >
                <Layers size={13} />
            </button>
            <button
                className={styles.railBtn[api.drawings.some((d) => !d.locked) ? 'normal' : 'disabled']}
                disabled={!api.drawings.some((d) => !d.locked)}
                {...tipProps('清除全部 — 刪除目前商品的畫圖（鎖定的保留，可復原）', '清除全部')}
                onClick={api.clearAll}
            >
                <Trash2 size={13} />
            </button>

            {flyout && (
                <Popover
                    onInteraction={api.onInteraction}
                    anchor={flyout.anchor}
                    label={`${DRAWING_GROUPS.find((g) => g.group === flyout.group)!.label}工具`}
                    onClose={() => setFlyout(null)}
                    onMouseDown={keepChartFocus(api)}
                >
                    <span className={styles.popTitle}>
                        {DRAWING_GROUPS.find((g) => g.group === flyout.group)!.label}
                    </span>
                    {DRAWING_TOOL_DEFS.filter((d) => d.group === flyout.group).map((d) => {
                        const Icon = TOOL_ICON[d.tool];
                        const fav = api.favorites.includes(d.tool);
                        const sc = shortcutText(d.tool);
                        return (
                            <span
                                key={d.tool}
                                role='button'
                                tabIndex={-1}
                                aria-label={d.label}
                                className={styles.flyItem[api.tool === d.tool ? 'active' : 'normal']}
                                title={d.hint}
                                onClick={() => {
                                    setFlyout(null);
                                    arm(d.tool);
                                }}
                            >
                                <button
                                    className={styles.starBtn[fav ? 'on' : 'off']}
                                    aria-label={fav ? `取消收藏${d.label}` : `收藏${d.label}到工具列`}
                                    aria-pressed={fav}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        api.toggleFavorite(d.tool);
                                    }}
                                >
                                    <Star size={11} fill={fav ? 'currentColor' : 'none'} />
                                </button>
                                <Icon size={13} />
                                <span className={styles.flyLabel}>{d.label}</span>
                                {sc && <kbd className={styles.kbd}>{sc}</kbd>}
                            </span>
                        );
                    })}
                </Popover>
            )}
            {tipNode}
        </div>
    );
}

// 不透明度／填色滑桿（色盤彈出層與設定視窗共用）。value 0–1，
// 顯示百分比；滑桿連續拖動在 applyStyle 裡合併成一步復原
export function OpacitySlider({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
}) {
    const pct = Math.round(value * 100);
    const fill = ((pct - min) / (max - min)) * 100;
    return (
        <span className={styles.row}>
            <span className={styles.label}>{label}</span>
            <input
                type='range'
                className={styles.slider}
                min={min}
                max={max}
                step={max - min > 60 ? 5 : 2}
                aria-label={label}
                value={pct}
                style={{ ['--sj-fill' as string]: `${fill}%` }}
                onChange={(e) => onChange(Number(e.target.value) / 100)}
            />
            <span>{pct}%</span>
        </span>
    );
}

// ── 浮動物件工具列＋文字輸入框 ───────────────────────────────────────

export function ChartDrawingOverlays({ api }: { api: ChartDrawingsApi }) {
    const barRef = useRef<HTMLDivElement | null>(null);
    const [barSize, setBarSize] = useState({ width: 220, height: 30 });
    const [menu, setMenu] = useState<{ kind: 'color' | 'width'; anchor: HTMLElement } | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const { tipProps, tipNode } = useTips();
    const sel = api.selectedList;
    const primary = api.selected;
    const box = api.selectionBox;

    useLayoutEffect(() => {
        const el = barRef.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (w && h && (w !== barSize.width || h !== barSize.height)) setBarSize({ width: w, height: h });
    });

    // 選取換了就收起色盤／線寬選單
    const selKey = api.selectedIds.join(',');
    useEffect(() => setMenu(null), [selKey]);
    // 設定視窗只對單一物件；選取變了（例如 Esc 取消選取）就關
    useEffect(() => {
        setSettingsOpen(false);
    }, [primary?.id, api.symbolKey]);

    const showBar = !!primary && !!box && !api.editingTextId && !api.tool;
    const pos = showBar ? placeFloatingToolbar(box!, barSize, api.hostSize) : null;
    const locked = sel.length > 0 && sel.every((d) => d.locked);
    const anyUnlocked = sel.some((d) => !d.locked);
    const style = api.style;
    const full = api.drawings.length + sel.length > MAX_DRAWINGS_PER_SYMBOL;

    return (
        <>
            {showBar && pos && (
                <div
                    ref={barRef}
                    className={styles.floatBar}
                    style={{ left: pos.left, top: pos.top }}
                    role='toolbar'
                    data-drawing-overlay=''
                    {...drawingCapture(api.onInteraction)}
                    aria-label='畫圖物件工具列'
                    onMouseDown={(e) => {
                        // 不要讓這一下落到圖表（取消選取、平移）
                        e.stopPropagation();
                        keepChartFocus(api)(e);
                    }}
                >
                    <button
                        className={styles.floatText}
                        {...tipProps('顏色', '顏色')}
                        onClick={(e) => {
                            const anchor = e.currentTarget;
                            setMenu((m) => (m?.kind === 'color' ? null : { kind: 'color', anchor }));
                        }}
                    >
                        <span className={styles.swatchDot} style={{ background: style.color }} />
                    </button>
                    <button
                        className={styles.floatText}
                        {...tipProps('線寬', '線寬')}
                        onClick={(e) => {
                            const anchor = e.currentTarget;
                            setMenu((m) => (m?.kind === 'width' ? null : { kind: 'width', anchor }));
                        }}
                    >
                        {style.width}px
                    </button>
                    <button
                        className={styles.floatText}
                        {...tipProps(style.dash === 'solid' ? '線型：實線（點一下改虛線）' : '線型：虛線（點一下改實線）', '線型')}
                        onClick={() => api.applyStyle({ dash: style.dash === 'solid' ? 'dashed' : 'solid' })}
                    >
                        <span className={styles.dashIcon[style.dash]} />
                    </button>
                    <span className={styles.floatSep} />
                    {sel.length === 1 && (
                        <button
                            className={styles.railBtn.normal}
                            {...tipProps('設定 — 樣式與座標', '設定')}
                            onClick={() => setSettingsOpen(true)}
                        >
                            <Settings2 size={13} />
                        </button>
                    )}
                    <button
                        className={styles.railBtn[locked ? 'on' : 'normal']}
                        aria-pressed={locked}
                        {...tipProps(locked ? '解鎖' : '鎖定 — 不可拖曳、刪除', locked ? '解鎖' : '鎖定')}
                        onClick={api.toggleLock}
                    >
                        {locked ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                    <button
                        className={styles.railBtn.normal}
                        {...tipProps('隱藏 — 可從物件列表或「全部顯示」找回', '隱藏')}
                        onClick={api.toggleHidden}
                    >
                        <EyeOff size={13} />
                    </button>
                    <button
                        className={styles.railBtn[full ? 'disabled' : 'normal']}
                        disabled={full}
                        {...tipProps('複製', '複製')}
                        onClick={api.duplicate}
                    >
                        <Copy size={13} />
                    </button>
                    <button
                        className={styles.railBtn[anyUnlocked ? 'normal' : 'disabled']}
                        disabled={!anyUnlocked}
                        {...tipProps(anyUnlocked ? '刪除（Delete／Backspace）' : '刪除 — 已鎖定，請先解鎖', '刪除')}
                        onClick={api.remove}
                    >
                        <Trash2 size={13} />
                    </button>
                </div>
            )}

            {showBar && menu?.kind === 'color' && (
                <Popover anchor={menu.anchor} label='顏色' onClose={() => setMenu(null)} onInteraction={api.onInteraction}>
                    <span className={styles.palette}>
                        {DRAWING_PALETTE.map((c) => (
                            <button
                                key={c}
                                className={styles.swatch[style.color === c ? 'active' : 'normal']}
                                style={{ background: c }}
                                aria-label={`顏色 ${c}`}
                                onClick={() => api.applyStyle({ color: c })}
                            />
                        ))}
                    </span>
                    {/* 透明度：蓋在 K 棒上時線條、填色都可以半透明，不把 K 棒擋住 */}
                    <OpacitySlider
                        label='不透明度'
                        value={style.opacity ?? 1}
                        min={10}
                        max={100}
                        onChange={(v) => api.applyStyle({ opacity: v })}
                    />
                    {sel.some((d) => d.tool === 'box' || d.tool === 'channel') && (
                        <OpacitySlider
                            label='填色'
                            value={style.fillOpacity}
                            min={0}
                            max={50}
                            onChange={(v) => api.applyStyle({ fillOpacity: v })}
                        />
                    )}
                </Popover>
            )}
            {showBar && menu?.kind === 'width' && (
                <Popover anchor={menu.anchor} label='線寬' onClose={() => setMenu(null)} onInteraction={api.onInteraction}>
                    {WIDTHS.map((w) => (
                        <button
                            key={w}
                            className={styles.flyItem[style.width === w ? 'active' : 'normal']}
                            aria-label={`線寬 ${w}`}
                            onClick={() => {
                                api.applyStyle({ width: w });
                                setMenu(null);
                            }}
                        >
                            <span style={{ width: 28, borderTop: `${w}px solid currentColor` }} />
                            {w}px
                        </button>
                    ))}
                </Popover>
            )}

            {settingsOpen && primary && (
                <DrawingSettingsDialog key={`${api.symbolKey}:${primary.id}`} api={api} drawing={primary} onClose={() => setSettingsOpen(false)} />
            )}

            {api.editingTextId && api.editBox && (
                <TextEditor
                    onInteraction={api.onInteraction}
                    key={api.editingTextId}
                    initial={api.drawings.find((d) => d.id === api.editingTextId)?.text ?? ''}
                    onDraftChange={api.updateTextDraft}
                    box={api.editBox}
                    onCommit={api.commitText}
                />
            )}
            {tipNode}
        </>
    );
}

// 文字註記的輸入框：Enter 確定（Shift+Enter 換行）、Esc 取消、失焦確定
export function TextEditor({
    initial,
    box,
    onCommit,
    onDraftChange,
    onInteraction,
}: {
    initial: string;
    box: { left: number; top: number };
    onCommit: (text: string | null) => void;
    onDraftChange?: (text: string) => void;
    onInteraction: () => void;
}) {
    const [value, setValue] = useState(initial);
    const done = useRef(false);
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => {
        ref.current?.focus?.();
        ref.current?.select?.();
    }, []);
    const finish = (text: string | null) => {
        if (done.current) return;
        done.current = true;
        onCommit(text);
    };
    return (
        <textarea
            ref={ref}
            className={styles.textEditor}
            data-drawing-overlay=''
            {...drawingCapture(onInteraction)}
            style={{ left: box.left, top: box.top }}
            value={value}
            maxLength={MAX_TEXT_LENGTH}
            aria-label='文字註記內容'
            placeholder='輸入文字，Enter 完成'
            rows={Math.min(6, Math.max(1, value.split('\n').length))}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => { setValue(e.target.value); onDraftChange?.(e.target.value); }}
            onBlur={() => finish(value)}
            onKeyDown={(e) => {
                if (isImeKey(e)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    finish(value);
                } else if (e.key === 'Escape') {
                    // 吃掉這一下：不算進 Esc×2 全部刪單（use-hotkeys 本來就
                    // 不理打字中的 Esc，這裡再保險一次）
                    e.preventDefault();
                    e.stopPropagation();
                    finish(null);
                }
            }}
        />
    );
}

// ── 設定視窗 ─────────────────────────────────────────────────────────

function toLocalInput(sec: number): string {
    const d = new Date(sec * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): number | null {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

export function parseLevels(text: string): number[] {
    return text
        .split(/[,\s，、]+/)
        .filter((part) => part.trim() !== '')
        .map(Number)
        .filter(Number.isFinite);
}

const ANCHOR_NAMES: Partial<Record<Drawing['tool'], string[]>> = {
    channel: ['起點', '終點', '通道寬度'],
    fib: ['起點（1）', '終點（0）'],
    box: ['角 1', '角 2'],
};

export function DrawingSettingsDialog({
    api: sourceApi,
    drawing,
    onClose,
}: {
    api: ChartDrawingsApi;
    drawing: Drawing;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<'style' | 'coords'>('style');
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const dialogRef = useRef<HTMLDivElement | null>(null);
    // 遠端勝出時先同步封住所有事件，再關閉；unmount 期間的 blur 也不能寫舊值。
    const invalidated = useRef(false);
    useEffect(() => subscribeDrawingRemoteChanges((key, ids) => {
        if (key !== sourceApi.symbolKey || !ids.has(drawing.id)) return;
        invalidated.current = true;
        noteDrawingHistoryConflict();
        closeRef.current();
    }), [sourceApi.symbolKey, drawing.id]);
    const api: ChartDrawingsApi = {
        ...sourceApi,
        applyStyle: (patch) => {
            if (invalidated.current) return;
            const diff = Object.fromEntries(Object.entries(patch).filter(([k, v]) => drawing.style[k as keyof DrawingStyle] !== v));
            if (Object.keys(diff).length) sourceApi.applyStyle(diff);
        },
        rename: (id, value) => {
            if (!invalidated.current && value !== (drawing.name ?? '')) sourceApi.rename(id, value);
        },
        setText: (id, value) => {
            if (!invalidated.current && value !== (drawing.text ?? '')) sourceApi.setText(id, value);
        },
        setAnchor: (id, index, patch) => {
            if (!invalidated.current) sourceApi.setAnchor(id, index, patch);
        },
        setFib: (id, patch) => {
            if (invalidated.current) return;
            const fib = fibOptionsOf(drawing);
            const diff = Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(fib[k as keyof FibOptions]) !== JSON.stringify(v)));
            if (Object.keys(diff).length) sourceApi.setFib(id, diff);
        },
    };
    // Esc 關閉：入 modal stack（preventDefault），不算進 Esc×2 全部刪單。
    // 輸入框裡的 Esc 是還原輸入（輸入框自己處理），不關視窗
    useEscClose(() => {
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (isTextInput(active) && dialogRef.current?.contains(active!)) return;
        // modal 的 window capture 可能先關閉並卸載 UI；不能等根節點 keydown。
        sourceApi.onInteraction();
        closeRef.current();
    });
    const d = drawing;
    const style = d.style;
    const showsFill = d.tool === 'box' || d.tool === 'channel';
    const names = ANCHOR_NAMES[d.tool] ?? (d.anchors.length === 1 ? ['位置'] : ['起點', '終點']);
    const [text, setText] = useState(d.text ?? '');

    const body = (
        <div className={styles.overlay} {...drawingCapture(api.onInteraction)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div
                ref={dialogRef}
                className={styles.dialog}
                style={d.tool === 'fib' ? { width: 'min(30rem, 94vw)' } : undefined}
                role='dialog'
                aria-label='畫圖物件設定'
            >
                <div className={styles.dialogHeader}>
                    <span>{drawingLabel(d)}</span>
                    <button className={styles.iconBtn} aria-label='關閉' onClick={onClose}>
                        <X size={14} />
                    </button>
                </div>
                <div className={styles.tabs} role='tablist'>
                    <button role='tab' aria-selected={tab === 'style'} className={styles.tab[tab === 'style' ? 'active' : 'normal']} onClick={() => setTab('style')}>
                        樣式
                    </button>
                    <button role='tab' aria-selected={tab === 'coords'} className={styles.tab[tab === 'coords' ? 'active' : 'normal']} onClick={() => setTab('coords')}>
                        座標
                    </button>
                </div>
                <div className={styles.dialogBody}>
                    {tab === 'style' ? (
                        <>
                            <span className={styles.row}>
                                <span className={styles.label}>顏色</span>
                                <span className={styles.palette}>
                                    {DRAWING_PALETTE.map((c) => (
                                        <button
                                            key={c}
                                            className={styles.swatch[style.color === c ? 'active' : 'normal']}
                                            style={{ background: c }}
                                            aria-label={`顏色 ${c}`}
                                            onClick={() => api.applyStyle({ color: c })}
                                        />
                                    ))}
                                </span>
                            </span>
                            <span className={styles.row}>
                                <span className={styles.label}>線寬</span>
                                {WIDTHS.map((w) => (
                                    <button key={w} className={styles.chip[style.width === w ? 'active' : 'normal']} aria-label={`線寬 ${w}`} onClick={() => api.applyStyle({ width: w })}>
                                        {w}
                                    </button>
                                ))}
                            </span>
                            <span className={styles.row}>
                                <span className={styles.label}>線型</span>
                                <button className={styles.chip[style.dash === 'solid' ? 'active' : 'normal']} onClick={() => api.applyStyle({ dash: 'solid' })}>
                                    實線
                                </button>
                                <button className={styles.chip[style.dash === 'dashed' ? 'active' : 'normal']} onClick={() => api.applyStyle({ dash: 'dashed' })}>
                                    虛線
                                </button>
                            </span>
                            <OpacitySlider
                                label='不透明度'
                                value={style.opacity ?? 1}
                                min={10}
                                max={100}
                                onChange={(v) => api.applyStyle({ opacity: v })}
                            />
                            {showsFill && (
                                <OpacitySlider
                                    label='填色'
                                    value={style.fillOpacity}
                                    min={0}
                                    max={50}
                                    onChange={(v) => api.applyStyle({ fillOpacity: v })}
                                />
                            )}
                            {d.tool === 'fib' && <FibSection api={api} drawing={d} />}
                            {d.tool === 'text' && (
                                <span className={styles.row}>
                                    <span className={styles.label}>文字</span>
                                    <input
                                        className={styles.wideInput}
                                        aria-label='文字內容'
                                        value={text}
                                        maxLength={MAX_TEXT_LENGTH}
                                        disabled={d.locked}
                                        onChange={(e) => setText(e.target.value)}
                                        onBlur={() => api.setText(d.id, text)}
                                    />
                                </span>
                            )}
                            <span className={styles.row}>
                                <span className={styles.label}>名稱</span>
                                <input
                                    className={styles.wideInput}
                                    aria-label='物件名稱'
                                    defaultValue={d.name ?? ''}
                                    placeholder={toolDef(d.tool).label}
                                    onBlur={(e) => api.rename(d.id, e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && api.rename(d.id, e.currentTarget.value)}
                                />
                            </span>
                        </>
                    ) : (
                        <>
                            {d.locked && <span className={styles.hint}>物件已鎖定，解鎖後才能修改座標。</span>}
                            {d.anchors.map((a, i) => (
                                <span key={i} className={styles.row}>
                                    <span className={styles.label}>{names[i] ?? `點 ${i + 1}`}</span>
                                    {d.tool !== 'vertical' && (
                                        <PriceInput
                                            key={`${d.id}-${i}-p-${a.price}`}
                                            price={a.price}
                                            format={(p) => api.formatPrice(p, false)}
                                            disabled={d.locked}
                                            onCommit={(price) => api.setAnchor(d.id, i, { price })}
                                        />
                                    )}
                                    {d.tool !== 'horizontal' && (
                                        <input
                                            type='datetime-local'
                                            className={styles.input}
                                            style={{ width: '11.5rem' }}
                                            aria-label={`${names[i] ?? `點 ${i + 1}`}時間`}
                                            disabled={d.locked}
                                            defaultValue={toLocalInput(a.time)}
                                            onBlur={(e) => {
                                                const t = fromLocalInput(e.target.value);
                                                if (e.target.value !== toLocalInput(a.time) && t !== null && t !== a.time) api.setAnchor(d.id, i, { time: t });
                                            }}
                                        />
                                    )}
                                </span>
                            ))}
                            <span className={styles.hint}>價格會吸附到合法跳動價位（水平線）；時間以本機時區顯示。</span>
                        </>
                    )}
                </div>
                <div className={styles.dialogFooter}>
                    <button className={styles.chip.primary} onClick={onClose}>
                        完成
                    </button>
                </div>
            </div>
        </div>
    );
    const host = typeof document !== 'undefined' ? document.body : null;
    return host ? createPortal(body, host) : body;
}

// ── 斐波那契設定（樣式分頁內）─────────────────────────────────────────

export function nextFibValue(values: number[]): number {
    for (const v of [1.272, 1.618, 2, 2.618, 3.618, 4.236, -0.272, -0.618]) {
        if (!values.includes(v)) return v;
    }
    return Number(((values.length ? Math.max(...values) : 0) + 0.5).toFixed(3));
}

function FibSection({ api, drawing }: { api: ChartDrawingsApi; drawing: Drawing }) {
    const fib = fibOptionsOf(drawing);
    const set = (patch: Partial<FibOptions>) => api.setFib(drawing.id, patch);
    const locked = drawing.locked;
    const [colorFor, setColorFor] = useState<{ index: number; anchor: HTMLElement } | null>(null);
    const [newValue, setNewValue] = useState('');
    const setLevel = (index: number, patch: Partial<FibLevel>) =>
        set({ levels: fib.levels.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
    const chip = (on: boolean) => styles.chip[on ? 'active' : 'normal'];
    const check = (label: string, on: boolean, onChange: (v: boolean) => void) => (
        <label className={styles.row} style={{ cursor: 'pointer' }}>
            <input type='checkbox' checked={on} disabled={locked} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
    );
    const addValue = (v: number) => {
        if (!Number.isFinite(v) || fib.levels.some((l) => l.value === v)) return;
        set({
            levels: [...fib.levels, { value: v, visible: true, token: tokenForValue(v, fib.levels.length) }],
        });
    };

    return (
        <>
            <span className={styles.row}>
                <span className={styles.label}>色帶</span>
                <input
                    type='range'
                    className={styles.slider}
                    min={0}
                    max={50}
                    step={2}
                    aria-label='色帶透明度'
                    disabled={locked}
                    value={Math.round(fib.bandOpacity * 100)}
                    style={{ ['--sj-fill' as string]: `${fib.bandOpacity * 200}%` }}
                    onChange={(e) => set({ bandOpacity: Number(e.target.value) / 100 })}
                />
                <span>{Math.round(fib.bandOpacity * 100)}%</span>
            </span>
            {check('使用單一顏色（物件線色）', fib.singleColor, (v) => set({ singleColor: v }))}

            <span className={styles.row} style={{ alignItems: 'flex-start' }}>
                <span className={styles.label}>比例</span>
                <span className={styles.fibLevels}>
                    {fib.levels.map((l, i) => {
                        const color = fibLevelColor(l, fib, drawing.style.color, api.themeMode);
                        return (
                            <span key={`${l.value}-${i}`} className={styles.fibLevelRow}>
                                <input
                                    type='checkbox'
                                    aria-label={`顯示比例 ${l.value}`}
                                    checked={l.visible}
                                    disabled={locked}
                                    onChange={(e) => setLevel(i, { visible: e.target.checked })}
                                />
                                <input
                                    className={styles.input}
                                    style={{ width: '4.2rem' }}
                                    aria-label={`比例 ${l.value}`}
                                    defaultValue={String(l.value)}
                                    disabled={locked}
                                    onBlur={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v) && v !== l.value && !fib.levels.some((x) => x.value === v)) {
                                            setLevel(i, { value: v });
                                        } else {
                                            e.target.value = String(l.value);
                                        }
                                    }}
                                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                />
                                <button
                                    className={styles.swatch.normal}
                                    style={{ background: color, opacity: fib.singleColor ? 0.4 : 1 }}
                                    aria-label={`比例 ${l.value} 的顏色`}
                                    disabled={locked || fib.singleColor}
                                    onClick={(e) => {
                                        const anchor = e.currentTarget;
                                        setColorFor((c) => (c?.index === i ? null : { index: i, anchor }));
                                    }}
                                />
                                <button
                                    className={styles.iconBtn}
                                    aria-label={`移除比例 ${l.value}`}
                                    disabled={locked || fib.levels.length <= 1}
                                    onClick={() => set({ levels: fib.levels.filter((_, j) => j !== i) })}
                                >
                                    <X size={11} />
                                </button>
                            </span>
                        );
                    })}
                    <span className={styles.fibLevelRow}>
                        <input
                            className={styles.input}
                            style={{ width: '4.2rem' }}
                            aria-label='新增比例'
                            placeholder={String(nextFibValue(fib.levels.map((l) => l.value)))}
                            value={newValue}
                            disabled={locked || fib.levels.length >= MAX_FIB_LEVELS}
                            onChange={(e) => setNewValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                addValue(newValue.trim() ? Number(newValue) : nextFibValue(fib.levels.map((l) => l.value)));
                                setNewValue('');
                            }}
                        />
                        <button
                            className={styles.chip.normal}
                            disabled={locked || fib.levels.length >= MAX_FIB_LEVELS}
                            onClick={() => {
                                addValue(newValue.trim() ? Number(newValue) : nextFibValue(fib.levels.map((l) => l.value)));
                                setNewValue('');
                            }}
                        >
                            新增比例
                        </button>
                        <button
                            className={styles.chip.normal}
                            disabled={locked}
                            onClick={() => set({ levels: defaultFibLevels() })}
                        >
                            還原預設
                        </button>
                    </span>
                </span>
            </span>

            <span className={styles.row}>
                <span className={styles.label}>標籤</span>
                <button className={chip(fib.labelH === 'left')} disabled={locked} onClick={() => set({ labelH: 'left' })}>左</button>
                <button className={chip(fib.labelH === 'right')} disabled={locked} onClick={() => set({ labelH: 'right' })}>右</button>
                <span className={styles.floatSep} />
                <button className={chip(fib.labelV === 'top')} disabled={locked} onClick={() => set({ labelV: 'top' })}>上</button>
                <button className={chip(fib.labelV === 'middle')} disabled={locked} onClick={() => set({ labelV: 'middle' })}>中</button>
                <button className={chip(fib.labelV === 'bottom')} disabled={locked} onClick={() => set({ labelV: 'bottom' })}>下</button>
            </span>
            <span className={styles.row}>
                <span className={styles.label} />
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.showLevel} disabled={locked} onChange={(e) => set({ showLevel: e.target.checked })} />
                    顯示層級
                </label>
                <button className={chip(fib.levelFormat === 'value')} disabled={locked || !fib.showLevel} onClick={() => set({ levelFormat: 'value' })}>數值</button>
                <button className={chip(fib.levelFormat === 'percent')} disabled={locked || !fib.showLevel} onClick={() => set({ levelFormat: 'percent' })}>百分比</button>
            </span>
            <span className={styles.row}>
                <span className={styles.label} />
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.showPrice} disabled={locked} onChange={(e) => set({ showPrice: e.target.checked })} />
                    顯示價格
                </label>
            </span>
            <span className={styles.row}>
                <span className={styles.label}>字級</span>
                {FIB_FONT_SIZES.map((f) => (
                    <button key={f} className={chip(fib.fontSize === f)} disabled={locked} onClick={() => set({ fontSize: f })}>
                        {f}
                    </button>
                ))}
            </span>
            <span className={styles.row}>
                <span className={styles.label}>延伸線段</span>
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.extendLeft} disabled={locked} onChange={(e) => set({ extendLeft: e.target.checked })} />
                    向左
                </label>
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.extendRight} disabled={locked} onChange={(e) => set({ extendRight: e.target.checked })} />
                    向右
                </label>
            </span>
            <span className={styles.row}>
                <span className={styles.label} />
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.reverse} disabled={locked} onChange={(e) => set({ reverse: e.target.checked })} />
                    反轉
                </label>
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input type='checkbox' checked={fib.showTrend} disabled={locked} onChange={(e) => set({ showTrend: e.target.checked })} />
                    趨勢線
                </label>
            </span>
            <span className={styles.hint}>預設終點＝0、起點＝1；反轉後起點＝0。標籤放在回撤範圍外側，延伸到圖表邊緣時改貼畫面內緣。</span>

            {colorFor && fib.levels[colorFor.index] && (
                <Popover anchor={colorFor.anchor} label='比例顏色' onClose={() => setColorFor(null)} onInteraction={api.onInteraction}>
                    <span className={styles.palette}>
                        {FIB_COLOR_CHOICES[api.themeMode].map((c) => (
                            <button
                                key={c}
                                className={styles.swatch[fibLevelColor(fib.levels[colorFor.index]!, fib, drawing.style.color, api.themeMode) === c ? 'active' : 'normal']}
                                style={{ background: c }}
                                aria-label={`顏色 ${c}`}
                                onClick={() => {
                                    setLevel(colorFor.index, { color: c });
                                    setColorFor(null);
                                }}
                            />
                        ))}
                    </span>
                    <button
                        className={styles.chip.normal}
                        onClick={() => {
                            const l = fib.levels[colorFor.index]!;
                            setLevel(colorFor.index, { color: undefined, token: tokenForValue(l.value, colorFor.index) });
                            setColorFor(null);
                        }}
                    >
                        預設顏色
                    </button>
                </Popover>
            )}
        </>
    );
}

// 比例顏色的選項：TradingView 那組（依主題）加上一般色盤
const FIB_COLOR_CHOICES: Record<'dark' | 'light', string[]> = {
    dark: [...new Set([...Object.values(FIB_TOKEN_COLORS.dark), ...DRAWING_PALETTE])],
    light: [...new Set([...Object.values(FIB_TOKEN_COLORS.light), ...DRAWING_PALETTE])],
};

// ── 物件列表 ─────────────────────────────────────────────────────────

export function ChartObjectList({ api }: { api: ChartDrawingsApi }) {
    const [renaming, setRenaming] = useState<string | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    if (!api.objectListOpen) return null;
    // 最上層（陣列尾端）排在最上面
    const rows = [...api.drawings].reverse();
    const indexOf = (id: string) => api.drawings.findIndex((d) => d.id === id);

    return (
        <aside className={styles.list} {...drawingCapture(api.onInteraction)} aria-label='物件列表' onMouseDown={keepChartFocus(api)}>
            <div className={styles.listHeader}>
                <span>
                    物件列表 <span className={styles.listCount}>{api.drawings.length}</span>
                </span>
                <button className={styles.iconBtn} aria-label='收起物件列表' onClick={() => api.setObjectListOpen(false)}>
                    <X size={12} />
                </button>
            </div>
            <div className={styles.listBody}>
                {rows.length === 0 && <div className={styles.empty}>這個商品還沒有畫圖物件。從左側工具列選一個工具開始畫。</div>}
                {rows.map((d) => {
                    const sel = api.selectedIds.includes(d.id);
                    return (
                        <div
                            key={d.id}
                            className={styles.listRow[overId === d.id && dragId && dragId !== d.id ? 'dropTarget' : sel ? 'selected' : 'normal']}
                            role='option'
                            aria-selected={sel}
                            aria-label={drawingLabel(d)}
                            draggable={renaming !== d.id}
                            onDragStart={(e) => {
                                setDragId(d.id);
                                e.dataTransfer?.setData?.('text/plain', d.id);
                            }}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setOverId(d.id);
                            }}
                            onDragEnd={() => {
                                setDragId(null);
                                setOverId(null);
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                const id = dragId ?? e.dataTransfer?.getData?.('text/plain');
                                setDragId(null);
                                setOverId(null);
                                if (id && id !== d.id) api.reorder(id, indexOf(d.id));
                            }}
                            onClick={(e) => api.select(d.id, e.shiftKey)}
                            onDoubleClick={() => setRenaming(d.id)}
                        >
                            <span className={styles.grip} aria-hidden>
                                <GripVertical size={11} />
                            </span>
                            <span className={styles.dot} style={{ background: d.style.color }} />
                            {renaming === d.id ? (
                                <input
                                    className={styles.wideInput}
                                    autoFocus
                                    aria-label='物件名稱'
                                    defaultValue={drawingLabel(d)}
                                    onClick={(e) => e.stopPropagation()}
                                    onBlur={(e) => {
                                        api.rename(d.id, e.target.value);
                                        setRenaming(null);
                                    }}
                                    onKeyDown={(e) => {
                                        if (isImeKey(e)) return;
                                        if (e.key === 'Enter') {
                                            api.rename(d.id, e.currentTarget.value);
                                            setRenaming(null);
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setRenaming(null);
                                        }
                                    }}
                                />
                            ) : (
                                <span className={styles.rowName[d.hidden ? 'hidden' : 'normal']} title='雙擊改名'>
                                    {drawingLabel(d)}
                                </span>
                            )}
                            <button
                                className={styles.iconBtn}
                                aria-label={d.hidden ? `顯示 ${drawingLabel(d)}` : `隱藏 ${drawingLabel(d)}`}
                                aria-pressed={d.hidden}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    api.setHidden(d.id, !d.hidden);
                                }}
                            >
                                {d.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                            </button>
                            <button
                                className={styles.iconBtn}
                                aria-label={d.locked ? `解鎖 ${drawingLabel(d)}` : `鎖定 ${drawingLabel(d)}`}
                                aria-pressed={d.locked}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    api.setLocked(d.id, !d.locked);
                                }}
                            >
                                {d.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                            </button>
                            <button
                                className={styles.iconBtn}
                                aria-label={`刪除 ${drawingLabel(d)}`}
                                disabled={d.locked}
                                style={d.locked ? { opacity: 0.35 } : undefined}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    api.removeOne(d.id);
                                }}
                            >
                                <Trash2 size={11} />
                            </button>
                        </div>
                    );
                })}
            </div>
            <div className={styles.listFooter}>
                <span className={styles.hint}>拖曳調整圖層順序；雙擊改名；Shift 點選可多選。</span>
                <label className={styles.row} style={{ cursor: 'pointer' }}>
                    <input
                        type='checkbox'
                        checked={api.shareContinuousMonth}
                        onChange={(e) => api.setShareContinuousMonth(e.target.checked)}
                    />
                    期貨連續月與月份合約共用畫圖
                </label>
                <span className={styles.hint}>商品鍵：{api.symbolKey}。多開的 K 線面板與彈出視窗同步顯示。</span>
            </div>
        </aside>
    );
}

// 精確價格輸入。編輯中的字串走 local state，不然每打一個字就把線移到
// 半成品價位（打「25100」會先跳到 2 元、25 元…）；Enter／失焦才送出，
// Esc 還原。
export function PriceInput({
    price,
    onCommit,
    disabled,
    format,
}: {
    price: number;
    onCommit: (p: number) => void;
    disabled?: boolean;
    // 顯示用格式（依商品跳動價位）；存的原始值不變
    format?: (p: number) => string;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    // Enter／Esc 之後的 blur() 會同步觸發 onBlur，而那時 draft 還是舊值
    // （setDraft 要等下次 render）。用 ref 標記這次已處理，不然 Esc 會把
    // 打到一半的價格套用上去、Enter 會套用兩次。
    const handled = useRef(false);
    const commit = () => {
        if (handled.current) {
            handled.current = false;
            return;
        }
        if (draft === null) return;
        const v = Number(draft);
        if (Number.isFinite(v) && v > 0) onCommit(v);
        setDraft(null);
    };
    return (
        <input
            className={styles.priceInput}
            value={draft ?? (format ? format(price) : String(Number(price.toFixed(2))))}
            inputMode='decimal'
            disabled={disabled}
            title='價格（Enter 套用）'
            aria-label='價格'
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onFocus={() => (handled.current = false)}
            onKeyDown={(e) => {
                if (isImeKey(e)) return;
                if (e.key === 'Enter') {
                    commit();
                    handled.current = true;
                    e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                    setDraft(null); // 還原輸入
                    handled.current = true;
                    e.currentTarget.blur();
                    e.stopPropagation(); // 不連帶關掉設定視窗
                }
            }}
        />
    );
}
