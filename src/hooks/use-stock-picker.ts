// src/hooks/use-stock-picker.ts — 短線選股（多方／空方）。
// 股票池＝作用中自選 + scanner 排行（多方掃漲量、空方掃跌量），去重上限 40；
// 對每檔取日 K（daily-candles 快取）評分，snapshots 提供最新價/漲跌，
// 另算大盤 IX0001 regime 作為選股 gate。唯讀、不下單。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDailyCandles } from '../lib/daily-candles';
import { ensureContract } from '../lib/contracts-cache';
import { fetchScanner, fetchSnapshots } from '../lib/shioaji';
import {
    scoreStock,
    scoreStockShort,
    type PickerScore,
} from '../lib/stock-picker';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { useWatchlist } from './use-watchlist';

export type PickerSide = 'long' | 'short';
export const PICKER_MAX_POOL = 40;
const POLL_MS = 120_000;

export interface PickerRow {
    contract: ContractInfo;
    score: PickerScore;
    price: number;
    changeRate: number; // %（快照最新）
    volumeRatio: number;
}

export interface MarketRegime {
    side: 'bull' | 'bear' | 'neutral';
    label: string;
    rsi: number;
    biasPct: number;
}

type ScanEntry = [Parameters<typeof fetchScanner>[0], number, boolean];

// 多方：量／漲幅（降冪）／額；空方：量／跌幅（升冪、ascending=true）／額
function scansFor(side: PickerSide): ScanEntry[] {
    return side === 'long'
        ? [
              ['VolumeRank', 25, false],
              ['ChangePercentRank', 20, false],
              ['AmountRank', 20, false],
          ]
        : [
              ['VolumeRank', 25, false],
              ['ChangePercentRank', 20, true],
              ['AmountRank', 20, false],
          ];
}

async function buildPool(
    watchContracts: ContractInfo[],
    side: PickerSide,
    max = PICKER_MAX_POOL,
): Promise<ContractInfo[]> {
    const map = new Map<string, ContractInfo>();
    for (const c of watchContracts.slice(0, max)) map.set(c.code, c);
    for (const [type, count, ascending] of scansFor(side)) {
        try {
            const items = await fetchScanner(type, count, ascending);
            for (const it of items) {
                if (map.has(it.code)) continue;
                if (map.size >= max) break;
                try {
                    const c = await ensureContract(it.code);
                    map.set(it.code, c);
                } catch {
                    /* 無法解析契約就略過 */
                }
            }
        } catch {
            /* 單一 scanner 失敗不影響其餘 */
        }
    }
    return [...map.values()].slice(0, max);
}

function deriveRegime(daily: Parameters<typeof scoreStock>[0]): MarketRegime | null {
    const sc = scoreStock(daily);
    if (!sc) return null;
    const side: MarketRegime['side'] =
        sc.biasPct > 0.005 && sc.rsi >= 52
            ? 'bull'
            : sc.biasPct < -0.005 && sc.rsi <= 48
              ? 'bear'
              : 'neutral';
    return {
        side,
        label:
            side === 'bull'
                ? '大盤多方'
                : side === 'bear'
                  ? '大盤空方'
                  : '盤勢中性',
        rsi: sc.rsi,
        biasPct: sc.biasPct,
    };
}

export function useStockPicker(side: PickerSide = 'long') {
    const w = useWatchlist();
    const watchlist = useMemo(
        () => w.items.map((i) => i.contract),
        [w.items],
    );
    const watchKey = useMemo(
        () => watchlist.map((c) => c.code).join(','),
        [watchlist],
    );
    const [rows, setRows] = useState<PickerRow[]>([]);
    const [regime, setRegime] = useState<MarketRegime | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [tick, setTick] = useState(0);
    const refresh = useCallback(() => setTick((x) => x + 1), []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        void (async () => {
            try {
                const pool = await buildPool(watchlist, side);
                if (cancelled) return;

                let snapMap = new Map<string, Snapshot>();
                try {
                    const snaps = await fetchSnapshots(pool);
                    snapMap = new Map(snaps.map((s) => [s.code, s]));
                } catch {
                    /* 快照失敗仍可用日 K */
                }

                let mktRegime: MarketRegime | null = null;
                try {
                    const idx = await ensureContract('IX0001');
                    mktRegime = deriveRegime(await getDailyCandles(idx));
                } catch {
                    /* 大盤無法取就不 gate */
                }

                const out: PickerRow[] = [];
                await Promise.all(
                    pool.map(async (contract) => {
                        try {
                            const daily = await getDailyCandles(contract);
                            const sc =
                                side === 'long'
                                    ? scoreStock(daily)
                                    : scoreStockShort(daily);
                            if (!sc) return;
                            const snap = snapMap.get(contract.code);
                            out.push({
                                contract,
                                score: sc,
                                price: snap?.close ?? daily.at(-1)!.close,
                                changeRate:
                                    snap?.change_rate ?? sc.changePct * 100,
                                volumeRatio:
                                    snap?.volume_ratio ?? sc.volumeRatio,
                            });
                        } catch {
                            /* 單檔失敗略過 */
                        }
                    }),
                );
                if (cancelled) return;

                out.sort(
                    (a, b) =>
                        Number(a.score.excluded) - Number(b.score.excluded) ||
                        b.score.score - a.score.score,
                );
                setRows(out);
                setRegime(mktRegime);
                setError(null);
                setLastUpdated(Date.now());
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [watchKey, tick, watchlist, side]);

    // 盤中定時重算（日 K 為增量、負擔小）
    useEffect(() => {
        const id = window.setInterval(() => setTick((x) => x + 1), POLL_MS);
        return () => window.clearInterval(id);
    }, []);

    return { rows, regime, loading, error, lastUpdated, refresh };
}
