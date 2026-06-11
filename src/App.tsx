// src/App.tsx — Shioaji Pro trading terminal
// Dynamic panel blocks on a draggable grid, with named layout profiles.

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { OrderTicket } from './components/order-ticket';
import { ChipsCard } from './components/chips-card';
import { PnlPanel } from './components/pnl-panel';
import { VolProfile } from './components/vol-profile';
import { ReplayPanel } from './components/replay-panel';
import { DepthMap } from './components/depth-map';
import { PanelChrome } from './components/panel-chrome';
import { QuoteBoard } from './components/quote-board';
import { ScannerPanel } from './components/scanner-panel';
import { TickTape } from './components/tick-tape';
import { Watchlist } from './components/watchlist';
import * as panel from './components/panel.css';
import { useHotkeys } from './hooks/use-hotkeys';
import { usePoll } from './hooks/use-poll';
import { useWatchlist } from './hooks/use-watchlist';
import { ensureContract, useContract } from './lib/contracts-cache';
import { reportDailyPnl } from './lib/risk';
import { openPopout } from './lib/tauri';
import {
    fetchAccountBalance,
    fetchMargin,
    fetchPositions,
    fetchTrades,
} from './lib/shioaji';
import { notify } from './lib/trade';
import type { ContractInfo } from './lib/types/contract';
import type { Trade } from './lib/types/order';
import type { Position } from './lib/types/portfolio';
import {
    BLOCK_META,
    DEFAULT_WORKSPACE,
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
const POPOUT_TYPE = popoutQuery.get('popout') as BlockType | null;
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
                <FlashOrder contract={contract} />
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
            return <OptionChain />;
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
    const meta = BLOCK_META[type];

    let body: React.ReactNode = <BlockPlaceholder />;
    if (type === 'pnl') body = <PnlPanel />;
    else if (type === 'optchain') body = <OptionChain />;
    else if (contract) {
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
                body = <FlashOrder contract={contract} />;
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
        addSymbol,
        removeSymbol,
        serverLists,
        activeListId,
        setActiveList,
        createList,
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

    const selectedSnapshot = useMemo(
        () => items.find((i) => i.contract.code === selected?.code)?.snapshot,
        [items, selected],
    );

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

    // ---- profiles ----

    const saveProfileAs = useCallback(
        (name: string) => {
            const next = [
                ...profiles.filter((p) => p.name !== name),
                { name, workspace: structuredClone(workspace) },
            ];
            setProfiles(next);
            saveProfiles(next);
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

    const booting = loading && items.length === 0;

    if (POPOUT_TYPE && POPOUT_TYPES.has(POPOUT_TYPE)) {
        return <PopoutView type={POPOUT_TYPE} code={POPOUT_CODE} />;
    }

    const watchlistProps = {
        items,
        selectedCode: selected?.code ?? null,
        onSelect: setSelected,
        onAdd: addSymbol,
        onRemove: removeSymbol,
        serverLists,
        activeListId,
        onSelectList: setActiveList,
        onCreateList: createList,
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
