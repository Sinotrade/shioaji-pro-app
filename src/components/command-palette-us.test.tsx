// 命令面板選美股建議：以連動 key（US:AAPL）跳轉，不帶型別，避免 region=TW 查詢
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { prime, usContract, suggestions } = vi.hoisted(() => {
    const usContract = { code: 'AAPL', region: 'US', exchange: 'NASDAQ', security_type: 'STK', us_reference: '187.5' };
    return {
        prime: vi.fn(),
        usContract,
        suggestions: [
            { code: 'AAPL', name: 'Apple', security_type: 'STK', exchange: 'NASDAQ', detail: '美股 · NASDAQ', region: 'US', key: 'US:AAPL', contract: usContract },
            { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' },
        ],
    };
});
vi.mock('../lib/contracts-cache', () => ({ primeContract: prime }));
vi.mock('../hooks/use-product-search', () => ({
    useProductSearch: () => ({
        suggestions, searching: false, searchError: false, activeIdentity: null, setActiveIdentity: () => undefined,
        renderedVersion: 0, currentVersion: () => 0, isCurrent: () => true, isComposing: () => false, isStale: () => false,
        cancel: () => undefined, clear: () => undefined, change: () => undefined, retry: () => undefined,
        startComposition: () => undefined, endComposition: () => undefined,
    }),
}));

import { CommandPalette } from './command-palette';

let r: ReactTestRenderer | null = null;
afterEach(() => { act(() => r?.unmount()); r = null; prime.mockClear(); });

function render() {
    const onJump = vi.fn().mockResolvedValue(undefined);
    act(() => { r = create(createElement(CommandPalette, { open: true, onClose: vi.fn(), onJump })); });
    return onJump;
}
const option = (code: string) => r!.root.find((n) => n.type === 'button' && n.props.role === 'option' &&
    n.findAll((c) => (c.children ?? []).includes(code)).length > 0);

it('jumps to a US suggestion by its link key without a security type', async () => {
    const onJump = render();
    await act(async () => { option('AAPL').props.onClick(); });
    expect(onJump).toHaveBeenCalledExactlyOnceWith('US:AAPL');
    expect(prime).toHaveBeenCalledWith(usContract);
});

it('keeps the TW jump unchanged', async () => {
    const onJump = render();
    await act(async () => { option('2330').props.onClick(); });
    expect(onJump).toHaveBeenCalledExactlyOnceWith('2330', 'STK');
});
