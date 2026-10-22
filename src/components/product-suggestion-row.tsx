// src/components/product-suggestion-row.tsx：搜尋結果的 option 列（命令面板與自選共用）

import type { MouseEvent, ReactNode, Ref } from 'react';
import type { ProductSuggestion } from '../lib/product-search';
import { PRODUCT_BADGES, productBadgeType, productDetailText } from '../lib/product-badge-presentation';
import { ProductBadge } from './product-badge';
import * as styles from './search-surface.css';

/** Type, exchange and code: the same code can be a stock and an index. */
export const productIdentity = (item: ProductSuggestion) => JSON.stringify([item.security_type, item.exchange, item.code]);

// Row identities hold JSON punctuation; escape it so ids also work as CSS selectors.
export const optionId = (listId: string, identity: string) =>
    `${listId}-${identity.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`)}`;

interface SearchOptionProps {
    id: string;
    /** The keyboard row, which the combobox input points to. */
    active: boolean;
    /** The surface's own row size and spacing. */
    className: string;
    disabled?: boolean;
    rowRef?: Ref<HTMLButtonElement>;
    onSelect: () => unknown;
    onMouseMove?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** A listbox option; focus stays in the combobox input while choosing with the mouse. */
export function SearchOption({ id, active, className, disabled, rowRef, onSelect, onMouseMove, title, children }: SearchOptionProps & {
    /** Full summary on hover, since narrow rows truncate. */
    title: string;
    children: ReactNode;
}) {
    return (
        <button
            ref={rowRef}
            id={id}
            role='option'
            aria-selected={active}
            tabIndex={-1}
            className={`${styles.resultRow} ${className}${active ? ` ${styles.resultActive}` : ''}`}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={onMouseMove}
            onClick={() => onSelect()}
        >
            <span className={styles.optionText} title={title}>{children}</span>
        </button>
    );
}

export function ProductSuggestionRow({ item, ...option }: SearchOptionProps & { item: ProductSuggestion }) {
    const detail = productDetailText(item.detail, item.security_type, item.kind);
    const label = PRODUCT_BADGES[productBadgeType(item.security_type, item.kind)].label;
    return (
        <SearchOption {...option} title={[item.name, item.code, label, detail].filter(Boolean).join(' · ')}>
            <span className={styles.resultCode}>{item.code}</span>
            <span className={styles.resultName}>{item.name}</span>
            <span className={styles.resultMeta}>
                <ProductBadge security_type={item.security_type} kind={item.kind} />
                {detail && <span className={styles.resultDetail}>{detail}</span>}
            </span>
        </SearchOption>
    );
}
