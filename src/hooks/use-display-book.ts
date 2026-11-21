import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useContract } from '../lib/contracts-cache';
import { displayBook, matchesSnapshot } from '../lib/display-book';
import { getMarketSnapshot, pendingMarketSnapshot, subscribeMarketSnapshots } from '../lib/market-snapshot-store';
import { fetchSnapshots } from '../lib/shioaji';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { useQuery } from './use-query';
import { useQuote } from './use-stream';
import { useUsSnapshot } from './use-us-snapshot';
import { usSnapshotToTw } from '../lib/us/us-adapter';

const NO_CONTRACT = { code: '', exchange: '' } as unknown as ContractBase;

/**
 * 報價板／五檔的快照墊底。美股（region US）改抓美股快照（SDK 1.8.0b1，
 * fetchSnapshots 不收美股）並轉成台股 Snapshot 形狀，code 是 US:CODE。
 */
export function useSnapshotBaseline(code: string, supplied?: Snapshot, suppliedContract?: ContractBase) {
    const cachedContract = useContract(code);
    const contract = suppliedContract ?? cachedContract;
    const isUs = contract?.region === 'US';
    const usSnap = useUsSnapshot(contract ?? NO_CONTRACT, isUs);
    const usBaseline = useMemo(() => (usSnap ? usSnapshotToTw(usSnap) : undefined), [usSnap]);
    const cached = useSyncExternalStore(subscribeMarketSnapshots, () => contract ? getMarketSnapshot(contract) : undefined);
    const suppliedSnapshot = matchesSnapshot(supplied, code, contract?.target_code) ? supplied : undefined;
    // Parent watchlist snapshots may carry a newer Tick timestamp while their
    // L1 still comes from an older BidAsk. Compare depth against raw HTTP time.
    const snapshot = cached ?? suppliedSnapshot;
    const key = JSON.stringify([contract?.security_type, contract?.exchange, contract?.target_code || code]);
    const query = useQuery(useCallback(async () => {
        if (!contract) return [];
        // Another panel/watchlist batch may have filled the store since render.
        const existing = getMarketSnapshot(contract);
        return existing ? [existing] : pendingMarketSnapshot(contract) ?? fetchSnapshots([contract]);
    }, [key, contract]), `display-snapshot:${key}`, !!contract && !snapshot && !isUs);
    const baseline = isUs ? usBaseline : snapshot ?? query.data?.find(s => matchesSnapshot(s, code, contract?.target_code));
    return { snapshot: baseline, contract };
}

export function useDisplayBook(code: string, supplied?: Snapshot, suppliedContract?: ContractBase) {
    const quote = useQuote(code);
    const { snapshot: baseline, contract } = useSnapshotBaseline(code, supplied, suppliedContract);
    const allowSigned = !!(contract && 'combo' in contract && contract.combo);
    const book = useMemo(() => displayBook(code, baseline, quote?.bidask, contract?.target_code, allowSigned), [code, baseline, quote?.bidask, contract?.target_code, allowSigned]);
    return { quote, snapshot: baseline, book };
}
