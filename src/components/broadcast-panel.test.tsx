// src/components/broadcast-panel.test.tsx
//
// 版面改版後的回歸測試：控制項集中在同一張「播報控制」卡、診斷區改成預設收合。
// 這裡只驗「結構與接線」——點哪個控制會呼叫哪個 store、診斷預設是收合的；
// 播報規則本身（冷卻／去重／水位）在 src/lib/broadcast/*.test.ts 已完整覆蓋。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    settings: {
        enabled: true,
        quoteEnabled: true,
        dealEnabled: false,
        noticeEnabled: false,
        rate: 4,
        cooldownSec: 4,
        voiceUri: '',
    },
    setSettings: vi.fn(),
    urgent: vi.fn(),
    setCodes: vi.fn(),
    clearCodes: vi.fn(),
    syncSwitches: vi.fn(),
    dump: vi.fn(),
    download: vi.fn(),
    setTrace: vi.fn(),
    log: [{ at: Date.now(), code: 'TXFR1', text: '臺股期貨 近月 39343' }],
    voices: [
        { uri: 'v-hanhan', name: 'Microsoft Hanhan', lang: 'zh-TW' },
        { uri: 'v-yating', name: 'Microsoft Yating', lang: 'zh-TW' },
    ],
    debug: {
        switches: { enabled: true, quote: true, deal: false, notice: false },
        queue: { pending: 0, speakingText: '' },
        counters: {
            ticks: 157,
            decisions: 157,
            spoke: 4,
            generalQuotes: 9,
            blockedCooldown: 147,
            duplicateSuppressed: 5,
            droppedStale: 0,
            dealEvents: 0,
            noticeEvents: 0,
            testAnnouncements: 0,
        },
        targets: {
            TXFR1: {
                code: 'TXFR1',
                name: '臺股期貨 近月',
                contractResolved: true,
                contractError: undefined,
                subscribedTypes: ['tick'],
                tickCount: 157,
                lastPrice: 39343,
                lastStatus: '一般報價',
                lastSkipReason: 'cooldown',
                lastSpokeText: '臺股期貨 近月 39343',
                noQuote: false,
                noQuoteReason: undefined,
            },
        },
    },
}));

vi.mock('../lib/broadcast/broadcast-hub', () => ({
    broadcastUrgent: m.urgent,
    clearBroadcastQuoteCodes: m.clearCodes,
    setBroadcastQuoteCodes: m.setCodes,
    syncBroadcastDebugSwitches: m.syncSwitches,
    useBroadcastLog: () => m.log,
}));

vi.mock('../lib/broadcast/broadcast-debug', () => ({
    downloadBroadcastTrace: m.download,
    dumpBroadcastDebug: m.dump,
    getBroadcastTrace: () => [],
    isBroadcastTraceEnabled: () => false,
    setBroadcastTraceEnabled: m.setTrace,
    useBroadcastDebug: () => m.debug,
}));

vi.mock('../lib/broadcast/broadcast-settings', () => ({
    COOLDOWN_MAX: 60,
    COOLDOWN_MIN: 0,
    RATE_MAX: 20,
    RATE_MIN: -10,
    setBroadcastSettings: m.setSettings,
    useBroadcastSettings: () => m.settings,
}));

vi.mock('../lib/product-search', () => ({
    searchProducts: async () => [],
}));

// 必須回傳「同一個」engine 物件：面板的 effect 依賴 engine 身分，
// 每次回新物件會讓 probe 無限重跑（真實的 getTtsEngine() 是 singleton）。
vi.mock('../lib/tts', () => {
    const engine = {
        id: 'web-speech',
        available: true,
        probe: async () => ({ available: true }),
        speak: async () => undefined,
        cancelAll: () => undefined,
        speaking: false,
        listVoices: () => m.voices,
        subscribeVoices: (cb: (v: unknown) => void) => {
            cb(m.voices);
            return () => undefined;
        },
    };
    return { getTtsEngine: () => engine };
});

vi.mock('../lib/contracts-cache', () => ({
    useContract: () => ({ code: 'TXFR1', name: '臺股期貨 近月' }),
}));

vi.mock('../hooks/use-stream', () => ({
    useQuote: () => ({ tick: { close: 39343 } }),
}));

// React 19 的 act() 需要這個旗標；repo 內其他元件測試同樣在 beforeEach 設定。
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { BroadcastPanel } = await import('./broadcast-panel');

// react-test-renderer 的 toJSON() 把子節點放在 `children`（不是 props.children），
// 兩種都吃，才不會只取到空字串。
function textOf(node: unknown): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    const n = node as { children?: unknown; props?: { children?: unknown } };
    if (n.children !== undefined) return textOf(n.children);
    return n.props ? textOf(n.props.children) : '';
}

async function render(): Promise<ReactTestRenderer> {
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(
            createElement(BroadcastPanel, {
                codes: ['TXFR1'],
                onCodesChange: () => undefined,
            }),
        );
    });
    return r;
}

function at<T>(arr: readonly T[], index: number, what: string): T {
    const value = arr[index];
    if (value === undefined) throw new Error(`找不到 ${what}[${index}]`);
    return value;
}

function buttonByText(r: ReactTestRenderer, label: string) {
    const found = r.root.findAll(
        (n) => n.type === 'button' && textOf(n.props.children).includes(label),
    );
    const first = found[0];
    if (!first) throw new Error(`找不到按鈕：${label}`);
    return first;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.setSettings.mockClear();
    m.urgent.mockClear();
    m.dump.mockClear();
    m.download.mockClear();
    m.setTrace.mockClear();
    m.settings.enabled = true;
    m.settings.dealEnabled = false;
});

describe('廣播面板版面', () => {
    it('把可調控制集中在同一張「播報控制」卡，且事件類別以 chip 呈現', async () => {
        const r = await render();
        const body = textOf(r.toJSON());
        expect(body).toContain('播報控制');
        // 三個事件類別都在卡片裡（不再散落成獨立區塊）
        expect(body).toContain('行情狀態');
        expect(body).toContain('成交／委託');
        expect(body).toContain('通知／條件單');
        // 總開關仍在 header
        expect(body).toContain('播報中');
        r.unmount();
    });

    it('chip 反映目前設定，點擊會反轉該類事件', async () => {
        const r = await render();
        const quoteChip = buttonByText(r, '行情狀態');
        const dealChip = buttonByText(r, '成交／委託');
        expect(quoteChip.props['aria-pressed']).toBe(true);
        expect(dealChip.props['aria-pressed']).toBe(false);

        await act(async () => {
            dealChip.props.onClick();
        });
        expect(m.setSettings).toHaveBeenCalledWith({ dealEnabled: true });
        r.unmount();
    });

    it('語速與冷卻滑桿直接寫入設定', async () => {
        const r = await render();
        const sliders = r.root.findAll((n) => n.type === 'input' && n.props.type === 'range');
        expect(sliders).toHaveLength(2);

        await act(async () => {
            at(sliders, 0, '語速滑桿').props.onChange({ target: { value: '12' } });
        });
        expect(m.setSettings).toHaveBeenCalledWith({ rate: 12 });

        await act(async () => {
            at(sliders, 1, '冷卻滑桿').props.onChange({ target: { value: '7' } });
        });
        expect(m.setSettings).toHaveBeenCalledWith({ cooldownSec: 7 });
        r.unmount();
    });

    it('測試語音不受總開關影響（關閉時仍會發聲）', async () => {
        m.settings.enabled = false;
        const r = await render();
        await act(async () => {
            buttonByText(r, '測試語音').props.onClick();
        });
        expect(m.urgent).toHaveBeenCalledTimes(1);
        expect(String(at(m.urgent.mock.calls, 0, '急件呼叫')[0])).toContain('語速');
        r.unmount();
    });

    it('診斷區預設收合，摘要顯示計數；展開後才出現商品狀態與 trace 按鈕', async () => {
        const r = await render();
        const details = r.root.findAll((n) => n.type === 'details');
        expect(details).toHaveLength(1);
        expect(at(details, 0, '診斷區').props.open).toBeUndefined();
        expect(textOf(at(details, 0, '診斷區').props.children)).toContain('tick 157');
        expect(textOf(at(details, 0, '診斷區').props.children)).toContain('已播 4');
        expect(textOf(at(details, 0, '診斷區').props.children)).toContain('記錄 trace：關');
        r.unmount();
    });

    it('多個語音時才顯示語音選擇（選項含自動挑選）', async () => {
        const r = await render();
        const selects = r.root.findAll((n) => n.type === 'select');
        expect(selects).toHaveLength(1);
        // 自動挑選 + 2 個語音
        expect(r.root.findAll((n) => n.type === 'option')).toHaveLength(3);
        r.unmount();
    });
});