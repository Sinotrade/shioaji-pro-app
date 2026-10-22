// src/components/command-palette.tsx — Cmd+K symbol jump + panel commands

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { primeContract } from '../lib/contracts-cache';
import { isTauri } from '../lib/runtime';
import {
    searchProducts,
    type ProductSuggestion,
} from '../lib/product-search';
import { BLOCK_META, type BlockType } from '../lib/workspace';
import type { SecurityType } from '../lib/types/contract';
import * as styles from './command-palette.css';
import { AsyncStatus } from './async-status';
import { getProductCatalogVersion, useProductCatalogVersion } from '../lib/product-catalog-version';
import { useProductNamesVersion } from '../hooks/use-product-names-version';
import { getEtfNamesVersion } from '../lib/etf-runtime-catalog';
import { ProductBadge } from './product-badge';
import { ProductSearchDetails } from './product-search-details';
import { PRODUCT_SEARCH_DEBOUNCE_MS } from '../lib/search-request';
import { PRODUCT_BADGES, productBadgeType, productDetailText } from '../lib/product-badge-presentation';

const PANEL_TYPES = Object.keys(BLOCK_META) as BlockType[];
const PANEL_MATCH_LIMIT = 4;
const productIdentity = (item: ProductSuggestion) => JSON.stringify([item.security_type, item.exchange, item.code]);

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
    const [searchError, setSearchError] = useState(false);
    const [searching, setSearching] = useState(false);
    const [searchRetry, setSearchRetry] = useState(0);
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    const [activeIdentity, setActiveIdentity] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef(new Map<string, HTMLButtonElement>());
    const composing = useRef(false);
    const queryVersion = useRef(0);
    const searchController = useRef<AbortController | null>(null);
    const pointerPosition = useRef<{ x: number; y: number } | null>(null);
    const catalogVersion = useProductCatalogVersion();
    const namesVersion = useProductNamesVersion();
    const suggestionScope = useRef('');
    const currentScope = () => JSON.stringify([getProductCatalogVersion(), getEtfNamesVersion()]);

    const selectWithPointer = (identity: string, event: MouseEvent<HTMLButtonElement>) => {
        const previous = pointerPosition.current;
        if (previous?.x === event.clientX && previous.y === event.clientY) return;
        pointerPosition.current = { x: event.clientX, y: event.clientY };
        setActiveIdentity(identity);
    };

    const cancelSearch = () => {
        queryVersion.current += 1;
        searchController.current?.abort();
        searchController.current = null;
        setSearching(false);
    };
    const closePalette = () => {
        cancelSearch();
        onClose();
    };

    useEffect(() => {
        if (open) {
            composing.current = false;
            queryVersion.current += 1;
            setValue('');
            setError(false);
            setSuggestions([]);
            setActiveIdentity(null);
            const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
            return () => {
                clearTimeout(focusTimer);
                // Parent-driven close/unmount must also invalidate a pending jump.
                queryVersion.current += 1;
            };
        }
    }, [open]);

    useEffect(() => {
        if (!open || !value.trim() || composing.current) {
            setSuggestions([]);
            setSearchError(false);
            setSearching(open && composing.current && !!value.trim());
            return;
        }
        let active = true;
        let completed = false;
        const controller = new AbortController();
        searchController.current = controller;
        const requestVersion = ++queryVersion.current;
        const requestScope = currentScope();
        const isCurrent = () => active && !controller.signal.aborted && requestVersion === queryVersion.current
            && requestScope === currentScope() && !composing.current;
        setSuggestions([]);
        setActiveIdentity(null);
        setSearchError(false);
        setSearching(true);
        const timer = setTimeout(() => {
            void searchProducts(value, 8, {
                includeWarrants: true,
                signal: controller.signal,
                onUpdate: (items) => {
                    if (isCurrent() && !completed) { suggestionScope.current = requestScope; setSuggestions(items); }
                },
            })
                .then((items) => {
                    completed = true;
                    if (isCurrent()) {
                        suggestionScope.current = requestScope;
                        setSuggestions(items);
                        setSearching(false);
                    }
                })
                .catch(() => {
                    completed = true;
                    if (isCurrent()) {
                        // Ordinary source failures resolve partial rows in the core.
                        // A rejection invalidates every row already published by this search.
                        setSuggestions([]);
                        setActiveIdentity(null);
                        setSearchError(true);
                        setSearching(false);
                    }
                });
        }, PRODUCT_SEARCH_DEBOUNCE_MS);
        controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        return () => {
            active = false;
            controller.abort();
            if (searchController.current === controller) searchController.current = null;
            clearTimeout(timer);
        };
    }, [open, value, searchRetry, catalogVersion, namesVersion]);

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
    const renderedVersion = queryVersion.current;
    const revealActiveRow = useCallback(() => {
        const container = resultsRef.current;
        const identity = rowIdentities[activeIndex];
        const row = identity && rowRefs.current.get(identity);
        if (!open || !container || !row) return;
        const box = container.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const top = box.top + container.clientTop;
        const bottom = top + container.clientHeight;
        if (rect.top < top) container.scrollTop -= top - rect.top;
        else if (rect.bottom > bottom) container.scrollTop += rect.bottom - bottom;
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
        cancelSearch();
        onAddPanel?.(type);
        onClose();
    };

    const submit = async (picked?: ProductSuggestion) => {
        if (composing.current || renderedVersion !== queryVersion.current) return;
        // active row past the product suggestions → it's a panel command
        if (!picked && activeIndex >= suggestions.length && rowCount > 0) {
            addPanelAt(activeIndex - suggestions.length);
            return;
        }
        const item = picked ?? suggestions[activeIndex];
        if (item && suggestionScope.current !== currentScope()) {
            cancelSearch();
            setSuggestions([]);
            setSearchRetry(retry => retry + 1);
            return;
        }
        const code = item?.code ?? value.trim().toUpperCase();
        if (!code || busy) return;
        // 名稱查詢待決時不可把上一輪結果當成本輪選取；直接代碼仍可送查詢。
        if (!item && searching && !/^[A-Z0-9]+$/.test(code)) return;
        cancelSearch();
        const submitVersion = queryVersion.current;
        setBusy(true);
        setError(false);
        try {
            if (item?.contract) primeContract(item.contract);
            await onJump(code, item?.security_type);
            if (submitVersion === queryVersion.current) onClose();
        } catch {
            if (submitVersion === queryVersion.current) setError(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={closePalette}
            onMouseMove={(event) => { pointerPosition.current = { x: event.clientX, y: event.clientY }; }}>
            <div className={styles.box} onClick={(e) => e.stopPropagation()}>
                <input
                    ref={inputRef}
                    className={styles.input}
                    placeholder='輸入代碼跳轉商品（2330、TXFR1…）'
                    value={value}
                    onCompositionStart={() => {
                        composing.current = true;
                        cancelSearch();
                        setSuggestions([]);
                        setActiveIdentity(null);
                        setError(false);
                        setSearchRetry((retry) => retry + 1);
                    }}
                    onCompositionEnd={(e) => {
                        composing.current = false;
                        cancelSearch();
                        setValue(e.currentTarget.value);
                        setSearchRetry((retry) => retry + 1);
                    }}
                    onChange={(e) => {
                        cancelSearch();
                        setValue(e.target.value);
                        setSuggestions([]);
                        setActiveIdentity(null);
                        setSearchError(false);
                        setSearching(!!e.target.value.trim());
                        setError(false);
                    }}
                    onKeyDown={(e) => {
                        if (composing.current || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                        if (e.key === 'ArrowDown' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIdentity(rowIdentities[(activeIndex + 1) % rowCount]!);
                        }
                        if (e.key === 'ArrowUp' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIdentity(rowIdentities[(activeIndex - 1 + rowCount) % rowCount]!);
                        }
                        if (e.key === 'Enter') void submit();
                        if (e.key === 'Escape') closePalette();
                    }}
                />
                {rowCount > 0 && (
                    <div ref={resultsRef} className={styles.results}>
                        {suggestions.map((item, index) => {
                            const detail = productDetailText(item.detail, item.security_type, item.kind);
                            return (
                            <button
                                key={productIdentity(item)}
                                title={[item.name, item.code, PRODUCT_BADGES[productBadgeType(item.security_type, item.kind)].label, detail].filter(Boolean).join(' · ')}
                                ref={(node) => { if (node) rowRefs.current.set(productIdentity(item), node); else rowRefs.current.delete(productIdentity(item)); }}
                                className={
                                    index === activeIndex
                                        ? styles.resultActive
                                        : styles.result
                                }
                                onMouseMove={(event) => selectWithPointer(productIdentity(item), event)}
                                onClick={() => void submit(item)}
                            >
                                <span className={styles.resultCode}>
                                    {item.code}
                                </span>
                                <span className={styles.resultName}>
                                    {item.name}
                                </span>
                                <span className={styles.resultMeta}>
                                    <ProductBadge security_type={item.security_type} kind={item.kind} />
                                    {detail && <span className={styles.resultType}>{detail}</span>}
                                </span>
                            </button>
                            );
                        })}
                        {panelMatches.map((type, index) => {
                            const rowIndex = suggestions.length + index;
                            return (
                                <button
                                    key={`panel:${type}`}
                                    title={`新增面板：${BLOCK_META[type].label} · ${BLOCK_META[type].description}`}
                                    ref={(node) => { if (node) rowRefs.current.set(`panel:${type}`, node); else rowRefs.current.delete(`panel:${type}`); }}
                                    className={
                                        rowIndex === activeIndex
                                            ? styles.resultActive
                                            : styles.result
                                    }
                                    onMouseMove={(event) => selectWithPointer(`panel:${type}`, event)}
                                    onClick={() => addPanelAt(index)}
                                >
                                    <span className={styles.panelIcon}>
                                        ＋
                                    </span>
                                    <span className={styles.panelName}>
                                        新增面板：{BLOCK_META[type].label}
                                    </span>
                                    <span className={styles.resultMeta}>
                                        <span className={styles.resultType}>{BLOCK_META[type].description}</span>
                                    </span>
                                </button>
                            );
                        })}
                        {isTauri && <div role='status' className={styles.hint}>原生版官方名稱更新未啟用，使用券商與內建名稱</div>}
                    </div>
                )}
                <ProductSearchDetails item={suggestions[activeIndex]} onToggle={revealActiveRow} />
                <div className={styles.hint}>
                    <AsyncStatus phase={busy ? 'loading' : error || searchError ? 'error' : searching ? 'loading' : 'idle'}
                        text={busy ? '查詢商品中…' : error ? '找不到此商品代碼' : searchError ? '搜尋失敗，可重試' : searching ? suggestions.length ? '正在補齊關聯商品…' : '搜尋中…' : 'Enter 跳轉 · Esc 關閉'}
                        action={error || searchError ? <button type='button' onClick={() => {
                            if (composing.current) return;
                            cancelSearch();
                            setError(false);
                            setSearchError(false);
                            setSuggestions([]);
                            setActiveIdentity(null);
                            setSearchRetry((retry) => retry + 1);
                        }}>{error ? '重新搜尋' : '重試'}</button> : undefined}
                        className={error || searchError ? styles.err : ''} />
                    <span>⌘K</span>
                </div>
            </div>
        </div>
    );
}
