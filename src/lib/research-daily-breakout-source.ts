import { dailyBarConfirmedAt } from './intraday-session';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';

/** The caller must read provenance-checked cache, never an unconfirmed live
 * aggregate. This is a time/identity gate, not proof of full-day completeness.
 * Chart dates encode Taiwan wall-clock as UTC, so add the explicit UTC+8
 * offset instead of depending on the computer/browser's local timezone. */
export function dailyBreakoutClosedSource(
    provenanceChecked: Candle[],
    contract: ContractBase,
    nowMs = Date.now(),
): Candle[] {
    if (contract.security_type !== 'STK'
        || (contract.region !== undefined && contract.region !== 'TW')
        || (contract.exchange !== 'TSE' && contract.exchange !== 'OTC')
        || !Number.isFinite(nowMs)) return [];
    const taipeiWall = Math.floor(nowMs / 1000) + 8 * 3600;
    // Do not delete a malformed label and join the dates around it into
    // an apparently complete price/volume window.
    if (provenanceChecked.some((c, i) => !Number.isSafeInteger(c.time)
        || c.time < 0 || c.time % 86400 !== 0
        || (i > 0 && c.time <= provenanceChecked[i - 1]!.time))) return [];
    return provenanceChecked
        .filter(c => dailyBarConfirmedAt(c.time, 'STK') <= taipeiWall)
        .map(c => ({ ...c }));
}
