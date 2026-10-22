// src/components/command-palette.tsx — Cmd+K symbol jump + panel commands

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { primeContract } from '../lib/contracts-cache';
import { isTauri } from '../lib/runtime';
import type { ProductSuggestion } from '../lib/product-search';
import { BLOCK_META, type BlockType } from '../lib/workspace';
import type { SecurityType } from '../lib/types/contract';
import * as styles from './command-palette.css';
import { resultDetail, resultMeta } from './search-surface.css';
import { AsyncStatus } from './async-status';
import { ProductSearchDetails } from './product-search-details';
import { optionId, ProductSuggestionRow, productIdentity, SearchOption } from './product-suggestion-row';
import { useProductSearch } from '../hooks/use-product-search';

const PANEL_TYPES = Object.keys(BLOCK_META) as BlockType[];
const PANEL_MATCH_LIMIT = 4;

export function CommandPalette({
    open,
    onClose,
    onJump,
    onAddPanel,
}: {
    open: boolean;
    onClose: () => void;
    onJump: (code: string, securityType?: SecurityType) => Promise<unknown>;
    onAddPanel?: (type: BlockType) => void;
}) {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const search = useProductSearch(value, { limit: 8, enabled: open, progressive: true });
    const { suggestions, searching, searchError, activeIdentity, setActiveIdentity } = search;
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const pointerPosition = useRef<{ x: number; y: number } | null>(null);

    const selectWithPointer = (identity: string, event: MouseEvent<HTMLButtonElement>) => {
        const previous = pointerPosition.current;
        if (previous?.x === event.clientX && previous.y === event.clientY) return;
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        setActiveIdentity(identity);
    };
    const rowRef = (identity: string) => (node: HTMLButtonElement | null) => {
        if (node) rowRefs.current.set(identity, node);
        else rowRefs.current.delete(identity);
    };

    const closePalette = () => {
        search.cancel();
        onClose();
    };

    useEffect(() => {
        if (open) {
            setValue('');
            setError(false);
            const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
            return () => clearTimeout(focusTimer);
        }
    }, [open]);

    const panelMatches = useMemo(() => {
        if (!onAddPanel) return [];
        const query = value.trim().toLowerCase();
        if (!query) return [];
        return PANEL_TYPES.filter((type) => {
            const meta = BLOCK_META[type];
            return (
                meta.label.toLowerCase().includes(query) ||
                meta.description.toLowerCase().includes(query)
            );
        }).slice(0, PANEL_MATCH_LIMIT);
    }, [onAddPanel, value]);

    const rowIdentities = useMemo(() => [
        ...suggestions.map(productIdentity), ...panelMatches.map((type) => `panel:${type}`),
    ], [suggestions, panelMatches]);
    useEffect(() => {
        setActiveIdentity((current) => current && rowIdentities.includes(current) ? current : null);
    }, [rowIdentities]);
    const activeIndex = Math.max(0, rowIdentities.indexOf(activeIdentity ?? ''));
    const rowCount = rowIdentities.length;
    const renderedVersion = search.renderedVersion;
    const revealActiveRow = useCallback(() => {
        const identity = rowIdentities[activeIndex];
        const row = identity && rowRefs.current.get(identity);
        if (!open || !row) return;
        row.scrollIntoView?.({ block: 'nearest' });
    }, [open, activeIndex, rowIdentities]);
    useEffect(() => {
        revealActiveRow();
        if (!open || typeof window === 'undefined') return;
        window.addEventListener('resize', revealActiveRow);
        return () => window.removeEventListener('resize', revealActiveRow);
    }, [open, revealActiveRow]);

    if (!open) return null;

    const addPanelAt = (index: number) => {
        const type = panelMatches[index];
        if (!type) return;
        search.cancel();
        onAddPanel?.(type);
        onClose();
    };

    const submit = async (picked?: ProductSuggestion) => {
        if (search.isComposing() || !search.isCurrent(renderedVersion)) return;
        // active row past the product suggestions → it's a panel command
        if (!picked && activeIndex >= suggestions.length && rowCount > 0) {
            addPanelAt(activeIndex - suggestions.length);
            return;
        }
        const item = picked ?? suggestions[activeIndex];
        if (item && search.isStale()) {
            search.retry();
            return;
        }
        const code = item?.code ?? value.trim().toUpperCase();
        if (!code || busy) return;
        // 名稱查詢待決時不可把上一輪結果當成本輪選取；直接代碼仍可送查詢。
        if (!item && searching && !/^[A-Z0-9]+$/.test(code)) return;
        search.cancel();
        const submitVersion = search.currentVersion();
        setBusy(true);
        setError(false);
        try {
            if (item?.contract) primeContract(item.contract);
            await onJump(code, item?.security_type);
            if (search.isCurrent(submitVersion)) onClose();
        } catch {
            if (search.isCurrent(submitVersion)) setError(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={closePalette}
            onMouseMove={(event) => { pointerPosition.current = { x: event.clientX, y: event.clientY }; }}>
            <div className={styles.box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
                if (e.key !== 'Escape' || search.isComposing() || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                // Claim the press that closes the palette: focus falls back to the
                // page, where an unclaimed Esc would arm Esc×2 cancel-all.
                e.preventDefault();
                closePalette();
            }}>
                <input
                    ref={inputRef}
                    className={styles.input}
                    placeholder='輸入代碼跳轉商品（2330、TXFR1…）'
                    role='combobox'
                    aria-autocomplete='list'
                    aria-expanded={rowCount > 0}
                    aria-controls={rowCount > 0 ? listId : undefined}
                    aria-activedescendant={rowCount > 0 ? optionId(listId, rowIdentities[activeIndex]!) : undefined}
                    value={value}
                    onCompositionStart={() => {
                        search.startComposition();
                        setError(false);
                    }}
                    onCompositionEnd={(e) => {
                        search.endComposition();
                        setValue(e.currentTarget.value);
                    }}
                    onChange={(e) => {
                        search.change(e.target.value);
                        setValue(e.target.value);
                        setError(false);
                    }}
                    onKeyDown={(e) => {
                        if (search.isComposing() || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                        if (e.key === 'ArrowDown' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIdentity(rowIdentities[(activeIndex + 1) % rowCount]!);
                        }
                        if (e.key === 'ArrowUp' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIdentity(rowIdentities[(activeIndex - 1 + rowCount) % rowCount]!);
                        }
                        if (e.key === 'Enter') void submit();
                    }}
                />
                {rowCount > 0 && (
                    <div className={styles.results}>
                        <div id={listId} role='listbox' aria-label='搜尋結果'>
                        {suggestions.map((item, index) => {
                            const identity = productIdentity(item);
                            return (
                                <ProductSuggestionRow
                                    key={identity}
                                    item={item}
                                    id={optionId(listId, identity)}
                                    active={index === activeIndex}
                                    className={styles.result}
                                    rowRef={rowRef(identity)}
                                    onMouseMove={(event) => selectWithPointer(identity, event)}
                                    onSelect={() => submit(item)}
                                />
                            );
                        })}
                        {panelMatches.map((type, index) => {
                            const identity = `panel:${type}`;
                            return (
                                <SearchOption
                                    key={identity}
                                    id={optionId(listId, identity)}
                                    active={suggestions.length + index === activeIndex}
                                    className={styles.result}
                                    rowRef={rowRef(identity)}
                                    onMouseMove={(event) => selectWithPointer(identity, event)}
                                    onSelect={() => addPanelAt(index)}
                                    title={`新增面板：${BLOCK_META[type].label} · ${BLOCK_META[type].description}`}
                                >
                                    <span className={styles.panelIcon} aria-hidden>
                                        ＋
                                    </span>
                                    <span className={styles.panelName}>
                                        新增面板：{BLOCK_META[type].label}
                                    </span>
                                    <span className={resultMeta}>
                                        <span className={resultDetail}>{BLOCK_META[type].description}</span>
                                    </span>
                                </SearchOption>
                            );
                        })}
                        </div>
                        {isTauri && <div role='status' className={styles.hint}>原生版官方名稱更新未啟用，使用券商與內建名稱</div>}
                    </div>
                )}
                <ProductSearchDetails item={suggestions[activeIndex]} onToggle={() => revealActiveRow()} />
                <div className={styles.hint}>
                    <AsyncStatus phase={busy ? 'loading' : error || searchError ? 'error' : searching ? 'loading' : 'idle'}
                        text={busy ? '查詢商品中…' : error ? '找不到此商品代碼' : searchError ? '搜尋失敗，可重試' : searching ? suggestions.length ? '正在補齊關聯商品…' : '搜尋中…' : 'Enter 跳轉 · Esc 關閉'}
                        action={error || searchError ? <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => {
                            if (search.isComposing()) return;
                            setError(false);
                            search.retry();
                            // The button disappears with the error; keep typing in the input.
                            inputRef.current?.focus();
                        }}>{error ? '重新搜尋' : '重試'}</button> : undefined}
                        className={error || searchError ? styles.err : ''} />
                    <span>⌘K</span>
                </div>
            </div>
        </div>
    );
}
