// src/components/command-palette.tsx — Cmd+K symbol jump + panel commands

import { useEffect, useMemo, useRef, useState } from 'react';
import { primeContract } from '../lib/contracts-cache';
import {
    searchProducts,
    type ProductSuggestion,
} from '../lib/product-search';
import { BLOCK_META, type BlockType } from '../lib/workspace';
import type { SecurityType } from '../lib/types/contract';
import * as styles from './command-palette.css';
import { AsyncStatus } from './async-status';

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
    const [searchError, setSearchError] = useState(false);
    const [searching, setSearching] = useState(false);
    const [searchRetry, setSearchRetry] = useState(0);
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const composing = useRef(false);
    const queryVersion = useRef(0);

    useEffect(() => {
        if (open) {
            composing.current = false;
            queryVersion.current += 1;
            setValue('');
            setError(false);
            setSuggestions([]);
            setActiveIndex(0);
            const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
            return () => clearTimeout(focusTimer);
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
        const requestVersion = queryVersion.current;
        const isCurrent = () => active && requestVersion === queryVersion.current && !composing.current;
        setSearchError(false);
        setSearching(true);
        const timer = setTimeout(() => {
            void searchProducts(value, 8, { includeWarrants: true })
                .then((items) => {
                    if (isCurrent()) {
                        setSuggestions(items);
                        setActiveIndex(0);
                        setSearching(false);
                    }
                })
                .catch(() => {
                    if (isCurrent()) {
                        setSuggestions([]);
                        setSearchError(true);
                        setSearching(false);
                    }
                });
        }, 120);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [open, value, searchRetry]);

    useEffect(() => {
        setActiveIndex(0);
    }, [value]);

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

    const rowCount = suggestions.length + panelMatches.length;

    if (!open) return null;

    const addPanelAt = (index: number) => {
        const type = panelMatches[index];
        if (!type) return;
        onAddPanel?.(type);
        onClose();
    };

    const submit = async (picked?: ProductSuggestion) => {
        if (composing.current) return;
        // active row past the product suggestions → it's a panel command
        if (!picked && activeIndex >= suggestions.length && rowCount > 0) {
            addPanelAt(activeIndex - suggestions.length);
            return;
        }
        const item = picked ?? suggestions[activeIndex];
        const code = item?.code ?? value.trim().toUpperCase();
        if (!code || busy) return;
        // 名稱查詢待決時不可把上一輪結果當成本輪選取；直接代碼仍可送查詢。
        if (!item && searching && !/^[A-Z0-9]+$/.test(code)) return;
        setBusy(true);
        setError(false);
        try {
            if (item?.contract) primeContract(item.contract);
            await onJump(code, item?.security_type);
            onClose();
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.box} onClick={(e) => e.stopPropagation()}>
                <input
                    ref={inputRef}
                    className={styles.input}
                    placeholder='輸入代碼跳轉商品（2330、TXFR1…）'
                    value={value}
                    onCompositionStart={() => {
                        composing.current = true;
                        queryVersion.current += 1;
                        setSuggestions([]);
                        setActiveIndex(0);
                        setSearchRetry((retry) => retry + 1);
                    }}
                    onCompositionEnd={(e) => {
                        composing.current = false;
                        queryVersion.current += 1;
                        setValue(e.currentTarget.value);
                        setSearchRetry((retry) => retry + 1);
                    }}
                    onChange={(e) => {
                        queryVersion.current += 1;
                        setValue(e.target.value);
                        setSuggestions([]);
                        setActiveIndex(0);
                        setSearchError(false);
                        setSearching(!!e.target.value.trim());
                        setError(false);
                    }}
                    onKeyDown={(e) => {
                        if (composing.current || e.nativeEvent?.isComposing || e.keyCode === 229) return;
                        if (e.key === 'ArrowDown' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIndex((index) => (index + 1) % rowCount);
                        }
                        if (e.key === 'ArrowUp' && rowCount > 0) {
                            e.preventDefault();
                            setActiveIndex(
                                (index) => (index - 1 + rowCount) % rowCount,
                            );
                        }
                        if (e.key === 'Enter') void submit();
                        if (e.key === 'Escape') onClose();
                    }}
                />
                {rowCount > 0 && (
                    <div className={styles.results}>
                        {suggestions.map((item, index) => (
                            <button
                                key={`${item.security_type}:${item.code}`}
                                className={
                                    index === activeIndex
                                        ? styles.resultActive
                                        : styles.result
                                }
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => void submit(item)}
                            >
                                <span className={styles.resultCode}>
                                    {item.code}
                                </span>
                                <span className={styles.resultName}>
                                    {item.name}
                                </span>
                                <span className={styles.resultType}>
                                    {item.detail}
                                </span>
                            </button>
                        ))}
                        {panelMatches.map((type, index) => {
                            const rowIndex = suggestions.length + index;
                            return (
                                <button
                                    key={`panel:${type}`}
                                    className={
                                        rowIndex === activeIndex
                                            ? styles.resultActive
                                            : styles.result
                                    }
                                    onMouseEnter={() =>
                                        setActiveIndex(rowIndex)
                                    }
                                    onClick={() => addPanelAt(index)}
                                >
                                    <span className={styles.resultCode}>
                                        ＋
                                    </span>
                                    <span className={styles.resultName}>
                                        新增面板：{BLOCK_META[type].label}
                                    </span>
                                    <span className={styles.resultType}>
                                        {BLOCK_META[type].description}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
                <div className={styles.hint}>
                    <AsyncStatus phase={busy ? 'loading' : error || searchError ? 'error' : searching ? 'loading' : 'idle'}
                        text={busy ? '查詢商品中…' : error ? '找不到此商品代碼' : searchError ? '搜尋失敗，可重試' : searching ? '搜尋中…' : 'Enter 跳轉 · Esc 關閉'}
                        action={searchError ? <button type='button' onClick={() => setSearchRetry((retry) => retry + 1)}>重試</button> : undefined}
                        className={error || searchError ? styles.err : ''} />
                    <span>⌘K</span>
                </div>
            </div>
        </div>
    );
}
