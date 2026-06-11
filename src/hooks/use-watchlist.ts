// src/hooks/use-watchlist.ts — watchlists: the editable local list plus
// every server-side watchlist (selectable, read-only — server 1.5.2 cannot
// update lists, see sinotrade/shioaji#205). Symbol type is auto-detected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureContract, primeContract } from '../lib/contracts-cache';
import {
    createWatchlist,
    fetchContract,
    fetchSnapshots,
    fetchWatchlists,
    subscribeQuote,
    syncWatchlist,
    type ServerWatchlist,
} from '../lib/shioaji';
import { registerCodeAlias } from '../lib/stream';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

export interface WatchItem {
    contract: ContractInfo;
    snapshot?: Snapshot;
}

export const LOCAL_LIST_ID = 'local';

const DEFAULT_SYMBOLS: { code: string; type: SecurityType }[] = [
    { code: '2330', type: 'STK' },
    { code: '2317', type: 'STK' },
    { code: '2454', type: 'STK' },
    { code: '2603', type: 'STK' },
    { code: '0050', type: 'STK' },
    { code: 'TXFR1', type: 'FUT' },
];

const STORAGE_KEY = 'sj-pro-watchlist';
const ACTIVE_KEY = 'sj-pro-active-watchlist';
const SERVER_LIST_NAME = 'shioaji-pro-v2';

function loadSaved(): { code: string; type: SecurityType | null }[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch {
        // fall through to defaults
    }
    return DEFAULT_SYMBOLS;
}

async function resolveContract(
    code: string,
    type?: SecurityType | null,
): Promise<ContractInfo> {
    if (type) return fetchContract(code, type);
    return ensureContract(code); // STK → FUT → IND auto-detect
}

export function useWatchlist() {
    const [items, setItems] = useState<WatchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [serverLists, setServerLists] = useState<ServerWatchlist[]>([]);
    const [activeListId, setActiveListId] = useState<string>(
        () => localStorage.getItem(ACTIVE_KEY) ?? LOCAL_LIST_ID,
    );
    const subscribed = useRef(new Set<string>());
    const initStarted = useRef(false);
    const activeRef = useRef(activeListId);
    activeRef.current = activeListId;
    const localPersistReady = useRef(false);
    const serverListId = useRef<string | null>(null);
    const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadSeq = useRef(0);

    const subscribeContract = useCallback(async (contract: ContractInfo) => {
        if (contract.target_code) {
            registerCodeAlias(contract.target_code, contract.code);
        }
        primeContract(contract);
        if (!subscribed.current.has(contract.code)) {
            subscribed.current.add(contract.code);
            await Promise.allSettled([
                subscribeQuote(contract, 'Tick'),
                subscribeQuote(contract, 'BidAsk'),
            ]);
        }
    }, []);

    const attachSnapshots = useCallback((contracts: ContractInfo[]) => {
        if (contracts.length === 0) return;
        fetchSnapshots(contracts)
            .then((snaps) => {
                const byCode = new Map(snaps.map((s) => [s.code, s]));
                setItems((prev) =>
                    prev.map((i) => {
                        const snap =
                            byCode.get(i.contract.code) ??
                            (i.contract.target_code
                                ? byCode.get(i.contract.target_code)
                                : undefined);
                        return snap ? { ...i, snapshot: snap } : i;
                    }),
                );
            })
            .catch(() => undefined);
    }, []);

    const addSymbol = useCallback(
        async (code: string, type?: SecurityType) => {
            const contract = await resolveContract(code, type);
            await subscribeContract(contract);
            setItems((prev) =>
                prev.some((i) => i.contract.code === contract.code)
                    ? prev
                    : [...prev, { contract }],
            );
            attachSnapshots([contract]);
            return contract;
        },
        [subscribeContract, attachSnapshots],
    );

    const removeSymbol = useCallback((code: string) => {
        setItems((prev) => prev.filter((i) => i.contract.code !== code));
    }, []);

    // load whichever list is active
    const loadList = useCallback(
        async (listId: string) => {
            const seq = ++loadSeq.current;
            setLoading(true);
            setItems([]);
            localPersistReady.current = false;
            if (listId === LOCAL_LIST_ID) {
                for (const s of loadSaved()) {
                    if (loadSeq.current !== seq) return;
                    try {
                        await addSymbol(s.code, s.type ?? undefined);
                    } catch {
                        // unknown code — skip
                    }
                }
                if (loadSeq.current === seq) {
                    localPersistReady.current = true;
                    setLoading(false);
                }
                return;
            }
            const list = serverLists.find((l) => l.id === listId);
            if (!list) {
                if (loadSeq.current === seq) setLoading(false);
                return;
            }
            const results = await Promise.allSettled(
                list.contracts.map((c) =>
                    resolveContract(c.code, c.security_type),
                ),
            );
            if (loadSeq.current !== seq) return;
            const contracts = results
                .filter(
                    (r): r is PromiseFulfilledResult<ContractInfo> =>
                        r.status === 'fulfilled',
                )
                .map((r) => r.value);
            await Promise.allSettled(contracts.map(subscribeContract));
            if (loadSeq.current !== seq) return;
            setItems(contracts.map((c) => ({ contract: c })));
            attachSnapshots(contracts);
            setLoading(false);
        },
        [serverLists, addSymbol, subscribeContract, attachSnapshots],
    );

    const setActiveList = useCallback(
        (listId: string) => {
            setActiveListId(listId);
            localStorage.setItem(ACTIVE_KEY, listId);
            void loadList(listId);
        },
        [loadList],
    );

    // persist + best-effort cloud sync — local list only
    useEffect(() => {
        if (!localPersistReady.current) return;
        if (activeRef.current !== LOCAL_LIST_ID) return;
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(
                items.map((i) => ({
                    code: i.contract.code,
                    type: i.contract.security_type,
                })),
            ),
        );
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
            const contracts = items.map((i) => i.contract);
            if (serverListId.current) {
                syncWatchlist(serverListId.current, contracts).catch(
                    () => undefined,
                );
            } else if (contracts.length > 0) {
                createWatchlist(SERVER_LIST_NAME, contracts)
                    .then((wl) => {
                        serverListId.current = wl.id;
                    })
                    .catch(() => undefined);
            }
        }, 2000);
    }, [items]);

    // initial boot
    useEffect(() => {
        if (initStarted.current) return;
        initStarted.current = true;
        (async () => {
            try {
                const lists = await fetchWatchlists();
                setServerLists(
                    lists.filter(
                        (l) =>
                            l.contracts.length > 0 &&
                            !l.name.startsWith('shioaji-pro'),
                    ),
                );
                const mine = lists.find((l) => l.name === SERVER_LIST_NAME);
                if (mine) serverListId.current = mine.id;
            } catch {
                // server watchlists unavailable — local only
            }
            // server lists state not yet visible to loadList — load local
            // directly; a saved server-list selection is restored below
            await loadList(LOCAL_LIST_ID);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // restore a previously selected server list once lists are known
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current) return;
        if (serverLists.length === 0) return;
        restoredRef.current = true;
        const saved = localStorage.getItem(ACTIVE_KEY);
        if (saved && saved !== LOCAL_LIST_ID) {
            if (serverLists.some((l) => l.id === saved)) {
                void loadList(saved);
            } else {
                setActiveListId(LOCAL_LIST_ID);
                localStorage.setItem(ACTIVE_KEY, LOCAL_LIST_ID);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverLists]);

    return {
        items,
        loading,
        addSymbol,
        removeSymbol,
        serverLists,
        activeListId,
        setActiveList,
        readOnly: activeListId !== LOCAL_LIST_ID,
    };
}
