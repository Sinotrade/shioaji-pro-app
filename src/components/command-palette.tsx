// src/components/command-palette.tsx — Cmd+K symbol jump + panel commands

import { useEffect, useMemo, useRef, useState } from 'react';
import { primeContract } from '../lib/contracts-cache';
import {
    searchProducts,
    type ProductSuggestion,
} from '../lib/product-search';
import { BLOCK_META, type BlockType } from '../lib/workspace';
import * as styles from './command-palette.css';

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
    onJump: (code: string) => Promise<unknown>;
    onAddPanel?: (type: BlockType) => void;
}) {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setValue('');
            setError(false);
            setSuggestions([]);
            setActiveIndex(0);
            setTimeout(() => inputRef.current?.focus(), 0);
        }
    }, [open]);

    useEffect(() => {
        if (!open || !value.trim()) {
            setSuggestions([]);
            return;
        }
        let active = true;
        const timer = setTimeout(() => {
            void searchProducts(value, 8)
                .then((items) => {
                    if (active) {
                        setSuggestions(items);
                        setActiveIndex(0);
                    }
                })
                .catch(() => {
                    if (active) setSuggestions([]);
                });
        }, 120);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [open, value]);

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
        // active row past the product suggestions → it's a panel command
        if (!picked && activeIndex >= suggestions.length && rowCount > 0) {
            addPanelAt(activeIndex - suggestions.length);
            return;
        }
        const item = picked ?? suggestions[activeIndex];
        const code = item?.code ?? value.trim().toUpperCase();
        if (!code || busy) return;
        setBusy(true);
        setError(false);
        try {
            if (item?.contract) primeContract(item.contract);
            await onJump(code);
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
                    onChange={(e) => {
                        setValue(e.target.value);
                        setError(false);
                    }}
                    onKeyDown={(e) => {
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
                    <span className={error ? styles.err : ''}>
                        {busy
                            ? '查詢中…'
                            : error
                              ? '找不到此商品代碼'
                              : 'Enter 跳轉 · Esc 關閉'}
                    </span>
                    <span>⌘K</span>
                </div>
            </div>
        </div>
    );
}
