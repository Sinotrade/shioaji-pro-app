import { RefreshButton } from './refresh-button';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
// src/components/option-chain.tsx — 臺指選擇權 T 字報價表（月選＋週選）.
// Loads the TAIEX option contracts once per Taipei day: the monthly TXO root
// plus every weekly root discovered from options/roots (issue #152).
// Expiries are keyed by (root, delivery_date). Every strike of the selected
// expiry is listed and scrollable, centred on the underlying index (fallback
// TXFR1, then the median strike). Only the strikes on screen (plus a buffer)
// subscribe to quotes; see docs/design/option-chain-range.md (#371).

import { Crosshair } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '../hooks/use-query';
import { useQuote } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import {
    buildExpiries,
    chainUnderlying,
    chooseAtmReference,
    contractsForExpiry,
    identifiedChainRoots,
    isChainContract,
    migrateLegacyMonth,
    MONTHLY_ROOT,
    msUntilNextBoundary,
    pickChainRoots,
    resolveExpiry,
    taipeiClock,
    underlyingLabel,
    unverifiedContracts,
    type ChainContract,
    type ExpiryClock,
} from '../lib/option-expiry';
import { pickOptionLeg } from '../lib/option-pick';
import {
    centeredRange,
    fetchChainSnapshots,
    inRange,
    liveRangeFor,
    nextLiveRange,
    scrollTopFor,
    visibleRange,
    WINDOW_SETTLE_MS,
    type StrikeRange,
} from '../lib/option-window';
import { fetchOptionRoots, fetchOptions, fetchSnapshots } from '../lib/shioaji';
import type { Snapshot } from '../lib/types/market';
import { fmtCompactInt, fmtInt, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as styles from './option-chain.css';
import { AsyncStatus } from './async-status';
import { OptionExpiryPicker } from './option-expiry-picker';
import * as panel from './panel.css';

type OptContract = ChainContract;

// 各商品代碼的合約每個台北交易日載一次（週選每週掛牌／到期）。快取在
// 模組層級、只存在於單一視窗：彈出視窗是獨立的 webview，各自每天載一次。
// 只快取有資料的成功結果與已知的占位代碼；其他失敗（一次性 500、逾時）
// 與空結果都不快取，下次載入會重試。
interface RootRows {
    rows: OptContract[];
    // 回應中不是有效選擇權合約（缺到期日、履約價等欄位）的筆數
    invalid: number;
}
const rootCache = new Map<string, { day: string } & RootRows>();
let rootsCache: { day: string; roots: string[]; identified: string[] } | null =
    null;
const inflight = new Map<string, Promise<ChainLoad>>();
// resetChainContractsCache 之後，先前發出的請求晚到也不能寫回快取
let generation = 0;
// 跨午夜時舊交易日晚到的回應不能蓋掉較新交易日的快取（YYYY-MM-DD 可直接比字串）
const canCache = (cached: string | undefined, day: string, gen: number) =>
    gen === generation && (cached ?? '') <= day;

/** 測試用：清掉跨掛載的合約快取。 */
export function resetChainContractsCache() {
    generation += 1;
    rootCache.clear();
    rootsCache = null;
    inflight.clear();
}

// 合約查詢逾時（比照 kbars／capability 訂閱的 10 秒）；sidecar 懸住不回時
// 把該代碼當成讀取失敗，不讓整條 T 字卡在載入中
export const CHAIN_LOAD_TIMEOUT_MS = 10_000;

// 週選清單（options/roots）讀取失敗時在狀態列顯示的名稱
export const ROOTS_LABEL = '週選清單';

export interface ChainFailure {
    root: string; // 商品代碼，或 ROOTS_LABEL
    timeout: boolean;
}

export interface ChainLoad {
    rows: OptContract[];
    // false：roots 或某些代碼讀取失敗（非占位），可以重試
    complete: boolean;
    failures: ChainFailure[];
    // 可確認為臺指選擇權的代碼；合約缺 underlying_code 時只列這些
    identified: string[];
    // 可確認身分的代碼回應中欄位不完整、無法列出的合約數
    invalid: number;
}

/** 交易所預留、尚未有合約資料的週選代碼（sidecar 回 500 no info_hash）。 */
export function isPlaceholderRootError(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    return status === 500 && /info_hash/i.test(String((e as Error)?.message ?? e));
}

function isTimeout(e: unknown): boolean {
    return (e as { timeout?: boolean } | null)?.timeout === true;
}

/** 限時執行；逾時即中止請求並以 { timeout: true } 的錯誤拒絕，晚到的回應一律丟棄。 */
function withDeadline<T>(
    what: string,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                Object.assign(
                    new Error(
                        `${what} 查詢逾時（${CHAIN_LOAD_TIMEOUT_MS / 1000} 秒）`,
                    ),
                    { timeout: true },
                ),
            );
            controller.abort();
        }, CHAIN_LOAD_TIMEOUT_MS);
        run(controller.signal).then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e);
            },
        );
    });
}

async function loadRoot(
    root: string,
    day: string,
    gen: number,
): Promise<RootRows> {
    const hit = rootCache.get(root);
    if (hit?.day === day) return hit;
    try {
        const raw = (
            await withDeadline(root, (signal) =>
                fetchOptions(root, {}, { signal }),
            )
        ).map((c) => (c.root ? c : { ...c, root }));
        const rows = raw.filter(isChainContract);
        const result = { rows, invalid: raw.length - rows.length };
        if (rows.length && canCache(rootCache.get(root)?.day, day, gen))
            rootCache.set(root, { day, ...result });
        return result;
    } catch (e) {
        if (isPlaceholderRootError(e)) {
            if (canCache(rootCache.get(root)?.day, day, gen))
                rootCache.set(root, { day, rows: [], invalid: 0 });
            return { rows: [], invalid: 0 };
        }
        throw e;
    }
}

export function loadChainContracts(day: string): Promise<ChainLoad> {
    const pending = inflight.get(day);
    if (pending) return pending;
    const gen = generation;
    const p = (async (): Promise<ChainLoad> => {
        const failures: ChainFailure[] = [];
        // 月選不依賴 roots，先發出；roots 懸住時月選仍能在時限內載完
        const monthly = loadRoot(MONTHLY_ROOT, day, gen);
        monthly.catch(() => {}); // 下方 allSettled 會處理
        let wanted: string[];
        let identified: string[];
        if (rootsCache?.day === day)
            ({ roots: wanted, identified } = rootsCache);
        else {
            try {
                const roots = await withDeadline(ROOTS_LABEL, (signal) =>
                    fetchOptionRoots({ signal }),
                );
                // 空清單不是正常狀態（至少有月選）：當成失敗、不快取
                if (roots.length === 0) throw new Error('empty roots');
                wanted = pickChainRoots(roots);
                identified = identifiedChainRoots(roots);
                if (canCache(rootsCache?.day, day, gen))
                    rootsCache = { day, roots: wanted, identified };
            } catch (e) {
                // roots 查不到時先只載月選，下次載入再重試
                wanted = [MONTHLY_ROOT];
                identified = [MONTHLY_ROOT];
                failures.push({ root: ROOTS_LABEL, timeout: isTimeout(e) });
            }
        }
        const settled = await Promise.allSettled(
            wanted.map((root) =>
                root === MONTHLY_ROOT ? monthly : loadRoot(root, day, gen),
            ),
        );
        settled.forEach((r, i) => {
            if (r.status === 'rejected')
                failures.push({ root: wanted[i]!, timeout: isTimeout(r.reason) });
        });
        const failed = settled.filter((r) => r.status === 'rejected');
        if (failed.length === settled.length)
            throw (failed[0] as PromiseRejectedResult).reason;
        const idSet = new Set(identified);
        let rows: OptContract[] = [];
        let invalid = 0;
        settled.forEach((r, i) => {
            if (r.status !== 'fulfilled') return;
            rows = rows.concat(r.value.rows);
            if (idSet.has(wanted[i]!)) invalid += r.value.invalid;
        });
        return {
            rows,
            complete: failures.length === 0,
            failures,
            identified,
            invalid,
        };
    })();
    inflight.set(day, p);
    return p.finally(() => {
        if (inflight.get(day) === p) inflight.delete(day);
    });
}

/** 台北日期／收盤時刻；跨 13:45 或午夜時更新，讓到期列表與合約重新計算。 */
function useExpiryClock(): ExpiryClock {
    const [clock, setClock] = useState(() => taipeiClock());
    useEffect(() => {
        const timer = setTimeout(
            () => setClock(taipeiClock()),
            msUntilNextBoundary() + 1000,
        );
        return () => clearTimeout(timer);
    }, [clock]);
    return clock;
}

/** 部分失敗狀態列：哪些代碼讀取失敗／逾時，以及未列出的合約數。 */
export function chainStatusText(
    complete: boolean,
    failures: ChainFailure[],
    unlisted: number,
): string {
    const parts: string[] = [];
    if (!complete) {
        const which = failures
            .map((f) => (f.timeout ? `${f.root} 逾時` : f.root))
            .join('、');
        parts.push(
            `部分合約載入失敗${which ? `（${which}）` : ''}，按更新報價重試`,
        );
    }
    if (unlisted > 0) parts.push(`${unlisted} 筆合約資料不完整或標的不符，未列出`);
    return parts.join('；');
}

function isCall(c: OptContract): boolean {
    return c.option_right.toUpperCase().startsWith('C');
}

// 記住 `${root}:${delivery_date}`
export const EXPIRY_KEY = 'sj-pro-optchain-expiry';
// 舊版只記月份（YYYYMM）；第一次載入時遷移成該月的月選後移除
export const LEGACY_MONTH_KEY = 'sj-pro-optchain-month';

function readStored(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function saveExpiry(key: string) {
    try {
        localStorage.setItem(EXPIRY_KEY, key);
    } catch {
        // 無法寫入（隱私模式等）時只是不記住
    }
}

function dropLegacyMonth() {
    try {
        localStorage.removeItem(LEGACY_MONTH_KEY);
    } catch {
        // ignore
    }
}

interface ChainRowData {
    strike: number;
    call?: OptContract;
    put?: OptContract;
}

function SideHead({ label }: { label: string }) {
    return (
        <>
            <th className={`${styles.th} ${styles.sideHeadWide}`} colSpan={4}>{label}</th>
            <th className={`${styles.th} ${styles.sideHeadNarrow}`} colSpan={2}>{label}</th>
        </>
    );
}

function QuoteHead() {
    return (
        <>
            <th className={styles.th}>成交</th>
            <th className={`${styles.th} ${styles.bookCol}`}>買</th>
            <th className={`${styles.th} ${styles.bookCol}`}>賣</th>
            <th className={styles.th}>量</th>
        </>
    );
}

function QuoteCells({ snapshot: s }: { snapshot?: Snapshot }) {
    if (!s) {
        return (
            <>
                <td className={styles.td}>—</td>
                <td className={`${styles.td} ${styles.bookCol}`}>—</td>
                <td className={`${styles.td} ${styles.bookCol}`}>—</td>
                <td className={`${styles.td} ${styles.volume}`}>—</td>
            </>
        );
    }
    const dir = s.change_price > 0 ? 'up' : s.change_price < 0 ? 'down' : 'flat';
    return (
        <>
            <td className={`${styles.td} ${panel.dirText[dir]}`}>
                {s.close ? fmtPrice(s.close, 0) : '—'}
            </td>
            <td className={`${styles.td} ${styles.bookCol}`}>
                {s.buy_price ? fmtPrice(s.buy_price, 0) : '—'}
            </td>
            <td className={`${styles.td} ${styles.bookCol}`}>
                {s.sell_price ? fmtPrice(s.sell_price, 0) : '—'}
            </td>
            <td className={`${styles.td} ${styles.volume}`} title={`今日成交量 ${fmtInt(s.total_volume)} 口`}>
                {fmtCompactInt(s.total_volume)}
            </td>
        </>
    );
}

// 全部履約價都在表上：列要 memo，一檔跳動不重畫整張表
const ChainRow = memo(function ChainRow({ row, call, put, atm, live, onPick }: {
    row: ChainRowData;
    call?: Snapshot;
    put?: Snapshot;
    atm: boolean;
    live: boolean;
    onPick?: (code: string | undefined) => void;
}) {
    const pickHint = onPick ? '點 CALL 側連動買權、PUT 側連動賣權' : '';
    const staleHint = live ? '' : '畫面外的檔位：顯示快照，捲到畫面內才即時更新';
    return (
        <tr
            className={`${onPick ? styles.pickableRow : ''} ${live ? '' : styles.staleRow}`}
            data-live={live ? true : undefined}
            title={[pickHint, staleHint].filter(Boolean).join('\n') || undefined}
            onClick={(e) => {
                if (!onPick) return;
                // left half of the row → call, right → put
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const left = e.clientX - rect.left < rect.width / 2;
                onPick(left ? row.call?.code : row.put?.code);
            }}
        >
            <QuoteCells snapshot={call} />
            <td className={`${styles.strike} ${atm ? styles.atmStrike : ''}`}>
                {fmtPrice(row.strike, 0)}
            </td>
            <QuoteCells snapshot={put} />
        </tr>
    );
});

export function OptionChain({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [contracts, setContracts] = useState<OptContract[]>([]);
    const [identified, setIdentified] = useState<string[]>([MONTHLY_ROOT]);
    const [complete, setComplete] = useState(true);
    const [failures, setFailures] = useState<ChainFailure[]>([]);
    const [invalid, setInvalid] = useState(0);
    const [reloadSeq, setReloadSeq] = useState(0);
    const [reloading, setReloading] = useState(false);
    const [choice, setChoice] = useState<string | null>(() =>
        readStored(EXPIRY_KEY),
    );
    const [legacyMonth, setLegacyMonth] = useState<string | null>(() =>
        readStored(LEGACY_MONTH_KEY),
    );
    const [loading, setLoading] = useState(true);
    const clock = useExpiryClock();

    // 台北日期改變（面板一直開著跨日）或手動重試時重新載入合約
    useEffect(() => {
        let stale = false;
        loadChainContracts(clock.date)
            .then((r) => {
                if (stale) return;
                setContracts(r.rows);
                setIdentified(r.identified);
                setComplete(r.complete);
                setFailures(r.failures);
                setInvalid(r.invalid);
            })
            .catch(() => {
                if (stale) return;
                // 全部失敗：保留上次成功的合約，狀態列改為一般失敗訊息
                setComplete(false);
                setFailures([]);
            })
            .finally(() => {
                if (stale) return;
                setLoading(false);
                setReloading(false);
            });
        return () => {
            stale = true;
        };
    }, [clock.date, reloadSeq]);

    const expiries = useMemo(
        () => buildExpiries(contracts, clock, { identified }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [contracts, identified, clock.date, clock.minutes],
    );

    // 可確認身分的代碼中，因欄位缺漏／標的不符而未列出的合約
    const unlisted = useMemo(
        () => invalid + unverifiedContracts(contracts, clock, { identified }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [invalid, contracts, identified, clock.date, clock.minutes],
    );

    // 舊版月份記憶：遷移成該月月選（新值優先），之後移除舊 key
    useEffect(() => {
        if (legacyMonth === null || expiries.length === 0) return;
        if (choice === null) {
            const key = migrateLegacyMonth(expiries, legacyMonth);
            if (key) {
                setChoice(key);
                saveExpiry(key);
            }
        }
        dropLegacyMonth();
        setLegacyMonth(null);
    }, [expiries, legacyMonth, choice]);

    // 記住的到期若已到期或不再列出，改選最近到期的
    const expiry = resolveExpiry(expiries, choice);
    const inExpiry = useMemo(
        () => contractsForExpiry(contracts, expiry),
        [contracts, expiry],
    );

    // 置中基準：合約標的指數（IX0001 加權）→ 台指期近月 → 履約價中位數
    const underlying =
        inExpiry.find((c) => c.underlying_code)?.underlying_code ??
        chainUnderlying(contracts, { identified }) ??
        'IX0001';
    const indexLive = useQuote(underlying);
    const txf = useQuote('TXFR1');
    const refQuery = useQuery<Snapshot[]>(
        useCallback(async () => {
            const cs = await Promise.all([
                ensureContract(underlying, 'IND'),
                ensureContract('TXFR1', 'FUT'),
            ]);
            return fetchSnapshots(cs);
        }, [underlying]),
        `optchain-atm-ref:${underlying}`,
    );
    const indexSnap = refQuery.data?.find((s) => s.code === underlying);
    const txfSnap = refQuery.data?.find((s) => s.code !== underlying);
    const ref = chooseAtmReference([
        {
            label: underlyingLabel(underlying),
            value: indexLive?.index
                ? Number(indexLive.index.close)
                : indexSnap?.close,
            change: indexLive?.index
                ? Number(indexLive.index.close) -
                  Number(indexLive.index.reference)
                : indexSnap?.change_price,
        },
        {
            label: 'TXF',
            value: txf?.tick ? Number(txf.tick.close) : txfSnap?.close,
            change: txf?.tick?.price_chg
                ? Number(txf.tick.price_chg)
                : txfSnap?.change_price,
        },
    ]);
    const atm = ref?.value ?? null;

    // every strike of the selected expiry, ascending
    const rows = useMemo(() => {
        const byStrike = new Map<number, ChainRowData>();
        for (const c of inExpiry) {
            const row = byStrike.get(c.strike_price) ?? { strike: c.strike_price };
            if (isCall(c)) row.call ??= c;
            else row.put ??= c;
            byStrike.set(c.strike_price, row);
        }
        return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    }, [inExpiry]);

    // the strike closest to ATM — exact, not a fixed point distance
    const nearestStrike = useMemo(() => {
        if (atm === null || rows.length === 0) return null;
        let best: number | null = null;
        let bestDist = Infinity;
        for (const r of rows) {
            const d = Math.abs(r.strike - atm);
            if (d < bestDist) {
                bestDist = d;
                best = r.strike;
            }
        }
        return best;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, atm === null ? 0 : Math.round(atm / 10)]);
    const centerIndex = nearestStrike === null
        ? Math.floor(rows.length / 2)
        : rows.findIndex((r) => r.strike === nearestStrike);

    // 即時訂閱窗（#371）：只有畫面內加緩衝的檔位訂閱，其他檔位留快照
    const chainKey = expiry;
    const [measured, setMeasured] = useState<{ key: string; range: StrikeRange } | null>(null);
    const [unmeasurable, setUnmeasurable] = useState(false);
    const liveRange = measured?.key === chainKey ? measured.range : centeredRange(centerIndex, rows.length);
    // 價平還沒算出來就訂閱的話，訂的是中位履約價那一窗，隨後整批退掉（#386）。
    // 指數與台指期都查不到時才以中位數為準。量到畫面前也先不訂，避免多訂一輪。
    const atmPending = atm === null && refQuery.updatedAt == null && !refQuery.error;
    const hasMeasured = measured?.key === chainKey;
    const windowReady = !atmPending && (hasMeasured || unmeasurable);
    const allContracts = useMemo(
        () => rows.flatMap((r) => [r.call, r.put]).filter((c): c is OptContract => !!c),
        [rows],
    );
    const liveContracts = useMemo(
        () => (windowReady ? rows.slice(liveRange.first, liveRange.last + 1) : [])
            .flatMap((r) => [r.call, r.put]).filter((c): c is OptContract => !!c),
        [rows, windowReady, liveRange.first, liveRange.last],
    );
    const chainSnapshots = useCallback(() => fetchChainSnapshots(allContracts), [allContracts]);
    const { snapshots: snaps, refresh: refreshQuotes, loading: quotesLoading, error: quotesError } = useLiveSnapshots(allContracts, chainSnapshots, liveContracts);

    const bodyRef = useRef<HTMLDivElement | null>(null);
    // 使用者捲動過就不再自動置中；按回到價平或換到期才恢復
    const followAtm = useRef(true);
    const autoScrollTop = useRef<number | null>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [atmAway, setAtmAway] = useState(false);
    const latest = useRef({ chainKey, total: rows.length, centerIndex, liveRange, atmPending });
    latest.current = { chainKey, total: rows.length, centerIndex, liveRange, atmPending };

    const measure = useCallback(() => {
        const body = bodyRef.current;
        const row = body?.querySelector('tbody tr');
        if (!body || !row) return null;
        const rowHeight = row.getBoundingClientRect().height;
        const headerHeight = body.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const visible = visibleRange(body.scrollTop, body.clientHeight, headerHeight, rowHeight, latest.current.total);
        return visible && { body, visible, rowHeight, headerHeight };
    }, []);

    const noteAtm = useCallback((visible: StrikeRange) => {
        setAtmAway(!inRange(visible, latest.current.centerIndex));
    }, []);

    const settle = useCallback(() => {
        const m = measure();
        if (!m) return;
        noteAtm(m.visible);
        const { chainKey: key, total, liveRange: current, atmPending: pending } = latest.current;
        if (pending) return;
        // 這個到期第一次量到畫面：直接用畫面加緩衝；之後才有遲滯
        setMeasured((prev) => {
            if (prev?.key !== key) return { key, range: liveRangeFor(m.visible, total) };
            const range = nextLiveRange(current, m.visible, total);
            return prev.range === range ? prev : { key, range };
        });
    }, [measure, noteAtm]);

    const centerOnAtm = useCallback(() => {
        const m = measure();
        if (!m) {
            setUnmeasurable(true); // 面板隱藏中：先用價平上下各八檔
            return;
        }
        m.body.scrollTop = scrollTopFor(latest.current.centerIndex, m.body.clientHeight, m.headerHeight, m.rowHeight);
        autoScrollTop.current = m.body.scrollTop;
        settle();
    }, [measure, settle]);

    const showing = !loading && rows.length > 0;

    useLayoutEffect(() => {
        followAtm.current = true;
    }, [chainKey]);
    useLayoutEffect(() => {
        if (!showing) return;
        if (followAtm.current) {
            centerOnAtm();
            return;
        }
        // 使用者捲走後不搶捲動位置，但價平移動了提示仍要更新
        const m = measure();
        if (m) noteAtm(m.visible);
        // 等價平時捲動過的話，量測被跳過了，這裡補上才會開始訂閱
        // 已經量過就交給捲動的 settle 計時，價平跳動不提早換窗
        if (atmPending || hasMeasured) return;
        if (m) settle();
        else setUnmeasurable(true);
    }, [showing, chainKey, centerIndex, atmPending, hasMeasured, rows.length, centerOnAtm, measure, noteAtm, settle]);
    useEffect(() => {
        const body = bodyRef.current;
        if (!showing || !body || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (followAtm.current) centerOnAtm();
            else settle();
        });
        observer.observe(body);
        return () => observer.disconnect();
    }, [showing, centerOnAtm, settle]);
    useEffect(() => () => clearTimeout(settleTimer.current), []);

    const onScroll = useCallback(() => {
        const m = measure();
        if (!m) return;
        // 自己置中引發的 scroll 事件不算使用者捲動
        if (autoScrollTop.current === null || Math.abs(m.body.scrollTop - autoScrollTop.current) > 1) followAtm.current = false;
        noteAtm(m.visible);
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(settle, WINDOW_SETTLE_MS);
    }, [measure, noteAtm, settle]);

    const pick = useCallback((code: string | undefined) => {
        if (!code || !onPick) return;
        onPick(code);
        // also offer it to a combo panel in 連動 mode (issue #1)
        pickOptionLeg(code);
    }, [onPick]);

    if (loading) {
        return <div className={dock.emptyState}>
                <AsyncStatus phase='loading' text='載入臺指選擇權合約…' />
            </div>;
    }
    const reloadContracts = () => {
        setReloading(true);
        setReloadSeq((n) => n + 1);
    };

    if (rows.length === 0) {
        // 全部讀取失敗時也要留重試入口，不能讓使用者卡在空畫面
        return (
            <div className={dock.emptyState}>
                <AsyncStatus
                    phase={complete ? 'empty' : 'error'}
                    text={complete ? '無可用合約' : '臺指選擇權合約載入失敗'}
                    action={<RefreshButton
                        label="重新載入合約"
                        loading={reloading}
                        onClick={() => {
                            // 已成功但真的沒有合約時，清掉當日快取重新查
                            if (complete) resetChainContractsCache();
                            reloadContracts();
                        }}
                    />}
                />
            </div>
        );
    }

    return (
        <div className={styles.wrap}>
                {quotesError && <span role="status">{quotesError}；保留上次報價</span>}
            <div className={styles.toolbar}>
                <OptionExpiryPicker
                    expiries={expiries}
                    value={expiry}
                    onChange={(key) => {
                        setChoice(key);
                        saveExpiry(key);
                    }}
                />
                <span
                    className={styles.atm}
                    title={
                        ref
                            ? `${ref.label} ${fmtPrice(ref.value, 0)}${
                                  ref.change !== undefined ? ` ${fmtSigned(ref.change, 0)}` : ''
                              }，履約價以 ${ref.label} 為中心`
                            : '尚無標的報價，履約價以中位數為中心'
                    }
                >
                    {ref ? (
                        <>
                            {ref.label} {fmtPrice(ref.value, 0)}{' '}
                            {ref.change !== undefined &&
                                fmtSigned(ref.change, 0)}
                        </>
                    ) : (
                        '中位數置中'
                    )}
                </span>
                <button
                    type="button"
                    className={styles.atmBtn}
                    aria-label="回到價平"
                    title={atmAway ? '價平不在畫面內，點一下回到價平' : '回到價平'}
                    data-away={atmAway ? true : undefined}
                    onClick={() => {
                        followAtm.current = true;
                        centerOnAtm();
                    }}
                >
                    <Crosshair size={12} aria-hidden />
                </button>
                <RefreshButton
                    label="更新報價"
                    loading={quotesLoading}
                    onClick={() => {
                        void refreshQuotes();
                        void refQuery.refresh();
                        // 合約有讀取失敗時一併重試
                        if (!complete) reloadContracts();
                    }}
                />
            </div>
            {/* 狀態訊息獨立一列並截斷，不擠壓到期選擇器與更新報價；全文見 tooltip */}
            {(!complete || unlisted > 0) && (
                <div
                    role="status"
                    className={styles.status}
                    title={chainStatusText(complete, failures, unlisted)}
                >
                    {chainStatusText(complete, failures, unlisted)}
                </div>
            )}
            <div className={panel.panelBody} ref={bodyRef} onScroll={onScroll} data-testid="optchain-body">
                <table className={styles.table}>
                    <thead className={styles.thead}>
                        <tr>
                            <SideHead label="CALL 買權" />
                            <th className={`${styles.th} ${styles.strikeTh}`}>
                                履約價
                            </th>
                            <SideHead label="PUT 賣權" />
                        </tr>
                        <tr>
                            <QuoteHead />
                            <th className={`${styles.th} ${styles.strikeTh}`} />
                            <QuoteHead />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => (
                            <ChainRow
                                key={r.strike}
                                row={r}
                                call={r.call && snaps.get(r.call.code)}
                                put={r.put && snaps.get(r.put.code)}
                                atm={r.strike === nearestStrike}
                                live={inRange(liveRange, i)}
                                onPick={onPick ? pick : undefined}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
