// Market Replay state + data loading (presentation-only, never sends orders).
// Replays a chosen historical date with real ticks: official 1-min kbars give
// exact candles (with warm-up), history ticks give aggressor delta/CVD.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchHistoryTicks, fetchKbars } from '../lib/shioaji';
import { kbarsToCandles, dateStrOffset } from '../lib/utils/kbars';
import { ticksToTrades, type OrderFlowTrade } from '../lib/order-flow';
import type { ContractBase } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';

export type ReplayStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ReplaySpeed = 1 | 5 | 20 | 100;
export const REPLAY_SPEEDS: ReplaySpeed[] = [1, 5, 20, 100];
const WARMUP_DAYS = 45;

export function shiftDateStr(date: string, deltaDays: number): string {
    const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export interface MarketReplay {
    enabled: boolean;
    date: string;
    playing: boolean;
    speed: ReplaySpeed;
    visibleTime: number;
    status: ReplayStatus;
    error: string;
    rawCandles: Candle[];
    trades: OrderFlowTrade[];
    dayStart: number;
    dayEnd: number;
    hasData: boolean;
    enable: (date?: string) => void;
    disable: () => void;
    togglePlay: () => void;
    setSpeed: (s: ReplaySpeed) => void;
    seek: (time: number) => void;
    setDate: (date: string) => void;
    prevDay: () => void;
    nextDay: () => void;
}

export function useMarketReplay(contract: ContractBase): MarketReplay {
    const [enabled, setEnabled] = useState(false);
    const [date, setDateState] = useState(() => dateStrOffset(1));
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeedState] = useState<ReplaySpeed>(20);
    const [visibleTime, setVisibleTime] = useState(0);
    const [status, setStatus] = useState<ReplayStatus>('idle');
    const [error, setError] = useState('');
    const [rawCandles, setRawCandles] = useState<Candle[]>([]);
    const [trades, setTrades] = useState<OrderFlowTrade[]>([]);
    const loadedKeyRef = useRef('');

    const enable = useCallback((initialDate?: string) => {
        if (initialDate) setDateState(initialDate);
        setEnabled(true);
    }, []);
    const disable = useCallback(() => {
        setEnabled(false);
        setPlaying(false);
        setStatus('idle');
    }, []);

    // Load kbars (warm-up + replay day) and the day's aggressor ticks.
    useEffect(() => {
        if (!enabled) return;
        const key = `${contract.code}|${date}`;
        loadedKeyRef.current = key;
        let cancelled = false;
        setStatus('loading');
        setError('');
        setPlaying(false);
        const start = shiftDateStr(date, -WARMUP_DAYS);
        Promise.all([
            fetchKbars(contract, start, date, { timeoutMs: 30_000 }),
            fetchHistoryTicks(contract, date).catch(() => null),
        ])
            .then(([kbars, hTicks]) => {
                if (cancelled || loadedKeyRef.current !== key) return;
                const candles = kbarsToCandles(kbars);
                const dayTrades = hTicks ? ticksToTrades(hTicks) : [];
                setRawCandles(candles);
                setTrades(dayTrades);
                const dayUnixStart = Math.floor(
                    new Date(`${date}T00:00:00Z`).getTime() / 1000,
                );
                const inDay = candles.filter((c) => c.time >= dayUnixStart);
                const startT = dayTrades[0]?.time
                    ?? inDay[0]?.time ?? 0;
                const endT = dayTrades.at(-1)?.time
                    ?? inDay.at(-1)?.time ?? 0;
                setVisibleTime(startT);
                setStatus(startT && endT ? 'ready' : 'error');
                if (!startT || !endT) {
                    setError('該日無 K 棒／Tick（可能休市），請換日');
                }
            })
            .catch((e) => {
                if (cancelled || loadedKeyRef.current !== key) return;
                setStatus('error');
                setError(e instanceof Error ? e.message : String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, date, contract]);

    const dayStart = useMemo(() => trades[0]?.time
        ?? rawCandles.filter((c) => c.time >= Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000))[0]?.time
        ?? 0,
    [trades, rawCandles, date]);
    const dayEnd = useMemo(() => trades.at(-1)?.time
        ?? rawCandles.filter((c) => c.time >= Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)).at(-1)?.time
        ?? 0,
    [trades, rawCandles, date]);

    // Playback clock: advance virtual wall time at the chosen multiplier.
    useEffect(() => {
        if (!enabled || !playing || status !== 'ready') return;
        const id = setInterval(() => {
            setVisibleTime((t) => {
                const nt = t + 0.1 * speed;
                return nt >= dayEnd ? dayEnd : nt;
            });
        }, 100);
        return () => clearInterval(id);
    }, [enabled, playing, speed, dayEnd, status]);
    useEffect(() => {
        if (playing && visibleTime >= dayEnd) setPlaying(false);
    }, [visibleTime, dayEnd, playing]);

    const togglePlay = useCallback(() => {
        if (status !== 'ready') return;
        if (visibleTime >= dayEnd) setVisibleTime(dayStart);
        setPlaying((p) => !p);
    }, [status, visibleTime, dayEnd, dayStart]);
    const setSpeed = useCallback((s: ReplaySpeed) => setSpeedState(s), []);
    const seek = useCallback((time: number) => {
        setPlaying(false);
        setVisibleTime(Math.min(Math.max(time, dayStart), dayEnd));
    }, [dayStart, dayEnd]);
    const setDate = useCallback((d: string) => setDateState(d), []);
    const prevDay = useCallback(() => setDateState((d) => shiftDateStr(d, -1)), []);
    const nextDay = useCallback(() => {
        setDateState((d) => {
            const nd = shiftDateStr(d, 1);
            return nd > dateStrOffset(0) ? d : nd;
        });
    }, []);

    return {
        enabled, date, playing, speed, visibleTime, status, error,
        rawCandles, trades, dayStart, dayEnd,
        hasData: status === 'ready',
        enable, disable, togglePlay, setSpeed, seek, setDate, prevDay, nextDay,
    };
}
