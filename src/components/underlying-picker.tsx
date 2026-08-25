import { useEffect, useMemo, useState } from 'react';
import {
    loadStockCatalog,
    searchStocks,
    type StockMeta,
} from '../lib/stock-index';
import * as styles from './derivative-explorer.css';

export function UnderlyingPicker({
    value,
    onChange,
}: {
    value: StockMeta | null;
    onChange: (stock: StockMeta) => void;
}) {
    const [catalog, setCatalog] = useState<StockMeta[]>([]);
    const [input, setInput] = useState('');
    const [open, setOpen] = useState(false);

    useEffect(() => {
        loadStockCatalog().then(setCatalog).catch(() => undefined);
    }, []);

    useEffect(() => {
        // value 清空時同步清輸入框 — 外部（連動/手動切家族）改變狀態
        // 後不留過期文字
        setInput(value ? `${value.code} ${value.name}` : '');
    }, [value]);

    const suggestions = useMemo(() => {
        if (!open) return [];
        const query = input.replace(/^\d{4}\s+/, '').trim();
        return searchStocks(catalog, query, 8);
    }, [catalog, input, open]);

    return (
        <div className={styles.picker}>
            <input
                className={styles.input}
                value={input}
                placeholder='輸入股票代碼或名稱'
                aria-label='標的股票'
                onFocus={() => {
                    setInput('');
                    setOpen(true);
                }}
                onChange={(event) => {
                    setInput(event.target.value);
                    setOpen(true);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && suggestions[0]) {
                        onChange(suggestions[0]);
                        setOpen(false);
                    }
                    if (event.key === 'Escape') setOpen(false);
                }}
                onBlur={() => setTimeout(() => setOpen(false), 120)}
            />
            {open && suggestions.length > 0 && (
                <div className={styles.suggestions}>
                    {suggestions.map((stock) => (
                        <button
                            key={stock.code}
                            className={styles.suggestion}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
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

