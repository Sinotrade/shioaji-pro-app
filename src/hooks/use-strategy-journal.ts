import { useCallback, useEffect, useRef, useState } from 'react';
import {
    exportStrategyJournal, importStrategyJournal, listStrategyFrames,
    loadStrategyFrame, subscribeStrategyJournal,
} from '../lib/strategy-journal';
import type { JournalSummary, StrategyFrame } from '../lib/strategy-lab-types';

/** Local durable journal only. Scanning and brokerage requests belong to the parent. */
export function useStrategyJournal(enabled = true) {
    const [summaries, setSummaries] = useState<JournalSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const active = useRef(false);
    const request = useRef(0);
    const refresh = useCallback(async () => {
        if (!active.current) return;
        const current = ++request.current;
        setLoading(true);
        try {
            const next = await listStrategyFrames();
            if (active.current && current === request.current) {
                setSummaries(next);
                setError(null);
            }
        } catch (reason) {
            if (active.current && current === request.current) {
                setError(reason instanceof Error ? reason.message : String(reason));
            }
        } finally {
            if (active.current && current === request.current) setLoading(false);
        }
    }, []);
    useEffect(() => {
        active.current = enabled;
        if (!enabled) return;
        const unsubscribe = subscribeStrategyJournal(() => { void refresh(); });
        void refresh();
        return () => { active.current = false; request.current++; unsubscribe(); };
    }, [enabled, refresh]);
    const load = useCallback(async (ids: string[]): Promise<StrategyFrame[]> => {
        if (!ids.length) throw new Error('請先選擇至少一筆掃描日誌。');
        const frames = await Promise.all([...new Set(ids)].map(loadStrategyFrame));
        if (new Set(frames.map(frame => frame.sourceKey)).size !== 1) {
            throw new Error('不同資料來源不可混合回放，請重新選擇。');
        }
        return frames.sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
    }, []);
    const importJson = useCallback(async (text: string) => {
        const count = await importStrategyJournal(text);
        await refresh();
        return count;
    }, [refresh]);
    return { summaries, loading, error, refresh, load, importJson, exportJson: exportStrategyJournal };
}
