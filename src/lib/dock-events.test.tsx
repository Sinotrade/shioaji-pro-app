// src/lib/dock-events.test.tsx — 待確認卡「開啟委託查詢」reaches the dock.

import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { requestOpenOrdersTab, useOpenOrdersTabRequest } from './dock-events';

afterEach(() => { vi.unstubAllGlobals(); });

it('a request opens the orders tab while mounted, and not after', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget()); // node test env has no DOM
    const onOpen = vi.fn();
    function Probe() { useOpenOrdersTabRequest(onOpen); return null; }
    let view!: ReturnType<typeof create>;
    act(() => { view = create(createElement(Probe)); });
    requestOpenOrdersTab();
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => view.unmount());
    requestOpenOrdersTab();
    expect(onOpen).toHaveBeenCalledTimes(1);
});
