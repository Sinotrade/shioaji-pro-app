import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';

// the content layer the glass refracts (liquid-glass.md › extend visually rich content beneath):
// accent family only (deep blue, a cooler cyan/teal) plus one warm neutral, peaking near the panel edges.
// light-dark(): the light theme gets lower peaks so dark text on the glass keeps its contrast.
const glow = (color: string, dark: number, light: number) =>
    `light-dark(color-mix(in srgb, ${color} ${light}%, transparent), color-mix(in srgb, ${color} ${dark}%, transparent))`;
const blue = vars.color.accent;
const teal = `color-mix(in srgb, ${vars.color.accent} 55%, ${vars.color.success})`;
const warm = `color-mix(in srgb, ${vars.color.amber} 30%, ${vars.color.mutedForeground})`;

export const root = style({
    position: 'fixed',
    inset: 0,
    zIndex: -1,
    overflow: 'hidden',
    pointerEvents: 'none',
});

const layer = style({
    position: 'absolute',
    inset: '-32px',
    willChange: 'transform',
});

export const far = style([layer, {
    transform: 'translate3d(calc(var(--login-px, 0) * -8px), calc(var(--login-py, 0) * -8px), 0)',
    background: [
        `radial-gradient(40% 46% at 8% 92%, ${glow(warm, 12, 16)}, transparent 70%)`,
        `radial-gradient(44% 38% at 62% 2%, ${glow(blue, 10, 6)}, transparent 70%)`,
    ].join(', '),
}]);

export const near = style([layer, {
    transform: 'translate3d(calc(var(--login-px, 0) * -16px), calc(var(--login-py, 0) * -16px), 0)',
    background: [
        `radial-gradient(30% 36% at 17% 14%, ${glow(blue, 26, 14)}, transparent 70%)`,
        `radial-gradient(28% 36% at 85% 74%, ${glow(teal, 22, 12)}, transparent 70%)`,
    ].join(', '),
}]);
