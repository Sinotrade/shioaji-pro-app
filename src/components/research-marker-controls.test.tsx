import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResearchMarkerControls, researchFlowStatus, v9MarketBias } from './research-marker-controls';
import { DEFAULT_MARKER_OPTIONS, EMPTY_FLOW } from '../lib/utils/v9-chart-markers';
vi.mock('./research-marker-controls.css', () => ({
    root: '', row: '', label: '', toggle: { on: 'on', off: 'off' }, status: '', help: '', explanation: '',
    overview: '', directionCard: { long: '', short: '', neutral: '', insufficient: '' }, eyebrow: '',
    directionValue: '', directionNote: '', frameGrid: '', frameCard: { long: '', short: '', neutral: '', insufficient: '' },
    frameName: '', frameDirection: '', frameMeta: '', levelCard: '', levelHeader: '', levelGrid: '',
    levelPoint: { resistance: '', current: '', support: '' }, levelLabel: '', levelValue: '', levelDetail: '',
    headline: '', headlineMeta: '', headlineBias: { long: '', short: '', neutral: '', insufficient: '' },
    frameBadges: '', frameBadge: { long: '', short: '', neutral: '', insufficient: '' },
    nearestSummary: '', expandButton: '', detailsPanel: '',
    regimeQuote: '', regimePrice: '', regimeChg: { up: '', down: '', flat: '' },
    regimeReferenceItems: '', toolbarSlot: '', fibBtn: { on: '', off: '' },
}));
let root: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    vi.unstubAllGlobals();
});
it('distinguishes waiting for data from warmup and no qualifying prints', () => {
    expect(researchFlowStatus(EMPTY_FLOW)).toContain('等待真實 Tick');
    expect(researchFlowStatus({ ...EMPTY_FLOW, sampleCount: 19 })).toContain('19/20');
    expect(researchFlowStatus({ ...EMPTY_FLOW, sampleCount: 20, threshold: 5 })).toContain('已識別 0 筆');
});
it('summarizes four-timeframe direction without overstating mixed data', () => {
    const resonance = (sides: Array<'long' | 'short' | 'neutral' | 'insufficient'>) => ({
        summary: 'test',
        frames: sides.map((side, index) => ({
            minutes: [1, 5, 60, 1440][index] as 1 | 5 | 60 | 1440,
            label: ['1分', '5分', '60分', '日K'][index] as '1分' | '5分' | '60分' | '日K',
            side, bars: 117, requiredBars: 117,
        })),
    });
    expect(v9MarketBias(resonance(['long', 'long', 'long', 'long']))).toMatchObject({ label: '強勢多方' });
    expect(v9MarketBias(resonance(['short', 'short', 'short', 'short']))).toMatchObject({ label: '強勢空方' });
    expect(v9MarketBias(resonance(['long', 'long', 'neutral', 'insufficient']))).toMatchObject({ label: '已載入週期偏多' });
    expect(v9MarketBias(resonance(['long', 'short', 'insufficient', 'insufficient']))).toMatchObject({ label: '多空分歧' });
});
it('shows the research controls with independent toggles and accessible pressed state', async () => {
    const change = vi.fn();
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={change}
            flow={EMPTY_FLOW} markers={[]} barCount={100} resonance={{
                summary: '多1／空1／中0／資料不足2',
                frames: [
                    { minutes: 1, label: '1分', side: 'long', score: 61, bars: 200, requiredBars: 117 },
                    { minutes: 5, label: '5分', side: 'short', score: 39, bars: 120, requiredBars: 117 },
                    { minutes: 60, label: '60分', side: 'insufficient', bars: 30, requiredBars: 117 },
                    { minutes: 1440, label: '日K', side: 'insufficient', bars: 10, requiredBars: 117 },
                ],
            }} levels={[
                { id: 'or-high', title: '開盤5分高', price: 101, kind: 'opening-range' },
                { id: 'or-low', title: '開盤5分低', price: 99, kind: 'opening-range' },
                { id: 'open', title: '開盤', price: 100, kind: 'open' },
            ]} currentPrice={100} />);
    });
    const expand = root!.root.findAllByType('button').find(button => 'aria-expanded' in button.props)!;
    expect(expand.props['aria-expanded']).toBe(false);
    expect(root!.root.findByProps({ id: expand.props['aria-controls'] }).props.hidden).toBe(true);
    await act(async () => expand.props.onClick());
    expect(expand.props['aria-expanded']).toBe(true);
    expect(root!.root.findByProps({ id: expand.props['aria-controls'] }).props.hidden).toBe(false);
    expect(change).not.toHaveBeenCalled();
    const buttons = root!.root.findAllByType('button').filter(button => 'aria-pressed' in button.props);
    expect(buttons).toHaveLength(13);
    expect(buttons.every(button => button.props['aria-pressed'])).toBe(true);
    await act(async () => buttons[0]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, volume: false });
    await act(async () => buttons[2]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, trend: false });
    await act(async () => buttons[3]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, trendShort: false });
    await act(async () => buttons[7]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, tint: false });
    await act(async () => buttons[8]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, opening: false });
    await act(async () => buttons[9]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, transitions: false });
    await act(async () => buttons.find(button => button.children.includes('支撐壓力'))!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, levels: false });
    await act(async () => buttons.find(button => button.children.includes('樞紐關卡'))!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, pivot: false });
    await act(async () => buttons.find(button => button.children.includes('精簡顯示'))!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, compact: false });
    const rendered = JSON.stringify(root!.toJSON());
    expect(rendered).toContain('153');
    expect(rendered).toContain('僅研究');
    expect(rendered).toContain('V9 共振');
    expect(rendered).toContain('多空分歧');
    expect(rendered).toContain('上方壓力');
    expect(rendered).toContain('下方支撐');
    expect(rendered).toContain('+1.00%');
    expect(rendered).toContain('-1.00%');
});
