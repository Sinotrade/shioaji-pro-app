import { useEffect, useMemo, useRef, useState } from 'react';
import { useStockCatalog } from '../hooks/use-stock-catalog';
import {
    searchStocks,
    type StockMeta,
} from '../lib/stock-index';
import { getProductCatalogVersion } from '../lib/product-catalog-version';
import * as styles from './derivative-explorer.css';

export function UnderlyingPicker({
    value,
    onChange,
}: {
    value: StockMeta | null;
    onChange: (stock: StockMeta) => void;
}) {
    const [input, setInput] = useState('');
    const [open, setOpen] = useState(false);
    const { catalog, ready, error, loading, retry, version } = useStockCatalog();
    const composing = useRef(false);
    const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(blurTimer.current), []);

    useEffect(() => {
        // value 清空時同步清輸入框 — 外部（連動/手動切家族）改變狀態
        // 後不留過期文字
        if (!open) setInput(value ? `${value.code} ${value.name}` : '');
    }, [value, open]);

    const suggestions = useMemo(() => {
        if (!open || !ready) return [];
        const query = input.replace(/^\d{4}\s+/, '').trim();
        return searchStocks(catalog, query, 8);
    }, [catalog, input, open, ready]);

    return (
        <div className={styles.picker}>
            <input
                className={styles.input}
                value={input}
                placeholder='輸入股票代碼或名稱'
                aria-label='標的股票'
                aria-busy={loading}
                onFocus={() => {
                    clearTimeout(blurTimer.current);
                    setInput('');
                    setOpen(true);
                    retry();
                }}
                onChange={(event) => {
                    setInput(event.target.value);
                    setOpen(true);
                }}
                onKeyDown={(event) => {
                    if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229) return;
                    if (event.key === 'Enter' && suggestions[0] && getProductCatalogVersion() === version) {
                        onChange(suggestions[0]);
                        setOpen(false);
                    }
                    if (event.key === 'Escape') setOpen(false);
                }}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; }}
                onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
            />
            {error && (
                <span role='alert'>
                    標的目錄載入失敗
                    <button type='button' onClick={retry}>重試</button>
                </span>
            )}
            {open && suggestions.length > 0 && (
                <div className={styles.suggestions}>
                    {suggestions.map((stock) => (
                        <button
                            key={stock.code}
                            className={styles.suggestion}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                if (getProductCatalogVersion() !== version) return;
                                onChange(stock);
                                setOpen(false);
                            }}
                        >
                            <span className={styles.suggestionCode}>
                                {stock.code}
                            </span>
                            <span className={styles.suggestionName}>
                                {stock.name}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

