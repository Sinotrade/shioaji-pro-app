// src/components/panel-preview-live.tsx — on-demand live panel preview
// for the panel library flyout. Mounts ONE real panel component at a
// time (user-initiated, so browsing cards never churns subscriptions)
// and unmounts it as soon as the selection changes. Only self-contained
// panels are whitelisted; account/trading panels keep the schematic.

import { type ReactElement, useEffect, useState } from 'react';
import { ensureContract } from '../lib/contracts-cache';
import type { ContractInfo } from '../lib/types/contract';
import type { BlockType } from '../lib/workspace';
import { CandleChart } from './candle-chart';
import { IntradayChart } from './intraday-chart';
import { ChipsCard } from './chips-card';
import { DepthLadder } from './depth-ladder';
import { MarketPulsePanel, MarketSignalPanel } from './market-pulse-panel';
import { OptionChain } from './option-chain';
import { ScannerPanel } from './scanner-panel';
import { SectorHeatmap } from './sector-heatmap';
import { TickTape } from './tick-tape';
import { VolProfile } from './vol-profile';
import * as styles from './panel-library.css';
import { Orb } from './orb';

// feature flag: default on; flip off per-user via
// localStorage.setItem('sj-pro-live-preview', 'off') or change the default
export function livePreviewEnabled() {
    try {
        return (localStorage.getItem('sj-pro-live-preview') ?? 'on') !== 'off';
    } catch {
        return true;
    }
}

const NO_CONTRACT_PREVIEWS: Partial<Record<BlockType, () => ReactElement>> = {
    movers: () => <ScannerPanel onPick={noop} />,
    heatmap: () => <SectorHeatmap onPick={noop} />,
    pulse: () => <MarketPulsePanel />,
    signals: () => <MarketSignalPanel />,
    optchain: () => <OptionChain onPick={noop} />,
};

const CONTRACT_PREVIEWS: Partial<
    Record<BlockType, (contract: ContractInfo) => ReactElement>
> = {
    chart: (contract) => (
        <CandleChart contract={contract} trades={[]} onOrdersChanged={noop} />
    ),
    intraday: (contract) => <IntradayChart contract={contract} />,
    depth: (contract) => <DepthLadder code={contract.code} />,
    tape: (contract) => <TickTape contract={contract} />,
    chips: (contract) => <ChipsCard contract={contract} />,
    volprofile: (contract) => <VolProfile contract={contract} />,
};

function noop() {}

export function canLivePreview(type: BlockType) {
    return type in NO_CONTRACT_PREVIEWS || type in CONTRACT_PREVIEWS;
}

// the panel renders at full desktop size and is scaled down to fit the
// flyout — interactions stay disabled (pointer-events: none upstream)
const RENDER_W = 760;
const RENDER_H = 560;
export const LIVE_PREVIEW_SCALE = 0.48;
export const LIVE_PREVIEW_W = RENDER_W * LIVE_PREVIEW_SCALE;
export const LIVE_PREVIEW_H = RENDER_H * LIVE_PREVIEW_SCALE;

export function LivePanelPreview({
    type,
    code,
}: {
    type: BlockType;
    code: string;
}) {
    const direct = NO_CONTRACT_PREVIEWS[type];
    const withContract = CONTRACT_PREVIEWS[type];
    const [contract, setContract] = useState<ContractInfo | null>(null);

    useEffect(() => {
        if (!withContract) return;
        let active = true;
        setContract(null);
        void ensureContract(code)
            .then((info) => {
                if (active) setContract(info);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [code, withContract]);

    let content: ReactElement | null = null;
    if (direct) {
        content = direct();
    } else if (withContract) {
        if (!contract) {
            return (
                <div className={styles.livePreviewLoading}>
                    <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    載入 {code} …
                </div>
            );
        }
        content = withContract(contract);
    }
    if (!content) return null;

    return (
        <div
            className={styles.livePreviewCanvas}
            style={{
                width: RENDER_W,
                height: RENDER_H,
                transform: `scale(${LIVE_PREVIEW_SCALE})`,
            }}
        >
            {content}
        </div>
    );
}
