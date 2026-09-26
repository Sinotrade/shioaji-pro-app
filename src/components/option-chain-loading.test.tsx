import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchOptions: vi.fn() }));
vi.mock('../lib/shioaji', () => ({ fetchOptions: mocks.fetchOptions }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => null }));
vi.mock('../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: () => ({ snapshots: new Map(), refresh: vi.fn(), loading: false, error: null }),
}));

import { OptionChain } from './option-chain';

let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fetchOptions.mockReset();
});
afterEach(async () => {
    await act(async () => { view?.unmount(); });
    view = undefined;
    vi.unstubAllGlobals();
});

it('shows a retryable error instead of empty when the TXO lookup fails', async () => {
    mocks.fetchOptions.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
    await act(async () => { view = create(createElement(OptionChain)); });
    expect(JSON.stringify(view!.toJSON())).toContain('TXO 合約無法取得');
    expect(JSON.stringify(view!.toJSON())).not.toContain('無可用合約');

    const retry = view!.root.findAllByType('button').find(node => node.props.children === '重試');
    expect(retry).toBeDefined();
    await act(async () => { retry!.props.onClick(); });
    expect(mocks.fetchOptions).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(view!.toJSON())).toContain('無可用合約');
});
