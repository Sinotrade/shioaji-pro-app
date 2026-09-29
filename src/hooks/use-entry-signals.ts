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
import type { ContractBase } from '../lib/types/contract';

export interface EntrySignalsSet {
    long: EntrySignal[];
    short: ShortSignal[];
}

export function useEntrySignals(contract: ContractBase): EntrySignalsSet {
    const [signals, setSignals] = useState<EntrySignalsSet>({
        long: [],
        short: [],
    });
    const key = dailyKey(contract);

    useEffect(() => {
        let cancelled = false;
        setSignals({ long: [], short: [] });
        getDailyCandles(contract)
            .then((daily) => {
                if (!cancelled)
                    setSignals({
                        long: collectEntrySignals(daily),
                        short: collectShortSignals(daily),
                    });
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [key, contract]);

    return signals;
}
