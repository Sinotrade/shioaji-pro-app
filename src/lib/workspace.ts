// src/lib/workspace.ts — dynamic panel blocks + grid layout + named profiles

import type { LayoutItem } from 'react-grid-layout';

export type BlockType =
    | 'watchlist'
    | 'movers'
    | 'dock'
    | 'chart'
    | 'depth'
    | 'ticket'
    | 'tape'
    | 'flash'
    | 'pnl'
    | 'chips'
    | 'volprofile'
    | 'optchain'
    | 'replay'
    | 'depthmap'
    | 'combo'
    | 'notices'
    | 'debug'
    | 'grid'
    | 'heatmap'
    | 'optpnl'
    | 'backtest'
    | 'assistant'
    | 'webview';

export interface Block {
    id: string;
    type: BlockType;
    // null → follows the globally selected symbol; string → pinned to a code
    pin: string | null;
    // webview only: the embedded page URL (persisted with the workspace)
    url?: string;
}

export interface Workspace {
    blocks: Block[];
    layout: LayoutItem[];
}

export interface Profile {
    name: string;
    workspace: Workspace;
}

export const BLOCK_META: Record<
    BlockType,
    {
        label: string;
        pinnable: boolean;
        singleton: boolean;
        defaultSize: { w: number; h: number; minW: number; minH: number };
    }
> = {
    watchlist: {
        label: '自選清單',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 14, minW: 3, minH: 6 },
    },
    movers: {
        label: '排行榜',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 11, minW: 3, minH: 5 },
    },
    dock: {
        label: '持倉/委託/帳務',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 15, h: 9, minW: 6, minH: 5 },
    },
    chart: {
        label: 'K 線圖',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 12, minW: 6, minH: 7 },
    },
    depth: {
        label: '五檔',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 7 },
    },
    ticket: {
        label: '下單面板',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 11, minW: 4, minH: 10 },
    },
    tape: {
        label: '成交明細',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 4, h: 8, minW: 3, minH: 4 },
    },
    flash: {
        label: '閃電下單',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 14, minW: 4, minH: 8 },
    },
    pnl: {
        label: '損益分析',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 8, minW: 6, minH: 6 },
    },
    chips: {
        label: '籌碼資訊',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 5 },
    },
    volprofile: {
        label: '分價量表',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 12, minW: 4, minH: 6 },
    },
    optchain: {
        label: '選擇權 T 字',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 10, h: 14, minW: 8, minH: 8 },
    },
    replay: {
        label: '行情回放',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 10, minW: 6, minH: 6 },
    },
    depthmap: {
        label: '委託簿熱圖',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 8, h: 9, minW: 5, minH: 6 },
    },
    combo: {
        label: '組合單',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 14, minW: 5, minH: 10 },
    },
    notices: {
        label: '通知中心',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 10, minW: 4, minH: 6 },
    },
    debug: {
        label: '診斷 Debug',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 11, minW: 4, minH: 7 },
    },
    grid: {
        label: '鋪單',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 13, minW: 4, minH: 10 },
    },
    heatmap: {
        label: '類股熱力圖',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 11, minW: 5, minH: 6 },
    },
    optpnl: {
        label: '選擇權損益圖',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 13, minW: 6, minH: 9 },
    },
    backtest: {
        label: '策略回測',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 12, h: 14, minW: 8, minH: 8 },
    },
    assistant: {
        label: 'AI Agent',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 7, h: 14, minW: 5, minH: 9 },
    },
    webview: {
        label: '自訂網頁',
        // pinnable：URL 含 {code} 時代入商品代碼（跟隨選股或釘選）；靜態 URL 不受影響
        pinnable: true,
        singleton: false,
        defaultSize: { w: 8, h: 10, minW: 3, minH: 4 },
    },
};

export const DEFAULT_WORKSPACE: Workspace = {
    blocks: [
        { id: 'watchlist-0', type: 'watchlist', pin: null },
        { id: 'movers-0', type: 'movers', pin: null },
        { id: 'chart-0', type: 'chart', pin: null },
        { id: 'dock-0', type: 'dock', pin: null },
        { id: 'depth-0', type: 'depth', pin: null },
        { id: 'ticket-0', type: 'ticket', pin: null },
        { id: 'tape-0', type: 'tape', pin: null },
    ],
    layout: [
        { i: 'watchlist-0', x: 0, y: 0, w: 4, h: 14, minW: 3, minH: 6 },
        { i: 'movers-0', x: 0, y: 14, w: 4, h: 11, minW: 3, minH: 5 },
        { i: 'chart-0', x: 4, y: 0, w: 15, h: 16, minW: 6, minH: 7 },
        { i: 'dock-0', x: 4, y: 16, w: 15, h: 9, minW: 6, minH: 5 },
        { i: 'depth-0', x: 19, y: 0, w: 5, h: 8, minW: 4, minH: 7 },
        { i: 'ticket-0', x: 19, y: 8, w: 5, h: 11, minW: 4, minH: 10 },
        { i: 'tape-0', x: 19, y: 19, w: 5, h: 6, minW: 3, minH: 4 },
    ],
};

// built-in layout presets for common trading workflows
export const LAYOUT_PRESETS: { name: string; desc: string; workspace: Workspace }[] = [
    {
        name: '標準看盤',
        desc: '自選+排行 / K線+持倉 / 五檔+下單+明細',
        workspace: DEFAULT_WORKSPACE,
    },
    {
        name: '當沖交易',
        desc: '大圖+閃電下單+五檔明細，執行優先',
        workspace: {
            blocks: [
                { id: 'chart-dt', type: 'chart', pin: null },
                { id: 'flash-dt', type: 'flash', pin: null },
                { id: 'depth-dt', type: 'depth', pin: null },
                { id: 'tape-dt', type: 'tape', pin: null },
                { id: 'dock-dt', type: 'dock', pin: null },
                { id: 'vol-dt', type: 'volprofile', pin: null },
                { id: 'ticket-dt', type: 'ticket', pin: null },
            ],
            layout: [
                { i: 'chart-dt', x: 0, y: 0, w: 13, h: 15, minW: 6, minH: 7 },
                { i: 'flash-dt', x: 13, y: 0, w: 5, h: 15, minW: 4, minH: 8 },
                { i: 'depth-dt', x: 18, y: 0, w: 6, h: 8, minW: 4, minH: 7 },
                { i: 'tape-dt', x: 18, y: 8, w: 6, h: 7, minW: 3, minH: 4 },
                { i: 'dock-dt', x: 0, y: 15, w: 13, h: 9, minW: 6, minH: 5 },
                { i: 'vol-dt', x: 13, y: 15, w: 5, h: 9, minW: 4, minH: 6 },
                { i: 'ticket-dt', x: 18, y: 15, w: 6, h: 9, minW: 4, minH: 9 },
            ],
        },
    },
    {
        name: '雙圖對照',
        desc: '連動圖+鎖定台指期圖並排',
        workspace: {
            blocks: [
                { id: 'watch-2c', type: 'watchlist', pin: null },
                { id: 'chart-2ca', type: 'chart', pin: null },
                { id: 'chart-2cb', type: 'chart', pin: 'TXFR1' },
                { id: 'movers-2c', type: 'movers', pin: null },
                { id: 'dock-2c', type: 'dock', pin: null },
                { id: 'ticket-2c', type: 'ticket', pin: null },
            ],
            layout: [
                { i: 'watch-2c', x: 0, y: 0, w: 4, h: 14, minW: 3, minH: 6 },
                { i: 'chart-2ca', x: 4, y: 0, w: 10, h: 14, minW: 6, minH: 7 },
                { i: 'chart-2cb', x: 14, y: 0, w: 10, h: 14, minW: 6, minH: 7 },
                { i: 'movers-2c', x: 0, y: 14, w: 4, h: 10, minW: 3, minH: 5 },
                { i: 'dock-2c', x: 4, y: 14, w: 14, h: 10, minW: 6, minH: 5 },
                { i: 'ticket-2c', x: 18, y: 14, w: 6, h: 10, minW: 4, minH: 9 },
            ],
        },
    },
    {
        name: '選擇權',
        desc: 'T字報價+台指期圖+損益圖+下單',
        workspace: {
            blocks: [
                { id: 'opt-ow', type: 'optchain', pin: null },
                { id: 'chart-ow', type: 'chart', pin: 'TXFR1' },
                { id: 'ticket-ow', type: 'ticket', pin: null },
                { id: 'depth-ow', type: 'depth', pin: null },
                { id: 'dock-ow', type: 'dock', pin: null },
                { id: 'optpnl-ow', type: 'optpnl', pin: null },
            ],
            layout: [
                { i: 'opt-ow', x: 0, y: 0, w: 10, h: 16, minW: 8, minH: 8 },
                { i: 'chart-ow', x: 10, y: 0, w: 9, h: 16, minW: 6, minH: 7 },
                { i: 'ticket-ow', x: 19, y: 0, w: 5, h: 10, minW: 4, minH: 9 },
                { i: 'depth-ow', x: 19, y: 10, w: 5, h: 6, minW: 4, minH: 6 },
                { i: 'dock-ow', x: 0, y: 16, w: 16, h: 9, minW: 6, minH: 5 },
                { i: 'optpnl-ow', x: 16, y: 16, w: 8, h: 9, minW: 6, minH: 9 },
            ],
        },
    },
    {
        name: '鋪單交易',
        desc: '鋪單+閃電+五檔明細，掛單火力全開',
        workspace: {
            blocks: [
                { id: 'chart-gr', type: 'chart', pin: null },
                { id: 'flash-gr', type: 'flash', pin: null },
                { id: 'grid-gr', type: 'grid', pin: null },
                { id: 'depth-gr', type: 'depth', pin: null },
                { id: 'dock-gr', type: 'dock', pin: null },
                { id: 'tape-gr', type: 'tape', pin: null },
            ],
            layout: [
                { i: 'chart-gr', x: 0, y: 0, w: 12, h: 14, minW: 6, minH: 7 },
                { i: 'flash-gr', x: 12, y: 0, w: 6, h: 14, minW: 4, minH: 8 },
                { i: 'grid-gr', x: 18, y: 0, w: 6, h: 14, minW: 4, minH: 10 },
                { i: 'depth-gr', x: 0, y: 14, w: 6, h: 10, minW: 4, minH: 7 },
                { i: 'dock-gr', x: 6, y: 14, w: 12, h: 10, minW: 6, minH: 5 },
                { i: 'tape-gr', x: 18, y: 14, w: 6, h: 10, minW: 3, minH: 4 },
            ],
        },
    },
    {
        name: '閃電矩陣',
        desc: '自選清單＋四條閃電梯：第一條連動點選，其餘可釘選熱門檔',
        workspace: {
            blocks: [
                { id: 'watch-fm', type: 'watchlist', pin: null },
                { id: 'flash-fm1', type: 'flash', pin: null },
                { id: 'flash-fm2', type: 'flash', pin: 'TXFR1' },
                { id: 'flash-fm3', type: 'flash', pin: '2330' },
                { id: 'flash-fm4', type: 'flash', pin: '2454' },
            ],
            layout: [
                { i: 'watch-fm', x: 0, y: 0, w: 4, h: 24, minW: 3, minH: 6 },
                { i: 'flash-fm1', x: 4, y: 0, w: 5, h: 24, minW: 4, minH: 8 },
                { i: 'flash-fm2', x: 9, y: 0, w: 5, h: 24, minW: 4, minH: 8 },
                { i: 'flash-fm3', x: 14, y: 0, w: 5, h: 24, minW: 4, minH: 8 },
                { i: 'flash-fm4', x: 19, y: 0, w: 5, h: 24, minW: 4, minH: 8 },
            ],
        },
    },
    {
        name: '熱力選股',
        desc: '熱力圖+排行掃標的，點格即連動全終端',
        workspace: {
            blocks: [
                { id: 'heatmap-hs', type: 'heatmap', pin: null },
                { id: 'movers-hs', type: 'movers', pin: null },
                { id: 'watch-hs', type: 'watchlist', pin: null },
                { id: 'chart-hs', type: 'chart', pin: null },
                { id: 'dock-hs', type: 'dock', pin: null },
            ],
            layout: [
                { i: 'heatmap-hs', x: 0, y: 0, w: 14, h: 12, minW: 5, minH: 6 },
                { i: 'movers-hs', x: 14, y: 0, w: 10, h: 12, minW: 3, minH: 5 },
                { i: 'watch-hs', x: 0, y: 12, w: 6, h: 12, minW: 3, minH: 6 },
                { i: 'chart-hs', x: 6, y: 12, w: 12, h: 12, minW: 6, minH: 7 },
                { i: 'dock-hs', x: 18, y: 12, w: 6, h: 12, minW: 6, minH: 5 },
            ],
        },
    },
    {
        name: 'AI 副駕',
        desc: 'AI Agent 常駐側欄，看盤帳務通知一條龍',
        workspace: {
            blocks: [
                { id: 'assistant-ai', type: 'assistant', pin: null },
                { id: 'chart-ai', type: 'chart', pin: null },
                { id: 'dock-ai', type: 'dock', pin: null },
                { id: 'watch-ai', type: 'watchlist', pin: null },
                { id: 'notices-ai', type: 'notices', pin: null },
            ],
            layout: [
                { i: 'assistant-ai', x: 0, y: 0, w: 7, h: 24, minW: 5, minH: 9 },
                { i: 'chart-ai', x: 7, y: 0, w: 11, h: 14, minW: 6, minH: 7 },
                { i: 'dock-ai', x: 7, y: 14, w: 11, h: 10, minW: 6, minH: 5 },
                { i: 'watch-ai', x: 18, y: 0, w: 6, h: 14, minW: 3, minH: 6 },
                { i: 'notices-ai', x: 18, y: 14, w: 6, h: 10, minW: 4, minH: 6 },
            ],
        },
    },
    {
        name: '分析研究',
        desc: 'K線+分價量+籌碼+損益+回放',
        workspace: {
            blocks: [
                { id: 'chart-an', type: 'chart', pin: null },
                { id: 'vol-an', type: 'volprofile', pin: null },
                { id: 'chips-an', type: 'chips', pin: null },
                { id: 'pnl-an', type: 'pnl', pin: null },
                { id: 'replay-an', type: 'replay', pin: null },
            ],
            layout: [
                { i: 'chart-an', x: 0, y: 0, w: 12, h: 13, minW: 6, minH: 7 },
                { i: 'vol-an', x: 12, y: 0, w: 6, h: 13, minW: 4, minH: 6 },
                { i: 'chips-an', x: 18, y: 0, w: 6, h: 13, minW: 4, minH: 5 },
                { i: 'pnl-an', x: 0, y: 13, w: 12, h: 11, minW: 6, minH: 6 },
                { i: 'replay-an', x: 12, y: 13, w: 12, h: 11, minW: 6, minH: 6 },
            ],
        },
    },
];

const WS_KEY = 'sj-pro-workspace-v2';
const PROFILES_KEY = 'sj-pro-profiles-v1';

function validWorkspace(w: unknown): w is Workspace {
    if (!w || typeof w !== 'object') return false;
    const ws = w as Workspace;
    if (!Array.isArray(ws.blocks) || !Array.isArray(ws.layout)) return false;
    if (ws.blocks.length === 0) return false;
    const ids = new Set(ws.blocks.map((b) => b.id));
    return ws.layout.every((l) => ids.has(l.i));
}

export function loadWorkspace(): Workspace {
    try {
        const raw = localStorage.getItem(WS_KEY);
        if (raw) {
            const w = JSON.parse(raw);
            if (validWorkspace(w)) return w;
        }
    } catch {
        // fall through
    }
    return structuredClone(DEFAULT_WORKSPACE);
}

export function saveWorkspace(w: Workspace) {
    localStorage.setItem(WS_KEY, JSON.stringify(w));
}

export function loadProfiles(): Profile[] {
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                return (arr as Profile[]).filter(
                    (p) =>
                        typeof p.name === 'string' &&
                        validWorkspace(p.workspace),
                );
            }
        }
    } catch {
        // fall through
    }
    return [];
}

export function saveProfiles(profiles: Profile[]) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

let blockCounter = Date.now() % 100000;
export function newBlockId(type: BlockType): string {
    blockCounter += 1;
    return `${type}-${blockCounter}`;
}
