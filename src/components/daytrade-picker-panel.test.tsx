import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaytradeResult, DaytradeRow } from '../lib/daytrade-picker';
import type { ContractInfo } from '../lib/types/contract';
import { DaytradePickerPanel, type DaytradePickerPanelProps } from './daytrade-picker-panel';

vi.mock('./daytrade-picker-panel.css', () => ({
    root: '', body: '', toolbar: '', title: '', badge: '', refresh: '', spinning: '', note: '', sourceNote: '', notice: '', warning: '',
    heading: '', sides: '', sidePanel: '', sideHeading: '', long: 'long', short: 'short', stock: '', row: '', rank: '', identity: '',
    name: '', info: '', numbers: '', metrics: '', source: '', rowDetails: '', detailsSummary: '', detailMetrics: '', reasons: '', empty: '',
    excluded: '', excludedRow: '',
}));

let renderer: ReactTestRenderer | undefined;
const fetchRequest = vi.fn();
const readText = (node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string =>
    typeof node === 'string' ? node : Array.isArray(node) ? node.map(readText).join('') : node?.children?.map(readText).join('') ?? '';
const text = () => readText(renderer!.toJSON());
const rows = (kind: 'confirmed' | 'observation') => renderer!.root.findAllByType('button')
    .filter(button => button.props['data-daytrade-kind'] === kind);
const row = (code = '2330', side: 'long' | 'short' = 'long'): DaytradeRow => ({
    contract: { code, name: `研究股${code}`, security_type: 'STK', region: 'TW', exchange: 'TSE' } as ContractInfo,
    side, score: 72, price: 100, changeRate: side === 'long' ? 2 : -2,
    volumeRatio: 1.65, rvol: 2.10, vwap: 99.8, spreadPct: 0.1, atrPct: 2,
    signal: '完成5分K方向確認', reasons: ['資格日期已核對', '同時段量能增加'],
    asOf: '2026-10-07T10:15:00+08:00', qualificationDate: '2026-10-07',
});
const result = (override: Partial<DaytradeResult> = {}): DaytradeResult => ({
    long: [], short: [], observationsLong: [], observationsShort: [], excluded: [], phase: 'live', tradeDate: '2026-10-07', ...override,
});
const mount = async (override: Partial<DaytradePickerPanelProps> = {}) => {
    const props: DaytradePickerPanelProps = { result: result(), loading: false, error: null,
        lastUpdated: Date.parse('2026-10-07T02:15:00Z'), poolSize: 40, onRefresh: vi.fn(), onPick: vi.fn(), ...override };
    await act(async () => { renderer = create(<DaytradePickerPanel {...props} />); });
    return props;
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchRequest);
    vi.clearAllMocks();
});
afterEach(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    renderer = undefined; vi.unstubAllGlobals();
});

it('renders empty states with pool boundaries and no network or trade behavior', async () => {
    await mount({ result: null, poolSize: 0, lastUpdated: null });
    expect(text()).toContain('當沖多空10');
    expect(text()).toContain('僅研究，不下單');
    expect(text()).toContain('自選＋排行榜最多40檔');
    expect(text()).toContain('目前 0 檔');
    expect(text()).toContain('不足不湊滿');
    expect(text()).toContain('研究分數不是勝率');
    expect(text()).toContain('尚無已提供的當沖研究資料');
    expect(rows('confirmed')).toHaveLength(0); expect(rows('observation')).toHaveLength(0);
    expect(fetchRequest).not.toHaveBeenCalled();
});

it('separates up to ten confirmed candidates on each side and never pads places', async () => {
    const longs = Array.from({ length: 12 }, (_, i) => row(String(1000 + i)));
    await mount({ result: result({ long: longs, short: [row('2001', 'short'), row('2002', 'short')], observationsLong: [row('3001')] }) });
    expect(rows('confirmed').filter(button => button.props['data-side'] === 'long')).toHaveLength(10);
    expect(rows('confirmed').filter(button => button.props['data-side'] === 'short')).toHaveLength(2);
    expect(rows('observation')).toHaveLength(1);
    expect(text()).toContain('前一交易日觀察');
    expect(text()).toContain('非今日盤中確認');
    expect(text()).toContain('帳戶與券源');
    expect(text()).not.toContain('BUY'); expect(text()).not.toContain('SELL');
});

it.each(['preopen', 'closed'] as const)('hides carried confirmation rows when phase is %s', async phase => {
    await mount({ result: result({ phase, long: [row()], short: [row('2001', 'short')], observationsLong: [row('3001')] }) });
    expect(rows('confirmed')).toHaveLength(0);
    expect(rows('observation')).toHaveLength(1);
    expect(text()).toContain('不提供目前可當沖的確認名單');
    expect(text()).toContain('09:15～13:25');
});

it('labels prior daily volume separately from same-clock RVOL, quotes and contract dates', async () => {
    await mount({ result: result({ long: [row()], observationsShort: [{ ...row('2001', 'short'), asOf: '2026-10-06T13:30:00+08:00', rvol: null, vwap: null, spreadPct: null }] }) });
    const current = rows('confirmed')[0]!;
    expect(text()).not.toContain('勝率72');
    expect(text()).toContain('前日量比 1.65倍');
    expect(text()).toContain('同時段 RVOL 2.10倍');
    expect(text()).toContain('同時段 RVOL 待補');
    expect(text()).toContain('行情 2026-10-07 10:15:00');
    expect(text()).toContain('日K收盤 2026-10-06 13:30:00');
    expect(text()).toContain('契約日 2026-10-07');
    expect(current.props.title).toBe('資格日期已核對；同時段量能增加');
    expect(renderer!.root.findAllByType('details').length).toBe(3);
});

it('dispatches only the parent selection callback and refresh, with no owned request', async () => {
    const props = await mount({ result: result({ long: [row()] }) });
    await act(async () => rows('confirmed')[0]!.props.onClick());
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith('2330');
    await act(async () => renderer!.root.findAllByType('button').find(button => button.props['aria-label'] === '重新整理當沖研究')!.props.onClick());
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchRequest).not.toHaveBeenCalled();
});

it('disables refresh during loading and makes retained old results explicit on failure', async () => {
    await mount({ loading: true, error: '歷史資料離線', result: result({ long: [row()] }) });
    expect(renderer!.root.findAllByType('button').find(button => button.props['aria-label'] === '重新整理當沖研究')!.props.disabled).toBe(true);
    expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
    expect(rows('confirmed')).toHaveLength(1);
    expect(text()).toContain('只代表各檔所示的行情時間');
    expect(text()).toContain('保留的研究結果不代表最新行情');
});

it('preserves all excluded reasons in a collapsed inspection list', async () => {
    await mount({ result: result({ excluded: [{ code: '2330', name: '台積電', reasons: ['資格日期過舊', '缺同時段分鐘歷史'] }] }) });
    expect(text()).toContain('排除／等待原因');
    expect(text()).toContain('資格日期過舊；缺同時段分鐘歷史');
    expect(renderer!.root.findByType('details').props.open).not.toBe(true);
    expect(rows('confirmed')).toHaveLength(0);
});

it('normalizes zone-less broker timestamps as Taipei and tolerates missing values and callback', async () => {
    const invalid = { ...row(), price: Number.NaN, rvol: Number.NaN, vwap: Number.NaN, asOf: 'not-a-timestamp', qualificationDate: '' };
    await mount({ result: result({ long: [invalid, { ...row('2001'), asOf: '2026-10-07 10:15:00' }] }), onPick: undefined });
    await act(async () => rows('confirmed')[0]!.props.onClick());
    expect(text()).toContain('時間待核對');
    expect(text()).toContain('行情 2026-10-07 10:15:00');
    expect(text()).toContain('契約日 待核對');
    expect(text()).not.toContain('NaN');
    expect(fetchRequest).not.toHaveBeenCalled();
});
