import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { getApiBase } from '../lib/runtime';

// Bounded, sequential reads; hidden views cancel only their own requests.
export function useMonitorResource<T>(path: string, enabled: boolean, interval: number, parse: (value: T) => T) {
    const base = getApiBase();
    const [state, setState] = useState<{ data: T | null; error: string; updated: number | null; base: string }>({ data: null, error: '', updated: null, base });
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        let controller: AbortController;
        setState({ data: null, error: '', updated: null, base });
        const refresh = async () => {
            controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
                const data = parse(await apiGet<T>(path, { signal: controller.signal, headers: { 'X-Shioaji-Activity': 'dashboard' } }));
                if (active) setState({ data, error: '', updated: Date.now(), base });
            } catch (error) {
                if (active) setState({ data: null, error: error instanceof Error ? error.message : String(error), updated: null, base });
            } finally {
                clearTimeout(timeout);
                if (active) timer = setTimeout(refresh, interval);
            }
        };
        void refresh();
        return () => { active = false; clearTimeout(timer); controller?.abort(); };
    }, [path, base, enabled, interval, parse]);
    return state.base === base ? state : { data: null, error: '', updated: null, base };
}
