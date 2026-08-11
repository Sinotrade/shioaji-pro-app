// src/components/panel-library.tsx — searchable panel picker dialog
//
// Replaces the old flat add-panel dropdown: search + recents + category
// groups scale to any number of panel types. Existing singleton panels
// become "jump to panel" navigation instead of a disabled dead end.

import {
    Activity,
    AreaChart,
    BarChart2,
    Bell,
    Bot,
    Briefcase,
    Bug,
    ChartSpline,
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Combine,
    Eye,
    Filter,
    Flame,
    FlaskConical,
    Grid2x2,
    History,
    Layers,
    LayoutGrid,
    LineChart,
    type LucideIcon,
    Package,
    PieChart,
    Radio,
    Rows,
    ScrollText,
    Search,
    Star,
    Table,
    TrendingUp,
    Users,
    Zap,
} from 'lucide-react';
import {
    type KeyboardEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    type Block,
    BLOCK_META,
    type BlockType,
    PANEL_CATEGORIES,
} from '../lib/workspace';
import {
    canLivePreview,
    LIVE_PREVIEW_H,
    LIVE_PREVIEW_W,
    LivePanelPreview,
    livePreviewEnabled,
} from './panel-preview-live';
import { PANEL_PREVIEWS } from './panel-previews';
import * as styles from './panel-library.css';

const RECENTS_KEY = 'sj-pro-panel-recents-v1';
const RECENTS_LIMIT = 6;

const PANEL_ICONS: Record<BlockType, LucideIcon> = {
    watchlist: Star,
    movers: TrendingUp,
    dock: Briefcase,
    chart: LineChart,
    intraday: ChartSpline,
    intradaywall: Grid2x2,
    depth: Layers,
    ticket: ClipboardList,
    tape: ScrollText,
    flash: Zap,
    pnl: PieChart,
    chips: Users,
    volprofile: BarChart2,
    optchain: Table,
    stockfutures: Package,
    warrants: Filter,
    replay: History,
    depthmap: Flame,
    combo: Combine,
    notices: Bell,
    debug: Bug,
    grid: Rows,
    heatmap: LayoutGrid,
    pulse: Activity,
    signals: Radio,
    optpnl: AreaChart,
    backtest: FlaskConical,
    assistant: Bot,
};

const ALL_TYPES = Object.keys(BLOCK_META) as BlockType[];

function loadRecents(): BlockType[] {
    try {
        const raw = localStorage.getItem(RECENTS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (value): value is BlockType =>
                typeof value === 'string' && value in BLOCK_META,
        );
    } catch {
        return [];
    }
}

function saveRecents(recents: BlockType[]) {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

interface LibraryItem {
    type: BlockType;
    // singleton already in the workspace → jump target instead of add
    existingId: string | null;
}

export function PanelLibrary({
    open,
    onClose,
    blocks,
    onAdd,
    onLocate,
    selectedCode,
}: {
    open: boolean;
    onClose: () => void;
    blocks: Block[];
    onAdd: (type: BlockType) => void;
    onLocate: (blockId: string) => void;
    selectedCode?: string | null;
}) {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [recents, setRecents] = useState<BlockType[]>(loadRecents);
    const [collapsed, setCollapsed] = useState<string[]>([]);
    // live preview mounts one real panel at a time, only on request
    const [liveType, setLiveType] = useState<BlockType | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) {
            setQuery('');
            setActiveIndex(0);
            setRecents(loadRecents());
            setLiveType(null);
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open]);

    const toItem = useMemo(() => {
        return (type: BlockType): LibraryItem => ({
            type,
            existingId:
                (BLOCK_META[type].singleton &&
                    blocks.find((b) => b.type === type)?.id) ||
                null,
        });
    }, [blocks]);

    const trimmed = query.trim().toLowerCase();
    const searching = trimmed.length > 0;

    const filtered = useMemo(() => {
        if (!searching) return [];
        return ALL_TYPES.filter((type) => {
            const meta = BLOCK_META[type];
            return (
                meta.label.toLowerCase().includes(trimmed) ||
                meta.description.toLowerCase().includes(trimmed) ||
                type.includes(trimmed)
            );
        }).map(toItem);
    }, [searching, toItem, trimmed]);

    const grouped = useMemo(
        () =>
            PANEL_CATEGORIES.map((category) => ({
                ...category,
                items: ALL_TYPES.filter(
                    (type) => BLOCK_META[type].category === category.key,
                ).map(toItem),
            })),
        [toItem],
    );

    const recentItems = useMemo(
        () => (searching ? [] : recents.map(toItem)),
        [recents, searching, toItem],
    );

    // single flat order backing keyboard navigation — must mirror the
    // render order exactly, so collapsed groups are skipped here too
    const flatItems = useMemo(
        () =>
            searching
                ? filtered
                : [
                      ...recentItems,
                      ...grouped
                          .filter((g) => !collapsed.includes(g.key))
                          .flatMap((g) => g.items),
                  ],
        [collapsed, filtered, grouped, recentItems, searching],
    );

    useEffect(() => {
        setActiveIndex(0);
    }, [trimmed]);

    // switching cards unmounts any live preview immediately
    useEffect(() => {
        setLiveType(null);
    }, [activeIndex]);

    useEffect(() => {
        const row = bodyRef.current?.querySelector(
            `[data-idx="${activeIndex}"]`,
        );
        row?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    if (!open) return null;

    const activate = (item: LibraryItem, keepOpen: boolean) => {
        if (item.existingId) {
            onLocate(item.existingId);
            onClose();
            return;
        }
        onAdd(item.type);
        const next = [
            item.type,
            ...recents.filter((value) => value !== item.type),
        ].slice(0, RECENTS_LIMIT);
        setRecents(next);
        saveRecents(next);
        if (!keepOpen) onClose();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (flatItems.length === 0) return;
            setActiveIndex((current) => {
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                return (
                    (current + delta + flatItems.length) % flatItems.length
                );
            });
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const item = flatItems[activeIndex];
            if (item) activate(item, event.shiftKey);
        }
    };

    let flatIndex = -1;
    const renderCard = (item: LibraryItem) => {
        flatIndex += 1;
        const idx = flatIndex;
        const meta = BLOCK_META[item.type];
        const Icon = PANEL_ICONS[item.type];
        return (
            <button
                key={`${idx}-${item.type}`}
                data-idx={idx}
                className={
                    styles.card[idx === activeIndex ? 'active' : 'normal']
                }
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={(event) => activate(item, event.shiftKey)}
            >
                <span className={styles.cardIcon}>
                    <Icon size={16} />
                </span>
                <span className={styles.cardText}>
                    <span className={styles.cardTitle}>{meta.label}</span>
                    <span className={styles.cardDesc}>
                        {item.existingId
                            ? '已在版面中 · 點擊前往'
                            : meta.description}
                    </span>
                </span>
                {item.existingId && (
                    <span className={styles.cardGo}>前往</span>
                )}
            </button>
        );
    };

    const activeItem = flatItems[activeIndex];

    return (
        <>
            <div className={styles.backdrop} onClick={onClose} />
            <div
                className={styles.shell}
                role='dialog'
                aria-label='新增面板'
                onKeyDown={onKeyDown}
            >
                <div className={styles.dialog}>
                <div className={styles.searchRow}>
                    <Search size={14} />
                    <input
                        ref={inputRef}
                        className={styles.searchInput}
                        placeholder='搜尋面板（名稱或用途）'
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    <span className={styles.hintKey}>Enter 新增</span>
                    <span className={styles.hintKey}>Shift+Enter 連續</span>
                    <span className={styles.hintKey}>Esc</span>
                </div>
                <div ref={bodyRef} className={styles.body}>
                    {searching ? (
                        filtered.length > 0 ? (
                            <div className={styles.cardGrid}>
                                {filtered.map(renderCard)}
                            </div>
                        ) : (
                            <div className={styles.empty}>
                                找不到符合「{query.trim()}」的面板
                            </div>
                        )
                    ) : (
                        <>
                            {recentItems.length > 0 && (
                                <>
                                    <div className={styles.sectionHeader}>
                                        最近使用
                                    </div>
                                    <div className={styles.cardGrid}>
                                        {recentItems.map(renderCard)}
                                    </div>
                                </>
                            )}
                            {grouped.map((group) => {
                                const isCollapsed = collapsed.includes(
                                    group.key,
                                );
                                return (
                                    <div key={group.key}>
                                        <button
                                            className={styles.sectionHeader}
                                            aria-expanded={!isCollapsed}
                                            onClick={() => {
                                                setCollapsed((current) =>
                                                    current.includes(group.key)
                                                        ? current.filter(
                                                              (key) =>
                                                                  key !==
                                                                  group.key,
                                                          )
                                                        : [
                                                              ...current,
                                                              group.key,
                                                          ],
                                                );
                                                setActiveIndex(0);
                                            }}
                                        >
                                            {isCollapsed ? (
                                                <ChevronRight size={12} />
                                            ) : (
                                                <ChevronDown size={12} />
                                            )}
                                            {group.label}
                                            <span
                                                className={
                                                    styles.sectionCount
                                                }
                                            >
                                                {group.items.length}
                                            </span>
                                        </button>
                                        {!isCollapsed && (
                                            <div className={styles.cardGrid}>
                                                {group.items.map(renderCard)}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>
                </div>
                {activeItem && (
                    <div
                        className={`${styles.previewFlyout} ${
                            liveType === activeItem.type
                                ? styles.previewFlyoutLive
                                : ''
                        }`}
                    >
                        {liveType === activeItem.type ? (
                            <div
                                className={styles.livePreviewViewport}
                                style={{
                                    width: LIVE_PREVIEW_W,
                                    height: LIVE_PREVIEW_H,
                                }}
                            >
                                <LivePanelPreview
                                    type={activeItem.type}
                                    code={selectedCode || '2330'}
                                />
                            </div>
                        ) : (
                            PANEL_PREVIEWS[activeItem.type]
                        )}
                        <span className={styles.previewTitle}>
                            {BLOCK_META[activeItem.type].label}
                        </span>
                        <span className={styles.previewDesc}>
                            {BLOCK_META[activeItem.type].description}
                            {activeItem.existingId &&
                                ' · 已在版面中，選取後前往'}
                        </span>
                        {liveType !== activeItem.type &&
                            livePreviewEnabled() &&
                            canLivePreview(activeItem.type) && (
                                <button
                                    className={styles.previewButton}
                                    onClick={() =>
                                        setLiveType(activeItem.type)
                                    }
                                >
                                    <Eye size={12} /> 即時預覽
                                </button>
                            )}
                    </div>
                )}
            </div>
        </>
    );
}
