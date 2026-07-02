// src/components/watchlist.tsx — server-backed editable watchlists.
// Pick a list, add symbols (type auto-detected), hover a row to remove,
// drag rows to reorder (persisted to the server).

import {
    ArrowDown,
    ArrowDownUp,
    ArrowUp,
    Pencil,
    Plus,
    TrendingUp,
    Trash2,
    X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import type { WatchItem } from '../hooks/use-watchlist';
import type { ServerWatchlist } from '../lib/shioaji';
import { getQuote } from '../lib/stream';
import type { ContractInfo } from '../lib/types/contract';
import {
    loadStockIndex,
    searchStocks,
    type StockMeta,
} from '../lib/stock-index';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { Sparkline } from './sparkline';
import * as panel from './panel.css';
import * as styles from './watchlist.css';

const SPARK_KEY = 'sj-pro-watchlist-spark';

type SortMode = 'custom' | 'desc' | 'asc';

// live percent change for sorting — quote first, snapshot fallback
function pctOf(item: WatchItem): number {
    const q = getQuote(item.contract.code);
    const ref = item.contract.reference;
    const close = q?.tick ? Number(q.tick.close) : item.snapshot?.close;
    if (close !== undefined && ref) return ((close - ref) / ref) * 100;
    return item.snapshot?.change_rate ?? 0;
}

const WatchRow = memo(function WatchRow({
    item,
    selected,
    dropTarget,
    spark,
    onSelect,
    onRemove,
    onDragStart,
    onDragOver,
    onDrop,
}: {
    item: WatchItem;
    selected: boolean;
    dropTarget: boolean;
    spark: boolean;
    onSelect: (c: ContractInfo) => void;
    onRemove: (code: string) => void;
    onDragStart: (code: string) => void;
    onDragOver: (code: string) => void;
    onDrop: () => void;
}) {
    const quote = useQuote(item.contract.code);
    const tick = quote?.tick;

    const close = tick ? Number(tick.close) : item.snapshot?.close;
    const ref = item.contract.reference;
    const chg = tick?.price_chg
        ? Number(tick.price_chg)
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
    // the flash overlay is re-keyed by flashSeq so the animation replays on
    // every real deal — the row itself stays mounted (hover state survives)
    const flashDir = !quote?.flashSeq
        ? null
        : quote.lastDir === -1
          ? ('down' as const)
          : ('up' as const);

    return (
        <div
            className={`${styles.row[selected ? 'selected' : 'normal']} ${
                spark ? styles.rowSparkCols : ''
            } ${dropTarget ? styles.dropTarget : ''}`}
            draggable
            onClick={() => onSelect(item.contract)}
            onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(item.contract.code);
            }}
            onDragOver={(e) => {
                e.preventDefault();
                onDragOver(item.contract.code);
            }}
            onDrop={(e) => {
                e.preventDefault();
                onDrop();
            }}
        >
            {flashDir && (
                <span
                    key={quote?.flashSeq}
                    className={styles.flashOverlay[flashDir]}
                />
            )}
            <span className={styles.code}>{item.contract.code}</span>
            {spark && (
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
            <span className={`${styles.price} ${panel.dirText[dir]}`}>
                {fmtPrice(close)}
            </span>
            <span className={styles.name}>{item.contract.name}</span>
            <span className={`${styles.change} ${panel.dirText[dir]}`}>
                {fmtSigned(chg)} {fmtPct(pct)}
            </span>
            <button
                className={styles.rowRemove}
                title='從清單移除'
                onClick={(e) => {
                    e.stopPropagation();
                    onRemove(item.contract.code);
                }}
            >
                <X size={10} />
            </button>
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
}: {
    items: WatchItem[];
    selectedCode: string | null;
    onSelect: (c: ContractInfo) => void;
    onAdd: (code: string) => Promise<unknown>;
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
}) {
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState(false);
    // 中文股名搜尋 (issue #2) — index loads lazily on first non-empty input
    const [stockIndex, setStockIndex] = useState<StockMeta[] | null>(null);
    const [suggestions, setSuggestions] = useState<StockMeta[]>([]);
    const updateSuggestions = (value: string) => {
        if (!value.trim()) {
            setSuggestions([]);
            return;
        }
        if (!stockIndex) {
            loadStockIndex()
                .then((idx) => {
                    setStockIndex(idx);
                    setSuggestions(searchStocks(idx, value));
                })
                .catch(() => undefined);
            return;
        }
        setSuggestions(searchStocks(stockIndex, value));
    };
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
    const setDropTarget = (code: string) => {
        dropCodeRef.current = code;
        setDropCode(code);
    };

    const handleDrop = () => {
        const from = dragCode.current;
        const to = dropCodeRef.current;
        dragCode.current = null;
        dropCodeRef.current = null;
        setDropCode(null);
        if (from && to && from !== to) onReorder(from, to);
    };

    const submit = async () => {
        const code = input.trim().toUpperCase();
        if (!code || busy) return;
        setBusy(true);
        try {
            await onAdd(code);
            setInput('');
        } catch {
            // keep input so user can fix typo
        } finally {
            setBusy(false);
        }
    };

    const submitNewList = async () => {
        const name = newName.trim();
        if (!name) return;
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
                        <button
                            className={styles.listBtn}
                            title='重新命名清單'
                            onClick={startRename}
                        >
                            <Pencil size={12} />
                        </button>
                        <button
                            className={`${styles.listBtn} ${
                                sortMode !== 'custom' ? styles.listBtnOn : ''
                            }`}
                            title={
                                sortMode === 'custom'
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
                        <div className={styles.loadingHint}>載入清單…</div>
                    )}
                    {!loading && items.length === 0 && (
                        <div className={styles.loadingHint}>
                            清單是空的 — 在下方輸入代碼加入
                        </div>
                    )}
                    {viewItems.map((item) => (
                        <WatchRow
                            key={item.contract.code}
                            item={item}
                            selected={item.contract.code === selectedCode}
                            spark={spark}
                            dropTarget={
                                sortMode === 'custom' &&
                                item.contract.code === dropCode
                            }
                            onSelect={onSelect}
                            onRemove={onRemove}
                            onDragStart={(code) => {
                                // dragging only reorders the custom order
                                if (sortMode === 'custom') {
                                    dragCode.current = code;
                                }
                            }}
                            onDragOver={setDropTarget}
                            onDrop={handleDrop}
                        />
                    ))}
                </div>
            </div>
            <div className={styles.addRow}>
                {suggestions.length > 0 && (
                    <div className={styles.suggestBox}>
                        {suggestions.map((s) => (
                            <button
                                key={s.code}
                                className={styles.suggestRow}
                                onClick={async () => {
                                    setSuggestions([]);
                                    setInput('');
                                    setBusy(true);
                                    try {
                                        await onAdd(s.code);
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                            >
                                <span className={styles.suggestCode}>
                                    {s.code}
                                </span>
                                <span className={styles.suggestName}>
                                    {s.name}
                                </span>
                                <span className={styles.suggestCat}>
                                    {s.category}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
                <input
                    className={styles.addInput}
                    placeholder='代碼或股名（如 2330 / 台積電）'
                    value={input}
                    onChange={(e) => {
                        setInput(e.target.value);
                        updateSuggestions(e.target.value);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            setSuggestions([]);
                            submit();
                        }
                        if (e.key === 'Escape') setSuggestions([]);
                    }}
                />
                <button className={panel.btn} onClick={submit} disabled={busy}>
                    {busy ? '…' : '+'}
                </button>
            </div>
        </>
    );
}
