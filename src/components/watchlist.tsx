// src/components/watchlist.tsx — server-backed editable watchlists.
// Pick a list, add symbols (type auto-detected), hover a row to remove,
// drag rows to reorder (persisted to the server).

import { usHaltLabel, useUsHalt } from '../lib/us/us-halts';
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
import { contractLinkKey } from '../lib/contract-key';
import { fmtUsPrice, usPriceDecimals } from '../lib/us/decimal';
import type { UsSnapshot } from '../lib/us/us-history';
import { usSessionViewFor } from '../hooks/use-us-snapshot';
import { useUsMarketClock } from '../hooks/use-us-market-clock';
import { usExtTitle, usMarketPhase, type UsClock, type UsExtLine } from '../lib/us/us-session-view';
import { UsSessionIcon } from './us-session-icon';
import type { SseTick } from '../lib/types/market';
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

const isUs = (contract: ContractInfo) => contract.region === 'US';

/**
 * 美股自選列（SDK 1.8 tick_stk_us，store key `US:CODE`）：主行是一般盤價與對參考價的
 * 漲跌（盤前是前一日收盤與它的漲跌），副行是盤前／盤後價（見 us-session-view）。
 * 和報價板同一個 usSessionViewFor。沒有任何價格時 main 為 null（畫面顯示「參考」）。
 */
export function usRowView(
    contract: ContractInfo,
    tick: SseTick | undefined,
    snap: UsSnapshot | null | undefined,
    now: UsClock,
) {
    return usSessionViewFor(contract, tick, snap ?? null, now);
}

// live percent change for sorting — quote first, snapshot fallback
// 美股：用主行（一般盤）的漲跌幅，盤前盤後價不影響排序；沒有價格就是 0
function pctOf(item: WatchItem): number {
    if (isUs(item.contract)) {
        return usRowView(item.contract, getQuote(contractLinkKey(item.contract))?.tick, item.usSnapshot, usMarketPhase(Date.now())).main?.pct ?? 0;
    }
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
    // 連動 key：台股裸代碼、美股 `US:CODE`（美股 T 不會和任何台股代碼撞名）
    const rowKey = contractLinkKey(item.contract);
    const us = isUs(item.contract);
    const halt = useUsHalt(us ? item.contract : null);
    const quote = useQuote(rowKey);
    const tick = quote?.tick;
    const index = quote?.index;
    // 美股：主行一般盤價（即時優先，盤前或沒有即時成交時用快照），副行盤前／盤後
    const usClock = useUsMarketClock();
    const usView = us ? usRowView(item.contract, tick, item.usSnapshot, usClock) : null;
    const usQuote = usView?.main ?? null;

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
    // 美股沒有漲跌停（limit_up／limit_down 為 0），不亮燈
    const atLimit = us ? null : limitStateOf(item.contract, limitPx);
    const limitLabel = atLimit === 'up' ? '漲停' : atLimit === 'down' ? '跌停' : '';
    // 亮燈樣式（設定 → 外觀，全域）；「不標示」時 lit 為 null
    const limitStyle = useLimitStyle();
    const lit = limitStyle === 'none' ? null : atLimit;
    // 小線圖模式＋數字區色塊：等寬色塊放不下小線圖，停板列收起小線圖
    //（鎖停板的走勢本來就是一條平線），色塊延伸到小線圖欄、位置與其他
    // 停板列一致
    const blockWide = spark && lit !== null && limitStyle === 'block';
    const priceDir = us
        ? usQuote?.chg === undefined || usQuote.chg === 0 ? 'flat' : usQuote.chg > 0 ? 'up' : 'down'
        : dir;
    // the flash overlay is re-keyed by flashSeq so the animation replays on
    // every real deal — the row itself stays mounted (hover state survives)
    // 美股：只在主行（一般盤價）變動時閃，零股、盤前盤後成交不閃
    const usFlash = useMainPriceFlash(us ? usQuote?.price : undefined);
    const flashSeq = us ? usFlash.seq : quote?.flashSeq;
    const flashDir = us
        ? usFlash.seq ? usFlash.dir : null
        : !quote?.flashSeq
        ? null
        : quote.lastDir === -1
          ? ('down' as const)
          : ('up' as const);

    return (
        <div
            data-code={item.contract.code}
            data-key={rowKey}
            data-region={us ? 'US' : undefined}
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
                onDragStart(rowKey);
            }}
            // 排序模式外不接任何拖放（外部拖進來的檔案/文字不該變 drop
            // target，更不該觸發 handleDrop）
            onDragOver={(e) => {
                if (!arrange) return;
                e.preventDefault();
                onDragOver(rowKey);
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
                    key={flashSeq}
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
                {us && (
                    <span className={styles.usBadge} title='美股，以美元報價'>
                        美股
                    </span>
                )}
                {halt && (
                    <span className={styles.usHalt} title={usHaltLabel(halt)}>
                        停牌
                    </span>
                )}
            </span>
            {spark && us && <span className={styles.sparkCell} />}
            {spark && !us && !blockWide && (
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
                {us ? (
                    usQuote ? (
                        <>
                            <span className={`${styles.price} ${panel.dirText[priceDir]}`}>
                                {fmtUsPrice(usQuote.price)}
                            </span>
                            {usQuote.prevClose ? (
                                // 前一日收盤、當天漲跌沒有意義：標「昨收」（同一格，列高不變）
                                <span className={`${styles.change} ${styles.usPrevClose}`} title='前一交易日一般盤收盤'>
                                    昨收
                                </span>
                            ) : (
                                <span className={`${styles.change} ${panel.dirText[priceDir]}`}>
                                    {fmtSigned(usQuote.chg, usPriceDecimals(usQuote.price))} {fmtPct(usQuote.pct)}
                                </span>
                            )}
                        </>
                    ) : (
                        <>
                            <span
                                className={`${styles.price} ${styles.usReference}`}
                                title={item.contract.reference_date
                                    ? `前一日參考價（${item.contract.reference_date}）`
                                    : '前一日參考價'}
                            >
                                {item.contract.us_reference
                                    ? `參考 ${fmtUsPrice(item.contract.us_reference)}`
                                    : '參考 —'}
                            </span>
                            <span className={styles.change}>USD</span>
                        </>
                    )
                ) : (
                    <>
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
                    </>
                )}
            </span>
            <span className={`${styles.name} ${styles.firstCol}`}>
                {item.contract.name}
            </span>
            {/* 美股一律保留副行高度：盤前／盤後出現或清掉時列高不變，清單不會跳 */}
            {us && <UsExtRow ext={usView?.ext ?? null} />}
            {arrange ? (
                <span className={styles.moveCol}>
                    <button
                        className={styles.moveBtn}
                        title='上移'
                        disabled={!canUp}
                        onClick={(e) => {
                            e.stopPropagation();
                            onMove(rowKey, -1);
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
                            onMove(rowKey, 1);
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
                        onRemove(rowKey);
                    }}
                >
                    <X size={10} />
                </button>
            )}
        </div>
    );
});

/** 價格變動時遞增（第一次拿到價格不算）；美股自選列用來只依主行價格閃爍 */
function useMainPriceFlash(price: number | undefined): { seq: number; dir: 'up' | 'down' } {
    const prev = useRef(price);
    const [flash, setFlash] = useState<{ seq: number; dir: 'up' | 'down' }>({ seq: 0, dir: 'up' });
    useEffect(() => {
        const before = prev.current;
        prev.current = price;
        if (before === undefined || price === undefined || before === price) return;
        setFlash((f) => ({ seq: f.seq + 1, dir: price > before ? 'up' : 'down' }));
    }, [price]);
    return flash;
}

/** 自選列的盤前／盤後副行（小字、同一套漲跌顏色；盤後結束轉灰） */
function UsExtRow({ ext }: { ext: UsExtLine | null }) {
    if (!ext) return <span className={styles.usExt} aria-hidden='true' data-us-ext='none'>{'\u00a0'}</span>;
    const dir = ext.chg === undefined || ext.chg === 0 ? 'flat' : ext.chg > 0 ? 'up' : 'down';
    const title = usExtTitle(ext, fmtUsPrice);
    return (
        <span
            className={`${styles.usExt} ${ext.closed ? styles.usExtClosed : panel.dirText[dir]}`}
            data-us-ext={ext.closed ? 'closed' : ext.session}
            title={title}
        >
            <UsSessionIcon session={ext.session} size={11} title={title} className={styles.usExtIcon} />
            <span className={styles.usExtPrice}>{fmtUsPrice(ext.price)}</span>
            <span>{fmtSigned(ext.chg, usPriceDecimals(ext.price))} {fmtPct(ext.pct)}</span>
        </span>
    );
}

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
    /** 目前選取商品的連動 key（contractLinkKey：台股裸代碼、美股 `US:CODE`） */
    selectedCode: string | null;
    onSelect: (c: ContractInfo) => void;
    onAdd: (
        code: string,
        type?: SecurityType,
        resolved?: ContractInfo,
    ) => Promise<unknown>;
    /** key：contractLinkKey */
    onRemove: (key: string) => void;
    /** key：contractLinkKey */
    onReorder: (fromKey: string, toKey: string) => void;
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
                items.map((i) => contractLinkKey(i.contract)),
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
            // 美股建議以 `US:CODE` 加入（不帶型別，避免以 region=TW 查詢）
            if (item?.region === 'US') await onAdd(item.key ?? `US:${item.code}`, undefined, item.contract);
            else if (item) await onAdd(item.code, item.security_type, item.contract);
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
                            key={contractLinkKey(item.contract)}
                            item={item}
                            selected={contractLinkKey(item.contract) === selectedCode}
                            spark={spark}
                            arrange={arrange && !loading && !loadError}
                            canUp={idx > 0 && !loading && !loadError}
                            canDown={idx < viewItems.length - 1 && !loading && !loadError}
                            canRemove={!loading}
                            onMove={moveRow}
                            dropTarget={
                                arrange && contractLinkKey(item.contract) === dropCode
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
                    placeholder='股票、期貨、指數或美股（如 台積電期、AAPL、蘋果）'
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
