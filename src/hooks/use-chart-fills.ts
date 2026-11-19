import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import type { IChartApi, ISeriesApi, MouseEventParams } from 'lightweight-charts';
import { createProjectionCache, fillDecimals, fillPriceText, missingDeals, priceKey, projectChartFills, resolvedCode, rolloverCodes, type ChartFill, type FillRollover } from '../lib/chart-fills';
import { FillMarksLayer, type FillMarkGroup, type FillMarkShape, type FillMarkStyle, type FillRect } from '../lib/chart-fill-marks';
import { ensureContract, getCachedContract } from '../lib/contracts-cache';
import { expiryTime } from '../lib/flash-link';
import type { ContractBase, ContractInfo } from '../lib/types/contract';
import type { AccountedTrade } from '../lib/types/order';
import type { Account } from '../lib/types/portfolio';
import type { Candle } from '../lib/types/market';

// 查不到最後交易日的近月（多半已到期）：這個工作階段不再查，每個別名最多白查一次
const noExpiry = new Set<string>();

// 連續月別名的換月分界：近月最後交易日 13:30（台北）。不是別名、查不到合約或沒有最後交易日 → null（只認現在的 target）。
// 只在要畫成交、而且今天的委託裡有這張圖的月份（現在的 target、換月前的 previous、決定換月的 near）時才查；
// 沒有這些委託就沒有成交要分。合約換了或卸載後，晚到的結果不寫回。
function useFillRollover(contract: ContractBase, enabled: boolean, trades: readonly AccountedTrade[]): FillRollover | null {
    const all = useMemo(() => enabled ? rolloverCodes(contract) : null, [enabled, contract]);
    // 報價每跳都重繪：委託沒變就不重掃
    const traded = useMemo(() => {
        if (!all) return false;
        const months = new Set([resolvedCode(contract), all.previous, all.near]);
        return trades.some(t => months.has(resolvedCode(t.contract)));
    }, [all, contract, trades]);
    const codes = all && !noExpiry.has(all.near) && traded ? all : null;
    const key = codes ? `${codes.previous}|${codes.near}` : '';
    const cached = codes ? getCachedContract(codes.near) : undefined;
    const [found, setFound] = useState<{ key: string; info: ContractInfo | null } | null>(null);
    useEffect(() => {
        if (!codes || cached) return;
        let alive = true;
        const done = (info: ContractInfo | null) => {
            if (!info || expiryTime(info) === null) noExpiry.add(codes.near);
            if (alive) setFound({ key, info });
        };
        ensureContract(codes.near, 'FUT').then(done, () => done(null));
        return () => { alive = false; };
    }, [key, cached]);
    const info = cached ?? (found?.key === key ? found.info : null);
    const ms = info ? expiryTime(info) : null;
    const previous = codes?.previous;
    return useMemo(() => previous && ms !== null ? { previous, cutoff: ms / 1000 } : null, [previous, ms]);
}

// 盤中連續回報合併：成交多到重算一次就很貴（≥ 8ms）時，同一個範圍裡兩次重算至少間隔 4 倍成本
// （重算最多吃 1/4 的時間；間隔最長 5 秒），最後一筆一定會算到；一般用量每筆回報都立即重算。
// 範圍（商品、週期、僅日盤、環境、帳戶、顯示、就緒）一變就立刻改用最新的委託，不拿舊範圍的資料畫。
const BURST_MIN_COST_MS = 8;
const BURST_MAX_WAIT_MS = 5000;
function useBurstValue<T>(value: T, key: string, cost: number): T {
    const [, wake] = useReducer((n: number) => n + 1, 0);
    const ref = useRef({ value, key, at: -Infinity });
    const state = ref.current;
    const gap = cost < BURST_MIN_COST_MS ? 0 : Math.min(BURST_MAX_WAIT_MS, cost * 4);
    const now = performance.now();
    if (state.value !== value && (state.key !== key || now - state.at >= gap)) {
        state.value = value;
        state.at = now;
    }
    state.key = key;
    const pending = state.value !== value;
    // 還有沒算到的回報：排一次到期重繪（從上次重算的時間起算，不會因為一直重繪而一直延後）
    useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(wake, Math.max(0, ref.current.at + gap - performance.now()));
        return () => clearTimeout(timer);
    });
    return state.value;
}

const NO_FILLS: { fills: ChartFill[]; unplaced: ChartFill[] } = { fills: [], unplaced: [] };
const NO_HOVER: ChartFill[] = [];
const NO_HOVER_GROUPS: never[] = [];
const NO_GROUPS: readonly FillMarkGroup[] = [];

// 彙整鍵：商品｜K 棒｜方向｜整數價格｜單位。整股與零股、換月日的兩個月份各自成組；不含帳戶（全部帳戶合併成點）
// 顯示組鍵：同商品｜K 棒｜方向｜單位、跨價位（圖上一組）。開頭不同，不會和每價分組鍵撞名
// 投影沿用沒變的成交物件，鍵跟著物件記住：每筆回報不必替上萬筆成交重組字串
const fillKeys = new WeakMap<ChartFill, { group: string; bundle: string }>();
function keysOf(fill: ChartFill) {
    let keys = fillKeys.get(fill);
    if (!keys) fillKeys.set(fill, keys = {
        group: `${fill.code}|${fill.time}|${fill.action}|${priceKey(fill.price)}|${fill.unit}`,
        bundle: `range:${fill.code}|${fill.time}|${fill.action}|${fill.unit}`,
    });
    return keys;
}
const groupKey = (fill: ChartFill) => keysOf(fill).group;
const accountKey = (account: Account) => `${account.account_type}:${account.broker_id}:${account.account_id}`;

// 標籤字串：dot 不畫；side「買」「買 3口」；price「46,459」「46,459 3口」。數量是同組（同單位）合計，多於 1 才加。
// 價位最少位數同圖表的價格位數、最多 8 位，不截掉實際成交價的小數（49.5 不會變成 50）。
// 多價位組：side「買 22口」；price「均 46,464.4 22口」（均價最多比圖表多 1 位，整數不補 0）。
const QTY_FORMAT = new Intl.NumberFormat('en-US');
function markText(style: FillMarkStyle, group: { action: ChartFill['action']; price: number; quantity: number; unit: ChartFill['unit']; avg?: number }, decimals: (price: number) => number): string | null {
    if (style === 'dot') return null;
    const price = group.avg ?? group.price;
    const min = fillDecimals(decimals, price);
    const head = style === 'side' ? (group.action === 'Buy' ? '買' : '賣')
        : group.avg === undefined ? fillPriceText(price, min) : `均 ${fillPriceText(price, min, min + 1)}`;
    return group.quantity > 1 ? `${head} ${QTY_FORMAT.format(group.quantity)}${group.unit}` : head;
}

// 僅呈現既有成交。建立/卸載跟圖表生命週期走，不訂閱行情或查詢帳務。
export function useChartFills({ chartRef, seriesRef, trades, contract, account, accounts, bars, dataVersion, minutes, dayOnly, visible, ready, retain, env, context, style, shape = 'triangle', priceDecimals, up, down, labelBg, avoid }: {
    chartRef: RefObject<IChartApi | null>;
    seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>;
    trades: readonly AccountedTrade[];
    contract: ContractBase;
    account: Account | undefined;
    /** 全部帳戶模式：同一市場的所有帳戶，取代 account。目前帳戶模式不要傳（[] 代表沒有範圍） */
    accounts?: readonly Account[];
    bars: readonly Candle[];
    dataVersion: number;
    minutes: number;
    dayOnly: boolean;
    visible: boolean;
    ready: boolean;
    /** 待確認時可以保留上次確認的分組；false 立即清空（彈出視窗的主視窗鏡像已失效） */
    retain: boolean;
    /** 目前的交易環境；null = 暫時未知（斷線重連） */
    env: string | null;
    context: string;
    style: FillMarkStyle;
    /** 標記形狀；沒傳就是三角形 */
    shape?: FillMarkShape;
    /** 價位標籤的最少小數位（同最高／最低標記） */
    priceDecimals: (price: number) => number;
    up: string;
    down: string;
    labelBg: string;
    /** 標籤要避開的範圍（pane 座標），繪製時才呼叫 */
    avoid?: () => FillRect[];
}) {
    const layerRef = useRef<FillMarksLayer | null>(null);
    const rollover = useFillRollover(contract, visible, trades);
    const accountScope = accounts ? `all:${[...new Set(accounts.map(accountKey))].sort().join(',')}` : account ? accountKey(account) : '';
    // 這張圖自己的投影快取（卸載就跟著釋放，不會被別的圖或預覽蓋掉）
    const [projectionCache] = useState(createProjectionCache);
    // 上次投影＋分組花的時間：決定連續回報要不要合併
    const costRef = useRef({ check: 0, project: 0, group: 0 });
    const cost = costRef.current;
    // 關掉時不合併（也不排計時器）：委託直接換最新的，重新打開就用它
    const fillTrades = useBurstValue(trades, `${context}|${accountScope}|${visible}|${ready}|${env}`, visible ? cost.check + cost.project + cost.group : 0);
    // 成交數量和明細對不上：明細還沒讀齊，畫出來會少點，整張圖當成未就緒。
    // 關掉時不掃，沿用關掉前的結果（待確認時關掉，保留的分組才不會被寫成空的）；重新打開立刻重查
    const incompleteRef = useRef(false);
    const incomplete = useMemo(() => {
        if (!visible) return incompleteRef.current;
        const started = performance.now();
        const missing = missingDeals({ trades: fillTrades, contract, account, accounts, rollover }, projectionCache);
        costRef.current.check = performance.now() - started;
        return incompleteRef.current = missing;
    }, [visible, fillTrades, contract, account, accounts, rollover, projectionCache]);
    const ok = ready && !incomplete;
    const scope = `${context}|${accountScope}|${visible}|${ok}`;
    const [hover, setHover] = useState<{ scope: string; key: string } | null>(null);
    // unplaced（圖上沒有對應 K 棒）只給明細清單與計數，不交給圖層
    const { fills, unplaced } = useMemo(() => {
        if (!ok || !visible) return NO_FILLS;
        const started = performance.now();
        const projected = projectChartFills({ trades: fillTrades, contract, account, accounts, rollover, bars, minutes, dayOnly }, projectionCache);
        costRef.current.project = performance.now() - started;
        return projected;
    }, [ok, visible, fillTrades, contract, account, accounts, rollover, bars, dataVersion, minutes, dayOnly, projectionCache]);
    const { groups, byTime, barGroups, confirmed } = useMemo(() => {
        const started = performance.now();
        // 每價分組（滑過與明細用）：同一彙整鍵的逐筆成交與合計數量
        type PriceGroup = FillMarkGroup & { fills: ChartFill[]; quantity: number; unit: ChartFill['unit']; code: string };
        const groups = new Map<string, PriceGroup>();
        // 顯示組（交給圖層）：同棒同方向同單位同月份的每價分組；只有一個價位就直接用那個每價分組
        const bundles = new Map<string, PriceGroup[]>();
        const byTime = new Map<number, ChartFill[]>();
        // 每根 K 棒的每價分組：明細「這根 K 棒」摘要用（上萬筆的日 K 也只有幾十個價位，不必逐筆重算）
        const barGroups = new Map<number, PriceGroup[]>();
        for (const fill of fills) {
            const key = groupKey(fill);
            const group = groups.get(key);
            if (group) {
                group.fills.push(fill);
                group.quantity += fill.quantity;
            } else {
                const created: PriceGroup = { key, time: fill.time, price: fill.price, action: fill.action, text: null, fills: [fill], quantity: fill.quantity, unit: fill.unit, code: fill.code };
                groups.set(key, created);
                const bar = barGroups.get(fill.time);
                if (bar) bar.push(created);
                else barGroups.set(fill.time, [created]);
                const bundleKey = keysOf(fill).bundle;
                const bundle = bundles.get(bundleKey);
                if (bundle) bundle.push(created);
                else bundles.set(bundleKey, [created]);
            }
            const rows = byTime.get(fill.time);
            if (rows) rows.push(fill);
            else byTime.set(fill.time, [fill]);
        }
        const confirmed: FillMarkGroup[] = [];
        for (const [key, members] of bundles) {
            if (members.length === 1) {
                const only = members[0]!;
                only.text = markText(style, only, priceDecimals);
                confirmed.push(only);
                continue;
            }
            // 多價位：三角形在最低買價／最高賣價（區間外側，都是真實成交價），標籤在均價高度
            members.sort((a, b) => a.price - b.price);
            let quantity = 0;
            let notional = 0;
            for (const m of members) {
                quantity += m.quantity;
                notional += m.price * m.quantity;
            }
            const first = members[0]!;
            const avg = notional / quantity;
            const price = first.action === 'Buy' ? first.price : members[members.length - 1]!.price;
            confirmed.push({
                key, time: first.time, price, action: first.action, labelPrice: avg,
                members: members.map(m => ({ key: m.key, price: m.price })),
                text: markText(style, { action: first.action, price, quantity, unit: first.unit, avg }, priceDecimals),
            });
        }
        costRef.current.group = performance.now() - started;
        return { groups, byTime, barGroups, confirmed };
    }, [fills, style, priceDecimals]);
    // 待確認時保留：只留這個圖層實例在已確認時交給圖層的分組，畫成淡色、不可命中；新掛載從空開始。
    // 商品、週期、僅日盤、帳戶模式改變，或不可保留（彈出視窗的主視窗已關閉）就清空。環境與帳戶範圍各記上次
    // 已知的值，換成另一個已知值才清空，暫時未知時保留：斷線時環境未知，未簽署的模擬帳戶也跟著解析不出來
    // （canTrade 看模擬／正式），所以環境未知時，沒有帳戶或全部帳戶模式的帳戶範圍都當成未知。
    // 環境已知卻沒有帳戶（固定的帳戶不再可交易）是範圍改變，要清空。
    const chartKey = `${contract.security_type}:${contract.exchange}:${contract.code}:${contract.target_code}|${minutes}|${dayOnly}|${accounts ? 'all' : 'active'}`;
    const scopeKnown = env === null && (accounts || !account) ? null : accountScope;
    const keptRef = useRef({ chart: chartKey, env, scope: scopeKnown, groups: NO_GROUPS });
    const kept = keptRef.current;
    const changed = (now: string | null, last: string | null) => now !== null && last !== null && now !== last;
    if (kept.chart !== chartKey || !retain || changed(env, kept.env) || changed(scopeKnown, kept.scope)) kept.groups = NO_GROUPS;
    kept.chart = chartKey;
    kept.env = env ?? kept.env;
    kept.scope = scopeKnown ?? kept.scope;
    // 明細「這根 K 棒」的範圍：商品、週期、僅日盤、帳戶模式＋上次已知的環境與帳戶範圍＋顯示。
    // 不含 ok：盤中回報短暫對不上明細時不取消；斷線時環境／帳戶暫時未知也不取消（同保留分組的規則）
    const focusScope = `${chartKey}|${kept.env}|${kept.scope}|${visible}`;
    const keptGroups = visible ? kept.groups : NO_GROUPS;
    // 關掉標記就放掉快取（成交多時不小），再打開從頭算；保留的分組只留繪圖欄位（單價分組帶著逐筆成交）
    useEffect(() => {
        if (visible) return;
        projectionCache.contexts.clear();
        projectionCache.scope = undefined;
        keptRef.current.groups = keptRef.current.groups.map(({ key, time, price, action, text, members, labelPrice }) => ({ key, time, price, action, text, members, labelPrice }));
    }, [visible, projectionCache]);
    const shown = useMemo(() => ok ? confirmed : visible ? keptGroups.map(group => ({ ...group, dimmed: true })) : NO_GROUPS,
        [ok, visible, confirmed, keptGroups]);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const avoidRef = useRef(avoid);
    avoidRef.current = avoid;
    useEffect(() => setHover(null), [scope]);
    const [focus, setFocus] = useState<{ scope: string; time: number } | null>(null);
    // 打開清單時標示最近查看的那根：要和當時的 hover 同一個範圍，而且那根現在還有成交
    const focusBar = (last: { scope: string; time: number } | null) =>
        setFocus(last && last.scope === scope && byTime.has(last.time) ? { scope: focusScope, time: last.time } : null);
    const clearFocus = useCallback(() => setFocus(null), []);
    useEffect(() => {
        // 範圍變了，或已確認時那根沒有成交了 → 取消；待確認時（成交暫時清空）保留，確認後再顯示
        if (focus && (focus.scope !== focusScope || (ok && !byTime.has(focus.time)))) setFocus(null);
    }, [focus, focusScope, ok, byTime]);
    // 清單的「這根 K 棒」：fills 是那根的全部成交（和 hoveredBar 同一個陣列）、groups 是那根的每價分組；待確認時都是空陣列
    const shownFocus = useMemo(() => focus && focus.scope === focusScope ? {
        time: focus.time,
        label: new Date(focus.time * 1000).toISOString().slice(minutes < 1440 ? 11 : 5, minutes < 1440 ? 16 : 10),
        fills: byTime.get(focus.time) ?? NO_HOVER,
        groups: barGroups.get(focus.time) ?? NO_HOVER_GROUPS,
    } : null, [focus, focusScope, byTime, barGroups, minutes]);

    useEffect(() => {
        const chart = chartRef.current;
        const series = seriesRef.current;
        if (!chart || !series) return;
        const layer = new FillMarksLayer();
        layer.setAvoid(() => avoidRef.current?.() ?? []);
        series.attachPrimitive(layer);
        layerRef.current = layer;
        const move = (event: MouseEventParams) => {
            const current = scopeRef.current;
            // 先找游標附近的圓點／標籤，沒有才取游標所在 K 棒的成交
            const key = event.point && (event.paneIndex ?? 0) === 0
                ? layer.hitAt(event.point.x, event.point.y, typeof event.time === 'number' ? event.time : undefined)
                : null;
            setHover(old => key === null ? (old === null ? old : null)
                : old?.scope === current && old.key === key ? old : { scope: current, key });
        };
        chart.subscribeCrosshairMove(move);
        return () => {
            // CandleChart 的 owner 可能已先 remove 整張圖，避免碰已銷毀的 chart。
            if (chartRef.current === chart) {
                chart.unsubscribeCrosshairMove(move);
                series.detachPrimitive(layer);
            }
            layerRef.current = null;
        };
    }, [chartRef, seriesRef]);

    useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        layer.setGroups(shown);
        // 寫入保留的時機：確認狀態下交給圖層的那一刻
        if (ok) keptRef.current.groups = shown;
    }, [shown, ok]);
    // 樣式一定要交給圖層，否則排版停在預設的 price 規則
    useEffect(() => layerRef.current?.setStyle({ up, down, labelBg, style, shape }), [up, down, labelBg, style, shape]);

    const group = hover?.scope === scope ? groups.get(hover.key) : undefined;
    // 滑到的那組排最前，再接同一根 K 棒的其他成交（報價每跳都會重繪，同一組就沿用同一個陣列）
    const hoveredFills = useMemo(() => group
        ? [...group.fills, ...(byTime.get(group.time) ?? []).filter(f => groupKey(f) !== group.key)]
        : NO_HOVER, [group, byTime]);
    // retained：未確認，圖上畫的是上次確認的淡色分組（明細不列）
    // 提示框的合計與均價摘要看整根 K 棒（同一根裡換價位時是同一個陣列，摘要不必重算）
    const hoveredBar = group ? byTime.get(group.time) ?? NO_HOVER : NO_HOVER;
    return { fills, unplaced, hoveredFills, hoveredBar, scope, incomplete, retained: !ok && shown.length > 0, focus: shownFocus, focusBar, clearFocus };
}
