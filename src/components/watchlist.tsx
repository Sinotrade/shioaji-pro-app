// src/components/watchlist.tsx — server-backed editable watchlists.
// Pick a list, add symbols (type auto-detected), hover a row to remove,
// drag rows to reorder (persisted to the server).

import {
    ArrowDown,
    ArrowDownUp,
    ArrowUp,
    Check,
    ChevronDown,
    ChevronUp,
    GripVertical,
    Pencil,
    Plus,
    TrendingUp,
    Trash2,
    X,
} from 'lucide-react';
import {
    memo,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react';
import { limitStateOf } from '../lib/limit-state';
import { useLimitStyle } from '../lib/limit-style-prefs';
import { neighborCode } from '../lib/list-move';
import { useQuote } from '../hooks/use-stream';
import type { WatchItem } from '../hooks/use-watchlist';
import type { ServerWatchlist } from '../lib/shioaji';
import { getQuote } from '../lib/stream';
import { isTauri } from '../lib/runtime';
import type { ContractInfo } from '../lib/types/contract';
import type { SecurityType } from '../lib/types/contract';
import type { ProductSuggestion } from '../lib/product-search';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { Sparkline } from './sparkline';
import { RefreshButton } from './refresh-button';
import { AsyncStatus } from './async-status';
import { ProductSearchDetails } from './product-search-details';
import { optionId, ProductSuggestionRow, productIdentity } from './product-suggestion-row';
import { useAnchoredPopup } from '../hooks/use-anchored-popup';
import { useProductSearch } from '../hooks/use-product-search';
import * as panel from './panel.css';
import * as styles from './watchlist.css';

const SPARK_KEY = 'sj-pro-watchlist-spark';

type SortMode = 'custom' | 'desc' | 'asc';

// live percent change for sorting — quote first, snapshot fallback
function pctOf(item: WatchItem): number {
    const q = getQuote(item.contract.code);
    const ref = q?.index
        ? Number(q.index.reference)
        : item.contract.reference;
    const close = q?.tick
        ? Number(q.tick.close)
        : q?.index
          ? Number(q.index.close)
          : item.snapshot?.close;
    if (close !== undefined && ref) return ((close - ref) / ref) * 100;
    return item.snapshot?.change_rate ?? 0;
}

const WatchRow = memo(function WatchRow({
    item,
    selected,
    dropTarget,
    spark,
    arrange,
    canUp,
    canDown,
    canRemove,
    onMove,
    onSelect,
    onRemove,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
}: {
    item: WatchItem;
    selected: boolean;
    dropTarget: boolean;
    spark: boolean;
    // 排序模式：grip＋上下移可見、拖曳啟用、點擊不觸發 onSelect
    arrange: boolean;
    canUp: boolean;
    canDown: boolean;
    canRemove: boolean;
    onMove: (code: string, dir: -1 | 1) => void;
    onSelect: (c: ContractInfo) => void;
    onRemove: (code: string) => void;
    onDragStart: (code: string) => void;
    onDragOver: (code: string) => void;
    onDrop: () => void;
    onDragEnd: () => void;
}) {
    const quote = useQuote(item.contract.code);
    const tick = quote?.tick;
    const index = quote?.index;

    const close = tick
        ? Number(tick.close)
        : index
          ? Number(index.close)
          : item.snapshot?.close;
    const ref = index ? Number(index.reference) : item.contract.reference;
    const chg = tick?.price_chg
        ? Number(tick.price_chg)
        : index
          ? Number(index.close) - Number(index.reference)
        : close !== undefined && ref
          ? close - ref
          : undefined;
    // NEVER use tick.pct_chg — its unit differs between stk (％×100) and
    // fop (％) streams; derive from the price change and reference instead
    const pct =
        chg !== undefined && ref
            ? (chg / ref) * 100
            : item.snapshot?.change_rate;

    const dir = chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    // 漲跌停亮燈（與報價看板／走勢共用 limitStateOf：指數、興櫃不亮）
    // 無即時 tick 時退回快照收盤：快照隱含的參考價（close − change_price）
    // 須等於合約今天的參考價，才確定是同一交易日；昨日快照（例如開盤前）
    // 只顯示價格、不亮燈
    const snap = item.snapshot;
    const limitPx =
        tick || index
            ? close
            : snap &&
                Number.isFinite(snap.change_price) &&
                Number(
                    (snap.close - snap.change_price).toFixed(4),
                ) === Number(Number(item.contract.reference).toFixed(4))
              ? snap.close
              : undefined;
    const atLimit = limitStateOf(item.contract, limitPx);
    const limitLabel = atLimit === 'up' ? '漲停' : atLimit === 'down' ? '跌停' : '';
    // 亮燈樣式（設定 → 外觀，全域）；「不標示」時 lit 為 null
    const limitStyle = useLimitStyle();
    const lit = limitStyle === 'none' ? null : atLimit;
    // 小線圖模式＋數字區色塊：等寬色塊放不下小線圖，停板列收起小線圖
    //（鎖停板的走勢本來就是一條平線），色塊延伸到小線圖欄、位置與其他
    // 停板列一致
    const blockWide = spark && lit !== null && limitStyle === 'block';
    // the flash overlay is re-keyed by flashSeq so the animation replays on
    // every real deal — the row itself stays mounted (hover state survives)
    const flashDir = !quote?.flashSeq
        ? null
        : quote.lastDir === -1
          ? ('down' as const)
          : ('up' as const);

    return (
        <div
            data-code={item.contract.code}
            data-limit={atLimit ?? undefined}
            className={`${styles.row[selected ? 'selected' : 'normal']} ${
                lit && limitStyle === 'tint' ? styles.limitTint[lit] : ''
            } ${lit && limitStyle === 'solid' ? styles.limitSolid[lit] : ''} ${
                spark ? styles.rowSparkCols : ''
            } ${dropTarget ? styles.dropTarget : ''} ${
                arrange ? styles.rowArrange : ''
            }`}
            // 只有排序模式才能拖 — 平常 draggable 會跟點擊選擇打架還會誤拖
            draggable={arrange}
            onClick={() => {
                if (!arrange) onSelect(item.contract);
            }}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(item.contract.code);
            }}
            // 排序模式外不接任何拖放（外部拖進來的檔案/文字不該變 drop
            // target，更不該觸發 handleDrop）
            onDragOver={(e) => {
                if (!arrange) return;
                e.preventDefault();
                onDragOver(item.contract.code);
            }}
            onDrop={(e) => {
                if (!arrange) return;
                e.preventDefault();
                onDrop();
            }}
            // 取消的拖曳（Esc／拖出視窗）也要清 drag state，否則殘留的
            // fromCode 會在下一次 drop 時造成 spurious reorder
            onDragEnd={onDragEnd}
        >
            {flashDir && (
                <span
                    key={quote?.flashSeq}
                    className={styles.flashOverlay[flashDir]}
                />
            )}
            {arrange && (
                <span className={styles.gripHandle}>
                    <GripVertical size={12} />
                </span>
            )}
            <span className={`${styles.code} ${styles.firstCol}`}>
                {item.contract.code}
            </span>
            {spark && !blockWide && (
                <span className={styles.sparkCell}>
                    <Sparkline
                        contract={item.contract}
                        last={close}
                        reference={ref || undefined}
                        height={26}
                        stretch
                    />
                </span>
            )}
            <span
                className={`${styles.numCell} ${
                    lit && limitStyle === 'block' ? styles.limitBlock[lit] : ''
                } ${blockWide ? styles.numCellWide : ''}`}
                title={lit ? `${limitLabel} ${fmtPrice(close)}` : undefined}
            >
                <span className={`${styles.price} ${panel.dirText[dir]}`}>
                    {lit ? (
                        <span className={styles.srOnly}>{limitLabel} </span>
                    ) : null}
                    {tick?.simtrade ? (
                        <span className={styles.simBadge}>試搓</span>
                    ) : null}
                    {fmtPrice(close)}
                </span>
                <span className={`${styles.change} ${panel.dirText[dir]}`}>
                    {fmtSigned(chg)} {fmtPct(pct)}
                </span>
            </span>
            <span className={`${styles.name} ${styles.firstCol}`}>
                {item.contract.name}
            </span>
            {arrange ? (
                <span className={styles.moveCol}>
                    <button
                        className={styles.moveBtn}
                        title='上移'
                        disabled={!canUp}
                        onClick={(e) => {
                            e.stopPropagation();
                            onMove(item.contract.code, -1);
                        }}
                    >
                        <ChevronUp size={11} />
                    </button>
                    <button
                        className={styles.moveBtn}
                        title='下移'
                        disabled={!canDown}
                        onClick={(e) => {
                            e.stopPropagation();
                            onMove(item.contract.code, 1);
                        }}
                    >
                        <ChevronDown size={11} />
                    </button>
                </span>
            ) : (
                <button
                    className={styles.rowRemove}
                    title='從清單移除'
                    disabled={!canRemove}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove(item.contract.code);
                    }}
                >
                    <X size={10} />
                </button>
            )}
        </div>
    );
});

export function Watchlist({
    items,
    selectedCode,
    onSelect,
    onAdd,
    onRemove,
    onReorder,
    serverLists,
    activeListId,
    onSelectList,
    onCreateList,
    onRenameList,
    onDeleteList,
    loading,
    structureBusy,
    loadError,
    onRetryLoad,
    onReload,
    reloading = false,
    onHoldReload,
}: {
    items: WatchItem[];
    selectedCode: string | null;
    onSelect: (c: ContractInfo) => void;
    onAdd: (
        code: string,
        type?: SecurityType,
        resolved?: ContractInfo,
    ) => Promise<unknown>;
    onRemove: (code: string) => void;
    onReorder: (fromCode: string, toCode: string) => void;
    serverLists: ServerWatchlist[];
    activeListId: string;
    onSelectList: (id: string) => void;
    onCreateList: (name: string) => Promise<unknown>;
    // resolves false when the rename is rejected (e.g. duplicate name)
    onRenameList: (name: string) => Promise<boolean>;
    onDeleteList: () => Promise<unknown>;
    loading: boolean;
    structureBusy: boolean;
    loadError: boolean;
    onRetryLoad: () => void;
    /** 重新讀取 (#340): pull lists changed outside this panel (Agent / CLI) */
    onReload?: () => unknown;
    reloading?: boolean;
    /** hold outside re-reads while the user is editing (排序 / 改名 / 新增) */
    onHoldReload?: (held: boolean) => void;
}) {
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState(false);
    // Final rows only: this popup grows upward, so partial rows would shift
    // under the pointer while later sources fill in.
    const search = useProductSearch(input, { limit: 10, resetKey: activeListId });
    const { suggestions, searching, searchError, activeIdentity, setActiveIdentity } = search;
    const [addError, setAddError] = useState(false);
    const [addRow, setAddRow] = useState<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const suggestBoxRef = useRef<HTMLDivElement>(null);
    const suggestRowRefs = useRef(new Map<string, HTMLButtonElement>());
    const submitBusy = useRef(false);
    const activeListRef = useRef(activeListId);
    activeListRef.current = activeListId;
    const suggestionIdentities = useMemo(() => suggestions.map(productIdentity), [suggestions]);
    const explicitIndex = suggestionIdentities.indexOf(activeIdentity ?? '');
    const activeIndex = explicitIndex >= 0 ? explicitIndex : searching ? -1 : 0;
    const popupOpen = suggestions.length > 0 || searchError || searching || addError;
    const renderedVersion = search.renderedVersion;
    useEffect(() => {
        setActiveIdentity(current => current && suggestionIdentities.includes(current) ? current : null);
    }, [suggestionIdentities]);
    const activeSuggestion = suggestionIdentities[activeIndex];
    useEffect(() => {
        const row = activeSuggestion ? suggestRowRefs.current.get(activeSuggestion) : undefined;
        row?.scrollIntoView?.({ block: 'nearest' });
    }, [activeSuggestion, suggestionIdentities]);
    // Closing keeps the typed text, like Esc: the popup never stays behind at a stale place.
    const closePopup = () => {
        search.clear();
        setAddError(false);
    };
    // Only rows hidden by an outside press come back on focus; Esc and typing keep them closed.
    const reopenOnFocus = useRef(false);
    // Focus inside the popup is lost to the page when its rows are replaced; give it back to the input.
    const focusInPopup = useRef(false);
    useEffect(() => {
        const doc = inputRef.current?.ownerDocument;
        if (focusInPopup.current && doc?.activeElement === doc?.body) inputRef.current?.focus();
    });
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const { style: popupStyle, portal } = useAnchoredPopup({
        anchor: popupOpen ? addRow : null,
        popup: suggestBoxRef,
        onDismiss: () => {
            reopenOnFocus.current = true;
            focusInPopup.current = false;
            closePopup();
        },
        // Above the add row's padding box, inset like the row's content; below it when the
        // space above is too short to read and the space below is larger.
        place: (row, { height }) => {
            const rect = row.getBoundingClientRect();
            const above = Math.floor(rect.top - 8);
            const below = Math.floor(height - rect.bottom - 8);
            const down = above < 120 && below > above;
            return {
                left: rect.left,
                right: row.ownerDocument.documentElement.clientWidth - rect.right,
                ...(down ? { top: rect.bottom, boxShadow: '0 6px 18px rgba(0, 0, 0, 0.3)' } : { bottom: height - rect.top - row.clientTop }),
                maxHeight: `min(24rem, 50vh, ${Math.max(0, down ? below : above)}px)`,
            };
        },
    });
    const [newName, setNewName] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    // inline rename (issue #9) — WKWebView has no working window.prompt,
    // so the picker row swaps to an input: Enter/blur commit, Esc cancels
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const renameBusy = useRef(false);
    const renameEscaped = useRef(false);
    const activeList = serverLists.find((l) => l.id === activeListId);

    const startRename = () => {
        if (!activeList) return;
        renameEscaped.current = false;
        setRenameValue(activeList.name);
        setRenaming(true);
    };

    const commitRename = async () => {
        if (renameBusy.current) return;
        const name = renameValue.trim();
        if (!name || name === activeList?.name) {
            setRenaming(false);
            return;
        }
        renameBusy.current = true;
        try {
            const ok = await onRenameList(name);
            // rejected (duplicate name) → stay in edit so the user can fix it
            if (ok) setRenaming(false);
        } finally {
            renameBusy.current = false;
        }
    };
    const dragCode = useRef<string | null>(null);
    // ref mirrors the state — drop can fire in the same frame as the last
    // dragover, before React commits the state update
    const dropCodeRef = useRef<string | null>(null);
    const [dropCode, setDropCode] = useState<string | null>(null);
    // mini intraday sparklines per row — user-toggleable, persisted
    const [spark, setSpark] = useState(
        () => localStorage.getItem(SPARK_KEY) === '1',
    );
    // sort by live percent change (issue #1) — re-sorts every 10s while on
    const [sortMode, setSortMode] = useState<SortMode>('custom');
    // 排序模式（調整順序）：grip/上下移/拖曳僅在此模式；與 % 排序互斥
    const [arrange, setArrange] = useState(false);
    const [sortTick, setSortTick] = useState(0);
    useEffect(() => {
        if (sortMode === 'custom') return;
        const t = setInterval(() => setSortTick((v) => v + 1), 10000);
        return () => clearInterval(t);
    }, [sortMode]);
    const viewItems = useMemo(() => {
        if (sortMode === 'custom') return items;
        const sorted = [...items].sort((a, b) => pctOf(b) - pctOf(a));
        if (sortMode === 'asc') sorted.reverse();
        return sorted;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, sortMode, sortTick]);
    const setDropTarget = useCallback((code: string) => {
        dropCodeRef.current = code;
        setDropCode(code);
    }, []);

    const clearDragState = useCallback(() => {
        dragCode.current = null;
        dropCodeRef.current = null;
        setDropCode(null);
    }, []);

    // 換清單時退出排序模式並清掉拖曳殘留 — 殘留的 from/to code 若恰好也
    // 存在於新清單，會造成看不懂的 spurious reorder
    useEffect(() => {
        setArrange(false);
        setConfirmDelete(false);
        clearDragState();
    }, [activeListId, clearDragState]);

    // An Agent change waits until 調整順序 / inline rename / create is done.
    // busy: an add is resolving the code; confirmDelete: the second click
    // must still delete the list the user armed it on
    const editing = arrange || renaming || creating || busy || confirmDelete;
    useEffect(() => {
        if (!editing || !onHoldReload) return;
        onHoldReload(true);
        return () => onHoldReload(false);
    }, [editing, onHoldReload]);

    const handleRowDragStart = useCallback((code: string) => {
        if (arrange) dragCode.current = code;
    }, [arrange]);

    const handleDrop = useCallback(() => {
        const from = dragCode.current;
        const to = dropCodeRef.current;
        dragCode.current = null;
        dropCodeRef.current = null;
        setDropCode(null);
        if (from && to && from !== to) onReorder(from, to);
    }, [onReorder]);

    // 上移/下移 — same persisted onReorder path as drag-to-reorder
    const moveRow = useCallback(
        (code: string, dir: -1 | 1) => {
            const to = neighborCode(
                items.map((i) => i.contract.code),
                code,
                dir,
            );
            if (to) onReorder(code, to);
        },
        [items, onReorder],
    );

    const submit = async (picked?: ProductSuggestion) => {
        if (search.isComposing() || !search.isCurrent(renderedVersion) || activeListRef.current !== activeListId) return;
        if (busy || submitBusy.current || loading || !activeListId) return;
        const rawCode = input.trim().toUpperCase();
        const isDirectCode = /^[A-Z0-9]+$/.test(rawCode);
        if (!picked && searching && !isDirectCode && activeIdentity === null) return;
        const item = picked ?? suggestions[activeIndex];
        if (item && search.isStale()) {
            search.retry();
            return;
        }
        const code = item?.code ?? rawCode;
        if (!code || !item && !isDirectCode) return;
        search.clear();
        reopenOnFocus.current = false;
        const submitVersion = search.currentVersion();
        setAddError(false);
        submitBusy.current = true;
        setBusy(true);
        try {
            if (item) await onAdd(item.code, item.security_type, item.contract);
            else await onAdd(code);
            if (search.isCurrent(submitVersion) && activeListRef.current === activeListId) setInput('');
        } catch {
            if (search.isCurrent(submitVersion) && activeListRef.current === activeListId) setAddError(true);
        } finally {
            submitBusy.current = false;
            setBusy(false);
        }
    };

    const submitNewList = async () => {
        const name = newName.trim();
        if (!name || loading || loadError) return;
        try {
            await onCreateList(name);
            setCreating(false);
            setNewName('');
        } catch {
            // notified upstream
        }
    };

    return (
        <>
            <div className={styles.listPicker}>
                {creating ? (
                    <>
                        <input
                            autoFocus
                            className={styles.addInput}
                            placeholder='新清單名稱'
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submitNewList();
                                if (e.key === 'Escape') setCreating(false);
                            }}
                        />
                        <button
                            className={panel.btn}
                            onClick={submitNewList}
                        >
                            建立
                        </button>
                    </>
                ) : renaming ? (
                    <input
                        autoFocus
                        className={styles.addInput}
                        placeholder='清單名稱'
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename();
                            if (e.key === 'Escape') {
                                renameEscaped.current = true;
                                setRenaming(false);
                            }
                        }}
                        onBlur={() => {
                            if (renameEscaped.current) return;
                            void commitRename();
                        }}
                    />
                ) : (
                    <>
                        <select
                            className={styles.listSelect}
                            value={activeListId}
                            disabled={structureBusy}
                            onChange={(e) => {
                                setConfirmDelete(false);
                                onSelectList(e.target.value);
                            }}
                        >
                            {serverLists.map((l) => (
                                <option key={l.id} value={l.id}>
                                    {l.name}（{l.contracts.length}）
                                </option>
                            ))}
                        </select>
                        {onReload && (
                            <RefreshButton
                                label='重新讀取清單'
                                iconSize={12}
                                className={styles.reloadBtn}
                                loading={reloading}
                                disabled={structureBusy || arrange}
                                onClick={() => {
                                    setConfirmDelete(false);
                                    void onReload();
                                }}
                            />
                        )}
                        <button
                            className={styles.listBtn}
                            title='重新命名清單'
                            onClick={startRename}
                        >
                            <Pencil size={12} />
                        </button>
                        <button
                            className={`${styles.listBtn} ${
                                arrange ? styles.listBtnOn : ''
                            }`}
                            disabled={!arrange && (sortMode !== 'custom' || loading || loadError)}
                            title={
                                arrange
                                    ? '完成調整'
                                    : loading || loadError
                                      ? '清單尚未完整載入，請先重試'
                                    : sortMode !== 'custom'
                                      ? '依漲跌幅排序中無法調整順序 — 先切回自訂順序'
                                      : '調整順序（拖曳或上下移，存回伺服器）'
                            }
                            onClick={() => {
                                // 進入排序模式一律回到自訂順序（互斥）
                                if (!arrange) setSortMode('custom');
                                clearDragState();
                                setArrange((v) => !v);
                            }}
                        >
                            {arrange ? (
                                <Check size={12} />
                            ) : (
                                <GripVertical size={12} />
                            )}
                        </button>
                        <button
                            className={`${styles.listBtn} ${
                                sortMode !== 'custom' ? styles.listBtnOn : ''
                            }`}
                            disabled={arrange}
                            title={
                                arrange
                                    ? '調整順序中 — 先按完成'
                                    : sortMode === 'custom'
                                      ? '依漲跌幅排序'
                                      : sortMode === 'desc'
                                        ? '漲幅在前 — 點擊改跌幅在前'
                                        : '跌幅在前 — 點擊回自訂順序'
                            }
                            onClick={() =>
                                setSortMode((m) =>
                                    m === 'custom'
                                        ? 'desc'
                                        : m === 'desc'
                                          ? 'asc'
                                          : 'custom',
                                )
                            }
                        >
                            {sortMode === 'custom' ? (
                                <ArrowDownUp size={12} />
                            ) : sortMode === 'desc' ? (
                                <ArrowDown size={12} />
                            ) : (
                                <ArrowUp size={12} />
                            )}
                        </button>
                        <button
                            className={`${styles.listBtn} ${
                                spark ? styles.listBtnOn : ''
                            }`}
                            title={spark ? '關閉小線圖' : '顯示小線圖'}
                            onClick={() =>
                                setSpark((v) => {
                                    localStorage.setItem(
                                        SPARK_KEY,
                                        v ? '0' : '1',
                                    );
                                    return !v;
                                })
                            }
                        >
                            <TrendingUp size={12} />
                        </button>
                        <button
                            className={styles.listBtn}
                            title='建立新清單'
                            disabled={loading || loadError}
                            onClick={() => setCreating(true)}
                        >
                            <Plus size={12} />
                        </button>
                        <button
                            className={`${styles.listBtn} ${
                                confirmDelete ? styles.listBtnDanger : ''
                            }`}
                            title={
                                confirmDelete
                                    ? '再按一次確認刪除整個清單'
                                    : '刪除目前清單'
                            }
                            onClick={() => {
                                if (confirmDelete) {
                                    setConfirmDelete(false);
                                    void onDeleteList();
                                } else {
                                    setConfirmDelete(true);
                                    setTimeout(
                                        () => setConfirmDelete(false),
                                        2500,
                                    );
                                }
                            }}
                        >
                            {confirmDelete ? '確認?' : <Trash2 size={12} />}
                        </button>
                    </>
                )}
            </div>
            <div className={panel.panelBody}>
                <div className={styles.list}>
                    {loading && items.length === 0 && (
                        <AsyncStatus phase='loading' text='載入清單…' className={styles.loadingHint} />
                    )}
                    {!loading && loadError && (
                        <AsyncStatus phase='error' text='自選清單讀取或同步失敗。'
                            action={<button type="button" onClick={onRetryLoad}>重試</button>}
                            className={styles.loadingHint} />
                    )}
                    {!loading && !loadError && items.length === 0 && (
                        <AsyncStatus phase='empty' text='清單是空的 — 在下方輸入代碼加入'
                            className={styles.loadingHint} />
                    )}
                    {viewItems.map((item, idx) => (
                        <WatchRow
                            key={item.contract.code}
                            item={item}
                            selected={item.contract.code === selectedCode}
                            spark={spark}
                            arrange={arrange && !loading && !loadError}
                            canUp={idx > 0 && !loading && !loadError}
                            canDown={idx < viewItems.length - 1 && !loading && !loadError}
                            canRemove={!loading}
                            onMove={moveRow}
                            dropTarget={
                                arrange && item.contract.code === dropCode
                            }
                            onSelect={onSelect}
                            onRemove={onRemove}
                            onDragStart={handleRowDragStart}
                            onDragOver={setDropTarget}
                            onDrop={handleDrop}
                            onDragEnd={clearDragState}
                        />
                    ))}
                    {loading && items.length > 0 && (
                        <AsyncStatus phase='loading' text='載入其餘商品…' className={styles.loadingHint} />
                    )}
                </div>
            </div>
            <div ref={setAddRow} className={styles.addRow}>
                {popupOpen && portal(
                    <div ref={suggestBoxRef} className={styles.suggestBox} style={popupStyle} onFocus={() => { focusInPopup.current = true; }} onBlur={(e) => {
                        // A removed row blurs with no next target; only a real move elsewhere ends it.
                        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focusInPopup.current = false;
                    }} onKeyDown={(e) => {
                        // The popup sits at the end of the page: Tab order runs input → popup → add button.
                        if (e.key === 'Tab') {
                            const stops = [...e.currentTarget.querySelectorAll<HTMLElement>('summary, button:not([role=option])')];
                            const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
                            if (e.target !== edge) return;
                            e.preventDefault();
                            (e.shiftKey ? inputRef.current : addButtonRef.current)?.focus();
                            return;
                        }
                        // Expanded details handle their own Esc; anything else closes and returns to the input.
                        if (e.key !== 'Escape') return;
                        e.preventDefault();
                        inputRef.current?.focus();
                        closePopup();
                    }}>
                        {suggestions.length > 0 && <div id={listId} role='listbox' aria-label='搜尋結果'>
                        {suggestions.map((s, index) => {
                            const identity = suggestionIdentities[index]!;
                            return (
                                <ProductSuggestionRow
                                    key={identity}
                                    item={s}
                                    id={optionId(listId, identity)}
                                    active={index === activeIndex}
                                    className={styles.suggestRow}
                                    disabled={busy || loading || !activeListId}
                                    rowRef={(node) => { if (node) suggestRowRefs.current.set(identity, node); else suggestRowRefs.current.delete(identity); }}
                                    onSelect={() => submit(s)}
                                />
                            );
                        })}
                        </div>}
                        <ProductSearchDetails item={suggestions[activeIndex]} onToggle={(details) => {
                            // Opening adds content below the rows; bring it into the popup's view.
                            if (details.open) details.scrollIntoView?.({ block: 'nearest' });
                        }} />
                        {isTauri && <div role='status' className={styles.loadingHint}>原生版官方名稱更新未啟用，使用券商與內建名稱</div>}
                        {(searchError || searching || addError) && <AsyncStatus phase={searchError || addError ? 'error' : 'loading'}
                            text={addError ? '加入自選失敗，可重新搜尋' : searchError ? '搜尋失敗，可重試' : '搜尋中…'}
                            className={styles.loadingHint}
                            action={searchError || addError ? <button type='button' onMouseDown={(event) => event.preventDefault()} onClick={() => {
                                setAddError(false);
                                search.retry();
                                // The button disappears with the error; keep typing in the input.
                                inputRef.current?.focus();
                            }}>{addError ? '重新搜尋' : '重試'}</button> : undefined} />}
                    </div>,
                )}
                <input
                    ref={inputRef}
                    className={styles.addInput}
                    placeholder='股票、期貨或指數（如 台積電期）'
                    role='combobox'
                    aria-autocomplete='list'
                    aria-expanded={suggestions.length > 0}
                    aria-controls={suggestions.length > 0 ? listId : undefined}
                    aria-activedescendant={activeIndex >= 0 && suggestionIdentities[activeIndex]
                        ? optionId(listId, suggestionIdentities[activeIndex]!) : undefined}
                    disabled={loading || !activeListId}
                    value={input}
                    // Rows cleared by an outside press come back when the input is focused again.
                    onFocus={() => {
                        focusInPopup.current = false;
                        if (!reopenOnFocus.current) return;
                        reopenOnFocus.current = false;
                        if (input.trim()) search.retry();
                    }}
                    onCompositionStart={() => {
                        search.startComposition();
                        setAddError(false);
                    }}
                    onCompositionEnd={(e) => {
                        search.endComposition();
                        setInput(e.currentTarget.value);
                    }}
                    onChange={(e) => {
                        reopenOnFocus.current = false;
                        search.change(e.target.value);
                        setInput(e.target.value);
                        setAddError(false);
                    }}
                    onKeyDown={(e) => {
                        if (search.isComposing() || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                        if (e.key === 'ArrowDown' && suggestions.length > 0) {
                            e.preventDefault();
                            setActiveIdentity(suggestionIdentities[(activeIndex + 1) % suggestions.length]!);
                        }
                        if (e.key === 'ArrowUp' && suggestions.length > 0) {
                            e.preventDefault();
                            setActiveIdentity(suggestionIdentities[activeIndex < 0 ? suggestions.length - 1 : (activeIndex - 1 + suggestions.length) % suggestions.length]!);
                        }
                        if (e.key === 'Enter') {
                            void submit();
                        }
                        if (e.key === 'Escape') closePopup();
                        // The popup is portaled to the end of the page; Tab reaches its details and retry first.
                        if (e.key === 'Tab' && !e.shiftKey && popupOpen) {
                            const next = suggestBoxRef.current?.querySelector<HTMLElement>('summary, button:not([role=option])');
                            if (next) {
                                e.preventDefault();
                                next.focus();
                            }
                        }
                    }}
                />
                <button ref={addButtonRef} className={panel.btn} onClick={() => void submit()} disabled={busy || loading || !activeListId}>
                    {busy ? '…' : '+'}
                </button>
            </div>
        </>
    );
}
