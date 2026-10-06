import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResearchMarkerControls, researchFlowStatus, v9MarketBias } from './research-marker-controls';
import { DEFAULT_MARKER_OPTIONS, EMPTY_FLOW } from '../lib/utils/v9-chart-markers';
import * as decisionModule from '../lib/research-decision';
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
    decisionSummary: '', decisionBadge: { long: 'long', short: 'short', neutral: 'neutral', insufficient: 'insufficient' },
    decisionRole: '', decisionReasons: '', formulaSources: '', decisionEntry: '', entryChecklist: '',
    entryCheck: { pass: 'pass', wait: 'wait', missing: 'missing' },
}));
let root: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
it('distinguishes waiting for data from warmup and no qualifying prints', () => {
    expect(researchFlowStatus(EMPTY_FLOW)).toContain('等待真實 Tick');
    expect(researchFlowStatus({ ...EMPTY_FLOW, sampleCount: 19 })).toContain('19/20');
    expect(researchFlowStatus({ ...EMPTY_FLOW, sampleCount: 20, threshold: 5 })).toContain('已識別 0 筆');
});
it('keeps new pattern research independent, compact and fail closed on stale data', async () => {
    const props = { options: DEFAULT_MARKER_OPTIONS, onChange: vi.fn(), flow: EMPTY_FLOW,
        markers: [], barCount: 100, resonance: null, levels: [],
        dataStatus: { state: 'fresh' as const },
        vwapEvaluation: { status: 'ready' as const, reason: '本時段開盤起算完整', points: [] },
        setupEvaluation: { state: 'confirmed' as const, label: '順勢回踩研究確認', detail: '最新已收5分K',
            side: 'long' as const, setup: 'pullback' as const, vwap: 100, confirmedAt: 100 },
    };
    await act(async () => { root = create(<ResearchMarkerControls {...props} />); });
    const setup = root!.root.findByProps({ 'aria-label': '獨立型態研究' });
    expect(setup.findByType('strong').children.join('')).toContain('順勢回踩研究確認');
    expect(setup.props['aria-expanded']).toBe(false);
    const details = root!.root.findByProps({ id: setup.props['aria-controls'] });
    expect(details.props.hidden).toBe(true);
    await act(async () => setup.props.onClick());
    expect(details.props.hidden).toBe(false);
    expect(JSON.stringify(root!.toJSON())).toContain('不合併原共振權重或進場門檻');
    expect(props.onChange).not.toHaveBeenCalled();
    await act(async () => { root!.update(<ResearchMarkerControls {...props} dataStatus={{ state: 'stale', reason: '資料過期' }} />); });
    const paused = root!.root.findByProps({ 'aria-label': '獨立型態研究' });
    expect(paused.findByType('strong').children.join('')).not.toContain('順勢回踩研究確認');
    expect(paused.props.title).toBe('資料過期');
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
            ]} currentPrice={100} dataStatus={{ state: 'fresh' }} />);
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

it('keeps direction, entry and formula sources distinct in the compact header', async () => {
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={vi.fn()}
            flow={EMPTY_FLOW} markers={[]} barCount={200} levels={[]} dataStatus={{ state: 'fresh' }}
            macdParams={[45, 117, 17]} resonance={{ summary: '多2／空2', frames: [
                { minutes: 1, label: '1分', side: 'short', bars: 200, requiredBars: 117 },
                { minutes: 5, label: '5分', side: 'short', bars: 200, requiredBars: 117 },
                { minutes: 60, label: '60分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 1440, label: '日K', side: 'long', bars: 200, requiredBars: 117 },
            ] }} />);
    });
    expect(root!.root.findByProps({ 'aria-label': '高週期背景' }).findByType('strong').children.join('')).toContain('背景偏多');
    expect(root!.root.findByProps({ 'aria-label': '短線方向' }).findByType('strong').children.join('')).toContain('短線偏空');
    expect(root!.root.findByProps({ 'aria-label': '進場狀態' }).findByType('strong').children.join('')).toBe('方向分歧');
    const rendered = JSON.stringify(root!.toJSON());
    expect(rendered).toContain('高週期背景與短線方向分歧');
    expect(rendered).toContain('收盤價 MACD(');
    expect(rendered).toContain('45,117,17');
    expect(rendered).toContain('加權價');
    expect(rendered).toContain('不代表可進場');
});

it('uses plain-language marker names and explains them without claiming a reversal', async () => {
    const props = {
        options: DEFAULT_MARKER_OPTIONS, onChange: vi.fn(), flow: EMPTY_FLOW, markers: [],
        barCount: 152, levels: [], resonance: null, dataStatus: { state: 'fresh' as const },
    };
    await act(async () => { root = create(<ResearchMarkerControls {...props} />); });
    const buttons = root!.root.findAllByType('button');
    expect(buttons.find(button => button.children.includes('攻／洗／量價提醒'))).toBeDefined();
    expect(buttons.find(button => button.children.includes('高低點動能提醒'))).toBeDefined();
    const rendered = JSON.stringify(root!.toJSON());
    for (const label of ['高點力道不足', '低點動能改善', '高點量未跟', '低點量未縮']) {
        expect(rendered).toContain(label);
    }
    expect(rendered).toContain('動能提醒資料準備中');
    expect(rendered).toContain('不代表已反轉');
    expect(rendered).toContain('不是直接買賣訊號');
    expect(rendered).toContain('不是說比上一根放量');
    expect(rendered).toContain('不保證逐根回升');
    expect(rendered).not.toMatch(/量背|頂背|底背|頂／底背|背離暖機/);
    await act(async () => root!.update(<ResearchMarkerControls {...props} barCount={200} />));
    expect(JSON.stringify(root!.toJSON())).toContain('高低點動能：目前無顯示提醒');
    expect(JSON.stringify(root!.toJSON())).not.toContain('動能提醒資料準備中');
});

it('does not keep old bullish direction visible while new-symbol data loads', async () => {
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={vi.fn()}
            flow={EMPTY_FLOW} markers={[]} barCount={200} levels={[]} loading
            dataStatus={{ state: 'fresh' }} resonance={{ summary: '四週期同多', frames: [
                { minutes: 1, label: '1分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 5, label: '5分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 60, label: '60分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 1440, label: '日K', side: 'long', bars: 200, requiredBars: 117 },
            ] }} />);
    });
    expect(root!.root.findByProps({ 'aria-label': '高週期背景' }).props.className).toBe('insufficient');
    expect(root!.root.findByProps({ 'aria-label': '短線方向' }).findByType('strong').children.join('')).toContain('待確認');
    expect(root!.root.findByProps({ 'aria-label': '進場狀態' }).findByType('strong').children.join('')).toBe('等待資料');
    expect(JSON.stringify(root!.toJSON())).not.toContain('四週期同多');
});

it('shows closed-session review without labeling it a lost connection', async () => {
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={vi.fn()}
            flow={EMPTY_FLOW} markers={[]} barCount={0} levels={[]} resonance={null}
            dataStatus={{ state: 'closed', reason: '夜盤已收盤' }} />);
    });
    expect(root!.root.findByProps({ 'aria-label': '進場狀態' }).findByType('strong').children.join('')).toBe('休市回顧');
    expect(JSON.stringify(root!.toJSON())).toContain('不是行情斷線');
});

it('lets an entry badge expose exact missing research conditions without enlarging the compact header', async () => {
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={vi.fn()}
            flow={EMPTY_FLOW} markers={[]} barCount={200} levels={[]} dataStatus={{ state: 'fresh' }}
            entryContext={{ closedFiveMinuteBars: [], securityType: 'STK', now: 123 }}
            resonance={{ summary: '四週期同多', frames: [
                { minutes: 1, label: '1分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 5, label: '5分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 60, label: '60分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 1440, label: '日K', side: 'long', bars: 200, requiredBars: 117 },
            ] }} />);
    });
    const badge = root!.root.findByProps({ 'aria-label': '進場狀態' });
    expect(badge.type).toBe('button');
    expect(badge.findByType('strong').children.join('')).toBe('等待資料');
    expect(badge.props['aria-expanded']).toBe(false);
    await act(async () => badge.props.onClick());
    expect(badge.props['aria-expanded']).toBe(true);
    expect(root!.root.findByProps({ id: badge.props['aria-controls'] }).props.hidden).toBe(false);
    const checks = root!.root.findByProps({ 'aria-label': '研究進場缺項檢核' }).findAllByType('li');
    expect(checks).toHaveLength(5);
    expect(JSON.stringify(root!.toJSON())).toContain('固定已收5分K');
    expect(JSON.stringify(root!.toJSON())).toContain('非正式進場策略');
});

it('keeps a ready shared background visible during an explicitly view-only chart load', async () => {
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={vi.fn()}
            flow={EMPTY_FLOW} markers={[]} barCount={200} levels={[]} loading directionLoading={false}
            dataStatus={{ state: 'fresh' }} resonance={{ summary: '四週期同多', frames: [
                { minutes: 1, label: '1分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 5, label: '5分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 60, label: '60分', side: 'long', bars: 200, requiredBars: 117 },
                { minutes: 1440, label: '日K', side: 'long', bars: 200, requiredBars: 117 },
            ] }} />);
    });
    expect(root!.root.findByProps({ 'aria-label': '高週期背景' }).props.className).toBe('long');
    expect(root!.root.findByProps({ 'aria-label': '短線方向' }).findByType('strong').children.join('')).toContain('短線偏多');
    expect(JSON.stringify(root!.toJSON())).toContain('四週期同多');
});

it('does not recalculate entry indicators when only tick flow or chart layers change', async () => {
    const decide = vi.spyOn(decisionModule, 'researchDecision');
    const stableProps = {
        options: DEFAULT_MARKER_OPTIONS, onChange: vi.fn(), flow: EMPTY_FLOW, markers: [], barCount: 200,
        levels: [], resonance: null, dataStatus: { state: 'fresh' as const },
        entryContext: { closedFiveMinuteBars: [], securityType: 'STK' as const, now: 123 },
    };
    await act(async () => { root = create(<ResearchMarkerControls {...stableProps} />); });
    expect(decide).toHaveBeenCalledTimes(1);
    await act(async () => root!.update(<ResearchMarkerControls {...stableProps}
        flow={{ ...EMPTY_FLOW, sampleCount: 1 }} options={{ ...DEFAULT_MARKER_OPTIONS, volume: false }} />));
    expect(decide).toHaveBeenCalledTimes(1);
    await act(async () => root!.update(<ResearchMarkerControls {...stableProps}
        entryContext={{ ...stableProps.entryContext, now: 124 }} />));
    expect(decide).toHaveBeenCalledTimes(2);
});
