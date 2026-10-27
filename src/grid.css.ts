// src/grid.css.ts — react-grid-layout integration styles

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from './theme.css';

export const gridWrap = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
});

// each grid item hosts exactly one panel; make it fill the cell
export const cell = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
});

globalStyle(`${cell} > *`, {
    flex: 1,
    minHeight: 0,
});

globalStyle('.drag-handle', {
    cursor: 'grab',
});

// The narrow display is static: nothing to grab.
globalStyle('.react-grid-item.static .drag-handle', {
    cursor: 'default',
});

globalStyle('.react-grid-item.react-draggable-dragging .drag-handle', {
    cursor: 'grabbing',
});

// drop-target ghost
globalStyle('.react-grid-item.react-grid-placeholder', {
    background: vars.color.accentDim,
    border: `1px dashed ${vars.color.accent}`,
    borderRadius: vars.radius.md,
    opacity: 1,
});

// while dragging / resizing, lift the panel
globalStyle('.react-grid-item.react-draggable-dragging, .react-grid-item.resizing', {
    zIndex: 30,
    opacity: 0.92,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
});

// subtle corner resize handle
globalStyle('.react-grid-item > .react-resizable-handle', {
    opacity: 0,
    transition: 'opacity 0.15s',
});

globalStyle('.react-grid-item:hover > .react-resizable-handle', {
    opacity: 0.7,
});

globalStyle('.react-grid-item > .react-resizable-handle::after', {
    borderRight: `2px solid ${vars.color.mutedForeground}`,
    borderBottom: `2px solid ${vars.color.mutedForeground}`,
});
