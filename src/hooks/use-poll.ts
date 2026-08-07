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
    const run = useCallback(async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            const d = await fetcherRef.current();
            setData(d);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            inFlight.current = false;
        }
    }, []);

    useEffect(() => {
        run();
        const t = setInterval(run, intervalMs);
        return () => clearInterval(t);
    }, [run, intervalMs]);

    return { data, error, refresh: run };
}
