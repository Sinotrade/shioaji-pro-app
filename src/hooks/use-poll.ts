// src/hooks/use-poll.ts — poll an async fetcher on an interval, with a
// manual refresh trigger (e.g. after an order event).

import { useCallback, useEffect, useRef, useState } from 'react';

export function usePoll<T>(
    fetcher: () => Promise<T>,
    intervalMs: number,
): { data: T | undefined; error: string | null; refresh: () => void } {
    const [data, setData] = useState<T>();
    const [error, setError] = useState<string | null>(null);
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    // skip ticks while one is still in flight — overlapping fetches pile up
    // exactly when the backend is slow, congesting plugin-http until even
    // probes against a live server time out
    const inFlight = useRef(false);
    // manual refresh during an in-flight fetch must not be dropped — the
    // caller usually just swapped the fetcher (scope/market switch) and a
    // swallowed refresh would show stale-scope data until the next tick.
    // Queue exactly one trailing rerun instead (interval ticks still skip).
    const queued = useRef(false);
    const run = useCallback(async (force = false) => {
        if (inFlight.current) {
            if (force) queued.current = true;
            return;
        }
        inFlight.current = true;
        try {
            do {
                queued.current = false;
                try {
                    const d = await fetcherRef.current();
                    setData(d);
                    setError(null);
                } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                }
            } while (queued.current);
        } finally {
            inFlight.current = false;
        }
    }, []);

    const refresh = useCallback(() => {
        void run(true);
    }, [run]);

    useEffect(() => {
        void run();
        const t = setInterval(() => void run(), intervalMs);
        return () => clearInterval(t);
    }, [run, intervalMs]);

    return { data, error, refresh };
}
