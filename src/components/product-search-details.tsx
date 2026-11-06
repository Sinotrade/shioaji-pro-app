import type { ProductSuggestion } from '../lib/product-search';
import { PRODUCT_BADGES, productBadgeType, productDetailText } from '../lib/product-badge-presentation';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import * as styles from './product-search-details.css';

/** Native disclosure for the active result only. It never resolves or submits a product. */
export function ProductSearchDetails({ item, onToggle }: {
    item?: ProductSuggestion;
    onToggle?: (details: HTMLDetailsElement) => void;
}) {
    if (!item) return null;
    const label = PRODUCT_BADGES[productBadgeType(item.security_type, item.kind)].label;
    const detail = productDetailText(item.detail, item.security_type, item.kind);
    // The warrant detail already contains its source's expiry date; never derive one from a code.
    const expiry = item.contract?.expiry_date || item.contract?.delivery_date
        || (item.security_type === 'WRT' ? item.detail.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] : undefined);
    const warningCount = item.detail.split(' · ').filter(part => part === '交易日期待確認').length;
    return (
        <details className={styles.disclosure} onToggle={event => onToggle?.(event.currentTarget)} onKeyDown={event => {
            if (event.key === 'Tab') return;
            if (event.key === 'Escape') {
                // Never a cancel-all press. Collapsed details hand Esc to the popup owner.
                event.preventDefault();
                if (!event.currentTarget.open) return;
                event.stopPropagation();
                resetEscCancelArm();
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
                return;
            }
            // Reading product details must not reach the global trading shortcuts.
            event.stopPropagation();
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
            }
        }}>
            <summary className={styles.summary}>完整資訊（到期 {expiry ? 1 : 0}、警告 {warningCount}）</summary>
            <dl className={styles.content}>
                <dt>名稱</dt><dd className={styles.value}>{item.name}</dd>
                <dt>代號</dt><dd className={styles.value}>{item.code}</dd>
                <dt>類別</dt><dd className={styles.value}>{label}</dd>
                {detail && <><dt>補充</dt><dd className={styles.value}>{detail}</dd></>}
                {expiry && !detail.includes(expiry) && <><dt>到期</dt><dd className={styles.value}>{expiry}</dd></>}
                {item.contract?.last_trading_date && <><dt>最後交易日</dt><dd className={styles.value}>{item.contract.last_trading_date}</dd></>}
            </dl>
        </details>
    );
}
