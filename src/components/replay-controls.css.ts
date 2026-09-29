import { style } from '@vanilla-extract/css';

export const bar = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    marginBottom: 6,
    background: '#14181f',
    border: '1px solid #232a36',
    borderRadius: 8,
    color: '#cbd5e1',
    fontSize: 12,
});
export const btn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 26,
    padding: '3px 8px',
    background: '#1b2230',
    border: '1px solid #2b3444',
    borderRadius: 5,
    color: '#cbd5e1',
    fontSize: 12,
    cursor: 'pointer',
    selectors: {
        '&:hover:not(:disabled)': { borderColor: '#3b465c', color: '#e2e8f0' },
        '&:disabled': { opacity: 0.45, cursor: 'not-allowed' },
    },
});
export const btnActive = style({
    background: 'rgba(34,211,238,0.16)',
    borderColor: '#22d3ee',
    color: '#22d3ee',
});
export const iconBtn = style({
    minWidth: 28,
    padding: '3px 6px',
});
export const dateInput = style({
    minHeight: 26,
    padding: '2px 6px',
    background: '#1b2230',
    border: '1px solid #2b3444',
    borderRadius: 5,
    color: '#cbd5e1',
    fontSize: 12,
    colorScheme: 'dark',
});
export const range = style({
    flex: 1,
    minWidth: 150,
    accentColor: '#22d3ee',
    cursor: 'pointer',
});
export const timeText = style({
    fontVariantNumeric: 'tabular-nums',
    color: '#94a3b8',
    whiteSpace: 'nowrap',
});
export const statusText = style({
    color: '#fbbf24',
});
export const errText = style({
    color: '#fb7185',
    width: '100%',
});
export const divider = style({
    width: 1,
    height: 18,
    background: '#2b3444',
    margin: '0 2px',
});
