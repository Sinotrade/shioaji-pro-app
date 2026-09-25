import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    prices: {} as Record<string, number>,
    request: {
        code: 'TXFR1', action: 'Sell' as const, price: null, quantity: 1,
        unit: '口', simulation: true, livePriceCode: 'TXFR1',
    },
    resolve: vi.fn(),
}));
vi.mock('../hooks/use-esc-close', () => ({ useEscClose: () => undefined }));
vi.mock('../lib/trigger-engine', () => ({ usePendingPrices: () => m.prices }));
vi.mock('../lib/order-confirm', () => ({
    getPendingOrderConfirm: () => m.request,
    subscribeOrderConfirm: () => () => undefined,
    resolveOrderConfirm: m.resolve,
}));
vi.mock('react-dom', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-dom')>(),
    createPortal: (children: unknown) => children,
}));

import { OrderConfirmHost } from './order-confirm-dialog';

it('updates the latest trigger price inside manual confirmation and blocks confirmation without a quote', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal('document', { body: {} });
    let rendered!: ReactTestRenderer;
    m.prices = {};
    try {
        await act(async () => { rendered = create(<OrderConfirmHost />); });
        const confirm = () => rendered.root.findAllByType('button').find(button => button.children.join('') === '確認賣出')!;
        expect(JSON.stringify(rendered.toJSON())).toContain('行情中斷');
        expect(confirm().props.disabled).toBe(true);

        m.prices = { TXFR1: 47900 };
        await act(async () => rendered.update(<OrderConfirmHost />));
        expect(JSON.stringify(rendered.toJSON())).toContain('47,900');
        expect(confirm().props.disabled).toBe(false);

        m.prices = { TXFR1: 47000 };
        await act(async () => rendered.update(<OrderConfirmHost />));
        expect(JSON.stringify(rendered.toJSON())).toContain('47,000');
        expect(JSON.stringify(rendered.toJSON())).not.toContain('47,900');
    } finally {
        if (rendered) await act(async () => rendered.unmount());
        vi.unstubAllGlobals();
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
});
