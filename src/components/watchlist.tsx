// src/components/watchlist.tsx — server-backed editable watchlists.
// Pick a list, add symbols (type auto-detected), hover a row to remove.

import { useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import type { WatchItem } from '../hooks/use-watchlist';
import type { ServerWatchlist } from '../lib/shioaji';
import type { ContractInfo } from '../lib/types/contract';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './watchlist.css';

function WatchRow({
    item,
    selected,
    onSelect,
    onRemove,
}: {
    item: WatchItem;
    selected: boolean;
    onSelect: (c: ContractInfo) => void;
    onRemove: (code: string) => void;
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
    const pct = tick?.pct_chg
        ? Number(tick.pct_chg)
        : chg !== undefined && ref
          ? (chg / ref) * 100
          : undefined;

    const dir = chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    // re-key by flashSeq so the flash animation replays only on real deals
    const flashDir =
        !quote?.flashSeq ? 'none' : quote.lastDir === -1 ? 'down' : 'up';

    return (
        <div
            key={`${item.contract.code}-${quote?.flashSeq ?? 0}`}
            className={`${styles.row[selected ? 'selected' : 'normal']} ${styles.flash[flashDir]}`}
            onClick={() => onSelect(item.contract)}
        >
            <span className={styles.code}>{item.contract.code}</span>
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
                ✕
            </button>
        </div>
    );
}

export function Watchlist({
    items,
    selectedCode,
    onSelect,
    onAdd,
    onRemove,
    serverLists,
    activeListId,
    onSelectList,
    onCreateList,
    onDeleteList,
    loading,
}: {
    items: WatchItem[];
    selectedCode: string | null;
    onSelect: (c: ContractInfo) => void;
    onAdd: (code: string) => Promise<unknown>;
    onRemove: (code: string) => void;
    serverLists: ServerWatchlist[];
    activeListId: string;
    onSelectList: (id: string) => void;
    onCreateList: (name: string) => Promise<unknown>;
    onDeleteList: () => Promise<unknown>;
    loading: boolean;
}) {
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);

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
                            title='建立新清單'
                            onClick={() => setCreating(true)}
                        >
                            ＋
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
                            {confirmDelete ? '確認?' : '🗑'}
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
                    {items.map((item) => (
                        <WatchRow
                            key={item.contract.code}
                            item={item}
                            selected={item.contract.code === selectedCode}
                            onSelect={onSelect}
                            onRemove={onRemove}
                        />
                    ))}
                </div>
            </div>
            <div className={styles.addRow}>
                <input
                    className={styles.addInput}
                    placeholder='代碼（自動判別股/期/指數）'
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
                <button className={panel.btn} onClick={submit} disabled={busy}>
                    {busy ? '…' : '+'}
                </button>
            </div>
        </>
    );
}
