// src/hooks/use-theme.ts

import { useEffect, useState } from 'react';
import { darkThemeClass, lightThemeClass } from '../theme.css';

const STORAGE_KEY = 'shioaji-theme';
type Theme = 'light' | 'dark';

function getInitial(): Theme {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
}

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(getInitial);

    useEffect(() => {
        const root = document.documentElement;
        root.classList.remove(lightThemeClass, darkThemeClass);
        root.classList.add(theme === 'dark' ? darkThemeClass : lightThemeClass);
        localStorage.setItem(STORAGE_KEY, theme);
    }, [theme]);

    return {
        theme,
        toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    };
}
