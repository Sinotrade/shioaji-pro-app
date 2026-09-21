import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResearchMarkerControls, researchFlowStatus } from './research-marker-controls';
import { DEFAULT_MARKER_OPTIONS, EMPTY_FLOW } from '../lib/utils/v9-chart-markers';
vi.mock('./research-marker-controls.css', () => ({
    root: '', row: '', label: '', toggle: { on: 'on', off: 'off' }, status: '', help: '', explanation: '',
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
it('shows the research controls with independent toggles and accessible pressed state', async () => {
    const change = vi.fn();
    await act(async () => {
        root = create(<ResearchMarkerControls options={DEFAULT_MARKER_OPTIONS} onChange={change}
            flow={EMPTY_FLOW} markers={[]} barCount={100} />);
    });
    const buttons = root!.root.findAllByType('button');
    expect(buttons).toHaveLength(7);
    expect(buttons.every(button => button.props['aria-pressed'])).toBe(true);
    await act(async () => buttons[0]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, volume: false });
    await act(async () => buttons[2]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, trend: false });
    await act(async () => buttons[3]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, trendShort: false });
    await act(async () => buttons[5]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, tint: false });
    await act(async () => buttons[6]!.props.onClick());
    expect(change).toHaveBeenLastCalledWith({ ...DEFAULT_MARKER_OPTIONS, compact: false });
    const rendered = JSON.stringify(root!.toJSON());
    expect(rendered).toContain('153');
    expect(rendered).toContain('僅研究');
});
