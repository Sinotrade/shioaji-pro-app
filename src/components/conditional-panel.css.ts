// src/components/conditional-panel.css.ts — 條件單管理面板 (#226), design v4.

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: vars.color.panel,
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.75rem',
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '7px 10px',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const title = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontWeight: 700,
    fontSize: '0.8rem',
    whiteSpace: 'nowrap',
});

export const grow = style({ flex: 1 });

const pillBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 8px',
    borderRadius: '999px',
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    whiteSpace: 'nowrap',
    fontSize: '0.7rem',
});

export const pill = styleVariants({
    plain: [pillBase],
    ok: [pillBase, { color: vars.color.success }],
    warn: [pillBase, { color: vars.color.amber }],
    err: [pillBase, { color: vars.color.danger }],
    muted: [pillBase, { color: vars.color.mutedForeground }],
});

const buttonBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 9px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    fontSize: '0.72rem',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    selectors: {
        '&:hover:not(:disabled)': { borderColor: vars.color.borderBright, background: vars.color.muted },
        '&:disabled': { opacity: 0.45, cursor: 'not-allowed' },
    },
});

export const button = styleVariants({
    plain: [buttonBase],
    primary: [buttonBase, {
        background: vars.color.accent,
        borderColor: vars.color.accent,
        color: '#fff',
        fontWeight: 600,
        selectors: { '&:hover:not(:disabled)': { background: vars.color.accent, borderColor: vars.color.accent, filter: 'brightness(1.08)' } },
    }],
    danger: [buttonBase, { borderColor: vars.color.danger, color: vars.color.danger }],
    dangerSolid: [buttonBase, {
        background: vars.color.dangerSolid,
        borderColor: vars.color.dangerSolid,
        color: '#fff',
        fontWeight: 600,
        selectors: { '&:hover:not(:disabled)': { background: vars.color.dangerSolid, borderColor: vars.color.dangerSolid, filter: 'brightness(1.08)' } },
    }],
});

const iconButtonBase = style({
    width: '24px',
    height: '24px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.foreground,
    cursor: 'pointer',
    selectors: {
        '&:hover:not(:disabled)': { borderColor: vars.color.borderBright, background: vars.color.muted },
        '&:disabled': { opacity: 0.4, cursor: 'not-allowed' },
    },
});

export const iconButton = styleVariants({
    plain: [iconButtonBase],
    danger: [iconButtonBase, { color: vars.color.danger }],
    dangerSolid: [iconButtonBase, { color: '#fff', background: vars.color.dangerSolid, borderColor: vars.color.dangerSolid }],
    active: [iconButtonBase, { borderColor: vars.color.accent, color: vars.color.accent }],
});

export const tabs = style({
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '5px 10px',
    borderBottom: `1px solid ${vars.color.border}`,
    overflowX: 'auto',
    scrollbarWidth: 'none',
});

const tabBase = style({
    padding: '3px 10px',
    borderRadius: vars.radius.sm,
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    font: 'inherit',
    fontSize: '0.72rem',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    selectors: { '&:hover': { color: vars.color.foreground } },
});

export const tab = styleVariants({
    off: [tabBase],
    on: [tabBase, { background: vars.color.inset, color: vars.color.foreground, fontWeight: 600 }],
});

export const tabCount = style({ marginLeft: '4px', fontVariantNumeric: 'tabular-nums' });

export const body = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontVariantNumeric: 'tabular-nums',
    // fixed widths from the colgroup: every section lines up, rows stay one line
    tableLayout: 'fixed',
});

globalStyle(`${table} th`, {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: vars.color.panel,
    textAlign: 'left',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    padding: '5px 10px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

globalStyle(`${table} td`, {
    padding: '4px 10px',
    height: '30px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    verticalAlign: 'middle',
});

export const thRight = style({ textAlign: 'right' });

export const section = style({});
globalStyle(`${section} td`, {
    padding: '4px 10px',
    color: vars.color.mutedForeground,
    fontSize: '0.68rem',
    background: vars.color.inset,
});

export const rowAlert = style({});
globalStyle(`${rowAlert} td`, { background: `color-mix(in srgb, ${vars.color.danger} 8%, transparent)` });
export const rowSelected = style({});
globalStyle(`${rowSelected} td`, { background: vars.color.inset });
export const rowClickable = style({ cursor: 'pointer' });

export const code = style({ fontWeight: 700, fontFamily: vars.font.mono });
export const mono = style({ fontFamily: vars.font.mono });
export const muted = style({ color: vars.color.mutedForeground });
export const up = style({ color: vars.color.up });
export const down = style({ color: vars.color.down });

export const tone = styleVariants({
    ok: { color: vars.color.success },
    warn: { color: vars.color.amber },
    err: { color: vars.color.danger },
    muted: { color: vars.color.mutedForeground },
});

export const actions = style({
    display: 'flex',
    gap: '4px',
    justifyContent: 'flex-end',
    alignItems: 'center',
});

export const expand = style({});
globalStyle(`${expand} > td`, { padding: 0, background: vars.color.panel, whiteSpace: 'normal' });

export const expandGrid = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    borderTop: `1px solid ${vars.color.border}`,
    '@container': {
        'condpanel (max-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
});

export const pane = style({ padding: '10px 12px', minWidth: 0 });
export const paneSplit = style([pane, { borderLeft: `1px solid ${vars.color.border}` }]);

export const paneTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontWeight: 700,
    marginBottom: '6px',
});

export const formRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    margin: '7px 0',
});

export const label = style({ width: '64px', flex: 'none', color: vars.color.mutedForeground });

export const input = style({
    width: '96px',
    padding: '4px 8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.background,
    color: vars.color.foreground,
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    selectors: { '&:focus': { outline: 'none', borderColor: vars.color.accent } },
});

export const inputNarrow = style([input, { width: '56px' }]);
export const inputWide = style([input, { width: '150px' }]);

export const select = style([input, { width: 'auto', fontFamily: vars.font.body, paddingRight: '4px' }]);

export const seg = style({
    display: 'inline-flex',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    overflow: 'hidden',
});

const segBase = style({
    padding: '3px 10px',
    border: 'none',
    borderLeft: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    fontSize: '0.72rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    selectors: {
        '&:first-child': { borderLeft: 'none' },
        '&:disabled': { opacity: 0.4, cursor: 'not-allowed' },
    },
});

export const segItem = styleVariants({
    off: [segBase],
    on: [segBase, { background: vars.color.accent, color: '#fff', fontWeight: 600 }],
    buy: [segBase, { background: vars.color.up, color: '#fff', fontWeight: 600 }],
    sell: [segBase, { background: vars.color.down, color: '#fff', fontWeight: 600 }],
});

export const summary = style({
    display: 'flex',
    gap: '6px',
    alignItems: 'flex-start',
    marginTop: '10px',
    padding: '8px 10px',
    borderRadius: vars.radius.md,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    lineHeight: 1.7,
});

export const message = styleVariants({
    err: { color: vars.color.danger, marginTop: '6px' },
    warn: { color: vars.color.amber, marginTop: '6px' },
    muted: { color: vars.color.mutedForeground, marginTop: '6px' },
});

export const history = style({ display: 'flex', flexDirection: 'column', gap: '2px' });
export const historyItem = style({ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '2px 0', lineHeight: 1.5 });

const dotBase = style({ width: '7px', height: '7px', marginTop: '5px', borderRadius: '50%', flex: 'none', background: vars.color.mutedForeground });
export const dot = styleVariants({
    plain: [dotBase],
    ok: [dotBase, { background: vars.color.success }],
    warn: [dotBase, { background: vars.color.amber }],
    err: [dotBase, { background: vars.color.danger }],
});

// ---- narrow (dock) card layout ----

export const cards = style({ display: 'flex', flexDirection: 'column', padding: '4px 0' });

const cardBase = style({
    minWidth: 0,
    overflow: 'hidden',
    margin: '6px 8px',
    padding: '8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: vars.color.panel,
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
});

export const card = styleVariants({
    plain: [cardBase],
    alert: [cardBase, { borderColor: vars.color.danger }],
    selected: [cardBase, { borderColor: vars.color.borderBright, background: vars.color.inset }],
});

// 第一列：標題（截斷）＋狀態標籤固定在最右
export const cardHead = style({ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 });
export const cardTitle = style({ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' });
globalStyle(`${cardHead} > [data-testid='cond-status']`, { flexShrink: 0, whiteSpace: 'nowrap' });
export const cardActions = style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', marginLeft: 'auto' });

// ---- empty state ----

export const empty = style({
    padding: '36px 20px',
    textAlign: 'center',
    color: vars.color.mutedForeground,
    lineHeight: 1.7,
});

export const emptyTitle = style({ fontSize: '0.8rem', color: vars.color.foreground, margin: '6px 0' });

// ---- dialog ----

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 1100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: 'rgba(0, 0, 0, 0.45)',
});

export const dialog = style({
    width: 'min(520px, 100%)',
    maxHeight: 'calc(100vh - 32px)',
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.panel,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 16px 40px rgba(0, 0, 0, 0.4)',
    fontFamily: vars.font.body,
    fontSize: '0.75rem',
    overflow: 'hidden',
});

export const dialogNarrow = style([dialog, { width: 'min(440px, 100%)' }]);

export const dialogBody = style({ padding: '12px', overflowY: 'auto' });

export const dialogFoot = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderTop: `1px solid ${vars.color.border}`,
});

export const closeButton = style([iconButtonBase, { border: 'none' }]);

export const container = style({ containerType: 'inline-size', containerName: 'condpanel', height: '100%' });

// ---- 二擇一 levels (design v4 mini chart) ----

export const ladder = style({
    position: 'relative',
    height: '90px',
    marginTop: '8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: vars.color.background,
    overflow: 'hidden',
});

const levelBase = style({
    position: 'absolute',
    left: 0,
    right: 0,
    borderTop: '1px dashed',
    fontSize: '0.64rem',
    paddingLeft: '4px',
    lineHeight: 1.4,
});

export const level = styleVariants({
    up: [levelBase, { borderColor: vars.color.up, color: vars.color.up }],
    down: [levelBase, { borderColor: vars.color.down, color: vars.color.down }],
    muted: [levelBase, { borderColor: vars.color.mutedForeground, color: vars.color.mutedForeground }],
});

// ---- 括號單 form ----

export const subhead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    margin: '10px 0 4px',
    paddingTop: '8px',
    borderTop: `1px dashed ${vars.color.border}`,
    fontWeight: 700,
});

export const tier = style({
    display: 'grid',
    gridTemplateColumns: '44px 110px 80px 1fr',
    gap: '6px',
    alignItems: 'center',
    margin: '4px 0 4px 72px',
});

export const tierTail = style({ display: 'flex', alignItems: 'center', gap: '8px' });

export const check = style({ display: 'inline-flex', alignItems: 'center', gap: '4px', color: vars.color.mutedForeground, cursor: 'pointer' });

const switchBase = style({
    width: '30px',
    height: '17px',
    flex: 'none',
    padding: 0,
    border: 'none',
    borderRadius: '9px',
    position: 'relative',
    cursor: 'pointer',
    background: vars.color.borderBright,
    selectors: {
        '&::after': {
            content: '""',
            position: 'absolute',
            width: '13px',
            height: '13px',
            borderRadius: '50%',
            background: '#fff',
            top: '2px',
            left: '2px',
            transition: 'left 0.12s',
        },
    },
});

export const switchOff = style([switchBase]);
export const switchOn = style([switchBase, { background: vars.color.accent, selectors: { '&::after': { left: '15px' } } }]);

// ---- settings ----

export const settings = style({ margin: '-12px -12px 0' });

export const setting = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '10px 12px',
    borderBottom: `1px solid ${vars.color.border}`,
});
export const settingLast = style([setting, { borderBottom: 'none' }]);
export const settingName = style({ fontWeight: 600, marginBottom: '2px' });
export const settingSection = style({
    padding: '6px 12px',
    background: vars.color.inset,
    color: vars.color.mutedForeground,
    fontSize: '0.68rem',
    borderBottom: `1px solid ${vars.color.border}`,
});
export const settingEmbed = style({ padding: '0 12px 10px', borderBottom: `1px solid ${vars.color.border}` });

export const nameCell = style({});
export const nameText = style({ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
export const numCell = style({ textAlign: 'right', fontFamily: vars.font.mono, fontVariantNumeric: 'tabular-nums' });
export const numText = style({ fontFamily: vars.font.mono, fontVariantNumeric: 'tabular-nums' });
export const statusFull = style({ padding: '0 0 8px', lineHeight: 1.5, whiteSpace: 'normal', overflowWrap: 'anywhere' });

// column widths (colgroup)
export const cName = style({ width: '118px' });
export const cKind = style({ width: '68px' });
export const cSide = style({ width: '92px' });
export const cPrice = style({ width: '118px' });
export const cStatus = style({ width: '92px' });
export const cValidity = style({ width: '80px' });
export const cAccount = style({ width: '92px' });
export const cOps = style({ width: '196px' });

// 操作: fixed slots — primary text button | edit | pause/resume | delete
export const actionsWrap = style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' });
export const opsGrid = style({
    display: 'grid',
    gridTemplateColumns: '72px 24px 24px 24px 24px',
    gap: '4px',
    alignItems: 'center',
    justifyItems: 'end',
});
export const opsPrimary = style({ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', width: '100%' });
export const opsSlot = style({ display: 'inline-flex', width: '24px', height: '24px', alignItems: 'center', justifyContent: 'center' });
const opButtonBase = style({
    height: '24px',
    minWidth: '70px',
    padding: '0 8px',
    fontSize: '0.7rem',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.foreground,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    selectors: { '&:disabled': { opacity: 0.4, cursor: 'not-allowed' } },
});
export const opButton = styleVariants({
    plain: [opButtonBase, { selectors: { '&:hover:not(:disabled)': { background: vars.color.muted } } }],
    primary: [opButtonBase, { background: vars.color.accent, borderColor: vars.color.accent, color: '#fff', fontWeight: 600 }],
    danger: [opButtonBase, { borderColor: vars.color.danger, color: vars.color.danger, fontWeight: 600 }],
});
const opsNoteBase = style({ fontSize: '0.64rem', maxWidth: '212px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const opsNote = styleVariants({
    ok: [opsNoteBase, { color: vars.color.success }],
    err: [opsNoteBase, { color: vars.color.danger }],
    danger: [opsNoteBase, { color: vars.color.danger }],
    muted: [opsNoteBase, { color: vars.color.mutedForeground }],
    warn: [opsNoteBase, { color: vars.color.amber }],
});
export const moreAnchor = style({ position: 'relative', display: 'inline-flex' });
export const moreBackdrop = style({ position: 'fixed', inset: 0, zIndex: 40 });
export const moreMenu = style({
    position: 'absolute', top: 'calc(100% + 2px)', right: 0, zIndex: 41, display: 'flex', flexDirection: 'column', minWidth: '96px', padding: '3px',
    background: vars.color.panelRaised, border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.md, boxShadow: '0 8px 20px rgba(0,0,0,.3)',
});
export const moreItem = style({
    padding: '4px 8px', fontSize: '0.7rem', textAlign: 'left', border: 'none', background: 'transparent', color: vars.color.foreground,
    borderRadius: vars.radius.sm, cursor: 'pointer', whiteSpace: 'nowrap', selectors: { '&:hover': { background: vars.color.muted } },
});
export const cardText = style({ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 });
export const cardFoot = style({ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '6px', minWidth: 0 });
export const statusCell = style({});
globalStyle(`${table} td.${statusCell}`, { whiteSpace: 'nowrap' });
/** a number with its words: never split across lines */
export const group = style({ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' });

// ---- column priority (TXF QA 2026-10-12: at ~800px the 操作 column
// scrolled out of view) ----
// 操作 stays pinned to the right edge; 帳戶, 有效期 and 現價／距離 give way
// first as the panel narrows (cards take over below 640px).

export const opsCell = style({});
globalStyle(`${table} ${opsCell}`, {
    position: 'sticky',
    right: 0,
    zIndex: 1,
    background: vars.color.panel,
    boxShadow: `inset 1px 0 0 ${vars.color.border}`,
});
globalStyle(`${table} th${opsCell}`, { zIndex: 2 });
const alertTint = `color-mix(in srgb, ${vars.color.danger} 8%, transparent)`;
globalStyle(`${rowAlert} td${opsCell}`, {
    background: `linear-gradient(${alertTint}, ${alertTint}), ${vars.color.panel}`,
});
globalStyle(`${rowSelected} td${opsCell}`, { background: vars.color.inset });

export const colAccount = style({
    '@container': { 'condpanel (max-width: 959px)': { display: 'none' } },
});
export const colValidity = style({
    '@container': { 'condpanel (max-width: 859px)': { display: 'none' } },
});
export const colPrice = style({
    '@container': { 'condpanel (max-width: 739px)': { display: 'none' } },
});

// ---- runner tag (shown while 背景持續執行 is on) ----
const runnerBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    marginLeft: '4px',
    verticalAlign: 'middle',
    cursor: 'help',
});
export const runner = styleVariants({
    background: [runnerBase, { color: vars.color.success }],
    window: [runnerBase, { color: vars.color.mutedForeground }],
});

// ---- order-ticket cards footer ----
export const cardsFoot = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 8px',
    color: vars.color.mutedForeground,
});
export const linkButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    padding: 0,
    border: 'none',
    background: 'none',
    color: vars.color.accent,
    font: 'inherit',
    cursor: 'pointer',
    selectors: { '&:hover': { textDecoration: 'underline' } },
});
globalStyle(`${table} td${opsCell}`, { paddingLeft: '6px', paddingRight: '6px' });
export const opsRow = style({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' });
export const opsItem = style({ display: 'inline-flex', alignItems: 'center' });
