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
import { useState, type ComponentType } from 'react';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';
import { DRAWING_PALETTE, DRAWING_TOOLS, type DrawingTool } from '../lib/chart-drawings';
import * as styles from './chart-drawing-tools.css';

const WIDTHS = [1, 2, 3, 4];

const TOOL_ICON: Record<DrawingTool, ComponentType<{ size?: number }>> = {
    horizontal: Minus,
    trend: Slash,
    ray: MoveUpRight,
    extended: MoveDiagonal,
    box: Square,
};

export function ChartDrawingTools({ api }: { api: ChartDrawingsApi }) {
    const [open, setOpen] = useState(false);
    const selected = api.selected;
    const style = api.style;
    // 方框才有填色可調
    const showsFill = selected ? selected.tool === 'box' : api.tool === 'box';
    const isHorizontal = selected?.tool === 'horizontal';

    return (
        <div className={styles.rail}>
            <button
                className={styles.railBtn[api.tool === null ? 'active' : 'normal']}
                title='游標（選取、拖曳既有物件）'
                aria-label='游標'
                onClick={() => api.setTool(null)}
            >
                <MousePointer2 size={13} />
            </button>

            <span className={styles.railDivider} />

            {DRAWING_TOOLS.map((t) => {
                const Icon = TOOL_ICON[t.tool];
                return (
                    <button
                        key={t.tool}
                        className={styles.railBtn[api.tool === t.tool ? 'armed' : 'normal']}
                        title={`${t.label} — ${t.hint}`}
                        aria-label={t.label}
                        onClick={() => api.setTool(api.tool === t.tool ? null : t.tool)}
                    >
                        <Icon size={13} />
                    </button>
                );
            })}

            <span className={styles.railDivider} />

            <span className={styles.popWrap}>
                <button
                    className={styles.swatchBtn}
                    title={selected ? '選取物件的樣式' : '下一個新物件的樣式'}
                    aria-label='樣式'
                    onClick={() => setOpen((v) => !v)}
                >
                    <span className={styles.swatchDot} style={{ background: style.color }} />
                </button>

                {open && (
                    <>
                        <span className={styles.backdrop} onClick={() => setOpen(false)} />
                        <span className={styles.pop}>
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
                                            className={
                                                styles.swatch[style.color === c ? 'active' : 'normal']
                                            }
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

                            <span className={styles.row}>
                                <button
                                    className={styles.chip.normal}
                                    title='清除目前商品的所有畫圖（鎖定的保留）'
                                    onClick={() => {
                                        api.clearAll();
                                        setOpen(false);
                                    }}
                                >
                                    清除全部
                                </button>
                            </span>
                        </span>
                    </>
                )}
            </span>

            {/* 選取中才出現的物件操作 — 沒選取時直排保持乾淨 */}
            {selected && (
                <>
                    <span className={styles.railDivider} />
                    <button
                        className={styles.railBtn[selected.locked ? 'active' : 'normal']}
                        title={selected.locked ? '解鎖' : '鎖定（不可拖曳／刪除）'}
                        aria-label={selected.locked ? '解鎖' : '鎖定'}
                        onClick={api.toggleLock}
                    >
                        {selected.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                    <button
                        className={styles.railBtn[selected.hidden ? 'active' : 'normal']}
                        title={selected.hidden ? '顯示' : '隱藏'}
                        aria-label={selected.hidden ? '顯示' : '隱藏'}
                        onClick={api.toggleHidden}
                    >
                        {selected.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                        className={styles.railBtn.normal}
                        title='複製'
                        aria-label='複製'
                        onClick={api.duplicate}
                    >
                        <Copy size={13} />
                    </button>
                    <button
                        className={styles.railBtn[selected.locked ? 'disabled' : 'normal']}
                        title={selected.locked ? '已鎖定，請先解鎖' : '刪除（Delete）'}
                        aria-label='刪除'
                        disabled={selected.locked}
                        onClick={api.remove}
                    >
                        <Trash2 size={13} />
                    </button>
                </>
            )}
        </div>
    );
}

// 水平線的精確價格輸入。編輯中的字串走 local state，不然每打一個字就把
// 線移到半成品價位（打「25100」會先跳到 2 元、25 元…）；Enter／失焦才
// 送出，Esc 還原。
function PriceInput({ price, onCommit }: { price: number; onCommit: (p: number) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
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
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    commit();
                    e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                    setDraft(null); // 還原輸入
                    e.currentTarget.blur();
                    e.stopPropagation(); // 不連帶取消圖上的選取
                }
            }}
        />
    );
}
