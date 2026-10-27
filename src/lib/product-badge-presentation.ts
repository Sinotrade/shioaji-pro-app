import type { SecurityType } from './types/contract';

// Presentation only: these labels never establish a tradable identity.
export const PRODUCT_BADGES = {
    STK: { label: '股票', tint: 'accent' },
    ETF: { label: 'ETF', tint: 'amber', blend: 'foreground', tintPercent: 85 },
    FUT: { label: '期貨', tint: 'accent', blend: 'foreground', tintPercent: 75 },
    OPT: { label: '選擇權', tint: 'accent', blend: 'foreground', tintPercent: 50 },
    WRT: { label: '權證', tint: 'amber', blend: 'foreground', tintPercent: 25 },
    IND: { label: '指數', tint: 'mutedForeground' },
} as const;

export const PRODUCT_BADGE_ALPHA = { fill: 12, edge: 45 } as const;
export const PRODUCT_SEARCH_ACTIVE = { background: 'accentDim', color: 'foreground', indicator: 'accent' } as const;

export function productBadgeType(securityType: Exclude<SecurityType, null>, kind?: 'ETF'): keyof typeof PRODUCT_BADGES {
    return securityType === 'STK' && kind === 'ETF' ? 'ETF' : securityType;
}

export function productDetailText(detail: string, securityType: Exclude<SecurityType, null>, kind?: 'ETF'): string {
    const label = PRODUCT_BADGES[productBadgeType(securityType, kind)].label;
    if (detail === label) return '';
    const prefix = `${label} · `;
    return detail.startsWith(prefix) ? detail.slice(prefix.length) : detail;
}
