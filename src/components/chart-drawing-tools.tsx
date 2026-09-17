// src/components/chart-drawing-tools.tsx — K 線圖畫圖工具列
//
// 工具選擇、樣式（顏色／線寬／實虛線／填色）、選取物件的鎖定隱藏複製
// 刪除，以及一鍵清除。互動邏輯全部在 hooks/use-chart-drawings.ts。

import { Copy, Eye, EyeOff, Lock, LockOpen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';
import { DRAWING_PALETTE, DRAWING_TOOLS } from '../lib/chart-drawings';
import * as styles from './chart-drawing-tools.css';

const WIDTHS = [1, 2, 3, 4];

export function ChartDrawingTools({ api }: { api: ChartDrawingsApi }) {
    const [open, setOpen] = useState(false);
    const selected = api.selected;
    const style = api.style;
    // 方框才有填色可調
    const showsFill = selected ? selected.tool === 'box' : api.tool === 'box';

    return (
        <span className={styles.wrap}>
            {DRAWING_TOOLS.map((t) => (
                <button
                    key={t.tool}
                    className={styles.toolBtn[api.tool === t.tool ? 'armed' : 'normal']}
                    title={t.hint}
                    onClick={() => api.setTool(api.tool === t.tool ? null : t.tool)}
                >
                    {t.label}
                </button>
            ))}

            <button
                className={styles.swatchBtn}
                title={selected ? '選取物件的樣式' : '下一個新物件的樣式'}
                onClick={() => setOpen((v) => !v)}
            >
                <span className={styles.swatchDot} style={{ background: style.color }} />
                樣式
            </button>

            {selected?.tool === 'horizontal' && !selected.locked && (
                <PriceInput
                    key={selected.id}
                    price={selected.anchors[0]!.price}
                    onCommit={api.setSelectedPrice}
                />
            )}

            {selected && (
                <>
                    <button
                        className={styles.iconBtn}
                        title={selected.locked ? '解鎖' : '鎖定（不可拖曳／刪除）'}
                        onClick={api.toggleLock}
                    >
                        {selected.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                    </button>
                    <button
                        className={styles.iconBtn}
                        title={selected.hidden ? '顯示' : '隱藏'}
                        onClick={api.toggleHidden}
                    >
                        {selected.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                    <button className={styles.iconBtn} title='複製' onClick={api.duplicate}>
                        <Copy size={12} />
                    </button>
                    <button
                        className={selected.locked ? styles.toolBtn.disabled : styles.iconBtn}
                        title={selected.locked ? '已鎖定，請先解鎖' : '刪除（Delete）'}
                        disabled={selected.locked}
                        onClick={api.remove}
                    >
                        <Trash2 size={12} />
                    </button>
                </>
            )}

            {open && (
                <>
                    <span className={styles.backdrop} onClick={() => setOpen(false)} />
                    <span className={styles.pop}>
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
                                        ['--sj-fill' as string]: `${(style.fillOpacity * 100) / 50 * 100}%`,
                                    }}
                                    onChange={(e) =>
                                        api.applyStyle({ fillOpacity: Number(e.target.value) / 100 })
                                    }
                                />
                                <span>{Math.round(style.fillOpacity * 100)}%</span>
                            </span>
                        )}

                        <span className={styles.popDivider} />

                        <span className={styles.row}>
                            <label className={styles.row} style={{ cursor: 'pointer' }}>
                                <input
                                    type='checkbox'
                                    checked={api.shareContinuousMonth}
                                    onChange={(e) => api.setShareContinuousMonth(e.target.checked)}
                                />
                                期貨連續月與月份合約共用畫圖
                            </label>
                        </span>
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
    );
}

// 水平線的精確價格輸入。編輯中走 local state，不然每打一個字就把線移到
// 半成品價位（打「25100」時會先跳到 2 元、25 元…）；Enter／失焦才送出，
// Esc 還原。
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
