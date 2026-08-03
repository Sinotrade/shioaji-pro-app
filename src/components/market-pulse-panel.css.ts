import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
    fontSize: '0.7rem',
});
export const tabs = style({
    display: 'flex',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
});
const tabBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    flex: 1,
    padding: '4px 8px',
    border: 0,
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    cursor: 'pointer',
});
export const tab = styleVariants({
    off: [
        tabBase,
        { color: vars.color.mutedForeground, background: 'transparent' },
    ],
    on: [
        tabBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
            fontWeight: 600,
        },
    ],
});
export const controls = style({
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    minHeight: '30px',
    overflowX: 'auto',
});
const controlBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.body,
    fontSize: '0.63rem',
    cursor: 'pointer',
});
export const control = styleVariants({
    off: [
        controlBase,
        { color: vars.color.mutedForeground, background: 'transparent' },
    ],
    on: [
        controlBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});
export const spacer = style({ flex: 1 });
export const controlDivider = style({
    width: '1px',
    height: '16px',
    margin: '0 2px',
    flex: '0 0 auto',
    background: vars.color.border,
});
export const live = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});
export const liveDot = style({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: vars.color.success,
});
export const liveDotPartial = style({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: vars.color.amber,
});
export const error = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: `4px ${vars.space.sm}`,
    color: vars.color.danger,
    background: `color-mix(in srgb, ${vars.color.danger} 12%, transparent)`,
});
export const gap = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: `4px ${vars.space.sm}`,
    color: vars.color.amber,
    borderBottom: `1px solid ${vars.color.border}`,
});
export const summary = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    padding: `8px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    fontVariantNumeric: 'tabular-nums',
    overflowX: 'auto',
});
export const summaryMetric = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '6px',
    whiteSpace: 'nowrap',
});
export const metricDivider = style({
    width: '1px',
    height: '20px',
    flex: '0 0 auto',
    alignSelf: 'center',
    background: vars.color.border,
});
export const summaryLabel = style({ color: vars.color.mutedForeground });
export const summaryValue = style({
    fontFamily: vars.font.mono,
    fontSize: '1rem',
});
export const change = style({
    fontFamily: vars.font.mono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});
export const metricValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
});
export const contractCode = style({
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '0.57rem',
});
export const simtrade = style({
    color: vars.color.amber,
    border: `1px solid ${vars.color.amber}`,
    borderRadius: vars.radius.sm,
    padding: '0 4px',
});
export const time = style({
    fontFamily: vars.font.mono,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});
export const columns = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(11rem, .78fr) minmax(16rem, 1.22fr)',
    flex: 1,
    minHeight: 0,
    '@media': { '(max-width: 720px)': { gridTemplateColumns: '1fr' } },
});
export const section = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    selectors: { '& + &': { borderLeft: `1px solid ${vars.color.border}` } },
});
export const flowSection = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
});
export const sectionTitle = style({
    padding: `5px ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontWeight: 600,
    borderBottom: `1px solid ${vars.color.border}`,
});
export const sectionHeading = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    padding: `5px ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontWeight: 600,
    borderBottom: `1px solid ${vars.color.border}`,
});
export const areaLegend = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontSize: '0.57rem',
    fontWeight: 400,
});
export const list = style({ flex: 1, overflow: 'auto' });
export const rowButton = style({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '1.5rem 4rem minmax(5rem, 1fr) minmax(4rem, auto)',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    color: vars.color.foreground,
    background: 'transparent',
    border: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});
export const treemap = style({
    position: 'relative',
    flex: 1,
    minHeight: 0,
    margin: '3px',
    overflow: 'hidden',
});
export const treemapTile = style({
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '5px 6px',
    color: vars.color.foreground,
    background: `color-mix(in srgb, var(--heat-color) var(--heat-alpha), ${vars.color.panel})`,
    border: `1px solid color-mix(in srgb, var(--heat-color) 58%, ${vars.color.border})`,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    transition: 'filter 120ms ease',
    ':hover': { filter: 'brightness(1.16)' },
});
export const rank = style({
    color: vars.color.mutedForeground,
    textAlign: 'right',
});
export const code = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '5px',
    minWidth: 0,
    color: vars.color.foreground,
    fontFamily: vars.font.mono,
    fontWeight: 600,
});
export const stockName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    fontWeight: 400,
    whiteSpace: 'nowrap',
});
export const points = style({
    textAlign: 'right',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});
export const pct = style({
    textAlign: 'right',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});
export const treemapName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
});
export const treemapPoints = style({
    alignSelf: 'flex-end',
    fontFamily: vars.font.mono,
    fontSize: '0.84rem',
    color: 'var(--heat-color)',
});
export const treemapShare = style({
    alignSelf: 'flex-end',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '0.57rem',
});
export const sankeyViewport = style({
    position: 'relative',
    flex: 1,
    minHeight: '220px',
    overflow: 'auto hidden',
    background: vars.color.inset,
});
export const sankey = style({
    display: 'block',
    minWidth: '560px',
});
export const sankeyLinks = style({
    fill: 'none',
    mixBlendMode: 'screen',
});
export const sankeyLink = style({
    strokeOpacity: 0.28,
    transition: 'stroke-opacity 120ms ease',
    ':hover': { strokeOpacity: 0.68 },
});
export const sankeyInteractiveNode = style({
    cursor: 'pointer',
    transition: 'filter 120ms ease',
    ':hover': { filter: 'brightness(1.25)' },
});
export const sankeyLabel = style({
    fontFamily: vars.font.body,
    fontSize: '10px',
    fontWeight: 600,
    paintOrder: 'stroke',
    stroke: vars.color.inset,
    strokeWidth: '3px',
    strokeLinejoin: 'round',
});
export const sankeyValue = style({
    fill: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '9px',
    fontWeight: 400,
});
export const empty = style({
    padding: '1.25rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
});
export const signalHeader = style({
    display: 'grid',
    gridTemplateColumns: '4.8rem 3rem 4rem minmax(5.5rem, 1fr) 5rem 5rem',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    fontSize: '0.61rem',
});
export const signalList = style({ flex: 1, minHeight: 0, overflow: 'auto' });
export const signalRow = style({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '4.8rem 3rem 4rem minmax(5.5rem, 1fr) 5rem 5rem',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    color: vars.color.foreground,
    background: 'transparent',
    border: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    textAlign: 'left',
    fontFamily: vars.font.body,
    fontSize: '0.67rem',
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});
export const exchange = style({
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
});
export const detail = style({
    textAlign: 'right',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});
export const price = style({
    textAlign: 'right',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});
