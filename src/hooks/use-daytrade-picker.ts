import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { ensureContract } from '../lib/contracts-cache';
import { getDailyCandles, readCachedDailyCandles } from '../lib/daily-candles';
import { evaluateDaytrade, type DaytradeInput } from '../lib/daytrade-picker';
import { researchBackgroundKey, researchBackgroundStore } from '../lib/research-background';
import { dailyBreakoutClosedSource } from '../lib/research-daily-breakout-source';
import { fetchScanner, fetchSnapshots } from '../lib/shioaji';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { V9_RESEARCH_MODE } from '../lib/workspace';
import { useWatchlist } from './use-watchlist';
import { getApiBase } from '../lib/runtime';
import { appendStrategyFrame } from '../lib/strategy-journal';
import { recordableStrategyFrame } from '../lib/strategy-recording';

export const DAYTRADE_MAX_POOL = 40;
const taipeiDate = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const ordinaryCode = (code: string) => /^[1-9]\d{3}$/.test(code);
const stockIdentity = (c: ContractInfo) => ordinaryCode(c.code) && c.security_type === 'STK'
    && (c.region === undefined || c.region === 'TW') && (c.exchange === 'TSE' || c.exchange === 'OTC')
    && c.currency === 'TWD' && !c.combo && (!c.target_code || c.target_code === c.code);

/** Balanced long/short pool. No single volume ranking consumes all 40 slots.
 * This is explicitly a watchlist + ranking pool, not an all-market screen. */
export async function buildDaytradePool(watch: ContractInfo[], cancelled: () => boolean = () => false): Promise<{ pool: ContractInfo[]; warnings: string[] }> {
    // Shioaji's ascending=true means largest-first, despite the parameter name.
    const specs = [['ChangePercentRank', 20, true], ['ChangePercentRank', 20, false],
        ['VolumeRank', 25, true], ['AmountRank', 25, true]] as const;
    const warnings: string[] = [];
    const lists = await Promise.all(specs.map(async ([kind, count, ascending]) => {
        try { return (await fetchScanner(kind, count, ascending)).map(item => item.code).filter(ordinaryCode); }
        catch { warnings.push(`${kind}${kind === 'ChangePercentRank' ? (ascending ? '漲幅' : '跌幅') : ''}排行榜未取得`); return []; }
    }));
    const watchMap = new Map(watch.filter(stockIdentity).map(c => [c.code, c]));
    const sources = [[...watchMap.keys()], ...lists];
    const codes = new Set<string>();
    const pool: ContractInfo[] = [];
    const depth = Math.max(0, ...sources.map(list => list.length));
    for (let i = 0; i < depth && pool.length < DAYTRADE_MAX_POOL && !cancelled(); i++) {
        for (const source of sources) {
            if (cancelled()) break;
            const code = source[i];
            if (!code || codes.has(code) || pool.length >= DAYTRADE_MAX_POOL) continue;
            codes.add(code);
            try {
                const contract = watchMap.get(code) ?? await ensureContract(code, 'STK');
                if (stockIdentity(contract)) pool.push(contract);
            } catch { warnings.push(`${code}契約未取得`); }
        }
    }
    return { pool, warnings };
}

async function currentMetadata(c: ContractInfo, now: number): Promise<ContractInfo> {
    if (c.update_date === taipeiDate(now) && typeof c.trading_suspended === 'boolean'
        && Number.isFinite(c.disposition_level) && Number.isFinite(c.unit)) return c;
    // Only refresh this research row. Do not replace the formal shared cache.
    try {
        const fresh = await apiGet<ContractInfo>(`/api/v1/data/contracts/${encodeURIComponent(c.code)}/info?security_type=STK&region=TW`,
            { signal: AbortSignal.timeout(10_000) });
        return stockIdentity(fresh) && fresh.code === c.code && fresh.exchange === c.exchange ? fresh : c;
    } catch { return c; } // Core will keep unknown/stale permissions out.
}

export async function scanDaytrade(watch: ContractInfo[], cancelled: () => boolean = () => false) {
    const { pool, warnings } = await buildDaytradePool(watch, cancelled);
    const inputs: DaytradeInput[] = [];
    let cursor = 0;
    // Bounded concurrency reuses the normal daily request. Capture its raw
    // minute background before the 24-symbol LRU can evict it; no second pull.
    await Promise.all(Array.from({ length: Math.min(4, pool.length) }, async () => {
        while (cursor < pool.length && !cancelled()) {
            const original = pool[cursor++]!;
            const contract = await currentMetadata(original, Date.now());
            if (cancelled()) break;
            try {
                await getDailyCandles(contract);
                if (cancelled()) break;
                const minutes = [...researchBackgroundStore.get(researchBackgroundKey(contract)).minutes];
                const now = Date.now();
                const checked = await readCachedDailyCandles(contract, { stockRegularCloseOnly: true, nowMs: now });
                if (cancelled()) break;
                inputs.push({ contract, daily: dailyBreakoutClosedSource(checked, contract, now), minutes });
            } catch { inputs.push({ contract, daily: [], minutes: [] }); }
        }
    }));
    if (cancelled()) return { inputs: [], poolSize: pool.length, warnings, indexChangeRate: undefined, indexAsOf: undefined };
    // Fetch quotes after history, so history latency cannot age a quote into
    // an apparently current candidate. Broker source timestamps remain intact.
    let index: ContractInfo | undefined;
    try {
        const candidate = await ensureContract('IX0001', 'IND');
        if (candidate.code === 'IX0001' && candidate.security_type === 'IND' && candidate.exchange === 'TSE'
            && (candidate.region === undefined || candidate.region === 'TW')) index = candidate;
        else warnings.push('大盤相對強弱契約身分不符');
    } catch { warnings.push('大盤相對強弱未取得'); }
    if (cancelled()) return { inputs: [], poolSize: pool.length, warnings, indexChangeRate: undefined, indexAsOf: undefined };
    let snapshots: Snapshot[] = [];
    try { snapshots = await fetchSnapshots(index ? [...inputs.map(i => i.contract), index] : inputs.map(i => i.contract)); }
    catch { warnings.push('即時快照未取得；不產生盤中確認名單'); }
    if (cancelled()) return { inputs: [], poolSize: pool.length, warnings, indexChangeRate: undefined, indexAsOf: undefined };
    const snapMap = new Map(snapshots.map(s => [`${s.exchange}:${s.code}`, s]));
    for (const input of inputs) input.snapshot = snapMap.get(`${input.contract.exchange}:${input.contract.code}`);
    const shortContracts = inputs.filter(i => i.contract.day_trade === 'Yes').map(i => ({
        security_type: i.contract.security_type, region: i.contract.region ?? 'TW',
        exchange: i.contract.exchange, code: i.contract.code, target_code: i.contract.target_code || null,
    }));
    if (shortContracts.length) {
        try {
            const sources = await apiPost<{code: string; short_stock_source: number; datetime: string}[]>(
                '/api/v1/data/short_stock_sources', { contracts: shortContracts }, { timeoutMs: 10_000 });
            const sourceMap = new Map(sources.map(source => [source.code, source]));
            for (const input of inputs) {
                const source = sourceMap.get(input.contract.code);
                if (source) input.shortSource = { quantity: source.short_stock_source, datetime: source.datetime };
            }
        } catch { warnings.push('券商券源未確認；空方僅供觀察'); }
    }
    const indexSnap = index ? snapMap.get(`${index.exchange}:${index.code}`) : undefined;
    const stamp = indexSnap ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(indexSnap.datetime)
        ? indexSnap.datetime : `${indexSnap.datetime}+08:00`) : NaN;
    const now = Date.now();
    const indexChangeRate = indexSnap && Number.isFinite(indexSnap.change_rate) && stamp <= now
        && now - stamp <= 180_000 && taipeiDate(stamp) === taipeiDate(now) ? indexSnap.change_rate : undefined;
    if (indexChangeRate === undefined && !warnings.includes('大盤相對強弱未取得')) warnings.push('大盤相對強弱未取得');
    return { inputs, poolSize: pool.length, warnings, indexChangeRate,
        indexAsOf: indexChangeRate === undefined ? undefined : stamp };
}

export function useDaytradePicker(enabled = false) {
    const watch = useWatchlist();
    const contracts = useMemo(() => watch.items.map(item => item.contract), [watch.items]);
    const [inputs, setInputs] = useState<DaytradeInput[]>([]);
    const [indexChangeRate, setIndexChangeRate] = useState<number>();
    const [indexAsOf, setIndexAsOf] = useState<number>();
    const [poolSize, setPoolSize] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [recordingError, setRecordingError] = useState<string | null>(null);
    const [lastRecordedAt, setLastRecordedAt] = useState<number | null>(null);
    const [recording, setRecording] = useState(false);
    const [now, setNow] = useState(Date.now);
    const [tick, setTick] = useState(0);
    const scanning = useRef(false);
    const refresh = useCallback(() => setTick(value => value + 1), []);
    useEffect(() => {
        if (!enabled || !V9_RESEARCH_MODE) return;
        let cancelled = false;
        scanning.current = true;
        setNow(Date.now());
        setLoading(true);
        void scanDaytrade(contracts, () => cancelled).then(scan => {
            if (cancelled) return;
            setInputs(scan.inputs); setPoolSize(scan.poolSize); setIndexChangeRate(scan.indexChangeRate); setIndexAsOf(scan.indexAsOf);
            setError(scan.warnings.length ? scan.warnings.join('；') : null);
            const capturedAt = Date.now();
            setLastUpdated(capturedAt); setNow(capturedAt);
            setRecording(true);
            // Journal errors must be visible, but cannot make a valid live scan disappear.
            void Promise.resolve().then(() => recordableStrategyFrame(scan, capturedAt, getApiBase()))
                .then(frame => appendStrategyFrame(frame))
                .then(() => { if (!cancelled) { setLastRecordedAt(capturedAt); setRecordingError(null); } })
                .catch(reason => { if (!cancelled) setRecordingError(`策略日誌未保存：${String(reason)}`); })
                .finally(() => { if (!cancelled) setRecording(false); });
        }).catch(reason => { if (!cancelled) setError(String(reason)); })
            .finally(() => { if (!cancelled) { scanning.current = false; setLoading(false); } });
        return () => { cancelled = true; scanning.current = false; };
    }, [enabled, contracts, tick]);
    useEffect(() => {
        if (!enabled || !V9_RESEARCH_MODE) return;
        const poll = window.setInterval(() => { if (!scanning.current) refresh(); }, 120_000);
        const clock = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => { window.clearInterval(poll); window.clearInterval(clock); };
    }, [enabled, refresh]);
    // Switching back to this tab must never reuse its frozen inactive clock,
    // even for the first render before the scan effect has run.
    const evaluationNow = Math.max(now, Date.now());
    const result = useMemo(() => evaluateDaytrade(inputs, evaluationNow, indexAsOf !== undefined && indexAsOf <= evaluationNow
        && evaluationNow - indexAsOf <= 180_000 && taipeiDate(indexAsOf) === taipeiDate(evaluationNow)
        ? indexChangeRate : undefined), [inputs, evaluationNow, indexChangeRate, indexAsOf]);
    return { result, loading, error, lastUpdated, poolSize, refresh, recording, recordingError, lastRecordedAt };
}
