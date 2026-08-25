// src/App.tsx — Shioaji Pro trading terminal
// Dynamic panel blocks on a draggable grid, with named layout profiles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GridLayout, {
    useContainerWidth,
    type Layout,
    type LayoutItem,
} from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import * as styles from './App.css';
import * as grid from './grid.css';
import { BottomDock } from './components/bottom-dock';
import { CandleChart } from './components/candle-chart';
import { IntradayChart } from './components/intraday-chart';
import { IntradayWallPanel } from './components/intraday-wall';
import { CommandPalette } from './components/command-palette';
import { DepthLadder } from './components/depth-ladder';
import { EventToasts } from './components/event-toasts';
import { FlashOrder } from './components/flash-order';
import { HudHeader } from './components/hud-header';
import { OptionChain } from './components/option-chain';
import { PanelLibrary } from './components/panel-library';
import * as libraryStyles from './components/panel-library.css';
import {
    broadcastSelectCode,
    onBroadcastSelectCode,
} from './lib/option-pick';
import { OrderTicket } from './components/order-ticket';
import { ChipsCard } from './components/chips-card';
import { ComboListPanel } from './components/combo-list';
import { ComboTicket } from './components/combo-ticket';
import { DebugPanel } from './components/debug-panel';
import { GridTicket } from './components/grid-ticket';
import { NoticeCenter } from './components/notice-center';
import { FeatureGate } from './components/feature-gate';
import { OptPayoff } from './components/opt-payoff';
import { SectorHeatmap } from './components/sector-heatmap';
import { PnlPanel } from './components/pnl-panel';
import { VolProfile } from './components/vol-profile';
import { ReplayPanel } from './components/replay-panel';
import { DepthMap } from './components/depth-map';
import { PanelChrome } from './components/panel-chrome';
import { QuoteBoard } from './components/quote-board';
import { ScannerPanel } from './components/scanner-panel';
import { TickTape } from './components/tick-tape';
import { TrayPanel } from './components/tray-panel';
import { Watchlist } from './components/watchlist';
import { StockFuturesPanel } from './components/stock-futures-panel';
import { WarrantPanel } from './components/warrant-panel';
import {
    MarketPulsePanel,
    MarketSignalPanel,
} from './components/market-pulse-panel';
import * as panel from './components/panel.css';
import { useHotkeys } from './hooks/use-hotkeys';
import { usePoll } from './hooks/use-poll';
import { useWatchlist } from './hooks/use-watchlist';
import { trackActivity } from './lib/activity';
import { agentModule, backtestModule } from './lib/features';
import {
    ensureContract,
    getCachedContract,
    useContract,
} from './lib/contracts-cache';
import { reportDailyPnl } from './lib/risk';
import { isTauri, openPopout } from './lib/tauri';
import {
    fetchAccountBalance,
    fetchMargin,
    fetchPositions,
    fetchSnapshots,
    fetchTrades,
} from './lib/shioaji';
import { onOrderEvent } from './lib/stream';
import { ensureAccounts, getAccountState } from './lib/account-store';
import { notify } from './lib/trade';
import type { ContractInfo } from './lib/types/contract';
import type { AccountedTrade, Trade } from './lib/types/order';
import type { AccountedPosition, Position } from './lib/types/portfolio';
import {
    BLOCK_META,
    DEFAULT_WORKSPACE,
    GRID_LEGACY_COLS,
    GRID_LEGACY_SCALE,
    LAYOUT_PRESETS,
    loadProfiles,
    loadWorkspace,
    newBlockId,
    saveProfiles,
    saveWorkspace,
    toRenderGeom,
    type Block,
    type BlockType,
    type PulseSection,
    type PulseSectionWeights,
    type Profile,
    type Workspace,
} from './lib/workspace';
import { Orb } from './components/orb';

const POPOUT_TYPES: ReadonlySet<string> = new Set([
    'chart',
    'intraday',
    'depth',
    'ticket',
    'tape',
    'flash',
    'chips',
    'volprofile',
    'optchain',
    'pnl',
    'replay',
    'depthmap',
]);

const popoutQuery = new URLSearchParams(window.location.search);
const POPOUT_TYPE = popoutQuery.get('popout');
const POPOUT_CODE = popoutQuery.get('code') || null;

// resolves a block's contract: pinned code (contract cache) or global selection
function useBlockContract(
    block: Block,
    selected: ContractInfo | null,
): ContractInfo | null {
    const pinned = useContract(block.pin);
    useEffect(() => {
        if (block.pin && !pinned) {
            ensureContract(block.pin).catch(() =>
                notify({
                    kind: 'err',
                    title: '找不到商品',
                    body: `代碼 ${block.pin} 無法解析`,
                }),
            );
        }
    }, [block.pin, pinned]);
    return block.pin ? (pinned ?? null) : selected;
}

function BlockBody({
    block,
    contract,
    snapshot,
    watchlistProps,
    dockProps,
    onSelectCode,
    onPulseConfigChange,
    onWallConfigChange,
    refreshTrading,
}: {
    block: Block;
    contract: ContractInfo | null;
    snapshot?: import('./lib/types/market').Snapshot;
    watchlistProps: React.ComponentProps<typeof Watchlist>;
    dockProps: React.ComponentProps<typeof BottomDock>;
    onSelectCode: (code: string) => void;
    onPulseConfigChange: (
        id: string,
        sections: PulseSection[],
        weights: PulseSectionWeights,
    ) => void;
    onWallConfigChange: (
        id: string,
        list: string,
        cols: number,
        rows: number,
    ) => void;
    refreshTrading: () => void;
}) {
    if (contract?.security_type === 'IND' && indexBlockMessage(block.type)) {
        return <IndexBlockUnavailable type={block.type} />;
    }
    switch (block.type) {
        case 'watchlist':
            return <Watchlist {...watchlistProps} />;
        case 'movers':
            return <ScannerPanel onPick={onSelectCode} />;
        case 'dock':
            return <BottomDock {...dockProps} />;
        case 'chart':
            return contract ? (
                <>
                    <QuoteBoard contract={contract} snapshot={snapshot} />
                    <CandleChart
                        contract={contract}
                        trades={dockProps.trades}
                        onOrdersChanged={dockProps.onTradesChanged}
                    />
                </>
            ) : (
                <BlockPlaceholder />
            );
        case 'intraday':
            return contract ? (
                <IntradayChart contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'intradaywall':
            return (
                <IntradayWallPanel
                    onPick={onSelectCode}
                    initialList={block.wallList}
                    initialCols={block.wallCols}
                    initialRows={block.wallRows}
                    onConfigChange={(list, cols, rows) =>
                        onWallConfigChange(block.id, list, cols, rows)
                    }
                />
            );
        case 'depth':
            return contract ? (
                <DepthLadder code={contract.code} />
            ) : (
                <BlockPlaceholder />
            );
        case 'ticket':
            return contract ? (
                <OrderTicket contract={contract} onPlaced={refreshTrading} />
            ) : (
                <BlockPlaceholder />
            );
        case 'tape':
            return contract ? (
                <TickTape contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'flash':
            return contract ? (
                <FlashOrder
                    contract={contract}
                    trades={dockProps.trades}
                    positions={dockProps.positions}
                    onOrdersChanged={dockProps.onTradesChanged}
                />
            ) : (
                <BlockPlaceholder />
            );
        case 'pnl':
            return <PnlPanel />;
        case 'chips':
            return contract ? (
                <ChipsCard contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'volprofile':
            return contract ? (
                <VolProfile contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'optchain':
            return <OptionChain onPick={onSelectCode} />;
        case 'stockfutures':
            return (
                <StockFuturesPanel
                    onPick={onSelectCode}
                    onAdd={(selectedContract) =>
                        watchlistProps.onAdd(
                            selectedContract.code,
                            selectedContract.security_type,
                            selectedContract,
                        )
                    }
                />
            );
        case 'warrants':
            return (
                <WarrantPanel
                    onPick={onSelectCode}
                    onAdd={(selectedContract) =>
                        watchlistProps.onAdd(
                            selectedContract.code,
                            selectedContract.security_type,
                            selectedContract,
                        )
                    }
                />
            );
        case 'combo':
            return <ComboTicket />;
        case 'combolist':
            return <ComboListPanel />;
        case 'notices':
            return <NoticeCenter />;
        case 'debug':
            return <DebugPanel />;
        case 'grid':
            return contract ? (
                <GridTicket
                    contract={contract}
                    trades={dockProps.trades}
                    onOrdersChanged={dockProps.onTradesChanged}
                />
            ) : (
                <BlockPlaceholder />
            );
        case 'heatmap':
            return <SectorHeatmap onPick={onSelectCode} />;
        case 'pulse':
            return (
                <MarketPulsePanel
                    onPick={onSelectCode}
                    initialVisualization={block.pulseVisualization}
                    initialSections={block.pulseSections}
                    initialWeights={block.pulseWeights}
                    initialIndexCode={block.pulseIndex}
                    fixedIndex={Boolean(block.pulseIndex)}
                    fixedView="index"
                    onConfigChange={(sections, weights) =>
                        onPulseConfigChange(block.id, sections, weights)
                    }
                />
            );
        case 'signals':
            return <MarketSignalPanel onPick={onSelectCode} />;
        case 'backtest': {
            const BtPanel = backtestModule?.Panel;
            return (
                <FeatureGate feature='backtest'>
                    {BtPanel ? (
                        <BtPanel contract={contract} onPick={onSelectCode} />
                    ) : null}
                </FeatureGate>
            );
        }
        case 'optpnl':
            return <OptPayoff positions={dockProps.positions} />;
        case 'assistant': {
            const Panel = agentModule?.Panel;
            return (
                <FeatureGate feature='agent'>
                    {Panel ? <Panel /> : null}
                </FeatureGate>
            );
        }
        case 'replay':
            return contract ? (
                <ReplayPanel contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'depthmap':
            return contract ? (
                <DepthMap contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
    }
}

function BlockPlaceholder() {
    return <div className={styles.blockPlaceholder}>等待商品…</div>;
}

function indexBlockMessage(type: BlockType): string | null {
    if (type === 'depth' || type === 'depthmap') {
        return '指數 Quote 行情不含五檔委託資料';
    }
    if (type === 'tape' || type === 'volprofile') {
        return '指數沒有即時 Tick 串流，此面板不支援盤中更新';
    }
    if (type === 'flash' || type === 'grid') {
        return '指數商品不可下單';
    }
    return null;
}

function IndexBlockUnavailable({ type }: { type: BlockType }) {
    return (
        <div className={styles.blockPlaceholder}>
            {indexBlockMessage(type)}
        </div>
    );
}

interface BlockViewProps {
    block: Block;
    selected: ContractInfo | null;
    onPinChange: (id: string, pin: string | null) => void;
    onRemove: (id: string) => void;
    snapshot?: import('./lib/types/market').Snapshot;
    watchlistProps: React.ComponentProps<typeof Watchlist>;
    dockProps: React.ComponentProps<typeof BottomDock>;
    onSelectCode: (code: string) => void;
    onPulseConfigChange: (
        id: string,
        sections: PulseSection[],
        weights: PulseSectionWeights,
    ) => void;
    onWallConfigChange: (
        id: string,
        list: string,
        cols: number,
        rows: number,
    ) => void;
    refreshTrading: () => void;
}

function BlockView(props: BlockViewProps) {
    const { block, selected, onPinChange, onRemove, ...bodyProps } = props;
    const contract = useBlockContract(block, selected);
    const meta = BLOCK_META[block.type];
    const showSymbol =
        meta.pinnable && contract ? ` · ${contract.code}` : '';
    const pulseMarket =
        block.type === 'pulse' && block.pulseIndex
            ? ` · ${block.pulseIndex === 'IX0001' ? '上市' : '上櫃'}`
            : '';

    return (
        <section className={panel.panel}>
            <PanelChrome
                title={`${meta.label}${pulseMarket}${showSymbol}`}
                pinnable={meta.pinnable}
                pin={block.pin}
                currentCode={selected?.code ?? null}
                onPinChange={(pin) => onPinChange(block.id, pin)}
                onRemove={() => onRemove(block.id)}
                onPopout={
                    POPOUT_TYPES.has(block.type)
                        ? () =>
                              void openPopout(
                                  block.type,
                                  contract?.code ?? null,
                              )
                        : undefined
                }
            />
            <BlockBody {...bodyProps} block={block} contract={contract} />
        </section>
    );
}

function PopoutView({
    type,
    code,
}: {
    type: BlockType;
    code: string | null;
}) {
    const contract = useContract(code);
    useEffect(() => {
        if (code) ensureContract(code).catch(() => undefined);
    }, [code]);
    // popouts can run 8+ at once (閃電全開) — longer intervals with a
    // per-window jitter so they don't hammer the upstream accounting
    // rate limit (25 req/5s) in lockstep
    const [pollJitter] = useState(() => Math.floor(Math.random() * 6000));
    const tradesPoll = usePoll<Trade[]>(
        useCallback(async () => {
            const [s, f] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return [
                ...(s.status === 'fulfilled' ? s.value : []),
                ...(f.status === 'fulfilled' ? f.value : []),
            ];
        }, []),
        12000 + pollJitter,
    );
    const popoutPositionsPoll = usePoll<Position[]>(
        useCallback(async () => {
            const [st, fu] = await Promise.allSettled([
                fetchPositions('S'),
                fetchPositions('F'),
            ]);
            return [
                ...(st.status === 'fulfilled' ? st.value : []),
                ...(fu.status === 'fulfilled' ? fu.value : []),
            ];
        }, []),
        20000 + pollJitter,
    );
    const meta = BLOCK_META[type];

    let body: React.ReactNode = <BlockPlaceholder />;
    if (type === 'pnl') body = <PnlPanel />;
    else if (type === 'optchain')
        // popout T 字 click → switch the MAIN window's selected symbol so
        // 下單面板等連動面板跟著動（issue #1: T 字要同時連動下單面板）
        body = <OptionChain onPick={broadcastSelectCode} />;
    else if (type === 'combo') body = <ComboTicket />;
    else if (type === 'combolist') body = <ComboListPanel />;
    else if (
        contract?.security_type === 'IND' &&
        indexBlockMessage(type)
    ) {
        body = <IndexBlockUnavailable type={type} />;
    } else if (contract) {
        switch (type) {
            case 'chart':
                body = (
                    <>
                        <QuoteBoard contract={contract} />
                        <CandleChart
                            contract={contract}
                            trades={tradesPoll.data ?? []}
                            onOrdersChanged={tradesPoll.refresh}
                        />
                    </>
                );
                break;
            case 'intraday':
                body = <IntradayChart contract={contract} />;
                break;
            case 'depth':
                body = <DepthLadder code={contract.code} />;
                break;
            case 'ticket':
                body = (
                    <OrderTicket
                        contract={contract}
                        onPlaced={tradesPoll.refresh}
                    />
                );
                break;
            case 'tape':
                body = <TickTape contract={contract} />;
                break;
            case 'flash':
                body = (
                    <FlashOrder
                        contract={contract}
                        trades={tradesPoll.data ?? []}
                        positions={popoutPositionsPoll.data ?? []}
                        onOrdersChanged={() => {
                            tradesPoll.refresh();
                            popoutPositionsPoll.refresh();
                        }}
                    />
                );
                break;
            case 'chips':
                body = <ChipsCard contract={contract} />;
                break;
            case 'volprofile':
                body = <VolProfile contract={contract} />;
                break;
            case 'replay':
                body = <ReplayPanel contract={contract} />;
                break;
            case 'depthmap':
                body = <DepthMap contract={contract} />;
                break;
            default:
                break;
        }
    }

    return (
        <div className={styles.shell}>
            <EventToasts />
            <section className={panel.panel} style={{ flex: 1, margin: 6 }}>
                <PanelChrome
                    title={`${meta.label}${contract ? ` · ${contract.code}` : ''}`}
                />
                {body}
            </section>
        </div>
    );
}

export default function App() {
    const {
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
    } = useWatchlist();
    const [selected, setSelected] = useState<ContractInfo | null>(null);
    const cachedSelected = useContract(selected?.code ?? null);
    const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
    const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
    const { width, containerRef, mounted } = useContainerWidth();

    // first loaded watchlist item becomes the active symbol
    useEffect(() => {
        const first = items[0];
        if (!selected && first) {
            setSelected(first.contract);
            return;
        }
        if (selected) {
            const refreshed = items.find(
                (item) => item.contract.code === selected.code,
            );
            // 只在 items 的物件就是 contract cache 的最新物件時才採用 —
            // 若其他面板（權證/個股期/走勢牆）對同一檔 prime 了另一個物
            // 件，這裡採 items 版、下面的 cachedSelected effect 採 cache
            // 版，兩個 effect 會互相覆寫成無限 re-render（K 線/走勢圖
            // 每輪都重抓 kbars 的風暴）。cache 是唯一權威來源；自選清單
            // 載入時本來就會把自己的物件 prime 進 cache，不會漏更新
            if (
                refreshed &&
                refreshed.contract !== selected &&
                (getCachedContract(selected.code) ?? refreshed.contract) ===
                    refreshed.contract
            ) {
                setSelected(refreshed.contract);
            }
        }
    }, [items, selected]);

    // Contract V2 info is refreshed after daily maintenance/update events.
    // Keep selections opened outside the active watchlist on the refreshed
    // cache object as well, so limits/reference never remain on yesterday.
    useEffect(() => {
        if (cachedSelected && cachedSelected !== selected) {
            setSelected(cachedSelected);
        }
    }, [cachedSelected, selected]);

    // portfolio polling — one request per signed account, rows tagged with
    // their source account so the dock can group/filter 分帳戶; falls back to
    // the plain S/F pair until the account list has loaded
    useEffect(ensureAccounts, []);
    const positionsPoll = usePoll<AccountedPosition[]>(
        useCallback(async () => {
            // signed only — the store now keeps unsigned accounts for
            // display, but they can't be queried for positions/orders
            const tradable = getAccountState().accounts.filter(
                (a) =>
                    a.signed &&
                    (a.account_type === 'S' || a.account_type === 'F'),
            );
            if (tradable.length > 0) {
                const rs = await Promise.allSettled(
                    tradable.map(async (a) => {
                        const ps = await fetchPositions(
                            a.account_type as 'S' | 'F',
                            a,
                        );
                        return ps.map((p) => ({ ...p, account: a }));
                    }),
                );
                return rs.flatMap((r) =>
                    r.status === 'fulfilled' ? r.value : [],
                );
            }
            const [st, fu] = await Promise.allSettled([
                fetchPositions('S'),
                fetchPositions('F'),
            ]);
            return [
                ...(st.status === 'fulfilled' ? st.value : []),
                ...(fu.status === 'fulfilled' ? fu.value : []),
            ];
        }, []),
        10000,
    );
    // trades 比照 positions 按簽署帳戶 fan-out（issue #19）— 分倉或多帳戶
    // 下單時，非選中帳戶的委託過去查不到；每列標記查詢來源帳戶，dock 的
    // 帳戶範圍篩選比對用清單同格式的帳號，不再受 order.account 格式差異
    // 影響。帳號清單載入前退回舊的 S/F 對。
    const tradesPoll = usePoll<AccountedTrade[]>(
        useCallback(async () => {
            const tradable = getAccountState().accounts.filter(
                (a) =>
                    a.signed &&
                    (a.account_type === 'S' || a.account_type === 'F'),
            );
            if (tradable.length > 0) {
                const rs = await Promise.allSettled(
                    tradable.map(async (a) => {
                        const ts = await fetchTrades(
                            a.account_type as 'S' | 'F',
                            a,
                        );
                        return ts.map((t) => ({ ...t, account: a }));
                    }),
                );
                if (rs.every((r) => r.status === 'rejected')) {
                    // 全滅（rate limit/斷線）拋出 — usePoll 保留上一輪
                    // 資料，不要把委託清單瞬間刷成「無委託」
                    throw new Error('委託查詢失敗');
                }
                const all = rs.flatMap((r) =>
                    r.status === 'fulfilled' ? r.value : [],
                );
                // server 的 list_trades 可能每次回整份快取 → 以委託 id
                // 去重；重複時保留 order.account 與查詢帳戶一致的那筆
                // （標籤才是真正的下單帳戶）。空 id 不合併、帳戶比對含
                // broker_id（不同券商同帳號不可互撞）
                const sameAcct = (t: AccountedTrade) =>
                    t.order.account?.account_id === t.account?.account_id &&
                    t.order.account?.broker_id === t.account?.broker_id;
                const seen = new Map<string, AccountedTrade>();
                const noId: AccountedTrade[] = [];
                for (const t of all) {
                    const key = t.order.id;
                    if (!key) {
                        noId.push(t);
                        continue;
                    }
                    const prev = seen.get(key);
                    if (!prev || (sameAcct(t) && !sameAcct(prev))) {
                        seen.set(key, t);
                    }
                }
                return [...seen.values(), ...noId];
            }
            const [s, f] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return [
                ...(s.status === 'fulfilled' ? s.value : []),
                ...(f.status === 'fulfilled' ? f.value : []),
            ];
        }, []),
        8000,
    );
    const balancePoll = usePoll(
        useCallback(() => fetchAccountBalance(), []),
        60000,
    );
    const marginPoll = usePoll(useCallback(() => fetchMargin(), []), 30000);

    const refreshTrading = useCallback(() => {
        tradesPoll.refresh();
        positionsPoll.refresh();
        balancePoll.refresh();
        marginPoll.refresh();
    }, [tradesPoll, positionsPoll, balancePoll, marginPoll]);
    const refreshTradingRef = useRef(refreshTrading);
    refreshTradingRef.current = refreshTrading;

    // order events drive an immediate (debounced) refresh — fills and
    // cancels reach every panel within ~0.5s instead of the next poll
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = onOrderEvent(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => refreshTradingRef.current(), 500);
        });
        return () => {
            off();
            if (timer) clearTimeout(timer);
        };
    }, []);

    // feed risk engine: unrealized position P&L + futures settle P&L
    useEffect(() => {
        const unrealized = (positionsPoll.data ?? []).reduce(
            (sum, p) => sum + (p.pnl || 0),
            0,
        );
        const settle = marginPoll.data?.future_settle_profitloss ?? 0;
        reportDailyPnl(unrealized + settle);
    }, [positionsPoll.data, marginPoll.data]);

    // select & link a symbol WITHOUT adding it to the watchlist
    const selectByCode = useCallback(
        async (code: string) => {
            const existing = items.find((i) => i.contract.code === code);
            if (existing) {
                setSelected(existing.contract);
                return;
            }
            try {
                const c = await ensureContract(code);
                setSelected(c);
            } catch {
                notify({
                    kind: 'err',
                    title: '找不到商品',
                    body: `代碼 ${code} 無法解析`,
                });
            }
        },
        [items],
    );

    // tray-panel clicks link the symbol into the main window
    const selectByCodeRef = useRef(selectByCode);
    selectByCodeRef.current = selectByCode;
    useEffect(() => {
        if (!isTauri) return;
        let off: (() => void) | undefined;
        void import('@tauri-apps/api/event').then(({ listen }) =>
            listen<string>('tray-pick-code', (e) => {
                if (e.payload) void selectByCodeRef.current(e.payload);
            }).then((un) => {
                off = un;
            }),
        );
        return () => off?.();
    }, []);
    // popout windows (T 字等) ask the main window to switch symbols
    useEffect(
        () =>
            onBroadcastSelectCode((code) => {
                void selectByCodeRef.current(code);
            }),
        [],
    );

    // 庫存/排行榜/指令面板等非自選清單來源選中的商品沒有清單快照 —
    // 收盤後（或訂閱後第一筆 tick 抵達前）報價板會整排「—」。補抓一次
    // 性快照當 fallback；盤中有 live tick 時 QuoteBoard 本來就以 live
    // 優先，快照僅墊底
    const [fallbackSnap, setFallbackSnap] = useState<{
        code: string;
        snap: import('./lib/types/market').Snapshot;
    } | null>(null);
    useEffect(() => {
        const c = selected;
        if (!c) return;
        // 只認 code 當依賴 — items 每輪快照輪詢都換 identity，跟著抖
        // 會變成重複抓
        if (
            items.some(
                (i) => i.contract.code === c.code && i.snapshot !== undefined,
            )
        ) {
            return;
        }
        let cancelled = false;
        void fetchSnapshots([c])
            .then((snaps) => {
                const s = snaps?.[0];
                if (!cancelled && s) {
                    setFallbackSnap({ code: c.code, snap: s });
                }
            })
            .catch(() => {
                // 快照拿不到就維持「—」— 不重試，選別檔再回來會再抓
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected?.code]);
    const selectedSnapshot = useMemo(
        () =>
            items.find((i) => i.contract.code === selected?.code)?.snapshot ??
            (fallbackSnap && fallbackSnap.code === selected?.code
                ? fallbackSnap.snap
                : undefined),
        [items, selected, fallbackSnap],
    );

    // ambient observation: one effect catches every selection path
    // (watchlist / palette / scanner / heatmap / tray)
    useEffect(() => {
        if (selected) {
            trackActivity('選商品', `${selected.code} ${selected.name}`);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected?.code]);

    // ---- workspace ops ----

    const updateWorkspace = useCallback((w: Workspace) => {
        setWorkspace(w);
        saveWorkspace(w);
    }, []);

    // ---- 版面密度（超寬螢幕支援）----
    // 儲存基準 288 欄；渲染依視窗寬選密度 k（cols=24k，每欄 ~40–55px）：
    // 欄寬與最小寬不再跟著螢幕等比放大，超寬幕上面板可以縮得更窄、
    // 拖拉步進更細。k 皆整除 12 → 同密度回存無損；跨密度僅一次舍入。
    const density = width < 1800 ? 1 : width < 2800 ? 2 : width < 3900 ? 3 : 4;
    const renderCols = GRID_LEGACY_COLS * density;
    const colW = width > 0 ? width / renderCols : 53;
    const renderLayout = useMemo(() => {
        const typeOf = new Map(workspace.blocks.map((b) => [b.id, b.type]));
        return workspace.layout.map((l) => {
            const meta = BLOCK_META[typeOf.get(l.i) as BlockType];
            // 最小寬錨定像素（24 欄 ×1280px 時代的等效值）— 在超寬幕
            // 不再是螢幕比例，自選清單等窄面板可以真正縮窄
            const minPx = (meta?.defaultSize.minW ?? 3) * (1280 / 24);
            return {
                ...l,
                ...toRenderGeom(l, density),
                minW: Math.min(
                    Math.max(1, Math.ceil(minPx / colW)),
                    renderCols,
                ),
            };
        });
    }, [workspace, density, colW, renderCols]);
    const onLayoutChange = useCallback(
        (next: Layout) => {
            const fromRender = GRID_LEGACY_SCALE / density; // 12/k，整數
            const prev = new Map(workspace.layout.map((l) => [l.i, l]));
            // RGL 在 mount 時必發一次 onLayoutChange（含跨密度舍入後的
            // 座標）— 儲存值渲染後與回報一致的面板保留原值，精細版面
            // 不會只因「開了 app」就被粗化回存
            let changed = false;
            const stored = next.map((l) => {
                const p = prev.get(l.i);
                if (p) {
                    const g = toRenderGeom(p, density);
                    if (
                        g.x === l.x &&
                        g.w === l.w &&
                        p.y === l.y &&
                        p.h === l.h
                    ) {
                        return p;
                    }
                }
                changed = true;
                return {
                    ...(p ?? {}),
                    i: l.i,
                    x: Math.round(l.x * fromRender),
                    y: l.y,
                    w: Math.max(1, Math.round(l.w * fromRender)),
                    h: l.h,
                };
            });
            if (!changed && stored.length === workspace.layout.length) return;
            updateWorkspace({ ...workspace, layout: stored });
        },
        [workspace, updateWorkspace, density],
    );

    const addBlock = useCallback(
        (type: BlockType) => {
            const meta = BLOCK_META[type];
            if (
                meta.singleton &&
                workspace.blocks.some((b) => b.type === type)
            ) {
                return;
            }
            trackActivity('開面板', meta.label);
            const id = newBlockId(type);
            const item: LayoutItem = {
                i: id,
                x: 0,
                y: Infinity, // RGL drops it at the bottom
                // defaultSize 以 24 欄語意撰寫 → 存檔是 288 基準
                w: meta.defaultSize.w * GRID_LEGACY_SCALE,
                h: meta.defaultSize.h,
                minW: meta.defaultSize.minW * GRID_LEGACY_SCALE,
                minH: meta.defaultSize.minH,
            };
            updateWorkspace({
                blocks: [...workspace.blocks, { id, type, pin: null }],
                layout: [...workspace.layout, item],
            });
        },
        [workspace, updateWorkspace],
    );

    const [panelLibraryOpen, setPanelLibraryOpen] = useState(false);

    // jump-to-existing-panel from the panel library: scroll the grid cell
    // into view and pulse its outline once
    const locateBlock = useCallback((id: string) => {
        requestAnimationFrame(() => {
            const cell = document.querySelector(`[data-block-id="${id}"]`);
            if (!cell) return;
            cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cell.classList.remove(libraryStyles.blockFlash);
            // restart the animation even when re-triggered back to back
            void (cell as HTMLElement).offsetWidth;
            cell.classList.add(libraryStyles.blockFlash);
            setTimeout(
                () => cell.classList.remove(libraryStyles.blockFlash),
                1300,
            );
        });
    }, []);

    const removeBlock = useCallback(
        (id: string) => {
            const gone = workspace.blocks.find((b) => b.id === id);
            if (gone) trackActivity('關面板', gone.type);
            updateWorkspace({
                blocks: workspace.blocks.filter((b) => b.id !== id),
                layout: workspace.layout.filter((l) => l.i !== id),
            });
        },
        [workspace, updateWorkspace],
    );

    const setBlockPin = useCallback(
        (id: string, pin: string | null) => {
            updateWorkspace({
                ...workspace,
                blocks: workspace.blocks.map((b) =>
                    b.id === id ? { ...b, pin } : b,
                ),
            });
        },
        [workspace, updateWorkspace],
    );

    const setBlockWallConfig = useCallback(
        (id: string, wallList: string, wallCols: number, wallRows: number) => {
            updateWorkspace({
                ...workspace,
                blocks: workspace.blocks.map((block) =>
                    block.id === id
                        ? { ...block, wallList, wallCols, wallRows }
                        : block,
                ),
            });
        },
        [workspace, updateWorkspace],
    );

    const setBlockPulseConfig = useCallback(
        (
            id: string,
            pulseSections: PulseSection[],
            pulseWeights: PulseSectionWeights,
        ) => {
            updateWorkspace({
                ...workspace,
                blocks: workspace.blocks.map((block) =>
                    block.id === id
                        ? { ...block, pulseSections, pulseWeights }
                        : block,
                ),
            });
        },
        [workspace, updateWorkspace],
    );

    const resetWorkspace = useCallback(() => {
        updateWorkspace(structuredClone(DEFAULT_WORKSPACE));
    }, [updateWorkspace]);

    const loadPreset = useCallback(
        (name: string) => {
            const preset = LAYOUT_PRESETS.find((p) => p.name === name);
            if (preset) {
                updateWorkspace(structuredClone(preset.workspace));
                trackActivity('套版面', name);
                notify({
                    kind: 'info',
                    title: '版面已套用',
                    body: `預設版面「${name}」`,
                });
            }
        },
        [updateWorkspace],
    );

    // ---- profiles ----

    const saveProfileAs = useCallback(
        (name: string, icon?: string) => {
            const next = [
                ...profiles.filter((p) => p.name !== name),
                {
                    name,
                    workspace: structuredClone(workspace),
                    ...(icon ? { icon } : {}),
                },
            ];
            setProfiles(next);
            saveProfiles(next);
            trackActivity('存版面', name);
            notify({
                kind: 'ok',
                title: '版面已儲存',
                body: `「${name}」已加入版面列表`,
            });
        },
        [profiles, workspace],
    );

    const loadProfile = useCallback(
        (name: string) => {
            const p = profiles.find((x) => x.name === name);
            if (p) {
                updateWorkspace(structuredClone(p.workspace));
                trackActivity('套版面', name);
                notify({
                    kind: 'info',
                    title: '版面已載入',
                    body: `已切換至「${name}」`,
                });
            }
        },
        [profiles, updateWorkspace],
    );

    const deleteProfile = useCallback(
        (name: string) => {
            const next = profiles.filter((p) => p.name !== name);
            setProfiles(next);
            saveProfiles(next);
        },
        [profiles],
    );

    const renameProfile = useCallback(
        (oldName: string, newName: string) => {
            if (oldName === newName) return;
            if (profiles.some((p) => p.name === newName)) {
                // silent revert would look like data loss — say why
                notify({
                    kind: 'err',
                    title: '改名失敗',
                    body: `已有同名版面「${newName}」`,
                });
                return;
            }
            const next = profiles.map((p) =>
                p.name === oldName ? { ...p, name: newName } : p,
            );
            setProfiles(next);
            saveProfiles(next);
            trackActivity('版面改名', newName);
        },
        [profiles],
    );

    const [paletteOpen, setPaletteOpen] = useState(false);
    const openPalette = useCallback(() => setPaletteOpen(true), []);
    useHotkeys({
        onOpenPalette: openPalette,
        onAfterCancelAll: refreshTrading,
    });

    const jumpToCode = useCallback(
        async (code: string) => {
            const existing = items.find((i) => i.contract.code === code);
            if (existing) {
                setSelected(existing.contract);
                return;
            }
            const c = await ensureContract(code);
            setSelected(c);
        },
        [items],
    );

    const booting = initialLoading;

    if (POPOUT_TYPE === 'traypanel') {
        return <TrayPanel />;
    }
    if (POPOUT_TYPE && POPOUT_TYPES.has(POPOUT_TYPE)) {
        return (
            <PopoutView type={POPOUT_TYPE as BlockType} code={POPOUT_CODE} />
        );
    }

    const watchlistProps = {
        items,
        selectedCode: selected?.code ?? null,
        onSelect: setSelected,
        onAdd: addSymbol,
        onRemove: removeSymbol,
        onReorder: reorderSymbol,
        serverLists,
        activeListId,
        onSelectList: setActiveList,
        onCreateList: createList,
        onRenameList: renameCurrentList,
        onDeleteList: deleteCurrentList,
        loading,
    };
    const dockProps = {
        positions: positionsPoll.data ?? [],
        trades: tradesPoll.data ?? [],
        balance: balancePoll.data,
        margin: marginPoll.data,
        onTradesChanged: refreshTrading,
        onSelectCode: selectByCode,
    };

    return (
        <div className={styles.shell}>
            <HudHeader
                accBalance={balancePoll.data?.acc_balance}
                onOpenPanelLibrary={() => setPanelLibraryOpen(true)}
                profiles={profiles}
                currentWorkspace={workspace}
                onSaveProfile={saveProfileAs}
                onLoadProfile={loadProfile}
                onDeleteProfile={deleteProfile}
                onRenameProfile={renameProfile}
                onResetWorkspace={resetWorkspace}
                onLoadPreset={loadPreset}
                flashCodes={items
                    .filter((i) => i.contract.security_type !== 'IND')
                    .map((i) => i.contract.code)}
            />
            <EventToasts onEvent={refreshTrading} />
            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                onJump={jumpToCode}
                onAddPanel={addBlock}
            />
            <PanelLibrary
                open={panelLibraryOpen}
                onClose={() => setPanelLibraryOpen(false)}
                blocks={workspace.blocks}
                onAdd={addBlock}
                onLocate={locateBlock}
                selectedCode={selected?.code}
            />

            <div className={grid.gridWrap} ref={containerRef}>
                {booting && (
                    <div className={styles.loading}>
                        <Orb size={20} />
                        <span>Shioaji Pro</span>
                        <span style={{ fontSize: '0.7rem' }}>
                            載入交易終端…
                        </span>
                    </div>
                )}
                {!booting && mounted && (
                    <GridLayout
                        layout={renderLayout}
                        width={width}
                        gridConfig={{
                            cols: renderCols,
                            rowHeight: 30,
                            margin: [6, 6],
                            containerPadding: [6, 6],
                        }}
                        dragConfig={{
                            handle: '.drag-handle',
                            cancel: 'button, input, select',
                        }}
                        onLayoutChange={onLayoutChange}
                    >
                        {workspace.blocks.map((block) => (
                            <div
                                key={block.id}
                                data-block-id={block.id}
                                className={grid.cell}
                            >
                                <BlockView
                                    block={block}
                                    selected={selected}
                                    onPinChange={setBlockPin}
                                    onRemove={removeBlock}
                                    snapshot={
                                        block.pin
                                            ? undefined
                                            : selectedSnapshot
                                    }
                                    watchlistProps={watchlistProps}
                                    dockProps={dockProps}
                                    onSelectCode={selectByCode}
                                    onPulseConfigChange={setBlockPulseConfig}
                                    onWallConfigChange={setBlockWallConfig}
                                    refreshTrading={refreshTrading}
                                />
                            </div>
                        ))}
                    </GridLayout>
                )}
            </div>
        </div>
    );
}
