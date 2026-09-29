// src/components/stock-picker-panel.css.ts — 短線選股面板樣式
import { style, keyframes } from '@vanilla-extract/css';

const bg = '#14181f';
const panelBg = '#171c25';
const border = '#232a36';
const up = '#fb7185'; // 多/漲（紅）
const down = '#4ade80'; // 空/跌（綠）
const warn = '#fbbf24';
const muted = '#8b94a3';
const accent = '#22d3ee';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: bg,
    color: '#e6eaf0',
    fontSize: 12,
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 9px',
    borderBottom: `1px solid ${border}`,
    flex: '0 0 auto',
});

export const title = style({
    fontWeight: 700,
    fontSize: 12.5,
    whiteSpace: 'nowrap',
});

export const poolCount = style({
    color: muted,
    fontWeight: 500,
    fontSize: 11,
});

export const regimeBadge = style({
    marginLeft: 'auto',
    padding: '2px 7px',
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 700,
    whiteSpace: 'nowrap',
});

export const regimeBull = style({ background: 'rgba(251,113,133,0.16)', color: up });
export const regimeBear = style({ background: 'rgba(239,68,68,0.22)', color: '#fca5a5' });
export const regimeNeutral = style({ background: 'rgba(148,163,184,0.15)', color: muted });

export const iconBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 5,
    border: `1px solid ${border}`,
    background: 'transparent',
    color: muted,
    cursor: 'pointer',
    selectors: { '&:hover': { color: '#fff', borderColor: '#36414f' } },
});

const spin = keyframes({ to: { transform: 'rotate(360deg)' } });
export const spinning = style({ animation: `1s ${spin} linear infinite` });

export const updatedAt = style({
    padding: '3px 9px',
    fontSize: 10.5,
    color: muted,
    borderBottom: `1px solid ${border}`,
    flex: '0 0 auto',
});

export const scroll = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
});

const gridCols =
    '26px minmax(58px,1.5fr) 52px 48px 40px 38px 40px minmax(56px,1fr)';

export const head = style({
    display: 'grid',
    gridTemplateColumns: gridCols,
    alignItems: 'center',
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: panelBg,
    color: muted,
    fontSize: 10.5,
    padding: '5px 8px',
    borderBottom: `1px solid ${border}`,
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: gridCols,
    alignItems: 'center',
    padding: '5px 8px',
    borderBottom: '1px solid rgba(35,42,54,0.6)',
    cursor: 'pointer',
    selectors: {
        '&:hover': { background: 'rgba(34,211,238,0.06)' },
    },
});

export const rowExcluded = style({ opacity: 0.5 });

export const rank = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 19,
    height: 19,
    borderRadius: '50%',
    fontSize: 10.5,
    fontWeight: 700,
    background: '#222a35',
    color: muted,
});
export const rank1 = style({ background: 'linear-gradient(135deg,#f5c451,#e8a93a)', color: '#3a2c05' });
export const rankTop = style({ background: 'rgba(251,113,133,0.18)', color: up });

export const nameCell = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    lineHeight: 1.2,
});
export const codeTxt = style({ fontWeight: 700, fontSize: 12 });
export const nameTxt = style({
    color: muted,
    fontSize: 10,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const num = style({
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});
export const upTxt = style({ color: up, fontWeight: 600 });
export const downTxt = style({ color: down, fontWeight: 600 });
export const volHot = style({ color: accent, fontWeight: 700 });

export const scoreCell = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    justifySelf: 'end',
    minWidth: 30,
    height: 20,
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 800,
    background: '#222a35',
    color: muted,
});
export const scoreHot = style({ background: 'rgba(251,113,133,0.18)', color: up });
export const scoreWarm = style({ background: 'rgba(251,191,36,0.16)', color: warn });

export const statusCell = style({
    textAlign: 'center',
    fontSize: 10.5,
    fontWeight: 700,
});
export const statusStrong = style({ color: up });
export const statusBuild = style({ color: warn });
export const statusWait = style({ color: muted });
export const statusExcl = style({ color: '#fca5a5' });

export const patternCell = style({
    fontSize: 10.5,
    color: '#c3cad6',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const stateBox = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: '100%',
    minHeight: 120,
    color: muted,
    fontSize: 12,
});

/* 多空切換 segmented */
export const segWrap = style({
    display: 'inline-flex',
    padding: 2,
    borderRadius: 6,
    border: `1px solid ${border}`,
    background: '#10141b',
    flex: '0 0 auto',
});
export const seg = style({
    padding: '2px 9px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    color: muted,
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    selectors: { '&:hover': { color: '#fff' } },
});
export const segActiveLong = style({
    background: 'rgba(251,113,133,0.20)',
    color: up,
});
export const segActiveShort = style({
    background: 'rgba(74,222,128,0.18)',
    color: down,
});

export const rankTopShort = style({
    background: 'rgba(74,222,128,0.18)',
    color: down,
});
export const scoreHotShort = style({
    background: 'rgba(74,222,128,0.16)',
    color: down,
});
export const statusStrongShort = style({ color: down });
