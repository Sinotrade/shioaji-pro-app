// src/App.tsx

import * as styles from './App.css';
import { ApiExplorer } from './components/api-explorer';
import { HealthBadge } from './components/health-badge';
import { ThemeToggle } from './components/theme-toggle';

export default function App() {
    return (
        <>
            <header className={styles.header}>
                <span className={styles.headerStatus}>
                    <HealthBadge />
                </span>
                <ThemeToggle />
            </header>
            <main className={styles.main}>
                <img
                    src='/shioaji-logo.png'
                    alt='Shioaji'
                    className={styles.logo}
                />
                <h1 className={styles.title}>Welcome to your Shioaji app</h1>
                <p className={styles.hint}>
                    Edit <code className={styles.code}>src/App.tsx</code> and
                    save to reload.
                </p>
                <ApiExplorer />
            </main>
        </>
    );
}
