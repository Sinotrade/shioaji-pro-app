import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from './use-query';
import { fetchSnapshots } from '../lib/shioaji';
import { getQuote, subscribeQuoteStore } from '../lib/stream';
import { retainQuote } from '../lib/quote-ownership';
import { registerCodeAlias } from '../lib/stream';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

import { displayBook, marketTime } from '../lib/display-book';

function atLeastSnapshot(event: { date?: string; time?: string; datetime?: string }, snapshot: Snapshot) {
    const eventTime = marketTime(event.datetime ?? event.date, event.datetime ? undefined : event.time);
    const snapshotTime = marketTime(snapshot.datetime);
    return Number.isFinite(eventTime) && Number.isFinite(snapshotTime) && eventTime >= snapshotTime;
}

/** One scoped snapshot, then quote events. Changing presentation does not query. */
export function useLiveSnapshots(contracts: ContractBase[], fetcher?: () => Promise<Snapshot[]>) {
    const key = JSON.stringify(contracts.map(c => [c.security_type, c.exchange, c.code, c.target_code]));
    const query = useQuery(useCallback(() => fetcher ? fetcher() : fetchSnapshots(contracts), [key]), `snapshots:${key}`, contracts.length > 0);
    const [sequence, setSequence] = useState(0);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const notify = () => { if (!timer) timer = setTimeout(() => { timer = undefined; setSequence(s => s + 1); }, 100); };
        const releases = contracts.flatMap(contract => {
            if (contract.target_code) registerCodeAlias(contract.target_code, contract.code);
            return [retainQuote(contract, contract.security_type === 'IND' ? 'Quote' : 'Tick'),
                ...(contract.security_type === 'IND' ? [] : [retainQuote(contract, 'BidAsk')]), subscribeQuoteStore(contract.code, notify)];
        });
        return () => { releases.forEach(release => release()); if (timer) clearTimeout(timer); };
    }, [key]);
    const snapshots = useMemo(() => {
        const result = new Map((query.data ?? []).map(s => [s.code, s]));
        for (const contract of contracts) {
            let baseline = result.get(contract.code) ?? (contract.target_code ? result.get(contract.target_code) : undefined);
            const quote = getQuote(contract.code);
            const tick = quote?.tick;
            if (!baseline) continue; // No fabricated zeros while the initial query failed.
            const finite = (v: unknown, fallback: number) => v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback;
            const book = quote?.bidask;
            if (book && !book.simtrade && atLeastSnapshot(book, baseline)) {
                const display = displayBook(contract.code, undefined, book, contract.target_code, 'combo' in contract && !!contract.combo);
                baseline = { ...baseline,
                    buy_price: display?.bids[0]?.price ?? 0, buy_volume: display?.bids[0]?.vol ?? 0,
                    sell_price: display?.asks[0]?.price ?? 0, sell_volume: display?.asks[0]?.vol ?? 0 };
            }
            if (quote?.index && atLeastSnapshot(quote.index, baseline)) {
                const close = Number(quote.index.close), reference = Number(quote.index.reference);
                if (Number.isFinite(close) && close > 0 && reference > 0) result.set(contract.code, {
                    ...baseline, close, change_price: close - reference, change_rate: (close - reference) / reference * 100,
                });
                continue;
            }
            if (!tick || tick.simtrade || Number(tick.close) <= 0 || !atLeastSnapshot(tick, baseline)) { result.set(contract.code, baseline); continue; }
            const change = finite(tick.price_chg, Number(tick.close) - (baseline.close - baseline.change_price));
            const reference = Number(tick.close) - change;
            result.set(contract.code, { ...baseline, code: contract.code, datetime: `${tick.date} ${tick.time}`,
                close: Number(tick.close), open: finite(tick.open, baseline.open), high: finite(tick.high, baseline.high), low: finite(tick.low, baseline.low),
                volume: tick.volume, total_volume: tick.total_volume, change_price: change,
                change_rate: reference > 0 ? change / reference * 100 : baseline.change_rate, average_price: finite(tick.avg_price, baseline.average_price),
                total_amount: finite(tick.total_amount, baseline.total_amount) });
        }
        return result;
    }, [query.data, key, sequence]);
    return { ...query, snapshots };
}
