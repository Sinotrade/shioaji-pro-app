import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PickerRow } from '../hooks/use-stock-picker';
import type { ResearchDailyBreakoutPanelProps } from './research-daily-breakout-panel';
import { StockPickerPanel } from './stock-picker-panel';

const mocks = vi.hoisted(() => ({ researchMode: true, usePicker: vi.fn(), daily: vi.fn(), refresh: vi.fn() }));
vi.mock('../lib/workspace', () => ({ get V9_RESEARCH_MODE() { return mocks.researchMode; } }));
vi.mock('../hooks/use-stock-picker', () => ({ useStockPicker: mocks.usePicker }));
vi.mock('./research-daily-breakout-panel', () => ({ ResearchDailyBreakoutPanel: (props: ResearchDailyBreakoutPanelProps) => {
    mocks.daily(props);
    return <div data-daily-study><span>模擬日K波段研究</span><button onClick={() => props.onPick(props.rows[0]!.contract.code)}>模擬選取日K股票</button></div>;
} }));
vi.mock('./stock-picker-panel.css', () => Object.fromEntries([
    'wrap', 'toolbar', 'title', 'poolCount', 'segWrap', 'seg', 'segActiveLong', 'segActiveShort', 'regimeBadge', 'regimeBull', 'regimeBear', 'regimeNeutral', 'iconBtn', 'spinning', 'updatedAt', 'stateBox', 'scroll', 'head', 'row', 'rowExcluded', 'rank', 'rank1', 'rankTop', 'rankTopShort', 'nameCell', 'codeTxt', 'nameTxt', 'num', 'upTxt', 'downTxt', 'volHot', 'scoreCell', 'scoreHot', 'scoreHotShort', 'scoreWarm', 'statusCell', 'statusExcl', 'statusStrong', 'statusStrongShort', 'statusBuild', 'statusWait', 'patternCell',
].map(name => [name, name])));

let renderer: ReactTestRenderer | undefined;
const stock: PickerRow = {
    contract: { code: '2330', name: '測試股票', exchange: 'TSE', security_type: 'STK', target_code: null, currency: 'TWD', limit_up: 110, limit_down: 90, reference: 100, day_trade: 'Yes', update_date: '2026-10-02', category: '24', margin_trading_balance: 0, short_selling_balance: 0 },
    price: 105, changeRate: 5, volumeRatio: 2,
    score: { asOf: 1790870400, side: 'long', excluded: false, score: 78, status: '強轉', pattern: '原選股型態', excludeReasons: [], volumeRatio: 2, changePct: 5, rsi: 65, biasPct: 3, isEntry: true, level: 100 },
};
const dailyRows = [{ contract: stock.contract, daily: [{ time: 1790870400, open: 104, high: 106, low: 103, close: 105, volume: 100 }] }];
const payload = (loading = false, error: string | null = null) => ({ rows: [stock], dailyRows, regime: { side: 'bull', label: '多頭測試', rsi: 65 }, loading, error, lastUpdated: 1790870400000, refresh: mocks.refresh });
const text = () => JSON.stringify(renderer!.toJSON());
const press = async (label: string) => {
    const button = renderer!.root.findAllByType('button').find(node => node.children.includes(label));
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => button!.props.onClick());
};
const mount = async (pick = vi.fn()) => {
    await act(async () => { renderer = create(<StockPickerPanel onPick={pick} />); });
    return pick;
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.researchMode = true; vi.clearAllMocks();
    mocks.usePicker.mockReturnValue(payload());
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it('opens daily research from the existing picker hook and forwards completed daily rows and picks', async () => {
    const pick = await mount();
    expect(mocks.usePicker).toHaveBeenCalledTimes(1); expect(mocks.usePicker).toHaveBeenLastCalledWith('long');
    expect(mocks.daily).not.toHaveBeenCalled(); expect(text()).toContain('原選股型態');
    await press('日K波段');
    // One hook evaluation per parent render; opening this child creates no
    // second picker instance or refresh request.
    expect(mocks.usePicker).toHaveBeenCalledTimes(2); expect(mocks.daily).toHaveBeenCalledTimes(1);
    const props = mocks.daily.mock.lastCall![0] as ResearchDailyBreakoutPanelProps;
    expect(props.rows).toBe(dailyRows); expect(props.loading).toBe(false); expect(props.error).toBeNull(); expect(props.onPick).toBe(pick);
    expect(text()).toContain('模擬日K波段研究'); expect(text()).not.toContain('原選股型態');
    await press('模擬選取日K股票'); expect(pick).toHaveBeenCalledExactlyOnceWith('2330');
    expect(mocks.refresh).not.toHaveBeenCalled();
});

it('switches back to the original selection view, preserving its row selection and refresh controls', async () => {
    const pick = await mount(); await press('日K波段'); await press('原選股');
    expect(text()).toContain('原選股型態'); expect(text()).not.toContain('模擬日K波段研究');
    expect(renderer!.root.findAllByType('button').some(button => button.children.includes('空方'))).toBe(true);
    await act(async () => renderer!.root.findAllByType('div').find(node => node.props.title === '原選股型態')!.props.onClick());
    expect(pick).toHaveBeenCalledExactlyOnceWith('2330');
    await act(async () => renderer!.root.findAllByType('button').find(node => node.props.title === '重新整理')!.props.onClick());
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
});

it('does not expose or mount daily research in the normal non-research mode', async () => {
    mocks.researchMode = false; await mount();
    const labels = renderer!.root.findAllByType('button').flatMap(button => button.children.filter(child => typeof child === 'string'));
    expect(labels).not.toContain('日K波段'); expect(labels).not.toContain('原選股');
    expect(labels).toContain('多方'); expect(labels).toContain('空方'); expect(text()).toContain('原選股型態');
    expect(mocks.daily).not.toHaveBeenCalled(); expect(mocks.usePicker).toHaveBeenCalledTimes(1);
});

it('uses long daily data after short selection while retaining the original short-side feature', async () => {
    await mount(); await press('空方'); expect(mocks.usePicker).toHaveBeenLastCalledWith('short');
    await press('日K波段'); expect(mocks.usePicker).toHaveBeenLastCalledWith('long');
    expect(renderer!.root.findAllByType('button').some(button => button.children.includes('空方'))).toBe(false);
    await press('原選股'); await press('空方'); expect(mocks.usePicker).toHaveBeenLastCalledWith('short');
    expect(text()).toContain('原選股型態');
});

it('forwards loading and errors to daily research without duplicating the original-view state display', async () => {
    mocks.usePicker.mockReturnValue(payload(true, '已供資料暫未更新'));
    await mount(); await press('日K波段');
    const props = mocks.daily.mock.lastCall![0] as ResearchDailyBreakoutPanelProps;
    expect(props.loading).toBe(true); expect(props.error).toBe('已供資料暫未更新');
    expect(props.rows).toBe(dailyRows); expect(mocks.refresh).not.toHaveBeenCalled();
});
