// src/components/chart-drawing-tools.tsx — K 線圖左側畫圖工具列
//
// TradingView 式的直排工具列，貼在主圖左緣。工具選擇、樣式（顏色／線寬／
// 實虛線／填色）、選取物件的鎖定隱藏複製刪除、一鍵清除都在這裡；互動
// 邏輯全部在 hooks/use-chart-drawings.ts。

import {
    Copy,
    Eye,
    EyeOff,
    Lock,
    LockOpen,
    Minus,
    MousePointer2,
    MoveDiagonal,
    MoveUpRight,
    Slash,
    Square,
    Trash2,
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
    DRAWING_PALETTE,
    DRAWING_TOOLS,
    MAX_DRAWINGS_PER_SYMBOL,
    type DrawingTool,
} from '../lib/chart-drawings';
import * as styles from './chart-drawing-tools.css';

const WIDTHS = [1, 2, 3, 4];

const TOOL_ICON: Record<DrawingTool, ComponentType<{ size?: number }>> = {
    horizontal: Minus,
    trend: Slash,
    ray: MoveUpRight,
    extended: MoveDiagonal,
    box: Square,
};

// 彈出面板離視窗邊緣至少留這麼多
const EDGE = 8;

// 樣式面板的位置：預設貼在樣式鈕右側、與它頂端對齊；下方放不下就往上
// 推，整個視窗都放不下就限制高度讓面板自己捲動。面板 portal 到 body、
// 以視窗座標定位 — 不受 K 線面板邊界裁切，矮面板裡每個控制項都點得到。
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

// 工具列按鈕的提示 — 立即顯示、畫在 body 上（直排工具列會捲動，
// 絕對定位的提示會被它裁掉）；原生 title 在桌面版 WebView 裡要停很久
// 才出現，所以不用
interface Tip {
    text: string;
    x: number;
    y: number;
}

export function ChartDrawingTools({ api }: { api: ChartDrawingsApi }) {
    const [open, setOpen] = useState(false);
    const [tip, setTip] = useState<Tip | null>(null);
    const swatchRef = useRef<HTMLButtonElement | null>(null);
    const selected = api.selected;
    const style = api.style;
    const full = api.drawings.length >= MAX_DRAWINGS_PER_SYMBOL;
    const fullHint = `此商品已達 ${MAX_DRAWINGS_PER_SYMBOL} 個畫圖物件上限，請先刪除部分物件`;

    const tipProps = (text: string) => ({
        'aria-label': text.split(' — ')[0]!.split('（')[0]!,
        onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            setTip({ text, x: r.right + 6, y: r.top + r.height / 2 });
        },
        onMouseLeave: () => setTip(null),
    });

    const doc = swatchRef.current?.ownerDocument;

    return (
        <div
            className={styles.rail}
            onMouseDown={keepChartFocus(api)}
            onScroll={() => setTip(null)}
        >
            <button
                className={styles.railBtn[api.tool === null ? 'active' : 'normal']}
                aria-pressed={api.tool === null}
                {...tipProps('游標 — 瀏覽模式：選取、拖曳既有物件（Esc 退出畫圖工具）')}
                onClick={() => api.setTool(null)}
            >
                <MousePointer2 size={13} />
            </button>

            <span className={styles.railDivider} />

            {DRAWING_TOOLS.map((t) => {
                const Icon = TOOL_ICON[t.tool];
                const armed = api.tool === t.tool;
                return (
                    <button
                        key={t.tool}
                        className={styles.railBtn[armed ? 'armed' : full ? 'disabled' : 'normal']}
                        aria-pressed={armed}
                        {...tipProps(
                            full
                                ? `${t.label} — ${fullHint}`
                                : `${t.label} — ${t.hint}（${armed ? '畫圖中，' : ''}Esc 取消）`,
                        )}
                        disabled={full && !armed}
                        onClick={() => api.setTool(armed ? null : t.tool)}
                    >
                        <Icon size={13} />
                    </button>
                );
            })}

            <span className={styles.railDivider} />

            <button
                ref={swatchRef}
                className={styles.swatchBtn}
                aria-expanded={open}
                {...tipProps(selected ? '樣式 — 選取物件的顏色、線寬、線型' : '樣式 — 下一個新物件的樣式、清除全部')}
                onClick={() => {
                    setTip(null);
                    setOpen((v) => !v);
                }}
            >
                <span className={styles.swatchDot} style={{ background: style.color }} />
            </button>

            {open && (
                <StylePopover
                    api={api}
                    anchor={swatchRef.current}
                    onClose={(reason) => {
                        setOpen(false);
                        // 點面板外關閉時焦點留在點到的地方（不搶回圖表）：
                        // 點了別的面板後，Delete 不能還作用在圖上的物件
                        if (reason !== 'outside') api.focusChart();
                    }}
                />
            )}

            {/* 選取中才出現的物件操作 — 沒選取時直排保持乾淨 */}
            {selected && (
                <>
                    <span className={styles.railDivider} />
                    <button
                        className={styles.railBtn[selected.locked ? 'active' : 'normal']}
                        aria-pressed={selected.locked}
                        {...tipProps(selected.locked ? '解鎖' : '鎖定 — 不可拖曳、改價、刪除')}
                        onClick={api.toggleLock}
                    >
                        {selected.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                    <button
                        className={styles.railBtn[selected.hidden ? 'active' : 'normal']}
                        aria-pressed={selected.hidden}
                        {...tipProps(selected.hidden ? '顯示' : '隱藏 — 可從樣式面板「顯示全部」找回')}
                        onClick={api.toggleHidden}
                    >
                        {selected.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                        className={styles.railBtn[full ? 'disabled' : 'normal']}
                        {...tipProps(full ? `複製 — ${fullHint}` : '複製')}
                        disabled={full}
                        onClick={api.duplicate}
                    >
                        <Copy size={13} />
                    </button>
                    <button
                        className={styles.railBtn[selected.locked ? 'disabled' : 'normal']}
                        {...tipProps(selected.locked ? '刪除 — 已鎖定，請先解鎖' : '刪除（Delete／Backspace）')}
                        disabled={selected.locked}
                        onClick={api.remove}
                    >
                        <Trash2 size={13} />
                    </button>
                </>
            )}

            {tip && doc?.body && (
                <BodyPortal host={doc.body}>
                    <span
                        role='tooltip'
                        className={styles.tip}
                        style={{ left: tip.x, top: tip.y }}
                    >
                        {tip.text}
                    </span>
                </BodyPortal>
            )}
        </div>
    );
}

function BodyPortal({ host, children }: { host: HTMLElement; children: ReactNode }) {
    return createPortal(children, host);
}

// 樣式面板本體 — 開著才掛載（Esc 關閉靠 useEscClose 入栈）
export function StylePopover({
    api,
    anchor,
    onClose,
}: {
    api: ChartDrawingsApi;
    anchor: HTMLElement | null;
    onClose: (reason: 'esc' | 'outside' | 'action') => void;
}) {
    const popRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const selected = api.selected;
    const style = api.style;
    // 方框才有填色可調
    const showsFill = selected ? selected.tool === 'box' : api.tool === 'box';
    const isHorizontal = selected?.tool === 'horizontal';

    // Esc 關閉面板：useEscClose 一律 preventDefault，這一下不會算進
    // Esc×2 全部刪單，也不會穿透去取消圖上的選取。價格輸入框裡的 Esc
    // 是「還原輸入」（輸入框自己處理），不關面板。
    useEscClose(() => {
        const active = popRef.current?.ownerDocument?.activeElement;
        if (active && active.tagName === 'INPUT' && popRef.current?.contains(active)) return;
        closeRef.current('esc');
    });

    // 依可用空間定位；視窗縮放或工具列捲動時重新定位
    useLayoutEffect(() => {
        const win = anchor?.ownerDocument?.defaultView;
        if (!anchor || !win) return;
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const pop = popRef.current;
            const h = pop ? pop.scrollHeight : 0;
            const w = pop ? pop.offsetWidth : 0;
            setPos(
                placeStylePopover(r, h, { width: win.innerWidth, height: win.innerHeight }, w),
            );
        };
        place();
        win.addEventListener('resize', place);
        win.addEventListener('scroll', place, true);
        return () => {
            win.removeEventListener('resize', place);
            win.removeEventListener('scroll', place, true);
        };
    }, [anchor, showsFill, isHorizontal, api.drawings.length]);

    // 點面板與樣式鈕以外的任何地方就關閉（不吃掉那一下 — 點到別的面板
    // 照常作用）
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
            aria-label='畫圖樣式'
            onMouseDown={keepChartFocus(api)}
        >
            {/* 精確價格只對水平線有意義 — 拖曳只能拖到游標所在的價位 */}
            {isHorizontal && !selected.locked && (
                <span className={styles.row}>
                    <span className={styles.label}>價格</span>
                    <PriceInput
                        key={selected.id}
                        price={selected.anchors[0]!.price}
                        onCommit={api.setSelectedPrice}
                    />
                </span>
            )}

            <span className={styles.row}>
                <span className={styles.label}>顏色</span>
                <span className={styles.palette}>
                    {DRAWING_PALETTE.map((c) => (
                        <button
                            key={c}
                            className={styles.swatch[style.color === c ? 'active' : 'normal']}
                            style={{ background: c }}
                            title={c}
                            aria-label={`顏色 ${c}`}
                            onClick={() => api.applyStyle({ color: c })}
                        />
                    ))}
                </span>
            </span>

            <span className={styles.row}>
                <span className={styles.label}>線寬</span>
                {WIDTHS.map((w) => (
                    <button
                        key={w}
                        className={styles.chip[style.width === w ? 'active' : 'normal']}
                        aria-label={`線寬 ${w}`}
                        onClick={() => api.applyStyle({ width: w })}
                    >
                        {w}
                    </button>
                ))}
            </span>

            <span className={styles.row}>
                <span className={styles.label}>線型</span>
                <button
                    className={styles.chip[style.dash === 'solid' ? 'active' : 'normal']}
                    onClick={() => api.applyStyle({ dash: 'solid' })}
                >
                    實線
                </button>
                <button
                    className={styles.chip[style.dash === 'dashed' ? 'active' : 'normal']}
                    onClick={() => api.applyStyle({ dash: 'dashed' })}
                >
                    虛線
                </button>
            </span>

            {showsFill && (
                <span className={styles.row}>
                    <span className={styles.label}>填色</span>
                    <input
                        type='range'
                        className={styles.slider}
                        min={0}
                        max={50}
                        step={2}
                        value={Math.round(style.fillOpacity * 100)}
                        style={{
                            ['--sj-fill' as string]: `${style.fillOpacity * 200}%`,
                        }}
                        onChange={(e) =>
                            api.applyStyle({
                                fillOpacity: Number(e.target.value) / 100,
                            })
                        }
                    />
                    <span>{Math.round(style.fillOpacity * 100)}%</span>
                </span>
            )}

            <span className={styles.popDivider} />

            <span className={styles.row}>
                <button
                    className={styles.chip.normal}
                    title='清除目前商品的所有畫圖（鎖定的保留）'
                    onClick={() => {
                        api.clearAll();
                        closeRef.current('action');
                    }}
                >
                    清除全部
                </button>
                {api.drawings.some((d) => d.hidden) && (
                    <button
                        className={styles.chip.normal}
                        title='隱藏的物件點不到，從這裡把它們全部顯示回來'
                        onClick={api.showAll}
                    >
                        顯示全部
                    </button>
                )}
            </span>

            <label className={styles.row} style={{ cursor: 'pointer' }}>
                <input
                    type='checkbox'
                    checked={api.shareContinuousMonth}
                    onChange={(e) => api.setShareContinuousMonth(e.target.checked)}
                />
                期貨連續月與月份合約共用畫圖
            </label>
            <span className={styles.hint}>
                目前商品鍵：{api.symbolKey}（共 {api.drawings.length} 個物件）。
                畫圖依此鍵保存，多開的 K 線面板與彈出視窗同步顯示。
            </span>
        </div>
    );

    // 測試（無 DOM）時就地渲染；瀏覽器中 portal 到錨點所在文件的 body
    const host = anchor?.ownerDocument?.body;
    return host ? createPortal(pop, host) : pop;
}

// 水平線的精確價格輸入。編輯中的字串走 local state，不然每打一個字就把
// 線移到半成品價位（打「25100」會先跳到 2 元、25 元…）；Enter／失焦才
// 送出，Esc 還原。
export function PriceInput({ price, onCommit }: { price: number; onCommit: (p: number) => void }) {
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
            value={draft ?? String(price)}
            inputMode='decimal'
            title='水平線價格（Enter 套用，會吸附到合法跳動價位）'
            aria-label='水平線價格'
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onFocus={() => (handled.current = false)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    commit();
                    handled.current = true;
                    e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                    setDraft(null); // 還原輸入
                    handled.current = true;
                    e.currentTarget.blur();
                    e.stopPropagation(); // 不連帶取消圖上的選取
                }
            }}
        />
    );
}
