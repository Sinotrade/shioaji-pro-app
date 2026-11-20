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
    type ServerWatchlist,
    type ServerWatchlistContract,
} from '../lib/shioaji';
import { contractLinkKey, isUsKey, usLinkKey } from '../lib/contract-key';
import { noteUsReference } from '../lib/us/us-quotes';
import { cachedUsInfo, loadUsInfo, resolveUsContract, toUsContractInfo } from '../lib/us/us-contracts';
import { onContractEvent, registerCodeAlias } from '../lib/stream';
import { notify } from '../lib/trade';
import { onWatchlistChanged, type WatchlistChangedDetail } from '../lib/watchlist-sync';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fetchUsSnapshots, type UsSnapshot } from '../lib/us/us-history';
import { useUsMarketClock } from './use-us-market-clock';

export interface WatchItem {
    contract: ContractInfo;
    snapshot?: Snapshot;
    /** 美股快照（SDK 1.8.0b1）：沒有即時成交前的價格與漲跌 */
    usSnapshot?: UsSnapshot;
}

const US_SNAPSHOT_BATCH = 50;

/** 晚回來的舊請求（例如切換清單前送出的）不可蓋掉較新的快照 */
export function isNewerUsSnapshot(row: UsSnapshot, current: UsSnapshot | undefined): boolean {
    if (!current) return true;
    if (row.ts === null || current.ts === null) return row.ts !== null || current.ts === null;
    return row.ts >= current.ts;
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

/** 第一次把美股加進自選時提示一次（舊版 SDK 讀含美股的清單會失敗） */
export const US_WATCHLIST_NOTICE_KEY = 'sj-pro-us-watchlist-notice:v1';

function noticeUsWatchlistOnce() {
    try {
        if (localStorage.getItem(US_WATCHLIST_NOTICE_KEY)) return;
        localStorage.setItem(US_WATCHLIST_NOTICE_KEY, '1');
    } catch {
        // 讀不到儲存空間：照樣提示，下次可能再提示一次
    }
    notify({
        kind: 'info',
        title: '自選清單已含美股',
        body: '含美股的自選清單：使用 SDK 1.7.x 的程式讀取時會失敗，請改用 1.8.0b1 以上版本',
    });
}

/** 自選成員（伺服器 wire 或 ContractInfo）共用的最小欄位 */
type MemberBase = { security_type: string | null; code: string; region?: string | null };

/** 成員的連動 key：美股 `US:CODE`，台股裸代碼（台股 `T` 與美股 `T` 不會撞名） */
export const memberLinkKey = (contract: MemberBase) =>
    contractLinkKey({ code: contract.code, region: contract.region === 'US' ? 'US' : 'TW' });

const isUsMember = (contract: MemberBase) => contract.region === 'US';

/** ContractInfo → 伺服器清單的成員格式；美股帶 region（台股維持舊格式） */
function toWire(contract: ContractInfo): ServerWatchlistContract {
    return {
        security_type: contract.security_type,
        exchange: contract.exchange ?? '',
        code: contract.code,
        ...(contract.region === 'US' ? { region: 'US' as const } : {}),
    };
}

async function resolveContract(
    code: string,
    type?: SecurityType | null,
): Promise<ContractInfo> {
    // 美股 `US:CODE` 一律走美股商品資訊，不打 region=TW 查詢
    if (isUsKey(code)) return ensureContract(code);
    if (type) return resolveContractV2(code, type);
    return ensureContract(code);
}

/**
 * 還原美股成員：名稱與前一日參考價取自美股商品資訊（今日快取優先），
 * 交易所以清單內存的實際交易所墊底；絕不以 region=TW 查詢。
 */
async function restoreUsMember(base: MemberBase & { exchange?: string | null }): Promise<ContractInfo> {
    const info = await loadUsInfo(base.code).catch(() => cachedUsInfo(base.code));
    const contract = toUsContractInfo(base.code, info, { exchange: base.exchange ?? '' });
    if (!contract.exchange) throw new Error(`查不到美股 ${base.code} 的交易所`);
    return contract;
}

export function resolveWatchlistContract(
    base: ServerWatchlistContract,
): Promise<ContractInfo> {
    if (isUsMember(base)) return restoreUsMember(base);
    // The watchlist already contains a Base contract. Fetch only the typed
    // details; preserve the generic lookup for legacy/missing types and WRT,
    // whose Info endpoint requires an underlying shard.
    if (base.security_type && base.security_type !== 'WRT') {
        return fetchContractInfo(base.code, base.security_type);
    }
    return resolveContract(base.code, base.security_type);
}

const membershipKey = (contract: MemberBase) =>
    `${contract.security_type}:${memberLinkKey(contract)}`;

/**
 * True when the server list's members differ from what the panel is about
 * to save. This session's own confirmed adds/removes are overlaid first, so
 * a read from a slightly older server snapshot is not mistaken for a change.
 */
export function serverMembershipChanged(
    server: { contracts: readonly MemberBase[] },
    toSave: readonly MemberBase[],
    committed?: ReadonlyMap<string, MemberBase | null>,
): boolean {
    const members = new Set(server.contracts
        .filter((contract) => !committed?.has(memberLinkKey(contract)))
        .map(membershipKey));
    for (const contract of committed?.values() ?? []) {
        if (contract) members.add(membershipKey(contract));
    }
    const saving = new Set(toSave.map(membershipKey));
    return members.size !== saving.size || [...saving].some((key) => !members.has(key));
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
    // 重新讀取 (#340): local edits in progress hold an external re-read until
    // they finish, so an Agent change never yanks a row out mid-drag.
    const [reloading, setReloading] = useState(false);
    const editingHolds = useRef(0);
    const deferredReload = useRef<WatchlistChangedDetail | null>(null);
    const flushDeferredReload = useRef<() => void>(() => undefined);
    // A panel save found the server list changed elsewhere: the re-read
    // runs as soon as the queue drains, even while 調整順序 holds re-reads.
    const conflictReload = useRef(false);
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

    const attachUsSnapshots = useCallback((all: ContractInfo[]) => {
        // 美股快照另外批次抓（載入／加入時一次，之後只在美東時段界線再抓，不輪詢）；
        // 舊 SDK 或非正式環境拿不到就維持「參考價」顯示
        const us = all.filter(isUsMember);
        for (let i = 0; i < us.length; i += US_SNAPSHOT_BATCH) {
            const batch = us.slice(i, i + US_SNAPSHOT_BATCH);
            fetchUsSnapshots(batch)
                .then((rows) => {
                    const byKey = new Map<string, UsSnapshot>();
                    batch.forEach((c, n) => { const row = rows[n]; if (row && row.close > 0) byKey.set(contractLinkKey(c), row); });
                    if (byKey.size === 0) return;
                    setItems((prev) => prev.map((i) => {
                        const row = isUsMember(i.contract) ? byKey.get(contractLinkKey(i.contract)) : undefined;
                        if (row?.tradeDate) noteUsReference(usLinkKey(row.code), row.tradeDate, row.reference);
                        return row && isNewerUsSnapshot(row, i.usSnapshot) ? { ...i, usSnapshot: row } : i;
                    }));
                })
                .catch(() => undefined);
        }
    }, []);

    const attachSnapshots = useCallback((all: ContractInfo[]) => {
        attachUsSnapshots(all);
        const contracts = all.filter((contract) => !isUsMember(contract));
        if (contracts.length === 0) return;
        fetchSnapshots(contracts)
            .then((snaps) => {
                const byCode = new Map(snaps.map((s) => [s.code, s]));
                setItems((prev) =>
                    prev.map((i) => {
                        if (isUsMember(i.contract)) return i;
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
    }, [attachUsSnapshots]);

    // 美東時段界線（04:00、09:30、16:00、20:00 ET）一過就重抓美股快照：沒有即時成交的
    // 商品也會換到正確的狀態（盤前價、盤後價、收盤後轉灰、04:00 換日清掉）
    const usClock = useUsMarketClock();
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const lastUsClock = useRef(usClock);
    useEffect(() => {
        if (lastUsClock.current === usClock) return;
        lastUsClock.current = usClock;
        attachUsSnapshots(itemsRef.current.map((i) => i.contract));
        // 伺服器剛過界線可能還沒換：30 秒後再抓一次（晚回來的舊快照由 isNewerUsSnapshot 擋掉）
        const again = setTimeout(() => attachUsSnapshots(itemsRef.current.map((i) => i.contract)), 30_000);
        return () => clearTimeout(again);
    }, [usClock, attachUsSnapshots]);

    const keepCommittedOrder = useCallback((id: string, list: ServerWatchlist) => {
        const anchor = committedOrder.current.get(id);
        if (!anchor) return list;
        const key = membershipKey;
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
                    ...list.contracts.filter((contract) => !unconfirmed.has(memberLinkKey(contract))),
                    ...[...unconfirmed.values()].flatMap((contract) => contract ? [toWire(contract)] : []),
                ] }
                : list;
            const reconciled = keepCommittedOrder(list.id, membership);
            const expected = pendingServerContracts.current.get(list.id);
            if (!expected) return reconciled;
            if (expected.length === reconciled.contracts.length && expected.every((contract, index) =>
                reconciled.contracts[index] !== undefined &&
                membershipKey(contract) === membershipKey(reconciled.contracts[index]!))) {
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
        pendingServerContracts.current.set(id, contracts.map(toWire));
        applyLocalLists(serverListsRef.current.map((list) => list.id === id
            ? { ...list, contracts: pendingServerContracts.current.get(id)! }
            : list));
    }, [applyLocalLists]);

    const reconcileFailedMembership = useCallback((id: string, list: ServerWatchlist) => {
        const changes = committedMembership.current.get(id);
        if (!changes?.size) return keepCommittedOrder(id, list);
        const unchanged = list.contracts.filter((contract) => !changes.has(memberLinkKey(contract)));
        const added = [...changes.values()].flatMap((contract) => contract ? [toWire(contract)] : []);
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
                if (pendingMutations.current.size === 0) flushDeferredReload.current();
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
                if (conflictReload.current) return;
                // The PUT replaces the whole list and the API has no version
                // check. Read the server first: if its membership differs from
                // this panel's snapshot (an Agent, the CLI or another device
                // added or removed symbols), saving would silently undo that.
                // A failed check read does not block the save; the PUT then
                // reports its own error as before.
                const lists = await fetchWatchlists().catch(() => null);
                const raw = lists?.find((candidate) => candidate.id === id);
                if (lists && (!raw || serverMembershipChanged(raw, contractsToSave, committedMembership.current.get(id)))) {
                    conflictReload.current = true;
                    deferredReload.current = { ...deferredReload.current };
                    notify({
                        kind: 'info',
                        title: '自選清單已在其他地方變更',
                        body: '已取消這次調整，並重新讀取伺服器上的最新清單',
                    });
                    return;
                }
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
                                membershipKey(contract),
                                contract,
                            ]),
                        );
                        const authoritative = await Promise.all(list.contracts.map(
                            (base) => previous.get(membershipKey(base)) ??
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
            const contracts = desired?.map(toWire) ?? list.contracts;
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
            let contract = resolved ?? (await resolveContract(code, type));
            // 美股：搜尋建議的合約可能還沒有參考價，加入前補齊商品資訊；
            // 送出的 exchange 必須是實際交易所（NASDAQ／NYSE／BATS／TXSE）
            if (isUsMember(contract) && (!contract.us_reference || !contract.exchange)) {
                const usContract = contract;
                contract = await resolveUsContract(usContract.code).catch(() => usContract);
            }
            if (isUsMember(contract) && !contract.exchange) {
                throw new Error(`查不到美股 ${contract.code} 的交易所，無法加入自選`);
            }
            const key = memberLinkKey(contract);
            // 組合商品（合成合約）不能進自選 — server 端自選清單只收
            // 一般合約 code，同步會 400；組合請用「組合商品」面板
            if (contract.combo) {
                throw new Error(
                    '組合商品暫不支援加入自選，請使用「組合商品」面板',
                );
            }
            if (resolved) primeContract(contract);
            if (items.some((i) => memberLinkKey(i.contract) === key)) {
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
                if (desired.some((item) => memberLinkKey(item) === key)) return;
                await addWatchlistContracts(id, [contract]);
                if (isUsMember(contract)) noticeUsWatchlistOnce();
                const changes = committedMembership.current.get(id) ?? new Map();
                changes.set(key, contract);
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

    // key：contractLinkKey（台股裸代碼、美股 `US:CODE`）
    const removeSymbol = useCallback(
        async (key: string) => {
            if (loading || structureBusyRef.current) return;
            const item = items.find((i) => memberLinkKey(i.contract) === key);
            if (!item) return;
            const id = activeIdRef.current;
            if (id) {
                await enqueueMutation(id, async () => {
                    await removeWatchlistContracts(id, [item.contract]);
                    const changes = committedMembership.current.get(id) ?? new Map();
                    changes.set(key, null);
                    committedMembership.current.set(id, changes);
                    const desired = desiredContracts.current.get(id) ?? [];
                    desiredContracts.current.set(id, desired.filter((contract) => memberLinkKey(contract) !== key));
                    patchLocalContracts(id, desiredContracts.current.get(id) ?? []);
                    if (activeIdRef.current === id) {
                        setItems((prev) => prev.filter((i) => memberLinkKey(i.contract) !== key));
                    }
                    await refreshLists().catch(() => undefined);
                });
            }
        },
        [items, loading, enqueueMutation, patchLocalContracts, refreshLists],
    );

    // drag-to-reorder: move `fromKey` to the position of `toKey`
    // （contractLinkKey：台股裸代碼、美股 `US:CODE`）
    const reorderSymbol = useCallback(
        (fromKey: string, toKey: string) => {
            const id = activeIdRef.current;
            if (!id || !canReplaceList.current) return;
            const current = desiredContracts.current.get(id) ?? items.map((item) => item.contract);
            const fromIdx = current.findIndex((contract) => memberLinkKey(contract) === fromKey);
            const toIdx = current.findIndex((contract) => memberLinkKey(contract) === toKey);
            if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
            const next = [...current];
            const [moved] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, moved!);
            desiredContracts.current.set(id, next);
            setItems((prev) => {
                const byKey = new Map(prev.map((item) => [memberLinkKey(item.contract), item]));
                return next.map((contract) => byKey.get(memberLinkKey(contract)) ?? { contract });
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
                queueMicrotask(() => flushDeferredReload.current());
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
            queueMicrotask(() => flushDeferredReload.current());
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

    // 重新讀取 (#340): read the server lists again after another program (the
    // AI Agent, the CLI, another device) changed them. Explicit only: the
    // reload button or the in-App WATCHLIST_CHANGED_EVENT; nothing polls.
    // Returns 'deferred' while a local edit (pending save, rename/delete,
    // 調整順序 mode, inline rename/create) is in progress; the re-read then
    // runs when that edit settles, so it never overwrites unsaved work.
    const reloadFromServer = useCallback(
        async (request: WatchlistChangedDetail = {}): Promise<'reloaded' | 'deferred' | 'failed'> => {
            const held = editingHolds.current > 0 && !conflictReload.current;
            if (structureBusyRef.current || pendingMutations.current.size > 0 || held) {
                const first = !deferredReload.current;
                deferredReload.current = { ...deferredReload.current, ...request };
                if (first) {
                    notify({
                        kind: 'info',
                        title: request.source === 'agent' ? '自選清單已由 Agent 變更' : '稍後重新讀取自選清單',
                        body: '你正在編輯或儲存清單，完成後會自動重新讀取伺服器上的最新清單',
                    });
                }
                return 'deferred';
            }
            deferredReload.current = null;
            conflictReload.current = false;
            // An explicit re-read trusts the server: drop this session's
            // read-your-writes overlays so an outside reorder or removal is
            // not masked by an older local commit.
            const dropOverlays = () => {
                committedMembership.current.clear();
                committedOrder.current.clear();
                pendingServerContracts.current.clear();
                deferredContractEvents.current.clear();
                desiredContracts.current.clear();
            };
            if (failedSaves.current.size > 0) {
                // A rejected save already left the panel in its error state;
                // a full re-read from the server is the same as 重試.
                dropOverlays();
                retryLoad();
                return 'reloaded';
            }
            // Lock edits for the whole re-read: an add, remove or move that
            // started now would mix with the snapshot being replaced.
            structureBusyRef.current = true;
            setStructureBusy(true);
            canReplaceList.current = false;
            setReloading(true);
            try {
                dropOverlays();
                const lists = await refreshLists();
                const target =
                    (request.select ? lists.find((list) => list.id === request.select) : undefined) ??
                    lists.find((list) => list.id === activeIdRef.current) ??
                    lists[0];
                if (!target) {
                    ++loadSeq.current;
                    activeIdRef.current = '';
                    localStorage.removeItem(ACTIVE_KEY);
                    setActiveListId('');
                    setItems([]);
                    setLoading(false);
                    return 'reloaded';
                }
                const sameList = target.id === activeIdRef.current;
                activeIdRef.current = target.id;
                setActiveListId(target.id);
                localStorage.setItem(ACTIVE_KEY, target.id);
                await loadList(target, sameList);
                return 'reloaded';
            } catch {
                setLoadError(true);
                notify({ kind: 'err', title: '重新讀取自選清單失敗', body: '無法讀取伺服器上的自選清單，請稍後再試' });
                return 'failed';
            } finally {
                structureBusyRef.current = false;
                setStructureBusy(false);
                setReloading(false);
                queueMicrotask(() => flushDeferredReload.current());
            }
        },
        [refreshLists, loadList, retryLoad],
    );

    flushDeferredReload.current = () => {
        const request = deferredReload.current;
        const held = editingHolds.current > 0 && !conflictReload.current;
        if (!request || structureBusyRef.current || pendingMutations.current.size > 0 || held) return;
        deferredReload.current = null;
        void reloadFromServer(request);
    };

    /** The panel holds external re-reads while the user is editing. */
    const holdReload = useCallback((held: boolean) => {
        editingHolds.current = Math.max(0, editingHolds.current + (held ? 1 : -1));
        if (!held) queueMicrotask(() => flushDeferredReload.current());
    }, []);

    useEffect(() => onWatchlistChanged((detail) => {
        void reloadFromServer(detail);
    }), [reloadFromServer]);

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
        reloadFromServer,
        reloading,
        holdReload,
    };
}
