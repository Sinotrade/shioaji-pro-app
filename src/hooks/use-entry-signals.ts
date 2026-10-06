// src/hooks/use-entry-signals.ts — 取該商品日 K 的歷史進場信號（多方＋空方）。
// 日 K 由 daily-candles 快取提供（首次拉、之後增量），信號口徑與選股面板一致。

import { useEffect, useState } from 'react';
import { dailyKey, getDailyCandles } from '../lib/daily-candles';
import {
    collectEntrySignals,
    collectShortSignals,
    type EntrySignal,
    type ShortSignal,
} from '../lib/stock-picker';
import type { ContractBase, SecurityType } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { completedResearchBars } from '../lib/utils/v9-chart-markers';
import { nowWallClockUtc } from '../lib/utils/kbars';

export interface EntrySignalsSet {
    long: EntrySignal[];
    short: ShortSignal[];
}

const EMPTY_ENTRY_SIGNALS: EntrySignalsSet = { long: [], short: [] };

/** Freeze the eligible daily set at load time. A morning partial candle must
 * not be promoted to 'confirmed' merely because the local clock reaches
 * 13:30/13:45; a subsequent explicit load must first supply the closed data.
 * The scoring formulas and automatic-fetch cadence remain unchanged.
 */
export function confirmedDailySignals(daily: Candle[], securityType: SecurityType, now: number): EntrySignalsSet {
    const completed = completedResearchBars(daily, 1440, now, securityType);
    return { long: collectEntrySignals(completed), short: collectShortSignals(completed) };
}

export function useEntrySignals(contract: ContractBase): EntrySignalsSet {
    const [signals, setSignals] = useState<EntrySignalsSet & { key: string }>({
        key: '',
        long: [],
        short: [],
    });
    const key = dailyKey(contract);

    useEffect(() => {
        let cancelled = false;
        setSignals({ key, long: [], short: [] });
        getDailyCandles(contract, { completedOnly: true })
            .then((daily) => {
                if (!cancelled)
                    setSignals({
                        key,
                        ...confirmedDailySignals(daily, contract.security_type, nowWallClockUtc()),
                    });
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [key, contract]);

    return signals.key === key ? signals : EMPTY_ENTRY_SIGNALS;
}
