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
    addWatchlistContracts,
    createWatchlist,
    deleteWatchlist,
    fetchContractInfo,
    fetchSnapshots,
    fetchWatchlists,
    removeWatchlistContracts,
    renameWatchlist,
    resolveContract as resolveContractV2,
    syncWatchlist,
    type ServerWatchlist
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

function resolveWatchlistContract(
    base: ServerWatchlist['contracts'][number],
): Promise<ContractInfo> {
    // The watchlist already contains a Base contract. Fetch only the typed
    // details; preserve the generic lookup for legacy/missing types and WRT,
    // whose Info endpoint requires an underlying shard.
    if (base.security_type && base.security_type !== 'WRT') {
        return fetchContractInfo(base.code, base.security_type);
    }
    return resolveContract(base.code, base.security_type);
}

export function useWatchlist() {
    const [items, setItems] = useState<WatchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [structureBusy, setStructureBusy] = useState(false);
    const structureBusyRef = useRef(false);
    const [loadError, setLoadError] = useState(false);
    const [retryKey, setRetryKey] = useState(0);
    const [serverLists, setServerLists] = useState<ServerWatchlist[]>([]);
    const [activeListId, setActiveListId] = useState<string>('');
    const initStarted = useRef(false);
    const loadSeq = useRef(0);
    const canReplaceList = useRef(false);
    const activeIdRef = useRef('');
    const serverListsRef = useRef<ServerWatchlist[]>([]);
    const refreshRequest = useRef(0);
    const refreshApplied = useRef(0);
    const pendingServerContracts = useRef(new Map<string, ServerWatchlist['contracts']>());
    const pendingRenames = useRef(new Map<string, ServerWatchlist>());
    const pendingDeletions = useRef(new Set<string>());
    const committedMembership = useRef(new Map<string, Map<string, ContractInfo | null>>());
    const committedOrder = useRef(new Map<string, ContractInfo[]>());
    const desiredContracts = useRef(new Map<string, ContractInfo[]>());
    const mutationTails = useRef(new Map<string, Promise<void>>());
    const pendingMutations = useRef(new Map<string, number>());
    const failedSaves = useRef(new Set<string>());
    const deferredContractEvents = useRef(new Set<string>());
    const replayContractEvent = useRef<(id: string) => void>(() => undefined);
    activeIdRef.current = activeListId;
    const retryLoad = useCallback(() => {
        initStarted.current = false;
        canReplaceList.current = false;
        failedSaves.current.clear();
        setLoadError(false);
        setLoading(true);
        setRetryKey((key) => key + 1);
    }, []);

    const subscribeContract = useCallback(async (contract: ContractInfo) => {
        if (contract.target_code) {
            registerCodeAlias(contract.target_code, contract.code);
        }
        primeContract(contract);
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

    const keepCommittedOrder = useCallback((id: string, list: ServerWatchlist) => {
        const anchor = committedOrder.current.get(id);
        if (!anchor) return list;
        const key = (contract: { security_type: string | null; code: string }) =>
            `${contract.security_type}:${contract.code}`;
        const byKey = new Map(list.contracts.map((contract) => [key(contract), contract]));
        const anchored = anchor.flatMap((contract) => {
            const base = byKey.get(key(contract));
            if (!base) return [];
            byKey.delete(key(contract));
            return [base];
        });
        return { ...list, contracts: [...anchored, ...byKey.values()] };
    }, []);

    const refreshLists = useCallback(async (): Promise<ServerWatchlist[]> => {
        const request = ++refreshRequest.current;
        let lists = await fetchWatchlists();
        // An older response may still apply while a newer GET is pending;
        // this keeps the just-saved list available for its deferred reload.
        // Once a newer response has applied, an older one cannot replace it.
        if (request < refreshApplied.current) return serverListsRef.current;
        for (const [oldId, renamed] of pendingRenames.current) {
            if (lists.some((list) => list.id === renamed.id) &&
                !lists.some((list) => list.id === oldId)) {
                pendingRenames.current.delete(oldId);
            } else {
                lists = [...lists.filter((list) => list.id !== oldId && list.id !== renamed.id), renamed];
            }
        }
        for (const id of pendingDeletions.current) {
            if (!lists.some((list) => list.id === id)) pendingDeletions.current.delete(id);
            else lists = lists.filter((list) => list.id !== id);
        }
        lists = lists.map((list) => {
            // A single successful GET is not a consistency barrier: a later
            // read can still come from an older server snapshot. Keep this
            // session's confirmed membership edits until they are superseded.
            const unconfirmed = committedMembership.current.get(list.id);
            const membership = unconfirmed?.size
                ? { ...list, contracts: [
                    ...list.contracts.filter((contract) => !unconfirmed.has(contract.code)),
                    ...[...unconfirmed.values()].flatMap((contract) => contract ? [{
                        security_type: contract.security_type,
                        exchange: contract.exchange ?? '',
                        code: contract.code,
                    }] : []),
                ] }
                : list;
            const reconciled = keepCommittedOrder(list.id, membership);
            const expected = pendingServerContracts.current.get(list.id);
            if (!expected) return reconciled;
            if (expected.length === reconciled.contracts.length && expected.every((contract, index) =>
                contract.code === reconciled.contracts[index]?.code &&
                contract.security_type === reconciled.contracts[index]?.security_type)) {
                pendingServerContracts.current.delete(list.id);
                return reconciled;
            }
            return { ...reconciled, contracts: expected };
        });
        refreshApplied.current = request;
        serverListsRef.current = lists;
        setServerLists(lists);
        return lists;
    }, [keepCommittedOrder]);

    const applyLocalLists = useCallback((lists: ServerWatchlist[]) => {
        // A server mutation has committed. Invalidate older GET responses so
        // a failed or slow follow-up read cannot restore the old snapshot.
        refreshApplied.current = ++refreshRequest.current;
        serverListsRef.current = lists;
        setServerLists(lists);
    }, []);

    const patchLocalContracts = useCallback((id: string, contracts: ContractInfo[]) => {
        pendingServerContracts.current.set(id, contracts.map((contract) => ({
            security_type: contract.security_type,
            exchange: contract.exchange ?? '',
            code: contract.code,
        })));
        applyLocalLists(serverListsRef.current.map((list) => list.id === id
            ? { ...list, contracts: pendingServerContracts.current.get(id)! }
            : list));
    }, [applyLocalLists]);

    const reconcileFailedMembership = useCallback((id: string, list: ServerWatchlist) => {
        const changes = committedMembership.current.get(id);
        if (!changes?.size) return keepCommittedOrder(id, list);
        const unchanged = list.contracts.filter((contract) => !changes.has(contract.code));
        const added = [...changes.values()].flatMap((contract) => contract ? [{
            security_type: contract.security_type,
            exchange: contract.exchange ?? '',
            code: contract.code,
        }] : []);
        return keepCommittedOrder(id, { ...list, contracts: [...unchanged, ...added] });
    }, [keepCommittedOrder]);

    const enqueueMutation = useCallback((id: string, task: () => Promise<void>) => {
        pendingMutations.current.set(id, (pendingMutations.current.get(id) ?? 0) + 1);
        const write = (mutationTails.current.get(id) ?? Promise.resolve()).then(task);
        mutationTails.current.set(id, write.then(() => undefined, () => undefined));
        void write.then(
            () => finish(),
            () => finish(),
        );
        function finish() {
            const remaining = (pendingMutations.current.get(id) ?? 1) - 1;
            if (remaining > 0) pendingMutations.current.set(id, remaining);
            else {
                pendingMutations.current.delete(id);
                if (!failedSaves.current.has(id) && deferredContractEvents.current.delete(id)) {
                    replayContractEvent.current(id);
                }
            }
        }
        return write;
    }, []);

    // push the current items to the server (PUT replaces all contracts)
    const persistItems = useCallback(
        (id: string) => {
            if (!id || !canReplaceList.current) return;
            const seq = loadSeq.current;
            // Every list mutation shares this list's queue. Read the latest
            // desired order when the PUT starts so a preceding add/remove is
            // included even if the user moved another row while it was pending.
            const write = enqueueMutation(id, async () => {
                const contractsToSave = desiredContracts.current.get(id) ?? [];
                try {
                    await syncWatchlist(id, contractsToSave);
                } catch (error) {
                    failedSaves.current.add(id);
                    throw error;
                }
                committedOrder.current.set(id, contractsToSave);
                patchLocalContracts(id, contractsToSave);
                // The PUT committed. A failed follow-up GET must not make us
                // roll the visible order back to the previous list snapshot.
                await refreshLists().catch(() => undefined);
            });
            void write
                .catch(() => {
                    if (activeIdRef.current === id && loadSeq.current === seq) {
                        canReplaceList.current = false;
                        setLoadError(true);
                    }
                    // A later POST/DELETE does not save a failed PUT's order.
                    // Queue the authoritative read after this list's pending
                    // writes. New writes will then use its corrected order.
                    deferredContractEvents.current.add(id);
                    void enqueueMutation(id, async () => {
                        if (!failedSaves.current.has(id)) return;
                        // The optimistic reorder was rejected; a later POST
                        // may have committed only membership. Read the raw
                        // server order for recovery, without our commit overlay.
                        pendingServerContracts.current.delete(id);
                        const lists = await fetchWatchlists();
                        const raw = lists.find((candidate) => candidate.id === id);
                        if (!raw) throw new Error('自選清單已不存在');
                        const list = reconcileFailedMembership(id, raw);
                        const previous = new Map(
                            (desiredContracts.current.get(id) ?? []).map((contract) => [
                                `${contract.security_type}:${contract.code}`,
                                contract,
                            ]),
                        );
                        const authoritative = await Promise.all(list.contracts.map(
                            (base) => previous.get(`${base.security_type}:${base.code}`) ??
                                resolveWatchlistContract(base),
                        ));
                        desiredContracts.current.set(id, authoritative);
                        pendingServerContracts.current.set(id, list.contracts);
                        // Merge this list's raw recovery result into the
                        // current snapshot; a newer update to another list
                        // must not invalidate or replace this read.
                        const current = serverListsRef.current;
                        applyLocalLists(current.some((candidate) => candidate.id === id)
                            ? current.map((candidate) => candidate.id === id ? list : candidate)
                            : [...current, list]);
                        failedSaves.current.delete(id);
                    }).catch(() => undefined);
                    notify({
                        kind: 'err',
                        title: '自選清單同步失敗',
                        body: '與伺服器同步時發生錯誤',
                    });
                });
        },
        [enqueueMutation, patchLocalContracts, applyLocalLists, reconcileFailedMembership, refreshLists],
    );

    const loadList = useCallback(
        async (list: ServerWatchlist, preserveVisible = false) => {
            const seq = ++loadSeq.current;
            canReplaceList.current = false;
            setLoading(true);
            setLoadError(false);
            if (!preserveVisible) setItems([]);
            try {
                const resolutions = list.contracts.map(resolveWatchlistContract);
                // The linked panels only need one symbol to stop showing
                // "等待商品…". Let the first available one render immediately;
                // the full list can keep loading without holding the workspace.
                // Editing stays locked until every contract has been checked.
                let finished = false;
                if (!preserveVisible) {
                    void Promise.any(resolutions).then(async (first) => {
                        if (loadSeq.current !== seq || finished) return;
                        await subscribeContract(first);
                        if (loadSeq.current !== seq || finished) return;
                        setItems([{ contract: first }]);
                    }).catch(() => undefined);
                }
                const results = await Promise.allSettled(resolutions);
                finished = true;
                if (loadSeq.current !== seq) return;
                const contracts = results
                    .filter(
                        (r): r is PromiseFulfilledResult<ContractInfo> =>
                            r.status === 'fulfilled',
                    )
                    .map((r) => r.value);
                const resolveFailed = results.some((r) => r.status === 'rejected');
                const migrated = !resolveFailed && contracts.some(
                    (contract, index) =>
                        contract.code !== list.contracts[index]?.code,
                );
                const subscriptions = await Promise.allSettled(contracts.map(subscribeContract));
                if (loadSeq.current !== seq) return;
                if (!preserveVisible || !resolveFailed) {
                    setItems(contracts.map((c) => ({ contract: c })));
                    attachSnapshots(contracts);
                }
                if (!resolveFailed) desiredContracts.current.set(list.id, contracts);
                if (migrated) {
                    await syncWatchlist(list.id, contracts);
                    await refreshLists();
                }
                if (loadSeq.current === seq) {
                    const complete = !resolveFailed &&
                        subscriptions.every((r) => r.status === 'fulfilled');
                    canReplaceList.current = complete;
                    setLoadError(!complete);
                }
            } catch {
                if (loadSeq.current === seq) setLoadError(true);
            } finally {
                if (loadSeq.current === seq) setLoading(false);
            }
        },
        [subscribeContract, attachSnapshots, refreshLists],
    );

    const setActiveList = useCallback(
        (listId: string, listsOverride?: ServerWatchlist[]) => {
            if (structureBusyRef.current) return;
            const list = (listsOverride ?? serverLists).find(
                (l) => l.id === listId,
            );
            if (!list) return;
            setActiveListId(listId);
            activeIdRef.current = listId;
            localStorage.setItem(ACTIVE_KEY, listId);
            if (pendingMutations.current.has(listId) || failedSaves.current.has(listId)) {
                ++loadSeq.current;
                // The picker still holds the pre-save server snapshot. Show
                // the desired order and reload from the server after the last
                // queued mutation settles instead of undoing the local move.
                const desired = desiredContracts.current.get(listId);
                canReplaceList.current = !!desired && !failedSaves.current.has(listId);
                setItems(desired?.map((contract) => ({ contract })) ?? []);
                setLoading(!desired);
                setLoadError(failedSaves.current.has(listId));
                if (desired) attachSnapshots(desired);
                deferredContractEvents.current.add(listId);
                return;
            }
            void loadList(list);
        },
        [serverLists, loadList, attachSnapshots],
    );

    replayContractEvent.current = (id) => {
        if (activeIdRef.current !== id) return;
        if (pendingMutations.current.has(id)) {
            deferredContractEvents.current.add(id);
            return;
        }
        const list = serverListsRef.current.find((candidate) => candidate.id === id);
        if (list) {
            const desired = desiredContracts.current.get(id);
            const contracts = desired?.map((contract) => ({
                security_type: contract.security_type,
                exchange: contract.exchange ?? '',
                code: contract.code,
            })) ?? list.contracts;
            void loadList({ ...list, contracts }, true);
        }
    };

    const addSymbol = useCallback(
        async (
            code: string,
            type?: SecurityType,
            resolved?: ContractInfo,
        ) => {
            if (loading) throw new Error('自選清單載入中，請稍後再試');
            if (structureBusyRef.current) throw new Error('自選清單更新中，請稍後再試');
            const id = activeIdRef.current;
            if (!id) throw new Error('自選清單尚未就緒');
            const contract = resolved ?? (await resolveContract(code, type));
            // 組合商品（合成合約）不能進自選 — server 端自選清單只收
            // 一般合約 code，同步會 400；組合請用「組合商品」面板
            if (contract.combo) {
                throw new Error(
                    '組合商品暫不支援加入自選，請使用「組合商品」面板',
                );
            }
            if (resolved) primeContract(resolved);
            if (items.some((i) => i.contract.code === contract.code)) {
                return contract;
            }
            await subscribeContract(contract);
            // Resolution can outlive a rename that replaced this list ID.
            // Do not queue a POST against the retired list.
            if (structureBusyRef.current || activeIdRef.current !== id) {
                throw new Error('自選清單已切換，請重新新增商品');
            }
            await enqueueMutation(id, async () => {
                const desired = desiredContracts.current.get(id) ?? [];
                if (desired.some((item) => item.code === contract.code)) return;
                await addWatchlistContracts(id, [contract]);
                const changes = committedMembership.current.get(id) ?? new Map();
                changes.set(contract.code, contract);
                committedMembership.current.set(id, changes);
                // A move can update the desired order while POST is in flight.
                const latest = desiredContracts.current.get(id) ?? desired;
                desiredContracts.current.set(id, [...latest, contract]);
                patchLocalContracts(id, desiredContracts.current.get(id) ?? []);
                if (activeIdRef.current === id) {
                    setItems((prev) => [...prev, { contract }]);
                    attachSnapshots([contract]);
                }
                await refreshLists().catch(() => undefined);
            });
            return contract;
        },
        [
            items,
            loading,
            subscribeContract,
            attachSnapshots,
            enqueueMutation,
            patchLocalContracts,
            refreshLists,
        ],
    );

    const removeSymbol = useCallback(
        async (code: string) => {
            if (loading || structureBusyRef.current) return;
            const item = items.find((i) => i.contract.code === code);
            if (!item) return;
            const id = activeIdRef.current;
            if (id) {
                await enqueueMutation(id, async () => {
                    await removeWatchlistContracts(id, [item.contract]);
                    const changes = committedMembership.current.get(id) ?? new Map();
                    changes.set(code, null);
                    committedMembership.current.set(id, changes);
                    const desired = desiredContracts.current.get(id) ?? [];
                    desiredContracts.current.set(id, desired.filter((contract) => contract.code !== code));
                    patchLocalContracts(id, desiredContracts.current.get(id) ?? []);
                    if (activeIdRef.current === id) {
                        setItems((prev) => prev.filter((i) => i.contract.code !== code));
                    }
                    await refreshLists().catch(() => undefined);
                });
            }
        },
        [items, loading, enqueueMutation, patchLocalContracts, refreshLists],
    );

    // drag-to-reorder: move `fromCode` to the position of `toCode`
    const reorderSymbol = useCallback(
        (fromCode: string, toCode: string) => {
            const id = activeIdRef.current;
            if (!id || !canReplaceList.current) return;
            const current = desiredContracts.current.get(id) ?? items.map((item) => item.contract);
            const fromIdx = current.findIndex((contract) => contract.code === fromCode);
            const toIdx = current.findIndex((contract) => contract.code === toCode);
            if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
            const next = [...current];
            const [moved] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, moved!);
            desiredContracts.current.set(id, next);
            setItems((prev) => {
                const byCode = new Map(prev.map((item) => [item.contract.code, item]));
                return next.map((contract) => byCode.get(contract.code) ?? { contract });
            });
            persistItems(id);
        },
        [items, persistItems],
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
            if (structureBusyRef.current) return false;
            if (trimmed === list.name) return true;
            if (serverLists.some((l) => l.id !== id && l.name === trimmed)) {
                notify({
                    kind: 'err',
                    title: '清單名稱重複',
                    body: `已有名為「${trimmed}」的清單`,
                });
                return false;
            }
            const wasReplaceable = canReplaceList.current;
            canReplaceList.current = false;
            structureBusyRef.current = true;
            setStructureBusy(true);
            try {
                await enqueueMutation(id, async () => {
                    // A preceding queued move may have changed the contracts
                    // since this render. Rename from the latest server list.
                    const raw = (await fetchWatchlists()).find((candidate) => candidate.id === id) ?? list;
                    const recovering = failedSaves.current.has(id);
                    // A successful POST/PUT may still be absent from a stale
                    // GET; recreate from confirmed local commits in either case.
                    const current = reconcileFailedMembership(id, raw);
                    const authoritative = recovering
                        ? await Promise.all(current.contracts.map(resolveWatchlistContract))
                        : null;
                    const created = await renameWatchlist(current, trimmed);
                    desiredContracts.current.set(
                        created.id,
                        authoritative ?? desiredContracts.current.get(id) ?? [],
                    );
                    desiredContracts.current.delete(id);
                    pendingServerContracts.current.delete(id);
                    const membership = committedMembership.current.get(id);
                    if (membership) committedMembership.current.set(created.id, membership);
                    committedMembership.current.delete(id);
                    const order = committedOrder.current.get(id);
                    if (order) committedOrder.current.set(created.id, order);
                    committedOrder.current.delete(id);
                    pendingRenames.current.set(id, created);
                    if (recovering) {
                        failedSaves.current.delete(id);
                        if (activeIdRef.current === id) {
                            setItems((authoritative ?? []).map((contract) => ({ contract })));
                        }
                    }
                    activeIdRef.current = created.id;
                    setActiveListId(created.id);
                    localStorage.setItem(ACTIVE_KEY, created.id);
                    applyLocalLists(serverListsRef.current.map((candidate) => candidate.id === id
                        ? created : candidate));
                    await refreshLists().catch(() => undefined);
                    if (deferredContractEvents.current.delete(id)) {
                        replayContractEvent.current(created.id);
                    }
                });
                if (activeIdRef.current !== id) canReplaceList.current = wasReplaceable;
                notify({
                    kind: 'ok',
                    title: '已重新命名',
                    body: `「${list.name}」→「${trimmed}」`,
                });
                return true;
            } catch {
                if (activeIdRef.current === id) canReplaceList.current = wasReplaceable;
                await refreshLists().catch(() => undefined);
                notify({
                    kind: 'err',
                    title: '重新命名失敗',
                    body: '與伺服器同步時發生錯誤',
                });
                return false;
            } finally {
                structureBusyRef.current = false;
                setStructureBusy(false);
            }
        },
        [serverLists, enqueueMutation, applyLocalLists, reconcileFailedMembership, refreshLists],
    );

    const deleteCurrentList = useCallback(async () => {
        const id = activeIdRef.current;
        const list = serverLists.find((l) => l.id === id);
        if (!id || !list || structureBusyRef.current) return;
        const wasReplaceable = canReplaceList.current;
        canReplaceList.current = false;
        structureBusyRef.current = true;
        setStructureBusy(true);
        let lists: ServerWatchlist[] = [];
        try {
            await enqueueMutation(id, async () => {
                await deleteWatchlist(id);
                desiredContracts.current.delete(id);
                pendingServerContracts.current.delete(id);
                committedMembership.current.delete(id);
                committedOrder.current.delete(id);
                pendingDeletions.current.add(id);
                deferredContractEvents.current.delete(id);
                failedSaves.current.delete(id);
                applyLocalLists(serverListsRef.current.filter((candidate) => candidate.id !== id));
                lists = await refreshLists().catch(() => serverListsRef.current);
            });
        } catch (error) {
            if (activeIdRef.current === id) canReplaceList.current = wasReplaceable;
            throw error;
        } finally {
            structureBusyRef.current = false;
            setStructureBusy(false);
        }
        notify({
            kind: 'ok',
            title: '已刪除清單',
            body: `「${list.name}」已刪除`,
        });
        const fallback = lists[0];
        if (activeIdRef.current !== id) return;
        if (fallback) {
            setActiveList(fallback.id, lists);
        } else {
            activeIdRef.current = '';
            localStorage.removeItem(ACTIVE_KEY);
            setItems([]);
            setActiveListId('');
        }
    }, [serverLists, enqueueMutation, applyLocalLists, refreshLists, setActiveList]);

    // boot: load lists; migrate legacy local list / create default if empty.
    // The first fetch can race a server that is still warming up after an
    // app update/restart — retry with backoff instead of giving up (the
    // poll-based panels recover on their own; this one must too).
    useEffect(() => {
        if (initStarted.current) return;
        initStarted.current = true;
        setLoadError(false);
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
                        // A healthy HTTP server can still be waiting for its
                        // Shioaji session. Keep retrying in the background;
                        // the terminal itself never waits for this one list.
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
                    if (resolved.some((r) => r.status === 'rejected')) {
                        throw new Error('自選清單合約尚未全數解析，稍後重試');
                    }
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
                setLoadError(true);
                setLoading(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [retryKey]);

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
                const id = activeIdRef.current;
                void refreshCachedContracts(pendingType ?? undefined);
                if (pendingMutations.current.has(id)) deferredContractEvents.current.add(id);
                else replayContractEvent.current(id);
                timer = null;
                pendingType = undefined;
            }, 250);
        });
        return () => {
            off();
            if (timer) clearTimeout(timer);
        };
    }, [loadList]);

    return {
        items,
        loading: loading || structureBusy,
        structureBusy,
        loadError,
        retryLoad,
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
