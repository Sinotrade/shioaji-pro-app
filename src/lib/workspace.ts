// src/lib/workspace.ts — dynamic panel blocks + grid layout + named profiles

import type { LayoutItem } from 'react-grid-layout';
import { isLinkGroup, LINK_GROUPS, type LinkGroupId } from './flash-link';
import { decodeQuoteBoardFields, encodeQuoteBoardFields } from './quote-board-fields';

// 版面座標底座（儲存基準）：288 欄 = 傳統 24 欄 × 12。
// - 撰寫/舊存檔仍是 24 欄語意，載入時 ×12 無損升階
// - App 渲染時依視窗寬選密度 k∈{1,2,3,4}（cols = 24k，每欄 ~40–55px，
//   超寬螢幕的欄寬不再等比放大、拖拉步進更細）
// - 12 可被 1/2/3/4/6 整除 → 任一密度的回存 ×(12/k) 都是整數（無損）；
//   只有「跨密度」（換螢幕/跨機）才會有一次 ≤ 半欄的舍入
// layout-thumb 以 GRID_COLS 做等比縮放，與儲存基準一致即可。
export const GRID_COLS = 288;
export const GRID_LEGACY_COLS = 24;
export const GRID_LEGACY_SCALE = GRID_COLS / GRID_LEGACY_COLS; // 12

function upscaleLayout(layout: LayoutItem[]): LayoutItem[] {
    return layout.map((l) => ({
        ...l,
        x: l.x * GRID_LEGACY_SCALE,
        w: l.w * GRID_LEGACY_SCALE,
        ...(l.minW !== undefined ? { minW: l.minW * GRID_LEGACY_SCALE } : {}),
        ...(l.maxW !== undefined ? { maxW: l.maxW * GRID_LEGACY_SCALE } : {}),
    }));
}

export function upscaleLegacyWorkspace(w: Workspace): Workspace {
    return { ...w, layout: upscaleLayout(w.layout) };
}

// 288 欄儲存值 → 密度 k 的渲染座標。邊緣錨定舍入：x 與右緣各走同一個
// 單調映射、w 取差值 — 相鄰面板共用的邊緣舍入後仍共用，絕不重疊。
// （x/w 獨立舍入時，跨密度開啟可能產生 1 欄重疊 → RGL compaction 會把
// 面板往下推一列並被 mount 觸發的 onLayoutChange 回存。）
export function toRenderGeom(
    l: { x: number; w: number },
    density: number,
): { x: number; w: number } {
    const f = density / GRID_LEGACY_SCALE;
    const x = Math.round(l.x * f);
    const right = Math.round((l.x + l.w) * f);
    return { x, w: Math.max(1, right - x) };
}

export type BlockType =
    | 'watchlist'
    | 'movers'
    | 'dock'
    | 'chart'
    | 'intraday'
    | 'intradaywall'
    | 'depth'
    | 'ticket'
    | 'tape'
    | 'flash'
    | 'oddspread'
    | 'pnl'
    | 'chips'
    | 'company'
    | 'volprofile'
    | 'optchain'
    | 'stockfutures'
    | 'warrants'
    | 'replay'
    | 'depthmap'
    | 'combo'
    | 'combolist'
    | 'notices'
    | 'debug'
    | 'grid'
    | 'conditional'
    | 'heatmap'
    | 'chainmap'
    | 'holdingmap'
    | 'pulse'
    | 'signals'
    | 'optpnl'
    | 'backtest'
    | 'assistant';

// 'industries' 區塊已移出市場脈動（產業地圖歸產業全景面板）— 舊存檔的
// 'industries' 值由面板端讀時過濾、權重按比例併入其餘區塊
export type PulseSection = 'stocks' | 'flow';
export type PulseSectionWeights = Record<PulseSection, number>;
export type PulseIndexCode = 'IX0001' | 'IX0043';

export interface Block {
    id: string;
    // Panel-local indicator state travels with saved workspace profiles.
    indicatorState?: import('./indicator-instance-service').IndicatorPanelState;
    type: BlockType;
    // null → follows the globally selected symbol; string → pinned to a code
    pin: string | null;
    // 閃電下單面板自己的帳戶（每市場一組 key）— 沒有 key 的市場跟隨主畫面
    flashAccounts?: import('./flash-account').FlashAccountKeys;
    // 閃電下單面板自己的單位（整股／盤中零股），換股票不變；缺省 = 設為預設的單位
    flashLot?: import('./flash-account').FlashLot;
    // 閃電下單「記住數量」：張／股／口各一個數量；false = 使用者關閉，缺省 = 預設開啟
    flashQty?: import('./flash-qty-memory').FlashQtySetting;
    // 閃電下單面板自己的信用條件（整股：現股／融資／融券／借券／借券豁免＋現股當沖先賣），換股票不變；缺省 = 現股
    flashCredit?: import('./flash-account').FlashCredit;
    // 閃電下單面板自己的委託條件（效期／期貨倉別／範圍市價），換商品不變；缺省 = ROD、自動、市價
    flashOrder?: import('./flash-account').FlashOrderOpts;
    // 連動群組 A／B／C（pin 為 null 時才有效）：群組成員共用 Workspace.linkGroups 的代碼
    linkGroup?: import('./flash-link').LinkGroupId;
    // 閃電下單的對應商品（照選取／現股／個股期＋規格月份＋價差對照）；缺省 = 照選取
    flashLink?: import('./flash-link').FlashLink;
    // Market-pulse presets can open multiple panels on distinct views.
    pulseVisualization?: 'distribution' | 'flow';
    pulseSections?: PulseSection[];
    pulseWeights?: Partial<PulseSectionWeights>;
    pulseIndex?: PulseIndexCode;
    // 當日走勢牆的面板設定（清單/排列）— 跟版面一起持久化
    wallList?: string;
    wallCols?: number;
    wallRows?: number;
    // 時段選擇（issue #73）— K 線全盤/僅日盤、當日走勢自動/日盤/夜盤，
    // 跟版面一起持久化；缺省 = 全盤 / 自動
    chartSession?: 'all' | 'day';
    intradaySession?: 'auto' | 'day' | 'night';
    // K 線週期（#331）— 跟版面一起持久化；缺省 = 5m
    chartInterval?: ChartInterval;
    // K 線圖下單設定（#204，每市場一組）— 跟版面一起持久化
    chartOrder?: import('./chart-order-settings').ChartOrderPanelState;
    // K 棒讀值列（開高低收，#240）— false = 隱藏；缺省 = 顯示
    chartOhlc?: boolean;
    // 可見範圍最高／最低標記（#240）— false = 隱藏；缺省 = 顯示
    chartHighLow?: boolean;
    // 報價欄自訂欄位（顯示哪些格子、區塊與格子的順序；指數與個股各一組）— 缺省 = 預設
    quoteBoard?: import('./quote-board-fields').QuoteBoardFieldsConfig;
    // 產業鏈資金流向的視圖／類型、持股族群的呈現／分組（內建版面可指定）—
    // 缺省 = 沿用上次在任一同類面板的選擇
    chainView?: ChainView;
    chainKind?: ChainKind;
    holdingForm?: HoldingForm;
    holdingGrouping?: import('./portfolio-sector').Grouping;
}

export const CHAIN_VIEWS = ['rank', 'rotation', 'heat'] as const;
export type ChainView = (typeof CHAIN_VIEWS)[number];
export const CHAIN_KINDS = ['all', 'chain', 'theme'] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];
export const HOLDING_FORMS = ['bubble', 'lanes'] as const;
export type HoldingForm = (typeof HOLDING_FORMS)[number];
export const HOLDING_GROUPINGS = ['sector', 'chain', 'theme'] as const satisfies readonly import('./portfolio-sector').Grouping[];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** 面板自己的設定值（舊存檔可能是任意值）：合法才採用，否則用 fallback */
export function panelPref<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return oneOf(value, allowed) ?? fallback;
}

// K 線圖可選週期（工具列順序）。版面只存標籤，分鐘數與載入天數在 candle-chart
export const CHART_INTERVALS = ['1m', '5m', '15m', '60m', '1D'] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export const DEFAULT_CHART_INTERVAL: ChartInterval = '5m';
export function isChartInterval(v: unknown): v is ChartInterval {
    return (CHART_INTERVALS as readonly unknown[]).includes(v);
}

export interface Workspace {
    blocks: Block[];
    layout: LayoutItem[];
    // 連動群組各自的代碼（跟版面一起存）
    linkGroups?: Partial<Record<LinkGroupId, string>>;
}

// ---- 連動群組 ----
export type LinkMode = 'main' | 'pin' | LinkGroupId;

// 連動群組這版只給閃電下單（其他面板的送單閘門不含群組身分）
export function blockLinkMode(block: Block): LinkMode {
    if (block.pin) return 'pin';
    return block.type === 'flash' && isLinkGroup(block.linkGroup) ? block.linkGroup : 'main';
}

/** 面板的來源代碼：鎖定代碼、群組代碼；null = 跟自選選取 */
export function blockSourceCode(block: Block, w: Workspace): string | null {
    const mode = blockLinkMode(block);
    if (mode === 'pin') return block.pin;
    if (mode === 'main') return null;
    return w.linkGroups?.[mode] ?? null;
}

/** 切換連動方式。加入沒人用的群組時以面板目前的代碼當群組代碼 */
export function withLinkMode(w: Workspace, id: string, mode: LinkMode, currentCode: string | null): Workspace {
    if (mode === 'pin' && !currentCode) return w;
    if (isLinkGroup(mode) && w.blocks.find((b) => b.id === id)?.type !== 'flash') return w;
    const linkGroups = { ...w.linkGroups };
    const unused = isLinkGroup(mode) && !w.blocks.some((b) => b.id !== id && blockLinkMode(b) === mode);
    if (isLinkGroup(mode) && currentCode && (!linkGroups[mode] || unused)) linkGroups[mode] = currentCode;
    return {
        ...w,
        linkGroups,
        blocks: w.blocks.map((b) => {
            if (b.id !== id) return b;
            const { linkGroup: _g, ...rest } = b;
            return isLinkGroup(mode) ? { ...rest, pin: null, linkGroup: mode } : { ...rest, pin: mode === 'pin' ? currentCode : null };
        }),
    };
}

/** 群組換代碼：所有成員同一次一起換 */
export function withGroupCode(w: Workspace, group: LinkGroupId, code: string): Workspace {
    return { ...w, linkGroups: { ...w.linkGroups, [group]: code } };
}

export function linkGroupSummary(w: Workspace): { id: LinkGroupId; code: string | null; count: number }[] {
    return LINK_GROUPS.map((id) => ({
        id,
        code: w.linkGroups?.[id] ?? null,
        count: w.blocks.filter((b) => blockLinkMode(b) === id).length,
    }));
}

export type SessionConfigPatch = Partial<
    Pick<
        Block,
        | 'chartSession'
        | 'chartInterval'
        | 'intradaySession'
        | 'chartOrder'
        | 'chartOhlc'
        | 'chartHighLow'
        | 'quoteBoard'
        | 'chainView'
        | 'chainKind'
        | 'holdingForm'
        | 'holdingGrouping'
    >
>;

// 開彈出視窗時把面板的時段選擇與 K 線週期帶進 URL（session=…、interval=…）
export function popoutSessionParam(block: Block): Record<string, string> {
    const session =
        block.type === 'chart'
            ? block.chartSession
            : block.type === 'intraday'
              ? block.intradaySession
              : undefined;
    const interval = block.type === 'chart' ? block.chartInterval : undefined;
    const qb = block.type === 'chart' ? encodeQuoteBoardFields(block.quoteBoard) : undefined;
    const form = block.type === 'holdingmap' ? block.holdingForm : undefined;
    const grouping = block.type === 'holdingmap' ? block.holdingGrouping : undefined;
    return {
        ...(session ? { session } : {}),
        ...(interval ? { interval } : {}),
        ...(qb ? { qb } : {}),
        ...(form ? { form } : {}),
        ...(grouping ? { grouping } : {}),
    };
}

// 彈出視窗讀回 URL 的 session — 依面板類型只接受已知值
export function popoutSessionFromQuery(q: URLSearchParams): SessionConfigPatch {
    const v = q.get('session');
    return {
        chartSession: v === 'all' || v === 'day' ? v : undefined,
        intradaySession:
            v === 'auto' || v === 'day' || v === 'night' ? v : undefined,
        chartInterval: isChartInterval(q.get('interval'))
            ? (q.get('interval') as ChartInterval)
            : undefined,
        quoteBoard: decodeQuoteBoardFields(q.get('qb')),
        holdingForm: oneOf(q.get('form'), HOLDING_FORMS),
        holdingGrouping: oneOf(q.get('grouping'), HOLDING_GROUPINGS),
    };
}

// 面板時段選擇寫回 workspace（跟版面/版面庫一起存）
export function withBlockSessionConfig(
    w: Workspace,
    id: string,
    patch: SessionConfigPatch,
): Workspace {
    return {
        ...w,
        blocks: w.blocks.map((block) =>
            block.id === id ? { ...block, ...patch } : block,
        ),
    };
}

export interface Profile {
    name: string;
    workspace: Workspace;
    // lucide icon name for the layout-library card badge; older saved
    // profiles have no icon — absent means no badge (backward compatible)
    icon?: string;
}

export type PanelCategory =
    | 'market'
    | 'trading'
    | 'account'
    | 'derivatives'
    | 'tools';

export const PANEL_CATEGORIES: { key: PanelCategory; label: string }[] = [
    { key: 'market', label: '行情' },
    { key: 'trading', label: '交易' },
    { key: 'account', label: '帳務分析' },
    { key: 'derivatives', label: '選擇權/衍生品' },
    { key: 'tools', label: '工具' },
];

export const BLOCK_META: Record<
    BlockType,
    {
        label: string;
        description: string;
        category: PanelCategory;
        pinnable: boolean;
        singleton: boolean;
        defaultSize: { w: number; h: number; minW: number; minH: number };
    }
> = {
    watchlist: {
        label: '自選清單',
        description: '自選商品即時報價清單',
        category: 'market',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 14, minW: 3, minH: 6 },
    },
    movers: {
        label: '排行榜',
        description: '漲跌幅、量與額排行掃描',
        category: 'market',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 4, h: 11, minW: 3, minH: 5 },
    },
    dock: {
        label: '持倉/委託/帳務',
        description: '持倉、委託與帳務總覽',
        category: 'account',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 15, h: 9, minW: 6, minH: 5 },
    },
    chart: {
        label: 'K 線圖',
        description: '多週期 K 線與技術指標',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 12, minW: 6, minH: 7 },
    },
    intraday: {
        label: '當日走勢',
        description: '分時走勢、均價線與量能',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 8, h: 10, minW: 4, minH: 5 },
    },
    intradaywall: {
        label: '當日走勢牆',
        description: '多檔分時走勢一次看，綁自選清單、可排列與翻頁',
        category: 'market',
        pinnable: false,
        singleton: false,
        defaultSize: { w: 12, h: 14, minW: 6, minH: 6 },
    },
    depth: {
        label: '五檔',
        description: '五檔報價與內外盤',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 7 },
    },
    ticket: {
        label: '下單面板',
        description: '標準委託下單',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 11, minW: 4, minH: 10 },
    },
    tape: {
        label: '成交明細',
        description: '逐筆成交明細',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 4, h: 8, minW: 3, minH: 4 },
    },
    flash: {
        label: '閃電下單',
        description: '價格梯快速點價下單',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 14, minW: 4, minH: 8 },
    },
    oddspread: {
        label: '整零價差',
        description: '整股與盤中零股價差試算、兩市場五檔對照與兩腳送單',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 6, h: 16, minW: 5, minH: 10 },
    },
    pnl: {
        label: '損益分析',
        description: '已實現與未實現損益',
        category: 'account',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 8, minW: 6, minH: 6 },
    },
    chips: {
        label: '籌碼資訊',
        description: '法人買賣超與籌碼動向',
        category: 'account',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 8, minW: 4, minH: 5 },
    },
    company: {
        label: '公司資料',
        description: '基本面、產業鏈位置、題材、上下游與財報，跟隨所選商品',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 6, h: 14, minW: 4, minH: 7 },
    },
    volprofile: {
        label: '分價量表',
        description: '各價位累計成交量分布',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 12, minW: 4, minH: 6 },
    },
    optchain: {
        label: '選擇權 T 字',
        description: '選擇權 T 字報價與下單',
        category: 'derivatives',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 10, h: 14, minW: 8, minH: 8 },
    },
    stockfutures: {
        label: '個股期選擇器',
        description: '個股期貨標的瀏覽',
        category: 'derivatives',
        // 標準 chrome 連動/釘選：不釘＝跟隨自選選擇切標的，釘＝固定
        pinnable: true,
        singleton: true,
        defaultSize: { w: 9, h: 12, minW: 7, minH: 8 },
    },
    warrants: {
        label: '權證篩選器',
        description: '權證條件篩選',
        category: 'derivatives',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 12, h: 14, minW: 9, minH: 9 },
    },
    replay: {
        label: '行情回放',
        description: '歷史行情逐筆回放',
        category: 'market',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 10, h: 10, minW: 6, minH: 6 },
    },
    depthmap: {
        label: '委託簿熱圖',
        description: '掛單量隨時間熱力分布',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 8, h: 9, minW: 5, minH: 6 },
    },
    combo: {
        label: '組合單',
        description: '選擇權組合單下單',
        category: 'derivatives',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 14, minW: 5, minH: 10 },
    },
    combolist: {
        label: '組合商品',
        description: '交易所組合商品列表與報價，點列帶入組合單',
        category: 'derivatives',
        // 標準 chrome 連動/釘選：不釘＝跟隨自選選擇切家族，釘＝固定
        pinnable: true,
        singleton: true,
        defaultSize: { w: 6, h: 12, minW: 4, minH: 8 },
    },
    notices: {
        label: '通知中心',
        description: '警示與系統通知',
        category: 'tools',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 10, minW: 4, minH: 6 },
    },
    debug: {
        label: '診斷 Debug',
        description: 'API 用量、查詢壓力、異常與連線診斷',
        category: 'tools',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 6, h: 11, minW: 4, minH: 7 },
    },
    grid: {
        label: '鋪單',
        description: '一次掛出階梯限價單',
        category: 'trading',
        pinnable: true,
        singleton: false,
        defaultSize: { w: 5, h: 13, minW: 4, minH: 10 },
    },
    conditional: {
        label: '條件單管理',
        description: '觸價單、二擇一、括號單集中查看、修改、暫停與取消',
        category: 'trading',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 14, h: 10, minW: 4, minH: 6 },
    },
    heatmap: {
        label: '產業全景',
        description: '產業資金與強弱地圖，點產業下鑽主力貢獻',
        category: 'market',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 11, minW: 5, minH: 6 },
    },
    chainmap: {
        label: '產業鏈資金流向',
        description: '產業鏈與題材的即時資金流向：族群淨流入排行、輪動與熱力，上中下游流向與領頭股',
        category: 'market',
        pinnable: false,
        singleton: false,
        defaultSize: { w: 14, h: 14, minW: 6, minH: 8 },
    },
    holdingmap: {
        label: '持股族群',
        description: '我的持股依族群、產業鏈或題材分組，對照各分組的即時資金流向與今日損益',
        category: 'account',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 10, h: 14, minW: 6, minH: 8 },
    },
    pulse: {
        label: '市場脈動',
        description: '指數自算與成分股貢獻',
        category: 'market',
        pinnable: false,
        singleton: false,
        defaultSize: { w: 10, h: 12, minW: 7, minH: 7 },
    },
    signals: {
        label: '即時訊號',
        description: '盤中異動訊號流',
        category: 'market',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 12, minW: 5, minH: 7 },
    },
    optpnl: {
        label: '選擇權損益圖',
        description: '選擇權部位到期損益',
        category: 'derivatives',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 8, h: 13, minW: 6, minH: 9 },
    },
    backtest: {
        label: '策略回測',
        description: '策略歷史回測',
        category: 'tools',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 12, h: 14, minW: 8, minH: 8 },
    },
    assistant: {
        label: 'AI Agent',
        description: 'AI 交易助理',
        category: 'tools',
        pinnable: false,
        singleton: true,
        defaultSize: { w: 7, h: 14, minW: 5, minH: 9 },
    },
};

// 預設/內建版面一律以「傳統 24 欄」撰寫（好讀好改），匯出前統一
// 升階到 288 基準 — 見檔頭說明
const RAW_DEFAULT_WORKSPACE: Workspace = {
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

export const DEFAULT_WORKSPACE: Workspace = upscaleLegacyWorkspace(
    RAW_DEFAULT_WORKSPACE,
);

// 內建版面格子：最小尺寸取面板庫預設（24 欄撰寫）
function presetCell(i: string, type: BlockType, x: number, y: number, w: number, h: number): LayoutItem {
    const { minW, minH } = BLOCK_META[type].defaultSize;
    return { i, x, y, w, h, minW, minH };
}

// built-in layout presets for common trading workflows（24 欄撰寫，
// 檔尾統一升階匯出）
const RAW_LAYOUT_PRESETS: { name: string; desc: string; workspace: Workspace }[] = [
    {
        name: '標準看盤',
        desc: '自選+排行 / K線+持倉 / 五檔+下單+明細',
        workspace: RAW_DEFAULT_WORKSPACE,
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
        name: '衍生商品探索',
        desc: '個股期與權證篩選、連動圖表、下單與自選',
        workspace: {
            blocks: [
                { id: 'stockfut-dx', type: 'stockfutures', pin: null },
                { id: 'warrant-dx', type: 'warrants', pin: null },
                { id: 'chart-dx', type: 'chart', pin: null },
                { id: 'ticket-dx', type: 'ticket', pin: null },
                { id: 'watch-dx', type: 'watchlist', pin: null },
            ],
            layout: [
                { i: 'stockfut-dx', x: 0, y: 0, w: 9, h: 14, minW: 7, minH: 8 },
                { i: 'warrant-dx', x: 9, y: 0, w: 15, h: 14, minW: 9, minH: 9 },
                { i: 'chart-dx', x: 0, y: 14, w: 12, h: 12, minW: 6, minH: 7 },
                { i: 'ticket-dx', x: 12, y: 14, w: 5, h: 12, minW: 4, minH: 10 },
                { i: 'watch-dx', x: 17, y: 14, w: 7, h: 12, minW: 3, minH: 6 },
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
        name: '市場脈動',
        desc: '上市＋上櫃並排，分別觀察成分股貢獻與貢獻傳導',
        workspace: {
            blocks: [
                {
                    id: 'pulse-tse',
                    type: 'pulse',
                    pin: null,
                    pulseIndex: 'IX0001',
                    pulseSections: ['flow'],
                    pulseWeights: {
                        stocks: 41,
                        flow: 59,
                    },
                },
                {
                    id: 'pulse-otc',
                    type: 'pulse',
                    pin: null,
                    pulseIndex: 'IX0043',
                    pulseSections: ['flow'],
                    pulseWeights: {
                        stocks: 41,
                        flow: 59,
                    },
                },
            ],
            layout: [
                {
                    i: 'pulse-tse',
                    x: 0,
                    y: 0,
                    w: 12,
                    h: 20,
                    minW: 7,
                    minH: 7,
                },
                {
                    i: 'pulse-otc',
                    x: 12,
                    y: 0,
                    w: 12,
                    h: 20,
                    minW: 7,
                    minH: 7,
                },
            ],
        },
    },
    {
        name: '盤中雷達',
        desc: '即時訊號連動 K 線、五檔與成交明細，各面板可個別鎖定',
        workspace: {
            blocks: [
                { id: 'signals-sr', type: 'signals', pin: null },
                { id: 'chart-sr', type: 'chart', pin: null },
                { id: 'depth-sr', type: 'depth', pin: null },
                { id: 'tape-sr', type: 'tape', pin: null },
            ],
            layout: [
                {
                    i: 'signals-sr',
                    x: 0,
                    y: 0,
                    w: 6,
                    h: 24,
                    minW: 5,
                    minH: 7,
                },
                {
                    i: 'chart-sr',
                    x: 6,
                    y: 0,
                    w: 13,
                    h: 24,
                    minW: 6,
                    minH: 7,
                },
                {
                    i: 'depth-sr',
                    x: 19,
                    y: 0,
                    w: 5,
                    h: 10,
                    minW: 4,
                    minH: 7,
                },
                {
                    i: 'tape-sr',
                    x: 19,
                    y: 10,
                    w: 5,
                    h: 14,
                    minW: 3,
                    minH: 4,
                },
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
    // ---- 新面板組合（條件單管理、整零價差、組合單、走勢牆、委託簿熱圖…）----
    {
        name: '期貨當沖',
        desc: '台指期 K 線＋閃電＋委託簿熱圖＋明細，條件單與持倉在下方',
        workspace: {
            blocks: [
                { id: 'chart-fd', type: 'chart', pin: 'TXFR1' },
                { id: 'flash-fd', type: 'flash', pin: 'TXFR1' },
                { id: 'depthmap-fd', type: 'depthmap', pin: 'TXFR1' },
                { id: 'tape-fd', type: 'tape', pin: 'TXFR1' },
                { id: 'cond-fd', type: 'conditional', pin: null },
                { id: 'dock-fd', type: 'dock', pin: null },
            ],
            layout: [
                presetCell('chart-fd', 'chart', 0, 0, 12, 15),
                presetCell('flash-fd', 'flash', 12, 0, 5, 24),
                presetCell('depthmap-fd', 'depthmap', 17, 0, 7, 12),
                presetCell('tape-fd', 'tape', 17, 12, 7, 12),
                presetCell('cond-fd', 'conditional', 0, 15, 6, 9),
                presetCell('dock-fd', 'dock', 6, 15, 6, 9),
            ],
        },
    },
    {
        name: '期現對照',
        desc: '點一檔股票，現股與個股期兩條閃電梯並排，含價差對照',
        workspace: {
            blocks: [
                { id: 'watch-sf', type: 'watchlist', pin: null },
                { id: 'stockfut-sf', type: 'stockfutures', pin: null },
                { id: 'chart-sf', type: 'chart', pin: null },
                {
                    id: 'flash-sfs',
                    type: 'flash',
                    pin: null,
                    flashLink: { kind: 'stock', spec: 'std', month: 'near', ref: true },
                },
                {
                    id: 'flash-sff',
                    type: 'flash',
                    pin: null,
                    flashLink: { kind: 'future', spec: 'std', month: 'near', ref: true },
                },
                { id: 'dock-sf', type: 'dock', pin: null },
            ],
            layout: [
                presetCell('watch-sf', 'watchlist', 0, 0, 4, 12),
                presetCell('stockfut-sf', 'stockfutures', 0, 12, 8, 12),
                presetCell('chart-sf', 'chart', 4, 0, 10, 12),
                presetCell('flash-sfs', 'flash', 14, 0, 5, 24),
                presetCell('flash-sff', 'flash', 19, 0, 5, 24),
                presetCell('dock-sf', 'dock', 8, 12, 6, 12),
            ],
        },
    },
    {
        name: '零股存股',
        desc: '自選＋日 K＋籌碼，整零價差試算與兩腳送單',
        workspace: {
            blocks: [
                { id: 'watch-od', type: 'watchlist', pin: null },
                { id: 'chart-od', type: 'chart', pin: null },
                { id: 'chips-od', type: 'chips', pin: null },
                { id: 'dock-od', type: 'dock', pin: null },
                { id: 'oddspread-od', type: 'oddspread', pin: null },
            ],
            layout: [
                presetCell('watch-od', 'watchlist', 0, 0, 5, 24),
                presetCell('chart-od', 'chart', 5, 0, 12, 14),
                presetCell('chips-od', 'chips', 5, 14, 5, 10),
                presetCell('dock-od', 'dock', 10, 14, 7, 10),
                presetCell('oddspread-od', 'oddspread', 17, 0, 7, 24),
            ],
        },
    },
    {
        name: '條件單監控',
        desc: '條件單管理加寬置底，K 線＋閃電觸價欄＋通知同屏盯單',
        workspace: {
            blocks: [
                { id: 'chart-cm', type: 'chart', pin: null },
                { id: 'flash-cm', type: 'flash', pin: null },
                { id: 'notices-cm', type: 'notices', pin: null },
                { id: 'cond-cm', type: 'conditional', pin: null },
                { id: 'dock-cm', type: 'dock', pin: null },
            ],
            layout: [
                presetCell('chart-cm', 'chart', 0, 0, 13, 14),
                presetCell('flash-cm', 'flash', 13, 0, 5, 14),
                presetCell('notices-cm', 'notices', 18, 0, 6, 14),
                presetCell('cond-cm', 'conditional', 0, 14, 14, 10),
                presetCell('dock-cm', 'dock', 14, 14, 10, 10),
            ],
        },
    },
    {
        name: '選擇權組合',
        desc: 'T 字＋組合單＋損益圖，台指期 K 線與持倉在下方',
        workspace: {
            blocks: [
                { id: 'opt-oc', type: 'optchain', pin: null },
                { id: 'combo-oc', type: 'combo', pin: null },
                { id: 'optpnl-oc', type: 'optpnl', pin: null },
                { id: 'chart-oc', type: 'chart', pin: 'TXFR1' },
                { id: 'dock-oc', type: 'dock', pin: null },
            ],
            layout: [
                presetCell('opt-oc', 'optchain', 0, 0, 10, 14),
                presetCell('combo-oc', 'combo', 10, 0, 6, 14),
                presetCell('optpnl-oc', 'optpnl', 16, 0, 8, 14),
                presetCell('chart-oc', 'chart', 0, 14, 10, 10),
                presetCell('dock-oc', 'dock', 10, 14, 14, 10),
            ],
        },
    },
    {
        name: '族群資金',
        desc: '產業鏈資金流向＋持股族群並排，看資金往哪走、自己的持股站在哪邊',
        workspace: {
            blocks: [
                { id: 'chain-sf', type: 'chainmap', pin: null },
                { id: 'holding-sf', type: 'holdingmap', pin: null },
                { id: 'watch-sf', type: 'watchlist', pin: null },
                { id: 'chart-sf', type: 'chart', pin: null },
                { id: 'dock-sf', type: 'dock', pin: null },
            ],
            layout: [
                presetCell('chain-sf', 'chainmap', 0, 0, 14, 14),
                presetCell('holding-sf', 'holdingmap', 14, 0, 10, 14),
                presetCell('watch-sf', 'watchlist', 0, 14, 6, 10),
                presetCell('chart-sf', 'chart', 6, 14, 10, 10),
                presetCell('dock-sf', 'dock', 16, 14, 8, 10),
            ],
        },
    },
    {
        name: '盤勢總覽',
        desc: '大盤貢獻＋產業全景＋自選走勢牆＋排行，開盤先看全局',
        workspace: {
            blocks: [
                { id: 'pulse-ov', type: 'pulse', pin: null, pulseIndex: 'IX0001' },
                { id: 'heatmap-ov', type: 'heatmap', pin: null },
                { id: 'wall-ov', type: 'intradaywall', pin: null },
                { id: 'movers-ov', type: 'movers', pin: null },
            ],
            layout: [
                presetCell('pulse-ov', 'pulse', 0, 0, 12, 12),
                presetCell('heatmap-ov', 'heatmap', 12, 0, 12, 12),
                presetCell('wall-ov', 'intradaywall', 0, 12, 16, 12),
                presetCell('movers-ov', 'movers', 16, 12, 8, 12),
            ],
        },
    },
    // ---- 產業資金面板組合（產業全景、產業鏈資金流向、持股族群、公司資料）----
    {
        name: '產業掃描',
        desc: '產業全景＋族群資金排行找強勢方向，點個股帶出 K 線、報價與公司資料',
        workspace: {
            blocks: [
                { id: 'heatmap-ms', type: 'heatmap', pin: null },
                { id: 'chain-ms', type: 'chainmap', pin: null, chainView: 'rank', chainKind: 'all' },
                { id: 'watch-ms', type: 'watchlist', pin: null },
                { id: 'chart-ms', type: 'chart', pin: null },
                { id: 'company-ms', type: 'company', pin: null },
            ],
            layout: [
                presetCell('heatmap-ms', 'heatmap', 0, 0, 13, 13),
                presetCell('chain-ms', 'chainmap', 13, 0, 11, 13),
                presetCell('watch-ms', 'watchlist', 0, 13, 5, 11),
                presetCell('chart-ms', 'chart', 5, 13, 12, 11),
                presetCell('company-ms', 'company', 17, 13, 7, 11),
            ],
        },
    },
    {
        name: '持股健檢',
        desc: '持股依族群分組對照產業全景，持倉、日 K 與公司資料同屏檢視',
        workspace: {
            blocks: [
                { id: 'holding-hc', type: 'holdingmap', pin: null, holdingForm: 'bubble', holdingGrouping: 'sector' },
                { id: 'heatmap-hc', type: 'heatmap', pin: null },
                { id: 'company-hc', type: 'company', pin: null },
                { id: 'dock-hc', type: 'dock', pin: null },
                { id: 'chart-hc', type: 'chart', pin: null, chartInterval: '1D' },
            ],
            layout: [
                presetCell('holding-hc', 'holdingmap', 0, 0, 10, 14),
                presetCell('heatmap-hc', 'heatmap', 10, 0, 8, 14),
                presetCell('company-hc', 'company', 18, 0, 6, 24),
                presetCell('dock-hc', 'dock', 0, 14, 9, 10),
                presetCell('chart-hc', 'chart', 9, 14, 9, 10),
            ],
        },
    },
    {
        name: '族群輪動',
        desc: '輪動象限看資金轉進、熱力看成分股，訊號與 K 線找點、閃電進場',
        workspace: {
            blocks: [
                { id: 'rotation-rt', type: 'chainmap', pin: null, chainView: 'rotation', chainKind: 'all' },
                { id: 'heat-rt', type: 'chainmap', pin: null, chainView: 'heat', chainKind: 'all' },
                { id: 'signals-rt', type: 'signals', pin: null },
                { id: 'chart-rt', type: 'chart', pin: null },
                { id: 'flash-rt', type: 'flash', pin: null },
            ],
            layout: [
                presetCell('rotation-rt', 'chainmap', 0, 0, 10, 14),
                presetCell('heat-rt', 'chainmap', 10, 0, 9, 14),
                presetCell('signals-rt', 'signals', 0, 14, 6, 10),
                presetCell('chart-rt', 'chart', 6, 14, 13, 10),
                presetCell('flash-rt', 'flash', 19, 0, 5, 24),
            ],
        },
    },
    {
        name: '個股研究',
        desc: '日 K 與報價、公司基本面與供應鏈位置，對照所屬族群的資金熱力',
        workspace: {
            blocks: [
                { id: 'watch-sr', type: 'watchlist', pin: null },
                { id: 'chart-sr', type: 'chart', pin: null, chartInterval: '1D' },
                { id: 'chain-sr', type: 'chainmap', pin: null, chainView: 'heat', chainKind: 'all' },
                { id: 'company-sr', type: 'company', pin: null },
            ],
            layout: [
                presetCell('watch-sr', 'watchlist', 0, 0, 5, 24),
                presetCell('chart-sr', 'chart', 5, 0, 11, 14),
                presetCell('chain-sr', 'chainmap', 5, 14, 11, 10),
                presetCell('company-sr', 'company', 16, 0, 8, 24),
            ],
        },
    },
];

export const LAYOUT_PRESETS: { name: string; desc: string; workspace: Workspace }[] =
    RAW_LAYOUT_PRESETS.map((p) => ({
        ...p,
        workspace: upscaleLegacyWorkspace(p.workspace),
    }));

// v3 = 288 欄基準；v2（24 欄）保留原樣供舊版 app 降版使用，讀到時
// 無損升階。profiles 同理。
const WS_KEY = 'sj-pro-workspace-v3';
const WS_KEY_LEGACY = 'sj-pro-workspace-v2';
const PROFILES_KEY = 'sj-pro-profiles-v2';
const PROFILES_KEY_LEGACY = 'sj-pro-profiles-v1';

function validWorkspace(w: unknown): w is Workspace {
    if (!w || typeof w !== 'object') return false;
    const ws = w as Workspace;
    if (!Array.isArray(ws.blocks) || !Array.isArray(ws.layout)) return false;
    if (ws.blocks.length === 0) return false;
    const ids = new Set(ws.blocks.map((b) => b.id));
    return ws.layout.every((l) => ids.has(l.i));
}

export function loadWorkspace(): Workspace {
    // 兩個 key 各自 try — corrupt v3 不能擋掉 v2 fallback
    try {
        const raw = localStorage.getItem(WS_KEY);
        if (raw) {
            const w = JSON.parse(raw);
            if (validWorkspace(w)) return w;
        }
    } catch {
        // fall through to legacy
    }
    try {
        // 舊 24 欄存檔 → ×12 無損升階（v2 key 原樣保留，降版安全）
        const legacy = localStorage.getItem(WS_KEY_LEGACY);
        if (legacy) {
            const w = JSON.parse(legacy);
            if (validWorkspace(w)) return upscaleLegacyWorkspace(w);
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
    const parse = (raw: string, legacy: boolean): Profile[] | null => {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return null;
        return (arr as Profile[])
            .filter(
                (p) =>
                    typeof p.name === 'string' && validWorkspace(p.workspace),
            )
            .map((p) => {
                const ws = legacy
                    ? upscaleLegacyWorkspace(p.workspace)
                    : p.workspace;
                return typeof p.icon === 'string' && p.icon
                    ? { ...p, workspace: ws }
                    : { name: p.name, workspace: ws };
            });
    };
    try {
        const raw = localStorage.getItem(PROFILES_KEY);
        if (raw) {
            const out = parse(raw, false);
            if (out) return out;
        }
    } catch {
        // fall through to legacy
    }
    try {
        const legacy = localStorage.getItem(PROFILES_KEY_LEGACY);
        if (legacy) {
            const out = parse(legacy, true);
            if (out) return out;
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

// Merge a partial update into one block (panel settings persisted with the
// workspace / layout library).
export function withBlockPatch(w: Workspace, id: string, patch: Partial<Block>): Workspace {
    return {
        ...w,
        blocks: w.blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    };
}
