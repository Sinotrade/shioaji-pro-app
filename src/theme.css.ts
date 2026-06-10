// src/theme.css.ts

import { createTheme, globalStyle } from '@vanilla-extract/css';

export const [lightThemeClass, vars] = createTheme({
    color: {
        background: '#ffffff',
        foreground: '#0a0a0a',
        muted: '#f4f4f5',
        mutedForeground: '#71717a',
        border: '#e4e4e7',
        accent: '#0070f3',
        buyRed: '#e11d48',
        sellGreen: '#16a34a',
        neutral: '#737373',
        success: '#16a34a',
        danger: '#dc2626',
    },
    space: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '1rem',
        lg: '1.5rem',
        xl: '2rem',
    },
    radius: {
        sm: '0.25rem',
        md: '0.5rem',
        lg: '0.75rem',
    },
    font: {
        mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
});

globalStyle('html, body', {
    background: vars.color.background,
    color: vars.color.foreground,
});

export const darkThemeClass = createTheme(vars, {
    color: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        muted: '#27272a',
        mutedForeground: '#a1a1aa',
        border: '#27272a',
        accent: '#3b82f6',
        buyRed: '#f43f5e',
        sellGreen: '#22c55e',
        neutral: '#a3a3a3',
        success: '#22c55e',
        danger: '#ef4444',
    },
    space: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '1rem',
        lg: '1.5rem',
        xl: '2rem',
    },
    radius: {
        sm: '0.25rem',
        md: '0.5rem',
        lg: '0.75rem',
    },
    font: {
        mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
});
