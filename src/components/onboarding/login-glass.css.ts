import { createVar, globalStyle, keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { agentCard as upstreamAgentCard, card as upstreamCard, layout as upstreamLayout, importMessage as upstreamImportMessage, shell as upstreamShell } from '../onboarding-setup.css';

// liquid-glass.md › Tauri and Electron: regular glass, only on the two floating panels (and the mode-switch thumb)
export const glassBlur = 'blur(24px) saturate(1.45)';
export const reducedGlass = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';
export const supportsGlass = '(backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))';
// lowest panelRaised alpha in the 74–80% range whose worst case keeps every text style ≥ 4.5:1 (see the report numbers)
const GLASS_ALPHA = '74%';

// text on glass ("vibrant" labels, materials.md): muted / danger / link pulled 30% toward the foreground,
// which raises contrast in both themes; the theme value is captured on the parent so the override isn't self-referencing
const base = { muted: createVar(), danger: createVar() };
const onGlass = (color: string) => `color-mix(in srgb, ${color} 70%, ${vars.color.foreground})`;
export const linkText = onGlass(vars.color.accent);

const solid = { background: vars.color.panelRaised, WebkitBackdropFilter: 'none', backdropFilter: 'none', borderColor: vars.color.borderBright };

// 透光: a soft accent-tinted light leak that follows the pointer-parallax vars, plus a faint sheen from the top edge.
// light-dark(): white light helps dark text, so the dark theme gets the quieter values.
const leakTint = `color-mix(in srgb, ${vars.color.accent} 22%, white)`;
const leak = `light-dark(color-mix(in srgb, ${leakTint} 8%, transparent), color-mix(in srgb, ${leakTint} 4%, transparent))`;
const sheen = 'light-dark(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.025))';
const leakAt = 'calc(50% + var(--login-px, 0) * 32%) calc(14% + var(--login-py, 0) * 20%)';

const rise = keyframes({ from: { opacity: 0, transform: 'translateY(8px)' } });

export const layout = style({
    vars: { [base.muted]: vars.color.mutedForeground, [base.danger]: vars.color.danger },
    selectors: { [`${upstreamLayout}&`]: { marginTop: 'clamp(16px, 8vh, 72px)', marginBottom: 'auto' } },
});

// DEV: scroll instead of clipping when the cards are taller than the viewport (layout's auto margins keep the top reachable)
export const shell = style({ selectors: { [`${upstreamShell}&`]: { overflowY: 'auto' } } });

// chained with the upstream class so the glass wins regardless of CSS emit order
const glassOver = (upstream: string, extra: Record<string, unknown> = {}) => {
    const self = `${upstream}&`;
    return style({
        vars: { [vars.color.mutedForeground]: onGlass(base.muted), [vars.color.danger]: onGlass(base.danger) },
        selectors: {
            [self]: {
                position: 'relative',
                isolation: 'isolate',
                borderRadius: 16,
                borderColor: `color-mix(in srgb, ${vars.color.borderBright} 55%, transparent)`,
                boxShadow: [
                    'inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.1))',
                    `0 24px 64px light-dark(rgba(15, 23, 42, 0.14), color-mix(in srgb, ${vars.color.accent} 16%, rgba(0, 0, 0, 0.45)))`,
                ].join(', '),
                animation: `${rise} 240ms cubic-bezier(0.2, 0, 0, 1)`,
            },
            [`${self}::before`]: {
                content: '""',
                position: 'absolute',
                inset: 0,
                zIndex: -1,
                borderRadius: 'inherit',
                pointerEvents: 'none',
                background: `radial-gradient(70% 55% at ${leakAt}, ${leak}, transparent 70%), linear-gradient(${sheen}, transparent 35%)`,
            },
        },
        '@supports': {
            [supportsGlass]: {
                selectors: {
                    [self]: {
                        background: `color-mix(in srgb, ${vars.color.panelRaised} ${GLASS_ALPHA}, transparent)`,
                        WebkitBackdropFilter: glassBlur,
                        backdropFilter: glassBlur,
                    },
                },
            },
        },
        '@media': {
            // opaque panels let no light through, so the leak goes too
            [reducedGlass]: { selectors: { [`${upstream}${self}`]: solid, [`${self}::before`]: { display: 'none' } } },
            '(prefers-reduced-motion: reduce)': { selectors: { [self]: { animation: 'none' } } },
            ...extra,
        },
    });
};

export const card = glassOver(upstreamCard, {
    '(max-width: 480px)': { selectors: { [`${upstreamCard}&`]: { padding: vars.space.lg } } },
});
globalStyle(`${card} ${upstreamImportMessage.ok}`, { color: linkText });

// DEV: match the login card's height instead of the upstream fixed height
export const agentCard = style([
    glassOver(upstreamAgentCard),
    {
        // the browser preview's FeatureGate reads these names with dark-only fallbacks
        vars: { '--foreground': vars.color.foreground, '--muted-foreground': vars.color.mutedForeground, '--accent': linkText },
        selectors: { [`${upstreamAgentCard}&`]: { height: 'auto', minHeight: 'min(38rem, 86vh)' } },
    },
]);
