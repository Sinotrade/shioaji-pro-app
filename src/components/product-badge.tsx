import { PRODUCT_BADGES, productBadgeType } from '../lib/product-badge-presentation';
import type { SecurityType } from '../lib/types/contract';
import * as styles from './product-badge.css';

export function ProductBadge({ security_type, kind }: {
    security_type: Exclude<SecurityType, null>;
    kind?: 'ETF';
}) {
    const type = productBadgeType(security_type, kind);
    return <span className={styles.tone[type]}>{PRODUCT_BADGES[type].label}</span>;
}
