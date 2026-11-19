import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Trade } from '../lib/types/order';
// 委託表併入美股列：美股操作模組在 import 時碰 window，測試裡換成空殼
vi.mock('./bottom-dock-us', () => ({ usAccountGroupKey: () => '', UsOrderActions: () => null, usOrderPriceText: () => '', usOrderRowKey: () => '', usStatusBucket: () => 'dead', UsTag: () => null }));
vi.mock('../lib/us/us-trading-state', () => ({ usRemaining: () => '0' }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), updateOrderPrice: vi.fn(), updateOrderQty: vi.fn() }));
import { OrderQuantity } from './bottom-dock-orders';

function render(status: Trade['status']['status'], quantity: number, filled: number, cancelled: number) {
    const trade = {
        order: { quantity },
        status: { status, deal_quantity: filled, cancel_quantity: cancelled },
    } as Trade;
    return renderToStaticMarkup(createElement(OrderQuantity, { trade }));
}

describe('委託數量顯示', () => {
    it('原始三張減一張後，主要數字為未成交二張且保留原始量明細', () => {
        const html = render('Submitted', 3, 0, 1);
        expect(html).toContain('未成交 2</span>');
        expect(html).toContain('成交 0 · 取消 1');
        expect(html).toContain('原始委託 3；已成交 0；已取消 1；未成交 2');
        expect(html).not.toContain('0/3');
    });

    it('部分成交與減量均扣除，剩餘量與成交量分開呈現', () => {
        const html = render('PartFilled', 3, 1, 1);
        expect(html).toContain('未成交 1</span>');
        expect(html).toContain('成交 1 · 取消 1');
    });

    it.each([
        ['Cancelled', 3, 0, 3],
        ['Filled', 3, 2, 1],
        ['Failed', 3, 0, 0],
    ] as const)('終態 %s 不顯示仍有掛單', (status, quantity, filled, cancelled) => {
        expect(render(status, quantity, filled, cancelled)).toContain('未成交 0</span>');
    });

    it('減量後其餘全部成交時，成交進度圈完整填滿', () => {
        const html = render('Filled', 3, 2, 1);
        expect(html).toContain(`stroke-dasharray="${2 * Math.PI * 5} ${2 * Math.PI * 5}"`);
    });
});
