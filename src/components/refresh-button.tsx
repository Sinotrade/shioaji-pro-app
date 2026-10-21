import type { ComponentProps } from 'react';
import { RefreshCw } from 'lucide-react';
import * as styles from './refresh-button.css';

type Props = Pick<ComponentProps<'button'>, 'onClick' | 'disabled' | 'className'> & {
    label: string;
    loading?: boolean;
    /** lucide icon size; panels with compact toolbars use 12 */
    iconSize?: number;
};

/** Manual refresh for the current panel; accessible text stays in the tooltip. */
export function RefreshButton({ label, loading = false, disabled = false, className, onClick, iconSize = 14 }: Props) {
    return (
        <button
            type='button'
            className={[styles.refreshButton, className].filter(Boolean).join(' ')}
            aria-label={label}
            aria-busy={loading}
            title={loading ? `${label}中…` : label}
            disabled={disabled || loading}
            onClick={onClick}
        >
            <RefreshCw size={iconSize} aria-hidden='true' className={loading ? styles.refreshSpinning : undefined} />
        </button>
    );
}
