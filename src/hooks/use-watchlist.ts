// src/hooks/use-watchlist.ts — fully server-backed watchlists (CRUD works
// on shioaji server ≥1.5.3). Every list is editable; edits sync via PUT.
// First run migrates the old local list / creates a default one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureContract, primeContract } from '../lib/contracts-cache';
import {
    createWatchlist,
    deleteWatchlist,
    fetchContract,
    fetchSnapshots,
    fetchWatchlists,
    subscribeQuote,
    syncWatchlist,
    type ServerWatchlist,
} from '../lib/shioaji';
import { registerCodeAlias } from '../lib/stream';
import { notify } from '../lib/trade';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

export interface WatchItem {
    contract: ContractInfo;
    snapshot?: Snapshot;
}

const DEFAULT_LIST_NAME = '我的自選';
const DEFAULT_SYMBOLS: { code: string; type: SecurityType }[] = [
    { code: '2330', type: 'STK' },
    { code: '2317', type: 'STK' },
    { code: '2454', type: 'STK' },
    { code: '2603', type: 'STK' },
    { code: '0050', type: 'STK' },
    { code: 'TXFR1', type: 'FUT' },
];

const LEGACY_KEY = 'sj-pro-watchlist';
const ACTIVE_KEY = 'sj-pro-active-watchlist';

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
    const [activeListId, setActiveListId] = useState<string>('');
    const subscribed = useRef(new Set<string>());
    const initStarted = useRef(false);
    const loadSeq = useRef(0);
    const activeIdRef = useRef('');
    activeIdRef.current = activeListId;

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

    const refreshLists = useCallback(async (): Promise<ServerWatchlist[]> => {
        const lists = await fetchWatchlists();
        setServerLists(lists);
        return lists;
    }, []);

    // push the current items to the server (PUT replaces all contracts)
    const persistItems = useCallback(
        (next: WatchItem[]) => {
            const id = activeIdRef.current;
            if (!id) return;
            syncWatchlist(
                id,
                next.map((i) => i.contract),
            )
                .then(() => refreshLists())
                .catch(() =>
                    notify({
                        kind: 'err',
                        title: '自選清單同步失敗',
                        body: '與伺服器同步時發生錯誤',
                    }),
                );
        },
        [refreshLists],
    );

    const loadList = useCallback(
        async (list: ServerWatchlist) => {
            const seq = ++loadSeq.current;
            setLoading(true);
            setItems([]);
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
        [subscribeContract, attachSnapshots],
    );

    const setActiveList = useCallback(
        (listId: string, listsOverride?: ServerWatchlist[]) => {
            const list = (listsOverride ?? serverLists).find(
                (l) => l.id === listId,
            );
            if (!list) return;
            setActiveListId(listId);
            localStorage.setItem(ACTIVE_KEY, listId);
            void loadList(list);
        },
        [serverLists, loadList],
    );

    const addSymbol = useCallback(
        async (code: string, type?: SecurityType) => {
            const contract = await resolveContract(code, type);
            await subscribeContract(contract);
            let next: WatchItem[] | null = null;
            setItems((prev) => {
                if (prev.some((i) => i.contract.code === contract.code)) {
                    return prev;
                }
                next = [...prev, { contract }];
                return next;
            });
            if (next) persistItems(next);
            attachSnapshots([contract]);
            return contract;
        },
        [subscribeContract, attachSnapshots, persistItems],
    );

    const removeSymbol = useCallback(
        (code: string) => {
            setItems((prev) => {
                const next = prev.filter((i) => i.contract.code !== code);
                persistItems(next);
                return next;
            });
        },
        [persistItems],
    );

    const createList = useCallback(
        async (name: string) => {
            const wl = await createWatchlist(name, []);
            const lists = await refreshLists();
            setActiveList(wl.id, lists);
            notify({
                kind: 'ok',
                title: '已建立清單',
                body: `「${name}」已建立並切換`,
            });
        },
        [refreshLists, setActiveList],
    );

    const deleteCurrentList = useCallback(async () => {
        const id = activeIdRef.current;
        const list = serverLists.find((l) => l.id === id);
        if (!id || !list) return;
        await deleteWatchlist(id);
        const lists = await refreshLists();
        notify({
            kind: 'ok',
            title: '已刪除清單',
            body: `「${list.name}」已刪除`,
        });
        const fallback = lists[0];
        if (fallback) {
            setActiveList(fallback.id, lists);
        } else {
            setItems([]);
            setActiveListId('');
        }
    }, [serverLists, refreshLists, setActiveList]);

    // boot: load lists; migrate legacy local list / create default if empty
    useEffect(() => {
        if (initStarted.current) return;
        initStarted.current = true;
        (async () => {
            try {
                let lists = await refreshLists();
                if (lists.length === 0) {
                    // first run — migrate the old local list or use defaults
                    let seed = DEFAULT_SYMBOLS as {
                        code: string;
                        type: SecurityType | null;
                    }[];
                    try {
                        const raw = localStorage.getItem(LEGACY_KEY);
                        if (raw) {
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                seed = parsed;
                            }
                        }
                    } catch {
                        // defaults
                    }
                    const resolved = await Promise.allSettled(
                        seed.map((s) =>
                            resolveContract(s.code, s.type ?? undefined),
                        ),
                    );
                    const contracts = resolved
                        .filter(
                            (
                                r,
                            ): r is PromiseFulfilledResult<ContractInfo> =>
                                r.status === 'fulfilled',
                        )
                        .map((r) => r.value);
                    await createWatchlist(DEFAULT_LIST_NAME, contracts);
                    lists = await refreshLists();
                }
                const saved = localStorage.getItem(ACTIVE_KEY);
                const target =
                    lists.find((l) => l.id === saved) ??
                    lists.find((l) => l.name === DEFAULT_LIST_NAME) ??
                    lists[0];
                if (target) {
                    setActiveListId(target.id);
                    localStorage.setItem(ACTIVE_KEY, target.id);
                    await loadList(target);
                } else {
                    setLoading(false);
                }
            } catch {
                setLoading(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        items,
        loading,
        addSymbol,
        removeSymbol,
        serverLists,
        activeListId,
        setActiveList,
        createList,
        deleteCurrentList,
    };
}
