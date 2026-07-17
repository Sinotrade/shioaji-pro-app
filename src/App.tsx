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
import { CommandPalette } from './components/command-palette';
import { DepthLadder } from './components/depth-ladder';
import { EventToasts } from './components/event-toasts';
import { FlashOrder } from './components/flash-order';
import { HudHeader } from './components/hud-header';
import { OptionChain } from './components/option-chain';
import {
    broadcastSelectCode,
    onBroadcastSelectCode,
} from './lib/option-pick';
import { OrderTicket } from './components/order-ticket';
import { ChipsCard } from './components/chips-card';
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
import * as panel from './components/panel.css';
import { useHotkeys } from './hooks/use-hotkeys';
import { usePoll } from './hooks/use-poll';
import { useWatchlist } from './hooks/use-watchlist';
import { trackActivity } from './lib/activity';
import { agentModule, backtestModule } from './lib/features';
import { ensureContract, useContract } from './lib/contracts-cache';
import { reportDailyPnl } from './lib/risk';
import { isTauri, openPopout } from './lib/tauri';
import {
    fetchAccountBalance,
    fetchMargin,
    fetchPositions,
    fetchTrades,
} from './lib/shioaji';
import { onOrderEvent } from './lib/stream';
import { notify } from './lib/trade';
import type { ContractInfo } from './lib/types/contract';
import type { Trade } from './lib/types/order';
import type { Position } from './lib/types/portfolio';
import {
    BLOCK_META,
    DEFAULT_WORKSPACE,
    LAYOUT_PRESETS,
    loadProfiles,
    loadWorkspace,
    newBlockId,
    saveProfiles,
    saveWorkspace,
    type Block,
    type BlockType,
    type Profile,
    type Workspace,
} from './lib/workspace';

const GRID_COLS = 24;

const POPOUT_TYPES: ReadonlySet<string> = new Set([
    'chart',
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
    refreshTrading,
}: {
    block: Block;
    contract: ContractInfo | null;
    snapshot?: import('./lib/types/market').Snapshot;
    watchlistProps: React.ComponentProps<typeof Watchlist>;
    dockProps: React.ComponentProps<typeof BottomDock>;
    onSelectCode: (code: string) => void;
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
    refreshTrading: () => void;
}

function BlockView(props: BlockViewProps) {
    const { block, selected, onPinChange, onRemove, ...bodyProps } = props;
    const contract = useBlockContract(block, selected);
    const meta = BLOCK_META[block.type];
    const showSymbol =
        meta.pinnable && contract ? ` · ${contract.code}` : '';

    return (
        <section className={panel.panel}>
            <PanelChrome
                title={`${meta.label}${showSymbol}`}
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
            if (refreshed && refreshed.contract !== selected) {
                setSelected(refreshed.contract);
            }
        }
    }, [items, selected]);

    // portfolio polling (stock + futures merged)
    const positionsPoll = usePoll<Position[]>(
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
        10000,
    );
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

    const selectedSnapshot = useMemo(
        () => items.find((i) => i.contract.code === selected?.code)?.snapshot,
        [items, selected],
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

    const onLayoutChange = useCallback(
        (next: Layout) => {
            updateWorkspace({ ...workspace, layout: [...next] });
        },
        [workspace, updateWorkspace],
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
                w: meta.defaultSize.w,
                h: meta.defaultSize.h,
                minW: meta.defaultSize.minW,
                minH: meta.defaultSize.minH,
            };
            updateWorkspace({
                blocks: [...workspace.blocks, { id, type, pin: null }],
                layout: [...workspace.layout, item],
            });
        },
        [workspace, updateWorkspace],
    );

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
        (name: string) => {
            const next = [
                ...profiles.filter((p) => p.name !== name),
                { name, workspace: structuredClone(workspace) },
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

    const addableTypes = useMemo(
        () =>
            (Object.keys(BLOCK_META) as BlockType[]).map((type) => ({
                type,
                label: BLOCK_META[type].label,
                disabled:
                    BLOCK_META[type].singleton &&
                    workspace.blocks.some((b) => b.type === type),
            })),
        [workspace.blocks],
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
                addableTypes={addableTypes}
                onAddBlock={addBlock}
                profiles={profiles.map((p) => p.name)}
                onSaveProfile={saveProfileAs}
                onLoadProfile={loadProfile}
                onDeleteProfile={deleteProfile}
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
            />

            <div className={grid.gridWrap} ref={containerRef}>
                {booting && (
                    <div className={styles.loading}>
                        <span>Shioaji Pro</span>
                        <span style={{ fontSize: '0.7rem' }}>
                            載入交易終端…
                        </span>
                    </div>
                )}
                {!booting && mounted && (
                    <GridLayout
                        layout={workspace.layout}
                        width={width}
                        gridConfig={{
                            cols: GRID_COLS,
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
                            <div key={block.id} className={grid.cell}>
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
