// #201 ② — the minimal background bracket list: the session-change reminder
// and 「在新盤別重新啟用」 capped by a fresh read of the account's positions,
// 「我已自行處理」, and the 待確認 decision. Nothing is sent by itself.
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Level, OrderProgram } from '../lib/execution/model';

const m = vi.hoisted(() => ({ programs: [] as unknown[], rearm: vi.fn(), handled: vi.fn(), resolve: vi.fn(), remove: vi.fn(), positions: vi.fn() }));
vi.mock('../lib/execution/background', () => ({
    useBackgroundPrograms: () => m.programs, rearmBackgroundBracket: m.rearm, markBackgroundHandled: m.handled,
    resolveBackgroundTrigger: m.resolve, removeBackgroundBracket: m.remove,
}));
vi.mock('../lib/execution/rearm', async () => ({ ...(await vi.importActual<object>('../lib/execution/rearm')), fetchAccountPositions: m.positions }));
vi.mock('../lib/trading-state', () => ({}));
vi.mock('../lib/shioaji', () => ({}));
vi.mock('../lib/account-query', () => ({}));
vi.mock('../lib/main-window-commands', () => ({ isMainWindow: () => true }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, maskAccountId: (id: string) => id }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'srv|simulation', protectionEnvLabel: () => '模擬' }));
const { BackgroundBracketList } = await import('./background-bracket-status');

function program(lv: Partial<Level>): OrderProgram {
    return { id: 'bkt-1', kind: 'bracket', version: 3, status: 'running', pauseReason: null, hold: null, ocoLevels: false,
        binding: { env: 'simulation', serverId: 'srv', account: { accountType: 'F', brokerId: 'B', accountId: 'A' },
            contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
        levels: [{ id: 'L1', side: 'Buy', qty: 2, entry: { type: 'external', orderId: 'bg:k' },
            exit: { type: 'oco', stop: { price: 95, condition: 'below' }, take: null, order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } },
            phase: 'disabled', check: null, recross: [], pending: null, position: 2, entryFilled: 2, unprotected: 0, cycles: 0,
            detail: 'sessionEnded', orders: [], ...lv }],
        generator: null, cycle: { rearmAfterExit: false, maxCycles: null, partialFill: 'immediate' },
        bounds: { upper: null, lower: null, onBreakUpper: 'none', onBreakLower: 'none' },
        session: { resumeRule: 'confirm', longDisconnectMs: 60000, silentStallMs: 90000 }, risk: { maxWorkingEntries: null },
        hooks: [], intentSeq: 0, issues: [], createdAt: 1, updatedAt: 1 } as OrderProgram;
}
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const button = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)));
const render = async () => { await act(async () => { view = create(createElement(BackgroundBracketList, { code: 'TXFR1' })); }); };
const held = (quantity: number) => ({ known: true, positions: [{ code: 'TXFJ6', direction: 'Buy', quantity,
    account: { account_type: 'F', broker_id: 'B', account_id: 'A' } }] });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const f of [m.rearm, m.handled, m.resolve, m.remove, m.positions]) f.mockReset();
    m.programs = [program({})];
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('reminds that protection did not carry over and rearms capped by the closable position', async () => {
    m.positions.mockResolvedValue(held(1));
    await render();
    expect(text(view.root)).toContain('保護未延續');
    await act(async () => { button(/在新盤別重新啟用/)!.props.onClick(); });
    expect(m.positions).toHaveBeenCalledOnce();
    const input = view.root.findAll(n => n.type === 'input')[0]!;
    expect(input.props.value).toBe('1');
    await act(async () => { input.props.onChange({ target: { value: '2' } }); });
    expect(button(/確認重新啟用/)!.props.disabled).toBe(true);
    await act(async () => { input.props.onChange({ target: { value: '1' } }); });
    await act(async () => { await button(/確認重新啟用/)!.props.onClick(); });
    expect(m.rearm).toHaveBeenCalledWith('bkt-1', 'L1', 1);
});

it('never rearms without a known closable position', async () => {
    m.positions.mockResolvedValue(held(0));
    await render();
    await act(async () => { button(/在新盤別重新啟用/)!.props.onClick(); });
    const input = view.root.findAll(n => n.type === 'input')[0]!;
    await act(async () => { input.props.onChange({ target: { value: '1' } }); });
    expect(button(/確認重新啟用/)!.props.disabled).toBe(true);
    m.positions.mockRejectedValue(new Error('x'));
    await act(async () => { button(/返回/)!.props.onClick(); });
    await act(async () => { button(/在新盤別重新啟用/)!.props.onClick(); });
    expect(button(/確認重新啟用/)!.props.disabled).toBe(true);
    expect(m.rearm).not.toHaveBeenCalled();
});

it('我已自行處理 asks once and only ends the tracking', async () => {
    await render();
    await act(async () => { button(/我已自行處理/)!.props.onClick(); });
    expect(m.handled).not.toHaveBeenCalled();
    await act(async () => { await button(/確認我已自行處理/)!.props.onClick(); });
    expect(m.handled).toHaveBeenCalledWith('bkt-1', 'L1');
});

it('a leg already past waits for the user: send asks twice, keep watches again', async () => {
    m.programs = [program({ phase: 'needsConfirm', detail: null, pending: { leg: 'stop', price: 94, ts: 1, reason: 'resume' } })];
    await render();
    await act(async () => { button(/送出平倉單/)!.props.onClick(); });
    expect(m.resolve).not.toHaveBeenCalled();
    await act(async () => { await button(/再按一次/)!.props.onClick(); });
    expect(m.resolve).toHaveBeenCalledWith('bkt-1', 'L1', 'send');
    await act(async () => { await button(/繼續盯價/)!.props.onClick(); });
    expect(m.resolve).toHaveBeenCalledWith('bkt-1', 'L1', 'keep');
});
