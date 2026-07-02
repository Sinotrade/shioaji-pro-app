// src/components/indicator-dialog.tsx — TradingView-style indicator picker
// (search / category sidebar / favorites / add-in-place) and the
// per-instance settings modal（輸入 / 樣式 分頁、確定/取消）.

import { ChevronDown, LineChart, Search, Star, Waves, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    DEF_BY_TYPE,
    factoryInstance,
    INDICATOR_DEFS,
    loadFavorites,
    outputStyle,
    saveFavorites,
    saveTypeDefault,
    type IndicatorDef,
    type IndicatorInstance,
    type OutputStyle,
    type PlotKind,
} from '../lib/indicator-defs';
import * as styles from './indicator-dialog.css';

const WIDTHS: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

export const PLOT_LABEL: Record<PlotKind, string> = {
    line: '線',
    step: '階梯線',
    area: '面積',
    histogram: '柱狀',
    circles: '圓點',
};

const PLOT_KINDS: PlotKind[] = ['line', 'step', 'area', 'histogram', 'circles'];

const PRECISIONS: (number | undefined)[] = [undefined, 0, 1, 2, 3, 4];

// TradingView-style color grid: grayscale row + 10 hues × 7 lightness tiers
function hslHex(h: number, s: number, l: number): string {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(255 * c)
            .toString(16)
            .padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

const HUES = [0, 25, 48, 95, 150, 178, 210, 245, 280, 330];
export const COLOR_GRID: string[][] = [
    [100, 95, 85, 70, 55, 40, 30, 20, 10, 0].map((l) => hslHex(0, 0, l)),
    HUES.map((h) => hslHex(h, 82, 58)),
    ...[84, 74, 64, 50, 38, 28].map((l) => HUES.map((h) => hslHex(h, 62, l))),
];

type Category = 'all' | 'fav' | 'overlay' | 'pane';

const CATEGORIES: { key: Category; label: string }[] = [
    { key: 'all', label: '全部指標' },
    { key: 'fav', label: '我的最愛' },
    { key: 'overlay', label: '主圖疊加' },
    { key: 'pane', label: '副圖指標' },
];

export function IndicatorDialog({
    instances,
    onAdd,
    onClose,
}: {
    instances: IndicatorInstance[];
    onAdd: (type: string) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState<Category>('all');
    const [favs, setFavs] = useState<Set<string>>(loadFavorites);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleFav = (type: string) => {
        setFavs((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            saveFavorites(next);
            return next;
        });
    };

    const counts = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of instances) m.set(i.type, (m.get(i.type) ?? 0) + 1);
        return m;
    }, [instances]);

    const q = query.trim().toLowerCase();
    const matches = (d: IndicatorDef) =>
        !q ||
        d.label.toLowerCase().includes(q) ||
        d.short.toLowerCase().includes(q) ||
        d.desc.toLowerCase().includes(q) ||
        d.aliases.some((a) => a.toLowerCase().includes(q));

    const inCategory = (d: IndicatorDef) =>
        category === 'all' ||
        (category === 'fav' && favs.has(d.type)) ||
        d.category === category;

    const filtered = INDICATOR_DEFS.filter(
        (d) => matches(d) && inCategory(d),
    );
    const overlays = filtered.filter((d) => d.category === 'overlay');
    const panes = filtered.filter((d) => d.category === 'pane');

    const renderRow = (d: IndicatorDef) => {
        const added = counts.get(d.type) ?? 0;
        return (
            <button
                key={d.type}
                className={styles.row}
                onClick={() => onAdd(d.type)}
            >
                <span
                    className={styles.rowSwatch}
                    style={{ background: d.outputs[0]!.color }}
                />
                <span className={styles.rowMain}>
                    <span className={styles.rowName}>{d.label}</span>
                    <span className={styles.rowDesc}>{d.desc}</span>
                </span>
                {added > 0 && (
                    <span className={styles.rowAdded}>已加入 {added}</span>
                )}
                <span
                    role='button'
                    tabIndex={0}
                    className={
                        styles.starBtn[favs.has(d.type) ? 'active' : 'normal']
                    }
                    title='加入我的最愛'
                    onClick={(e) => {
                        e.stopPropagation();
                        toggleFav(d.type);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            toggleFav(d.type);
                        }
                    }}
                >
                    <Star
                        size={13}
                        fill={favs.has(d.type) ? 'currentColor' : 'none'}
                    />
                </span>
            </button>
        );
    };

    return (
        <div
            className={styles.overlay}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className={styles.dialog}>
                <div className={styles.header}>
                    技術指標
                    <button className={styles.closeBtn} onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>
                <div className={styles.searchWrap}>
                    <Search size={14} />
                    <input
                        ref={inputRef}
                        className={styles.searchInput}
                        placeholder='搜尋指標（名稱、縮寫、中英文都可以）'
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <button
                            className={styles.closeBtn}
                            onClick={() => setQuery('')}
                        >
                            <X size={13} />
                        </button>
                    )}
                </div>
                <div className={styles.body}>
                    <div className={styles.sidebar}>
                        <div className={styles.sideTitle}>分類</div>
                        {CATEGORIES.map((c) => (
                            <button
                                key={c.key}
                                className={
                                    styles.sideItem[
                                        category === c.key
                                            ? 'active'
                                            : 'normal'
                                    ]
                                }
                                onClick={() => setCategory(c.key)}
                            >
                                {c.key === 'fav' ? (
                                    <Star size={13} />
                                ) : c.key === 'overlay' ? (
                                    <LineChart size={13} />
                                ) : c.key === 'pane' ? (
                                    <Waves size={13} />
                                ) : (
                                    <Search size={13} />
                                )}
                                {c.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.list}>
                        {filtered.length === 0 && (
                            <div className={styles.empty}>
                                沒有符合「{query}」的指標
                            </div>
                        )}
                        {overlays.length > 0 && (
                            <>
                                <div className={styles.listHeader}>
                                    主圖疊加
                                </div>
                                {overlays.map(renderRow)}
                            </>
                        )}
                        {panes.length > 0 && (
                            <>
                                <div className={styles.listHeader}>
                                    副圖指標
                                </div>
                                {panes.map(renderRow)}
                            </>
                        )}
                    </div>
                </div>
                <div className={styles.footer}>
                    <span>點擊指標開啟設定，確定後加入；同型可加多個（不同參數）</span>
                    <span>已啟用 {instances.length} 個</span>
                </div>
            </div>
        </div>
    );
}

// ---- per-instance settings（輸入 / 樣式 / 時框顯示）----

// TradingView-style color panel: grid + hex + opacity + thickness,
// expanded inline under the output row（modal 內不會被裁切）
function ColorPanel({
    style: s,
    showWidth,
    onChange,
}: {
    style: ReturnType<typeof outputStyle>;
    showWidth: boolean;
    onChange: (patch: OutputStyle) => void;
}) {
    const [hex, setHex] = useState(s.color);
    return (
        <div className={styles.colorPanel}>
            <div className={styles.colorGrid}>
                {COLOR_GRID.map((row, ri) => (
                    <div key={ri} className={styles.colorGridRow}>
                        {row.map((c) => (
                            <button
                                key={c}
                                className={
                                    styles.gridSwatch[
                                        s.color.toLowerCase() ===
                                        c.toLowerCase()
                                            ? 'active'
                                            : 'normal'
                                    ]
                                }
                                style={{ background: c }}
                                onClick={() => {
                                    setHex(c);
                                    onChange({ color: c });
                                }}
                            />
                        ))}
                    </div>
                ))}
            </div>
            <div className={styles.colorTools}>
                <span className={styles.colorToolLabel}>自訂</span>
                <input
                    className={styles.hexInput}
                    value={hex}
                    spellCheck={false}
                    onChange={(e) => {
                        const v = e.target.value.trim();
                        setHex(v);
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                            onChange({ color: v });
                        }
                    }}
                />
            </div>
            <div className={styles.colorTools}>
                <span className={styles.colorToolLabel}>透明度</span>
                <input
                    type='range'
                    className={styles.opacitySlider}
                    min={10}
                    max={100}
                    step={5}
                    value={s.opacity}
                    onChange={(e) =>
                        onChange({ opacity: Number(e.target.value) })
                    }
                />
                <span className={styles.opacityValue}>{s.opacity}%</span>
            </div>
            {showWidth && (
                <div className={styles.colorTools}>
                    <span className={styles.colorToolLabel}>粗細</span>
                    {WIDTHS.map((w) => (
                        <button
                            key={w}
                            className={
                                styles.widthBtn[
                                    s.width === w ? 'active' : 'normal'
                                ]
                            }
                            title={`${w}px`}
                            onClick={() => onChange({ width: w })}
                        >
                            <span
                                className={styles.widthLine}
                                style={{ height: `${w}px` }}
                            />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function IndicatorSettingsModal({
    inst,
    timeframes,
    onPatch,
    onRemove,
    onCommit,
    onCancel,
}: {
    inst: IndicatorInstance;
    timeframes: { label: string; minutes: number }[];
    onPatch: (patch: Partial<IndicatorInstance>) => void;
    onRemove: () => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    const def = DEF_BY_TYPE.get(inst.type);
    const [tab, setTab] = useState<'inputs' | 'style' | 'visibility'>(
        def && def.params.length > 0 ? 'inputs' : 'style',
    );
    // which output has its color panel / plot menu expanded
    const [colorFor, setColorFor] = useState<string | null>(null);
    const [plotFor, setPlotFor] = useState<string | null>(null);
    const [defaultsOpen, setDefaultsOpen] = useState(false);
    const [savedTip, setSavedTip] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!def) return null;

    const patchStyle = (key: string, patch: OutputStyle) => {
        onPatch({
            styles: {
                ...inst.styles,
                [key]: { ...inst.styles?.[key], ...patch },
            },
        });
    };

    const tfList = inst.visibleTf; // undefined = all
    const tfChecked = (m: number) => !tfList || tfList.includes(m);
    const toggleTf = (m: number) => {
        const all = timeframes.map((t) => t.minutes);
        const cur = tfList ?? all;
        const next = tfChecked(m)
            ? cur.filter((x) => x !== m)
            : [...cur, m];
        onPatch({
            visibleTf: next.length >= all.length ? undefined : next,
        });
    };

    return (
        <div
            className={styles.overlay}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onCancel();
            }}
        >
            <div className={styles.settingsDialog}>
                <div className={styles.header}>
                    {def.label}
                    <button className={styles.closeBtn} onClick={onCancel}>
                        <X size={16} />
                    </button>
                </div>
                <div className={styles.tabs}>
                    {def.params.length > 0 && (
                        <button
                            className={
                                styles.tab[
                                    tab === 'inputs' ? 'active' : 'normal'
                                ]
                            }
                            onClick={() => setTab('inputs')}
                        >
                            輸入
                        </button>
                    )}
                    <button
                        className={
                            styles.tab[tab === 'style' ? 'active' : 'normal']
                        }
                        onClick={() => setTab('style')}
                    >
                        樣式
                    </button>
                    <button
                        className={
                            styles.tab[
                                tab === 'visibility' ? 'active' : 'normal'
                            ]
                        }
                        onClick={() => setTab('visibility')}
                    >
                        時框顯示
                    </button>
                </div>
                <div className={styles.settingsBody}>
                    {tab === 'inputs' &&
                        def.params.map((p) => (
                            <label key={p.key} className={styles.fieldRow}>
                                <span>{p.label}</span>
                                <input
                                    type='number'
                                    className={styles.fieldInput}
                                    min={p.min}
                                    max={p.max}
                                    step={p.step ?? 1}
                                    value={inst.params[p.key] ?? p.def}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        onPatch({
                                            params: {
                                                ...inst.params,
                                                [p.key]: Math.min(
                                                    p.max,
                                                    Math.max(p.min, v),
                                                ),
                                            },
                                        });
                                    }}
                                />
                            </label>
                        ))}
                    {tab === 'style' && (
                        <>
                            {def.outputs.map((o) => {
                                const s = outputStyle(inst, def, o.key);
                                const isLine =
                                    s.plot !== 'histogram' &&
                                    s.plot !== 'circles';
                                return (
                                    <div
                                        key={o.key}
                                        className={styles.styleSection}
                                    >
                                        <div className={styles.styleRow}>
                                            <label
                                                className={styles.styleHead}
                                            >
                                                <input
                                                    type='checkbox'
                                                    className={styles.checkbox}
                                                    checked={s.visible}
                                                    onChange={(e) =>
                                                        patchStyle(o.key, {
                                                            visible:
                                                                e.target
                                                                    .checked,
                                                        })
                                                    }
                                                />
                                                {o.label}
                                            </label>
                                            <div
                                                className={
                                                    styles.styleRowBtns
                                                }
                                            >
                                                <button
                                                    className={
                                                        styles.previewBtn[
                                                            colorFor === o.key
                                                                ? 'active'
                                                                : 'normal'
                                                        ]
                                                    }
                                                    title='顏色 / 透明度 / 粗細'
                                                    onClick={() => {
                                                        setPlotFor(null);
                                                        setColorFor(
                                                            colorFor === o.key
                                                                ? null
                                                                : o.key,
                                                        );
                                                    }}
                                                >
                                                    <span
                                                        className={
                                                            styles.previewSwatch
                                                        }
                                                        style={{
                                                            background:
                                                                s.color,
                                                            opacity:
                                                                s.opacity /
                                                                100,
                                                        }}
                                                    />
                                                    <span
                                                        className={
                                                            styles.previewLine
                                                        }
                                                        style={{
                                                            background:
                                                                s.color,
                                                            height: `${s.width}px`,
                                                        }}
                                                    />
                                                </button>
                                                <button
                                                    className={
                                                        styles.plotBtn[
                                                            plotFor === o.key
                                                                ? 'active'
                                                                : 'normal'
                                                        ]
                                                    }
                                                    title='線型'
                                                    onClick={() => {
                                                        setColorFor(null);
                                                        setPlotFor(
                                                            plotFor === o.key
                                                                ? null
                                                                : o.key,
                                                        );
                                                    }}
                                                >
                                                    {PLOT_LABEL[s.plot]}
                                                    <ChevronDown size={11} />
                                                </button>
                                            </div>
                                        </div>
                                        {colorFor === o.key && (
                                            <ColorPanel
                                                style={s}
                                                showWidth={isLine}
                                                onChange={(patch) =>
                                                    patchStyle(o.key, patch)
                                                }
                                            />
                                        )}
                                        {plotFor === o.key && (
                                            <div
                                                className={styles.plotMenu}
                                            >
                                                {PLOT_KINDS.map((k) => (
                                                    <button
                                                        key={k}
                                                        className={
                                                            styles.plotItem[
                                                                s.plot === k
                                                                    ? 'active'
                                                                    : 'normal'
                                                            ]
                                                        }
                                                        onClick={() => {
                                                            patchStyle(o.key, {
                                                                plot: k,
                                                            });
                                                            setPlotFor(null);
                                                        }}
                                                    >
                                                        {PLOT_LABEL[k]}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            <div className={styles.sectionTitle}>
                                輸出數值
                            </div>
                            <label className={styles.fieldRow}>
                                <span>小數位數</span>
                                <select
                                    className={styles.fieldSelect}
                                    value={inst.precision ?? 'auto'}
                                    onChange={(e) =>
                                        onPatch({
                                            precision:
                                                e.target.value === 'auto'
                                                    ? undefined
                                                    : Number(e.target.value),
                                        })
                                    }
                                >
                                    {PRECISIONS.map((p) => (
                                        <option
                                            key={p ?? 'auto'}
                                            value={p ?? 'auto'}
                                        >
                                            {p === undefined ? '自動' : p}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className={styles.fieldRow}>
                                <span>價格軸最新值標籤</span>
                                <input
                                    type='checkbox'
                                    className={styles.checkbox}
                                    checked={inst.showLabels ?? false}
                                    onChange={(e) =>
                                        onPatch({
                                            showLabels: e.target.checked,
                                        })
                                    }
                                />
                            </label>
                            <label className={styles.fieldRow}>
                                <span>圖上顯示數值</span>
                                <input
                                    type='checkbox'
                                    className={styles.checkbox}
                                    checked={inst.showValues ?? true}
                                    onChange={(e) =>
                                        onPatch({
                                            showValues: e.target.checked,
                                        })
                                    }
                                />
                            </label>
                        </>
                    )}
                    {tab === 'visibility' && (
                        <>
                            <div className={styles.sectionTitle}>
                                在哪些時框顯示這個指標
                            </div>
                            {timeframes.map((t) => (
                                <label
                                    key={t.minutes}
                                    className={styles.fieldRow}
                                >
                                    <span>{t.label}</span>
                                    <input
                                        type='checkbox'
                                        className={styles.checkbox}
                                        checked={tfChecked(t.minutes)}
                                        onChange={() => toggleTf(t.minutes)}
                                    />
                                </label>
                            ))}
                        </>
                    )}
                </div>
                <div className={styles.settingsFooter}>
                    <div className={styles.defaultsWrap}>
                        <button
                            className={styles.cancelBtn}
                            onClick={() => setDefaultsOpen((o) => !o)}
                        >
                            預設值 <ChevronDown size={11} />
                        </button>
                        {defaultsOpen && (
                            <div className={styles.defaultsMenu}>
                                <button
                                    className={styles.defaultsItem}
                                    onClick={() => {
                                        const f = factoryInstance(inst);
                                        onPatch({
                                            params: f.params,
                                            colors: f.colors,
                                            styles: undefined,
                                            precision: undefined,
                                            showLabels: undefined,
                                            showValues: undefined,
                                        });
                                        setDefaultsOpen(false);
                                    }}
                                >
                                    重設為內建預設
                                </button>
                                <button
                                    className={styles.defaultsItem}
                                    onClick={() => {
                                        saveTypeDefault(inst);
                                        setDefaultsOpen(false);
                                        setSavedTip(true);
                                        setTimeout(
                                            () => setSavedTip(false),
                                            1800,
                                        );
                                    }}
                                >
                                    存為我的預設
                                </button>
                            </div>
                        )}
                        {savedTip && (
                            <span className={styles.savedTip}>
                                已存 — 之後新增 {def.short} 會直接套用
                            </span>
                        )}
                        <button
                            className={styles.dangerBtn}
                            onClick={onRemove}
                        >
                            移除
                        </button>
                    </div>
                    <div className={styles.footerActions}>
                        <button
                            className={styles.cancelBtn}
                            onClick={onCancel}
                        >
                            取消
                        </button>
                        <button className={styles.okBtn} onClick={onCommit}>
                            確定
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
