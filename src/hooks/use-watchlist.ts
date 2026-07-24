// src/hooks/use-watchlist.ts — fully server-backed watchlists (CRUD works
// on shioaji server ≥1.5.3). Every list is editable; edits sync via PUT.
// First run migrates the old local list / creates a default one.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ensureContract,
    primeContract,
    refreshCachedContracts,
} from '../lib/contracts-cache';
import {
    createWatchlist,
    deleteWatchlist,
    fetchSnapshots,
    fetchWatchlists,
    addWatchlistContracts,
    removeWatchlistContracts,
    renameWatchlist,
    resolveContract as resolveContractV2,
    subscribeContractQuotes,
    syncWatchlist,
    type ServerWatchlist,
} from '../lib/shioaji';
import { onContractEvent, registerCodeAlias } from '../lib/stream';
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
    if (type) return resolveContractV2(code, type);
    return ensureContract(code);
}

export function useWatchlist() {
    const [items, setItems] = useState<WatchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [initialLoading, setInitialLoading] = useState(true);
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
            await subscribeContractQuotes(contract);
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
            const migrated =
                results.every((result) => result.status === 'fulfilled') &&
                contracts.some(
                    (contract, index) =>
                        contract.code !== list.contracts[index]?.code,
                );
            await Promise.allSettled(contracts.map(subscribeContract));
            if (loadSeq.current !== seq) return;
            setItems(contracts.map((c) => ({ contract: c })));
            attachSnapshots(contracts);
            if (migrated) {
                await syncWatchlist(list.id, contracts);
                await refreshLists();
            }
            setLoading(false);
        },
        [subscribeContract, attachSnapshots, refreshLists],
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
        async (
            code: string,
            type?: SecurityType,
            resolved?: ContractInfo,
        ) => {
            const contract = resolved ?? (await resolveContract(code, type));
            if (resolved) primeContract(resolved);
            if (items.some((i) => i.contract.code === contract.code)) {
                return contract;
            }
            await subscribeContract(contract);
            const id = activeIdRef.current;
            if (id) {
                await addWatchlistContracts(id, [contract]);
                await refreshLists();
            }
            setItems((prev) => [...prev, { contract }]);
            attachSnapshots([contract]);
            return contract;
        },
        [
            items,
            subscribeContract,
            attachSnapshots,
            refreshLists,
        ],
    );

    const removeSymbol = useCallback(
        async (code: string) => {
            const item = items.find((i) => i.contract.code === code);
            if (!item) return;
            const id = activeIdRef.current;
            if (id) {
                await removeWatchlistContracts(id, [item.contract]);
                await refreshLists();
            }
            setItems((prev) =>
                prev.filter((i) => i.contract.code !== code),
            );
        },
        [items, refreshLists],
    );

    // drag-to-reorder: move `fromCode` to the position of `toCode`
    const reorderSymbol = useCallback(
        (fromCode: string, toCode: string) => {
            setItems((prev) => {
                const fromIdx = prev.findIndex(
                    (i) => i.contract.code === fromCode,
                );
                const toIdx = prev.findIndex(
                    (i) => i.contract.code === toCode,
                );
                if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
                    return prev;
                }
                const next = [...prev];
                const [moved] = next.splice(fromIdx, 1);
                next.splice(toIdx, 0, moved!);
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

    // rename = recreate + delete on the server (no rename endpoint), so the
    // active id changes; items stay as-is because the contracts are identical.
    // Returns false when rejected (duplicate name) so the UI can stay in edit.
    const renameCurrentList = useCallback(
        async (name: string): Promise<boolean> => {
            const id = activeIdRef.current;
            const list = serverLists.find((l) => l.id === id);
            const trimmed = name.trim();
            if (!id || !list || !trimmed) return false;
            if (trimmed === list.name) return true;
            if (serverLists.some((l) => l.id !== id && l.name === trimmed)) {
                notify({
                    kind: 'err',
                    title: '清單名稱重複',
                    body: `已有名為「${trimmed}」的清單`,
                });
                return false;
            }
            try {
                const created = await renameWatchlist(list, trimmed);
                // update the ref eagerly — a persistItems fired before the
                // re-render must not PUT against the deleted old id
                activeIdRef.current = created.id;
                setActiveListId(created.id);
                localStorage.setItem(ACTIVE_KEY, created.id);
                await refreshLists();
                notify({
                    kind: 'ok',
                    title: '已重新命名',
                    body: `「${list.name}」→「${trimmed}」`,
                });
                return true;
            } catch {
                await refreshLists().catch(() => undefined);
                notify({
                    kind: 'err',
                    title: '重新命名失敗',
                    body: '與伺服器同步時發生錯誤',
                });
                return false;
            }
        },
        [serverLists, refreshLists],
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

    // boot: load lists; migrate legacy local list / create default if empty.
    // The first fetch can race a server that is still warming up after an
    // app update/restart — retry with backoff instead of giving up (the
    // poll-based panels recover on their own; this one must too).
    useEffect(() => {
        if (initStarted.current) return;
        initStarted.current = true;
        (async () => {
            try {
                let lists: ServerWatchlist[] = [];
                let lastErr: unknown = null;
                for (let attempt = 0; attempt < 10; attempt++) {
                    try {
                        lists = await refreshLists();
                        lastErr = null;
                        break;
                    } catch (e) {
                        lastErr = e;
                        await new Promise((r) =>
                            setTimeout(r, 1500 + attempt * 1000),
                        );
                    }
                }
                if (lastErr) throw lastErr;
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
            } finally {
                setInitialLoading(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let pendingType: SecurityType | null | undefined;
        const off = onContractEvent((event) => {
            if (!event.base_changed && !event.info_changed) return;
            const eventType = event.security_type as SecurityType | null;
            if (!timer) {
                pendingType = eventType;
            } else if (pendingType !== eventType) {
                pendingType = null;
            }
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const list = serverLists.find(
                    (candidate) => candidate.id === activeIdRef.current,
                );
                void refreshCachedContracts(pendingType ?? undefined);
                if (list) void loadList(list);
                timer = null;
                pendingType = undefined;
            }, 250);
        });
        return () => {
            off();
            if (timer) clearTimeout(timer);
        };
    }, [serverLists, loadList]);

    return {
        items,
        loading,
        initialLoading,
        addSymbol,
        removeSymbol,
        reorderSymbol,
        serverLists,
        activeListId,
        setActiveList,
        createList,
        renameCurrentList,
        deleteCurrentList,
    };
}
