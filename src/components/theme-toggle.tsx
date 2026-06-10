// src/components/theme-toggle.tsx

import { useTheme } from '../hooks/use-theme';
import * as styles from './theme-toggle.css';

export function ThemeToggle() {
    const { theme, toggle } = useTheme();
    return (
        <button
            type='button'
            className={styles.button}
            onClick={toggle}
            aria-label='Toggle theme'
        >
            {theme === 'dark' ? '☀' : '☾'}
        </button>
    );
}
