// src/components/portfolio-types.ts — the contract every 持股 variant renders from.

import type { FlipAlert, Grouping, PortfolioView } from '../lib/portfolio-sector';

export interface VariantProps {
    view: PortfolioView;
    grouping: Grouping;
    /** Latest completed minute slot (null before the first bar). */
    now: number | null;
    /** First slot received since the panel opened. */
    from: number | null;
    /** Trading date: resets any viewport ratchet. */
    session: string | null;
    /** Groups whose flow flipped on the latest minute (pulse once). */
    flips: ReadonlyMap<string, FlipAlert>;
    /** 遮金額: hide amounts (market value, P&L); ratios and % stay. */
    privacyMoney: boolean;
    reducedMotion: boolean;
    /** Panel hidden or scrolled away: no running animations. */
    paused: boolean;
    selectedGroup: string | null;
    onSelectGroup: (id: string | null) => void;
    /** Open the stock in linked panels. */
    onPick: (code: string) => void;
}
