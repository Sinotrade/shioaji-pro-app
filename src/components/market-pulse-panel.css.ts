import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    position: 'relative',
    containerType: 'inline-size',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    flex: 1,
    fontSize: '0.7rem',
    overflow: 'hidden',
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
export const marketBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    height: '20px',
    padding: '0 7px',
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
    fontWeight: 600,
    whiteSpace: 'nowrap',
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
export const signalRuleFilters = style({
    position: 'absolute',
    top: '34px',
    left: vars.space.sm,
    zIndex: 101,
    display: 'flex',
    flexDirection: 'column',
    width: `calc(100% - ${vars.space.md})`,
    maxWidth: '720px',
    maxHeight: 'min(360px, calc(100% - 42px))',
    boxSizing: 'border-box',
    padding: 0,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.38)',
    overflow: 'auto',
});
export const signalRuleMenuHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: '34px',
    padding: `0 ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
});
export const signalRuleMenuTitle = style({
    fontSize: '0.72rem',
    color: vars.color.foreground,
});
export const signalRuleMenuSummary = style({
    color: vars.color.mutedForeground,
});
export const signalRuleClear = style({
    marginLeft: 'auto',
    padding: 0,
    border: 0,
    color: vars.color.accent,
    background: 'transparent',
    font: 'inherit',
    cursor: 'pointer',
    ':disabled': {
        opacity: 0.4,
        cursor: 'default',
    },
});
export const signalMarketSection = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
});
export const signalSectionToggle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    width: '100%',
    margin: 0,
    padding: 0,
    border: 0,
    color: vars.color.mutedForeground,
    background: 'transparent',
    fontSize: '0.65rem',
    fontWeight: 600,
    cursor: 'pointer',
});
export const signalMarketOptions = style({
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
    minHeight: '22px',
    marginTop: vars.space.sm,
});
export const signalRuleDivider = style({
    height: '1px',
    margin: `0 ${vars.space.md}`,
    background: vars.color.border,
});
export const signalRulesHeading = style({
    margin: 0,
    padding: `${vars.space.sm} ${vars.space.md} 0`,
    color: vars.color.mutedForeground,
    fontSize: '0.65rem',
});
export const signalRuleGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))',
    gap: `${vars.space.md} 24px`,
    padding: vars.space.md,
    '@container': {
        '(max-width: 560px)': {
            gridTemplateColumns: '1fr',
        },
    },
});
export const signalRuleBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 100,
    padding: 0,
    border: 0,
    background: 'transparent',
    cursor: 'default',
});
export const signalRuleGroup = style({
    minWidth: 0,
    margin: 0,
    padding: 0,
    border: 0,
    color: vars.color.foreground,
});
export const signalRuleLegend = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: '2px',
    color: vars.color.mutedForeground,
    fontWeight: 600,
});
export const signalRuleGroupToggle = style({
    padding: 0,
    border: 0,
    color: vars.color.accent,
    background: 'transparent',
    font: 'inherit',
    cursor: 'pointer',
});
export const signalRuleCollapseToggle = style({
    display: 'inline-flex',
    flex: 1,
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    padding: 0,
    border: 0,
    color: 'inherit',
    background: 'transparent',
    font: 'inherit',
    cursor: 'pointer',
});
export const signalGroupCount = style({
    marginLeft: 'auto',
    color: vars.color.accent,
    font: 'inherit',
});
export const signalRuleOption = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: '20px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
});
export const signalRuleOptions = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(100px, 1fr))',
    gap: '5px 14px',
});
export const signalRuleCheckbox = style({
    width: '12px',
    height: '12px',
    margin: 0,
    accentColor: vars.color.accent,
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
    flexWrap: 'wrap',
    alignItems: 'baseline',
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    columnGap: vars.space.sm,
    rowGap: '5px',
    padding: `8px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    fontVariantNumeric: 'tabular-nums',
});
export const summaryMetric = style({
    display: 'inline-flex',
    flex: '0 0 auto',
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
export const sectionWorkspace = style({
    display: 'flex',
    flex: 1,
    width: '100%',
    minWidth: 0,
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
});
export const section = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: '220px',
    minHeight: 0,
    overflow: 'hidden',
});
export const sectionDivider = style({
    position: 'relative',
    width: '7px',
    flex: '0 0 7px',
    cursor: 'col-resize',
    touchAction: 'none',
    outline: 'none',
    background: vars.color.border,
    selectors: {
        '&::after': {
            content: '',
            position: 'absolute',
            inset: '0 2px',
            background: vars.color.panel,
        },
        '&:hover, &:focus-visible': {
            background: vars.color.accent,
        },
    },
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
export const sectionHeadingTitle = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: vars.space.xs,
    whiteSpace: 'nowrap',
});
export const stockTableHeading = style({
    display: 'grid',
    gridTemplateColumns: '1.5rem minmax(0, 1fr) 5.75rem 4.25rem',
    alignItems: 'baseline',
    gap: vars.space.xs,
    padding: `5px ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontWeight: 600,
    borderBottom: `1px solid ${vars.color.border}`,
});
export const stockTableTitle = style({
    gridColumn: '1 / 3',
});
export const stockTableTitleWide = style({
    gridColumn: '1 / -1',
});
export const stockTableColumn = style({
    justifySelf: 'end',
    fontFamily: vars.font.mono,
    fontSize: '0.57rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
});
export const headingToggleGroup = style({
    display: 'inline-flex',
    gap: '3px',
    marginLeft: vars.space.sm,
});
const headingToggleBase = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    background: 'transparent',
    fontFamily: vars.font.body,
    fontSize: '0.57rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
});
export const headingToggle = styleVariants({
    off: [headingToggleBase, { color: vars.color.mutedForeground }],
    on: [
        headingToggleBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});
export const sideColumns = style({
    display: 'flex',
    flex: 1,
    minHeight: 0,
});
export const sideColumn = style({
    display: 'flex',
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
});
export const sideColumnDivider = style({
    flex: '0 0 1px',
    background: vars.color.border,
});
export const sideHeader = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 4.4rem 3.8rem',
    alignItems: 'baseline',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontWeight: 600,
    fontSize: '0.61rem',
    borderBottom: `1px solid ${vars.color.border}`,
});
export const sideHeaderLabel = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.xs,
    minWidth: 0,
    whiteSpace: 'nowrap',
});
export const sideCount = style({
    fontFamily: vars.font.mono,
    fontWeight: 400,
});
export const sideList = style({ flex: 1, minHeight: 0, overflow: 'auto' });
const sideRowBase = style({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 4.4rem 3.8rem',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    color: vars.color.foreground,
    border: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    backgroundColor: 'transparent',
    backgroundImage: `linear-gradient(
        color-mix(in srgb, var(--bar-color) 15%, transparent),
        color-mix(in srgb, var(--bar-color) 15%, transparent)
    )`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: 'var(--bar-size, 0%) 100%',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    cursor: 'pointer',
    ':hover': { backgroundColor: vars.color.muted },
});
export const sideRow = styleVariants({
    up: [sideRowBase, { backgroundPosition: 'right center' }],
    down: [sideRowBase, { backgroundPosition: 'left center' }],
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
const rowButtonBase = style({
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '1.5rem minmax(0, 1fr) 5.75rem 4.25rem',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    color: vars.color.foreground,
    backgroundColor: 'transparent',
    backgroundRepeat: 'no-repeat',
    border: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    cursor: 'pointer',
    ':hover': { backgroundColor: vars.color.muted },
});
export const rowButton = rowButtonBase;
// 影響最大 magnitude bars live in the numeric columns only, growing out
// of the divider between 貢獻（點） and 漲跌幅 (the zero axis): gainers
// extend right of it, losers left. Fixed-width gradient images anchored
// with edge-offset syntax avoid background-position percentage semantics
// (percentages resolve against container minus image size).
const barFill = `color-mix(in srgb, var(--bar-color, transparent) 15%, transparent)`;
const barGradRight = `linear-gradient(to right, ${barFill} 0 var(--bar-size, 0rem), transparent var(--bar-size, 0rem))`;
const barGradLeft = `linear-gradient(to left, ${barFill} 0 var(--bar-size, 0rem), transparent var(--bar-size, 0rem))`;
// axis from the right edge: padding 0.5rem + 漲跌幅 4.25rem + half gap
export const impactRow = styleVariants({
    up: [
        rowButtonBase,
        {
            backgroundImage: barGradRight,
            backgroundSize: '4.375rem 100%',
            backgroundPosition: 'right 0.5rem center',
        },
    ],
    down: [
        rowButtonBase,
        {
            backgroundImage: barGradLeft,
            backgroundSize: '4.25rem 100%',
            backgroundPosition: 'right 4.875rem center',
        },
    ],
    flat: [rowButtonBase, {}],
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
    justifySelf: 'end',
    textAlign: 'right',
});
export const code = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '5px',
    minWidth: 0,
    textAlign: 'left',
    color: vars.color.foreground,
    fontFamily: vars.font.mono,
    fontWeight: 600,
});
export const stockName = style({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textAlign: 'left',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    fontWeight: 400,
    whiteSpace: 'nowrap',
});
export const points = style({
    justifySelf: 'end',
    textAlign: 'right',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});
export const pct = style({
    justifySelf: 'end',
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
    minHeight: '13.75rem',
    overflow: 'auto hidden',
    background: vars.color.inset,
});
export const sankey = style({
    display: 'block',
    minWidth: '35rem',
});
export const sankeyLinks = style({
    fill: 'none',
});
export const sankeyLink = style({
    strokeOpacity: 0.42,
    transition: 'stroke-opacity 120ms ease',
    ':hover': { strokeOpacity: 0.68 },
});
export const sankeyInteractiveNode = style({
    cursor: 'pointer',
    transition: 'filter 120ms ease',
    ':hover': { filter: 'brightness(1.25)' },
});
export const sankeyTableHeader = style({
    fill: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.55rem',
    fontWeight: 600,
});
export const sankeyLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    paintOrder: 'stroke',
    stroke: vars.color.inset,
    strokeWidth: '3px',
    strokeLinejoin: 'round',
});
export const sankeyValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 700,
});
export const sankeyPercent = style({
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    fontWeight: 500,
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
