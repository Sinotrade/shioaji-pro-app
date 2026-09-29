// src/hooks/use-radar.ts — multi-symbol V9 radar.
// Loads a bounded 1-minute kbar window per symbol (concurrency-capped,
// shared chart-history cache), polls snapshots for live price, derives the
// four-timeframe V9 resonance for every symbol, and emits "flip / aligned"
// events when a timeframe changes side. Read-only: it never places orders.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    fetchChartHistory,
    nextChartHistoryRevision,
} from '../lib/chart-history';
import { fetchSnapshots } from '../lib/shioaji';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle, Snapshot } from '../lib/types/market';
import {
    dateStrOffset,
    kbarsToCandles,
    nowWallClockUtc,
} from '../lib/utils/kbars';
import { getDailyCandles } from '../lib/daily-candles';
import {
    v9Resonance,
    type V9Resonance,
    type V9ResonanceSide,
} from '../lib/utils/research-chart';

export interface RadarEvent {
    id: string;
    code: string;
    name: string;
    time: number;
    kind: 'flip' | 'aligned';
    frame?: string;
    from?: V9ResonanceSide;
    to?: V9ResonanceSide;
    text: string;
}

export type BarsState = 'loading' | 'ready' | 'error';

export interface RadarRow {
    code: string;
    name: string;
    securityType: ContractInfo['security_type'];
    candles: Candle[];
    resonance?: V9Resonance;
    snapshot?: Snapshot;
    barsState: BarsState;
}

// 60 calendar days ≈ 40 trading days → 1/5/60m frames reach the 117-bar
// requirement; the daily frame stays "insufficient" (needs ~170 days).
const LOOKBACK_DAYS = 60;
const SNAP_MS = 12_000;
const REFRESH_BARS_MS = 90_000;
const CONCURRENCY = 4;
export const RADAR_MAX_ROWS = 20;

export function sideLabel(side: V9ResonanceSide): string {
    return side === 'long' ? '多'
        : side === 'short' ? '空'
            : side === 'neutral' ? '中' : '不足';
}

export function useRadar(contracts: ContractInfo[]) {
    const list = useMemo(
        () => contracts.slice(0, RADAR_MAX_ROWS),
        [contracts],
    );
    const codeKey = list.map((c) => c.code).join(',');
    const listRef = useRef(list);
    listRef.current = list;

    const [candlesByCode, setCandlesByCode] = useState<Record<string, Candle[]>>({});
    const candlesRef = useRef(candlesByCode);
    const [dailyByCode, setDailyByCode] = useState<Record<string, Candle[]>>({});
    const [barsStateByCode, setBarsStateByCode] = useState<Record<string, BarsState>>({});
    const [snapByCode, setSnapByCode] = useState<Record<string, Snapshot>>({});
    const [events, setEvents] = useState<RadarEvent[]>([]);
    const [flashCodes, setFlashCodes] = useState<Record<string, number>>({});
    const [notifyOn, setNotifyOn] = useState(true);
    const notifyRef = useRef(notifyOn);
    notifyRef.current = notifyOn;

    const prevSideRef = useRef<Record<string, Record<number, V9ResonanceSide>>>({});
    const prevSummaryRef = useRef<Record<string, string>>({});

    const loadBars = useCallback(async (items: ContractInfo[], revision: number) => {
        const queue = [...items];
        const worker = async () => {
            while (queue.length > 0) {
                const contract = queue.shift();
                if (!contract) break;
                setBarsStateByCode((prev) => ({
                    ...prev,
                    [contract.code]: prev[contract.code] ?? 'loading',
                }));
                try {
                    const kbars = await fetchChartHistory(
                        contract,
                        dateStrOffset(LOOKBACK_DAYS),
                        dateStrOffset(0),
                        { revision },
                    );
                    const candles = kbarsToCandles(kbars);
                    candlesRef.current = { ...candlesRef.current, [contract.code]: candles };
                    setCandlesByCode(candlesRef.current);
                    setBarsStateByCode((prev) => ({ ...prev, [contract.code]: 'ready' }));
                } catch {
                    // a refresh failure must not downgrade an already-loaded symbol
                    setBarsStateByCode((prev) => ({
                        ...prev,
                        [contract.code]: candlesRef.current[contract.code]?.length
                            ? 'ready'
                            : 'error',
                    }));
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
        );
    }, []);

    // Daily feed for the D frame (~180 calendar days, IDB-cached; getDailyCandles
    // has its own global concurrency/IDB gate). A slow refresh updates the
    // partial day without re-pulling the full history.
    const DAILY_LOOKBACK = 180;
    const DAILY_REFRESH_MS = 300_000;
    const loadDaily = useCallback(async (items: ContractInfo[]) => {
        await Promise.all(
            items.map(async (contract) => {
                try {
                    const daily = await getDailyCandles(contract, {
                        calendarDays: DAILY_LOOKBACK,
                    });
                    setDailyByCode((prev) => ({
                        ...prev,
                        [contract.code]: daily,
                    }));
                } catch {
                    // keep the last good daily set; a miss leaves D as before
                }
            }),
        );
    }, []);

    // initial bar load whenever the symbol set changes
    useEffect(() => {
        if (list.length === 0) return;
        void loadBars(list, nextChartHistoryRevision());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeKey, loadBars]);

    // daily load on symbol-set change + slow incremental refresh
    useEffect(() => {
        if (list.length === 0) return;
        void loadDaily(list);
        const id = setInterval(() => {
            void loadDaily(listRef.current);
        }, DAILY_REFRESH_MS);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeKey, loadDaily]);

    // intraday bar refresh (new revision bypasses the cache)
    useEffect(() => {
        const id = setInterval(() => {
            void loadBars(listRef.current, nextChartHistoryRevision());
        }, REFRESH_BARS_MS);
        return () => clearInterval(id);
    }, [loadBars]);

    // snapshot polling — one request carries every contract
    useEffect(() => {
        if (list.length === 0) return;
        let stopped = false;
        const pull = () => {
            fetchSnapshots(listRef.current)
                .then((snaps) => {
                    if (stopped) return;
                    const next: Record<string, Snapshot> = {};
                    for (const s of snaps) next[s.code] = s;
                    setSnapByCode((prev) => ({ ...prev, ...next }));
                })
                .catch(() => undefined);
        };
        pull();
        const id = setInterval(pull, SNAP_MS);
        return () => {
            stopped = true;
            clearInterval(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeKey]);

    const rows = useMemo<RadarRow[]>(
        () =>
            list.map((contract) => {
                const candles = candlesByCode[contract.code] ?? [];
                return {
                    code: contract.code,
                    name: contract.name || contract.code,
                    securityType: contract.security_type,
                    candles,
                    resonance: candles.length
                        ? v9Resonance(
                              candles,
                              contract.security_type,
                              nowWallClockUtc(),
                              dailyByCode[contract.code],
                          )
                        : undefined,
                    snapshot: snapByCode[contract.code],
                    barsState: barsStateByCode[contract.code] ?? 'loading',
                };
            }),
        [list, candlesByCode, snapByCode, barsStateByCode, dailyByCode],
    );

    // diff resonance → flip / aligned events
    useEffect(() => {
        const created: RadarEvent[] = [];
        const flash: Record<string, number> = {};
        const now = Date.now();
        for (const row of rows) {
            const resonance = row.resonance;
            if (!resonance) continue;
            const sides = prevSideRef.current[row.code] ?? {};
            for (const frame of resonance.frames) {
                const prev = sides[frame.minutes];
                if (
                    prev !== undefined &&
                    prev !== frame.side &&
                    prev !== 'insufficient' &&
                    frame.side !== 'insufficient'
                ) {
                    created.push({
                        id: `${row.code}-${frame.minutes}-${now}-${Math.random().toString(36).slice(2, 6)}`,
                        code: row.code,
                        name: row.name,
                        time: now,
                        kind: 'flip',
                        frame: frame.label,
                        from: prev,
                        to: frame.side,
                        text: `${row.name} ${frame.label} ${sideLabel(prev)}→${sideLabel(frame.side)}`,
                    });
                    flash[row.code] = now;
                }
                sides[frame.minutes] = frame.side;
            }
            prevSideRef.current[row.code] = sides;

            const prevSummary = prevSummaryRef.current[row.code];
            if (
                (resonance.summary === '四週期同多' ||
                    resonance.summary === '四週期同空') &&
                prevSummary !== resonance.summary
            ) {
                created.push({
                    id: `${row.code}-align-${now}-${Math.random().toString(36).slice(2, 6)}`,
                    code: row.code,
                    name: row.name,
                    time: now,
                    kind: 'aligned',
                    text: `${row.name} ${resonance.summary}`,
                });
                flash[row.code] = now;
            }
            prevSummaryRef.current[row.code] = resonance.summary;
        }
        if (created.length > 0) {
            setEvents((prev) => [...created, ...prev].slice(0, 80));
            setFlashCodes((prev) => ({ ...prev, ...flash }));
            if (notifyRef.current) {
                for (const event of created) {
                    notify({
                        kind: 'info',
                        title: event.kind === 'aligned' ? '🎯 雷達共振' : '🔔 雷達轉折',
                        body: event.text,
                    });
                }
            }
        }
    }, [rows]);

    const refresh = useCallback(() => {
        void loadBars(listRef.current, nextChartHistoryRevision());
    }, [loadBars]);

    return {
        rows,
        events,
        flashCodes,
        refresh,
        notifyOn,
        setNotifyOn,
    };
}
