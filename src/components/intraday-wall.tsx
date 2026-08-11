// src/components/intraday-wall.tsx — 當日走勢牆: a grid of compact
// intraday (分時) charts driven by a chosen watchlist, with a
// configurable layout (cols×rows) and paging when the list doesn't fit.
// Each cell reuses the session/axis rules of the full 當日走勢 panel in a
// stripped-down form: baseline vs reference, average line, fixed session
// frame, live SSE updates, and a limit-lock lamp in the header.

import {
    BaselineSeries,
    ColorType,
    createChart,
    LineSeries,
    LineStyle,
    type AutoscaleInfo,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { colorWithOpacity } from '../lib/indicator-defs';
import { ensureContract } from '../lib/contracts-cache';
import {
    sessionMinutes,
    sessionWindowFor,
    tickBucket,
    type SessionWindow,
} from '../lib/intraday-session';
import {
    fetchKbars,
    fetchSnapshots,
    fetchWatchlists,
    type ServerWatchlist,
} from '../lib/shioaji';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import {
    dateStrOffset,
    kbarsToCandles,
    wallClockToUtc,
} from '../lib/utils/kbars';
import { Orb } from './orb';
import * as panel from './panel.css';
import * as styles from './intraday-wall.css';

const CLOSE_GRACE = 240;

// 自訂排列的欄/列上限 — 6×6=36 檔已是訂閱與可讀性的極限
const WALL_DIM_MIN = 1;
const WALL_DIM_MAX = 6;

function clampDim(n: number): number {
    if (!Number.isFinite(n)) return 2;
    return Math.min(WALL_DIM_MAX, Math.max(WALL_DIM_MIN, Math.round(n)));
}

// ---- one compact intraday cell ----

function MiniIntraday({ contract }: { contract: ContractInfo }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const priceRef = useRef<ISeriesApi<'Baseline'> | null>(null);
    const avgRef = useRef<ISeriesApi<'Line'> | null>(null);
    const fillerRef = useRef<ISeriesApi<'Line'> | null>(null);
    const chartApiRef = useRef<ReturnType<typeof createChart> | null>(null);
    const refLineRef = useRef<ReturnType<
        ISeriesApi<'Line'>['createPriceLine']
    > | null>(null);
    const sessionRef = useRef<SessionWindow | null>(null);
    const refPriceRef = useRef(0);
    const limitsRef = useRef<{ up: number; down: number } | null>(null);
    const hiRef = useRef(-Infinity);
    const loRef = useRef(Infinity);
    const lastLabelRef = useRef(0);
    const cumVRef = useRef(0);
    const cumPVRef = useRef(0);
    const loadedRef = useRef('');
    const lastReloadRef = useRef(0);
    const [reloadSeq, setReloadSeq] = useState(0);
    const [empty, setEmpty] = useState(false);
    const [loading, setLoading] = useState(true);

    const quote = useQuote(contract.code);
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = `${themeSettings.mode}-${themeSettings.convention}`;
    const isIndex = contract.security_type === 'IND';
    const avgColor = themeSettings.mode === 'light' ? '#b97f14' : '#e0a43c';

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = colors;
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                attributionLogo: false,
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { color: c.grid },
            },
            crosshair: {
                vertLine: { visible: false, labelVisible: false },
                horzLine: { visible: false, labelVisible: false },
            },
            rightPriceScale: {
                borderVisible: false,
                scaleMargins: { top: 0.08, bottom: 0.08 },
            },
            leftPriceScale: { visible: false },
            // lockVisibleTimeRangeOnResize：排列切換/面板縮放時 autoSize
            // 觸發 resize，不鎖範圍的話 lightweight-charts 會保持 bar
            // spacing 而讓時段框被裁掉或擠到一側（與完整版走勢圖同參數）
            timeScale: {
                visible: false,
                minBarSpacing: 0.001,
                lockVisibleTimeRangeOnResize: true,
            },
            handleScroll: false,
            handleScale: false,
            autoSize: true,
        });
        const symmetric = (
            original: () => AutoscaleInfo | null,
        ): AutoscaleInfo | null => {
            const ref = refPriceRef.current;
            if (!ref || hiRef.current === -Infinity) return original();
            const span = Math.max(
                hiRef.current - ref,
                ref - loRef.current,
                ref * 0.002,
            );
            let pad = span * 1.08;
            const lim = limitsRef.current;
            if (lim) {
                pad = Math.min(
                    pad,
                    Math.max(lim.up - ref, ref - lim.down),
                );
            }
            return {
                priceRange: {
                    minValue: ref - pad,
                    maxValue: ref + pad,
                },
            };
        };
        const price = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price', price: refPriceRef.current },
            topLineColor: c.up,
            topFillColor1: colorWithOpacity(c.up, 18),
            topFillColor2: colorWithOpacity(c.up, 2),
            bottomLineColor: c.down,
            bottomFillColor1: colorWithOpacity(c.down, 2),
            bottomFillColor2: colorWithOpacity(c.down, 18),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: symmetric,
        });
        const avg = chart.addSeries(LineSeries, {
            color: avgColor,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
        });
        const filler = chart.addSeries(LineSeries, {
            color: 'transparent',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
        });
        refLineRef.current = filler.createPriceLine({
            price: 0,
            color: colorWithOpacity(c.text, 60),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
        });
        chartApiRef.current = chart;
        priceRef.current = price;
        avgRef.current = avg;
        fillerRef.current = filler;
        return () => {
            chart.remove();
            chartApiRef.current = null;
            priceRef.current = null;
            avgRef.current = null;
            fillerRef.current = null;
            refLineRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    useEffect(() => {
        const loadKey = `${contract.code}|${reloadSeq}|${themeKey}`;
        loadedRef.current = '';
        sessionRef.current = null;
        refPriceRef.current = 0;
        limitsRef.current = null;
        hiRef.current = -Infinity;
        loRef.current = Infinity;
        lastLabelRef.current = 0;
        cumVRef.current = 0;
        cumPVRef.current = 0;
        setLoading(true);
        setEmpty(false);
        let cancelled = false;
        fetchKbars(contract, dateStrOffset(4), dateStrOffset(-1))
            .then((k) => {
                if (cancelled || !priceRef.current) return;
                const all = kbarsToCandles(k);
                const last = all[all.length - 1];
                if (!last) {
                    setEmpty(true);
                    return;
                }
                const win = sessionWindowFor(
                    contract.security_type,
                    last.time,
                );
                const bars = all.filter(
                    (b) =>
                        b.time > win.start &&
                        b.time <= win.end + CLOSE_GRACE,
                );
                for (const b of bars) {
                    if (b.time > win.end) b.time = win.end;
                }
                const ref =
                    Number(contract.reference) ||
                    bars[0]?.open ||
                    last.close;
                refPriceRef.current = ref;
                const lu = Number(contract.limit_up);
                const ld = Number(contract.limit_down);
                if (
                    Number.isFinite(lu) &&
                    Number.isFinite(ld) &&
                    lu > ld &&
                    ld > 0
                ) {
                    limitsRef.current = { up: lu, down: ld };
                }
                priceRef.current.applyOptions({
                    baseValue: { type: 'price', price: ref },
                });
                const lineData = [];
                const avgData = [];
                let prevT = 0;
                for (const b of bars) {
                    hiRef.current = Math.max(hiRef.current, b.high);
                    loRef.current = Math.min(loRef.current, b.low);
                    cumVRef.current += b.volume;
                    cumPVRef.current +=
                        ((b.high + b.low + b.close) / 3) * b.volume;
                    if (b.time === prevT) {
                        // CLOSE_GRACE merge — last value wins
                        lineData[lineData.length - 1] = {
                            time: b.time as UTCTimestamp,
                            value: b.close,
                        };
                        continue;
                    }
                    prevT = b.time;
                    lineData.push({
                        time: b.time as UTCTimestamp,
                        value: b.close,
                    });
                    if (!isIndex && cumVRef.current > 0) {
                        avgData.push({
                            time: b.time as UTCTimestamp,
                            value: cumPVRef.current / cumVRef.current,
                        });
                    }
                }
                priceRef.current.setData(lineData);
                avgRef.current?.setData(avgData);
                const minutes = sessionMinutes(win);
                fillerRef.current?.setData(
                    minutes.map((m, i) =>
                        i === 0 || i === minutes.length - 1
                            ? { time: m as UTCTimestamp, value: ref }
                            : { time: m as UTCTimestamp },
                    ),
                );
                refLineRef.current?.applyOptions({ price: ref });
                sessionRef.current = win;
                const lastBar = bars[bars.length - 1];
                lastLabelRef.current = lastBar?.time ?? 0;
                loadedRef.current = loadKey;
                chartApiRef.current?.timeScale().fitContent();
            })
            .catch(() => {
                if (!cancelled) setEmpty(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract, reloadSeq, themeKey]);

    const liveQuote = quote?.tick ?? quote?.index;
    useEffect(() => {
        if (!liveQuote || liveQuote.code !== contract.code) return;
        if ('simtrade' in liveQuote && liveQuote.simtrade) return;
        if (
            loadedRef.current !== `${contract.code}|${reloadSeq}|${themeKey}`
        ) {
            return;
        }
        const win = sessionRef.current;
        const series = priceRef.current;
        if (!win || !series) return;
        const p = Number(liveQuote.close);
        if (!Number.isFinite(p) || p <= 0) return;
        const t = wallClockToUtc(`${liveQuote.date}T${liveQuote.time}`);
        if (t > win.end + CLOSE_GRACE) {
            const next = sessionWindowFor(contract.security_type, t);
            if (
                next.start !== win.start &&
                Date.now() - lastReloadRef.current > 30_000
            ) {
                lastReloadRef.current = Date.now();
                setReloadSeq((v) => v + 1);
            }
            return;
        }
        if (t <= win.start) return;
        const label = tickBucket(win, t);
        if (label < lastLabelRef.current) return;
        lastLabelRef.current = label;
        const chg = Number(quote?.tick?.price_chg);
        if (quote?.tick && Number.isFinite(chg) && p - chg > 0) {
            refPriceRef.current = p - chg;
        } else if (quote?.index) {
            const r = Number(quote.index.reference);
            if (Number.isFinite(r) && r > 0) refPriceRef.current = r;
        }
        hiRef.current = Math.max(hiRef.current, p);
        loRef.current = Math.min(loRef.current, p);
        const vol = quote?.tick?.volume ?? 0;
        cumVRef.current += vol;
        cumPVRef.current += p * vol;
        const time = label as UTCTimestamp;
        try {
            series.update({ time, value: p });
            if (!isIndex) {
                const tickAvg = Number(quote?.tick?.avg_price);
                const avg =
                    Number.isFinite(tickAvg) && tickAvg > 0
                        ? tickAvg
                        : cumVRef.current > 0
                          ? cumPVRef.current / cumVRef.current
                          : null;
                if (avg !== null) {
                    avgRef.current?.update({ time, value: avg });
                }
            }
        } catch {
            // series torn down mid-update — ignore
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [liveQuote, contract.code]);

    return (
        <div className={styles.cellChart}>
            <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
            {loading && (
                <div className={styles.centerMsg} style={{ position: 'absolute', inset: 0 }}>
                    <Orb size={10} />
                </div>
            )}
            {empty && !loading && (
                <div className={styles.centerMsg} style={{ position: 'absolute', inset: 0 }}>
                    <span className={panel.mono}>無資料</span>
                </div>
            )}
        </div>
    );
}

// ---- cell header (price/chg from live quote, lamp on limit lock) ----
// 開頁後尚無 tick（收盤後看盤、鎖死停板、冷門股）→ 退回 snapshot 的
// 收盤/漲跌，否則整面牆的表頭會掛「—」直到各檔各自成交一筆

function CellHead({
    contract,
    snap,
}: {
    contract: ContractInfo;
    snap?: Snapshot;
}) {
    const quote = useQuote(contract.code);
    const tick = quote?.tick ?? quote?.index;
    const price = tick
        ? Number(tick.close)
        : snap
          ? Number(snap.close)
          : NaN;
    const ref = quote?.tick
        ? Number(tick?.close) - Number(quote.tick.price_chg ?? 0)
        : quote?.index
          ? Number(quote.index.reference)
          : snap
            ? Number(snap.close) - Number(snap.change_price ?? 0)
            : Number(contract.reference);
    const hasPx = Number.isFinite(price) && price > 0;
    const chgPct =
        hasPx && Number.isFinite(ref) && ref > 0
            ? ((price - ref) / ref) * 100
            : null;
    const dir =
        chgPct === null || chgPct === 0 ? 'flat' : chgPct > 0 ? 'up' : 'down';
    const locked =
        hasPx && contract.limit_up > contract.limit_down && contract.limit_down > 0
            ? price >= contract.limit_up
                ? ('up' as const)
                : price <= contract.limit_down
                  ? ('down' as const)
                  : null
            : null;
    return (
        <div className={styles.cellHead}>
            <span className={styles.cellCode}>{contract.code}</span>
            <span className={styles.cellName}>{contract.name}</span>
            <span
                className={
                    locked
                        ? styles.cellLock[locked]
                        : `${styles.cellPx} ${panel.dirText[dir]}`
                }
            >
                {hasPx ? fmtPrice(price) : '—'}
            </span>
            <span className={panel.dirText[dir]}>
                {chgPct !== null
                    ? `${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%`
                    : ''}
            </span>
        </div>
    );
}

// ---- the wall panel ----

export function IntradayWallPanel({
    onPick,
    initialList,
    initialCols,
    initialRows,
    onConfigChange,
}: {
    onPick?: (code: string) => void;
    initialList?: string;
    initialCols?: number;
    initialRows?: number;
    onConfigChange?: (list: string, cols: number, rows: number) => void;
}) {
    const [lists, setLists] = useState<ServerWatchlist[]>([]);
    const [listId, setListId] = useState(initialList ?? '');
    const [cols, setCols] = useState(() =>
        clampDim(initialCols ?? 2),
    );
    const [rows, setRows] = useState(() =>
        clampDim(initialRows ?? 2),
    );
    const [layoutOpen, setLayoutOpen] = useState(false);
    const [page, setPage] = useState(0);
    const [cells, setCells] = useState<ContractInfo[]>([]);
    const [snaps, setSnaps] = useState<Map<string, Snapshot>>(new Map());
    const [phase, setPhase] = useState<'boot' | 'ready' | 'error'>('boot');
    const onConfigChangeRef = useRef(onConfigChange);
    onConfigChangeRef.current = onConfigChange;

    // load server watchlists（重試 — server 可能還在暖機）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    const ls = await fetchWatchlists();
                    if (cancelled) return;
                    setLists(ls);
                    setPhase('ready');
                    return;
                } catch {
                    await new Promise((r) =>
                        setTimeout(r, 1500 + attempt * 1000),
                    );
                }
            }
            if (!cancelled) setPhase('error');
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // resolve the effective list: configured id → active watchlist → first
    const list =
        lists.find((l) => l.id === listId) ??
        lists.find(
            (l) =>
                l.id ===
                (localStorage.getItem('sj-pro-active-watchlist') ?? ''),
        ) ??
        lists[0];

    const pageSize = cols * rows;
    const total = list?.contracts.length ?? 0;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, maxPage - 1);

    const applyConfig = useCallback(
        (nextList: string, nextCols: number, nextRows: number) => {
            onConfigChangeRef.current?.(nextList, nextCols, nextRows);
        },
        [],
    );

    // resolve + subscribe the current page's contracts
    useEffect(() => {
        if (!list) return;
        const slice = list.contracts.slice(
            safePage * pageSize,
            safePage * pageSize + pageSize,
        );
        let cancelled = false;
        (async () => {
            const out: ContractInfo[] = [];
            await Promise.allSettled(
                slice.map(async (c) => {
                    // 走共用 contract cache（ensureContract）而非自行
                    // resolve+prime：自選清單已解析過的檔拿到「同一個物
                    // 件」，alias 註冊與行情訂閱（含失敗重試）也在裡面。
                    // 若在這裡 prime 新物件，App 的兩個 selected 同步
                    // effect（items 版 vs cache 版）會互相覆寫，造成無限
                    // re-render + K 線/走勢圖 kbars 風暴（QA 實測 28 req/s）
                    const info = await ensureContract(
                        c.code,
                        c.security_type ?? undefined,
                    );
                    out.push(info);
                }),
            );
            if (cancelled) return;
            // keep the list's order
            const order = new Map(slice.map((c, i) => [c.code, i]));
            out.sort(
                (a, b) =>
                    (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99),
            );
            setCells(out);
            // 表頭的 snapshot 退路 — 失敗就算了（有 tick 就用不到）
            fetchSnapshots(out)
                .then((list) => {
                    if (cancelled) return;
                    const byCode = new Map(list.map((s) => [s.code, s]));
                    setSnaps(
                        new Map(
                            out.flatMap((c) => {
                                const s =
                                    byCode.get(c.code) ??
                                    (c.target_code
                                        ? byCode.get(c.target_code)
                                        : undefined);
                                return s ? [[c.code, s] as const] : [];
                            }),
                        ),
                    );
                })
                .catch(() => undefined);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list?.id, safePage, pageSize, lists]);

    if (phase === 'boot') {
        return (
            <div className={styles.wrap}>
                <div className={styles.centerMsg}>
                    <Orb size={12} />
                    <span className={panel.mono}>載入自選清單…</span>
                </div>
            </div>
        );
    }
    if (phase === 'error' || !list) {
        return (
            <div className={styles.wrap}>
                <div className={styles.centerMsg}>
                    <span className={panel.mono}>
                        無法載入自選清單 — 請確認伺服器連線
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <select
                    className={styles.select}
                    value={list.id}
                    onChange={(e) => {
                        setListId(e.target.value);
                        setPage(0);
                        applyConfig(e.target.value, cols, rows);
                    }}
                >
                    {lists.map((l) => (
                        <option key={l.id} value={l.id}>
                            {l.name}（{l.contracts.length}）
                        </option>
                    ))}
                </select>
                <span className={styles.layoutWrap}>
                    <button
                        className={styles.select}
                        title='排列設定 — 自訂欄×列'
                        onClick={() => setLayoutOpen((v) => !v)}
                    >
                        {cols}×{rows}
                    </button>
                    {layoutOpen && (
                        <>
                            <span
                                className={styles.popBackdrop}
                                onClick={() => setLayoutOpen(false)}
                            />
                            <span className={styles.pop}>
                                {(
                                    [
                                        ['欄', cols, (n: number) => {
                                            const c = clampDim(n);
                                            setCols(c);
                                            setPage(0);
                                            applyConfig(list.id, c, rows);
                                        }],
                                        ['列', rows, (n: number) => {
                                            const r = clampDim(n);
                                            setRows(r);
                                            setPage(0);
                                            applyConfig(list.id, cols, r);
                                        }],
                                    ] as const
                                ).map(([label, value, set]) => (
                                    <span
                                        key={label}
                                        className={styles.popRow}
                                    >
                                        {label}
                                        <button
                                            className={styles.stepBtn}
                                            disabled={value <= WALL_DIM_MIN}
                                            onClick={() => set(value - 1)}
                                        >
                                            −
                                        </button>
                                        <span className={styles.stepVal}>
                                            {value}
                                        </span>
                                        <button
                                            className={styles.stepBtn}
                                            disabled={value >= WALL_DIM_MAX}
                                            onClick={() => set(value + 1)}
                                        >
                                            ＋
                                        </button>
                                    </span>
                                ))}
                                <span className={styles.popHint}>
                                    每頁 {cols * rows} 檔
                                </span>
                            </span>
                        </>
                    )}
                </span>
                <span className={styles.spacer} />
                <button
                    className={styles.pagerBtn}
                    disabled={safePage <= 0}
                    title='上一頁'
                    onClick={() => setPage(Math.max(0, safePage - 1))}
                >
                    <ChevronLeft size={12} />
                </button>
                <span className={styles.pageInfo}>
                    {safePage + 1}/{maxPage}
                </span>
                <button
                    className={styles.pagerBtn}
                    disabled={safePage >= maxPage - 1}
                    title='下一頁'
                    onClick={() =>
                        setPage(Math.min(maxPage - 1, safePage + 1))
                    }
                >
                    <ChevronRight size={12} />
                </button>
            </div>
            {total === 0 ? (
                <div className={styles.centerMsg}>
                    <span className={panel.mono}>這個清單是空的</span>
                </div>
            ) : (
                <div
                    className={styles.grid}
                    style={{
                        gridTemplateColumns: `repeat(${cols}, 1fr)`,
                        gridTemplateRows: `repeat(${rows}, 1fr)`,
                    }}
                >
                    {cells.map((contract) => (
                        <div
                            key={contract.code}
                            className={styles.cell}
                            title={`${contract.code} ${contract.name} — 點擊連動`}
                            onClick={() => onPick?.(contract.code)}
                        >
                            <CellHead
                                contract={contract}
                                snap={snaps.get(contract.code)}
                            />
                            <MiniIntraday contract={contract} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// HMR 對 imperative chart 清不乾淨 — 此模組一變更就整頁重載
if (import.meta.hot) {
    import.meta.hot.accept(() => {
        import.meta.hot?.invalidate();
    });
}
