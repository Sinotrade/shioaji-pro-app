import { useEffect, useMemo, useState } from 'react';
import { onAnyTick } from '../lib/stream';
import type { SecurityType } from '../lib/types/contract';
import { wallClockToUtc } from '../lib/utils/kbars';
import { V9FlowTracker } from '../lib/utils/v9-chart-markers';

/** Observes the existing shared stream only. It never logs in, subscribes to
 * extra instruments, requests history, or changes the recorder. */
export function useV9ResearchFlow(code: string, securityType: SecurityType, minutes: number, enabled: boolean, sourceScope = code) {
    const tracker = useMemo(() => new V9FlowTracker(securityType), [code, securityType, enabled, sourceScope]);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = onAnyTick(tick => {
            if (tick.code !== code || tick.simtrade || tick.intraday_odd) return;
            const fraction = Number(`0.${tick.time.split('.')[1] ?? '0'}`);
            const accepted = tracker.push({
                time: wallClockToUtc(`${tick.date}T${tick.time}`) + fraction,
                volume: tick.volume, tickType: tick.tick_type,
                id: `${tick.date}|${tick.time}|${tick.total_volume}`,
            });
            if (accepted && timer === undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    setVersion(value => value + 1);
                }, 250);
            }
        });
        return () => {
            off();
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [code, tracker, enabled]);
    return useMemo(() => tracker.snapshot(minutes), [tracker, minutes, version]);
}
