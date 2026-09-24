import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
    APPROVAL_FIXTURES,
    ApprovalView,
    summarizeApproval,
    type ApprovalRequest,
} from './main';

function render(request: ApprovalRequest) {
    return renderToStaticMarkup(
        createElement(ApprovalView, {
            request,
            remaining: 15,
            busy: false,
            error: null,
            detailOpen: false,
            onToggleDetail: () => {},
            onRespond: () => {},
        }),
    );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Agent 核可視窗：新單', () => {
    it('新單仍顯示買賣方向、價格與數量', () => {
        const html = text(render(APPROVAL_FIXTURES.place!));
        expect(html).toContain('買進 CCFI6');
        expect(html).toContain('2 口');
        expect(html).toContain('130.50');
        expect(html).toContain('核准');
        expect(html).toContain('報價已變動，請重新確認');
    });
});

describe('Agent 核可視窗：刪改單（A-03）', () => {
    it('刪單以操作為標題，顯示原委託與剩餘量，不寫成買進 N 張', () => {
        const html = text(render(APPROVAL_FIXTURES.cancel!));
        expect(html).toContain('刪單 2330');
        expect(html).toContain('2330 台積電');
        expect(html).toContain('原委託 買進 1,000 × 5 張');
        expect(html).toContain('委託書號 W0001');
        expect(html).toContain('刪除剩餘未成交 2 張');
        expect(html).toContain('****4567');
        expect(html).toContain('核准刪單');
        expect(html).not.toMatch(/買進\s*2330/);
        expect(html).not.toContain('報價已變動');
    });

    it('舊版 native payload（無 operation 欄）仍是刪單卡，剩餘量由狀態推算', () => {
        const summary = summarizeApproval(APPROVAL_FIXTURES['cancel-legacy']!);
        expect(summary).toMatchObject({ kind: 'modify', operation: 'cancel_order', remaining: 2 });
        const html = text(render(APPROVAL_FIXTURES['cancel-legacy']!));
        expect(html).toContain('刪除剩餘未成交 2 張');
        expect(html).not.toMatch(/買進\s*2330/);
    });

    it('改價顯示原價到新價', () => {
        const html = text(render(APPROVAL_FIXTURES.update_price!));
        expect(html).toContain('改價 2330');
        expect(html).toContain('剩餘未成交 2 張');
        expect(html).toContain('1,000 → 995');
        expect(html).toContain('核准改價');
    });

    it('減量顯示減少量與減量後剩餘', () => {
        const html = text(render(APPROVAL_FIXTURES.update_qty!));
        expect(html).toContain('減量 2330');
        expect(html).toContain('減少 1 張');
        expect(html).toContain('減量後剩餘 1 張');
        expect(html).toContain('核准減量');
    });

    it('缺少 status 時剩餘量顯示 —，不以原委託量代替', () => {
        const payload = {
            contract: { security_type: 'STK', code: '2330' },
            order: { action: 'Buy', price: 1000, quantity: 5, price_type: 'LMT', order_type: 'ROD' },
            request: { trade_id: 'x' },
        };
        expect(summarizeApproval({ operation: 'cancel_order', payload })).toMatchObject({
            kind: 'modify',
            remaining: null,
        });
        const html = text(render({ ...APPROVAL_FIXTURES.cancel!, payload }));
        expect(html).toContain('刪除剩餘未成交 —');
        expect(html).not.toContain('刪除剩餘未成交 5 張');
        const bare = text(render({ ...APPROVAL_FIXTURES.cancel!, payload: { request: { trade_id: 'x' } } }));
        expect(bare).toContain('刪除剩餘未成交 —');
    });

    it('外層 operation 為準；payload.operation 不一致時只顯示操作名稱', () => {
        const mismatched: ApprovalRequest = {
            ...APPROVAL_FIXTURES.cancel!,
            payload: { ...(APPROVAL_FIXTURES.place!.payload as object), operation: 'place_order' },
        };
        expect(summarizeApproval(mismatched)).toBeNull();
        const html = text(render(mismatched));
        expect(html).not.toMatch(/買進\s*CCFI6/);
        expect(html).not.toContain('原委託');
        expect(html).toContain('刪單 操作 刪單');
        expect(html).toContain('核准刪單');
        // 反向：外層是新單、payload 宣稱刪單，也不畫刪單卡
        const reversed: ApprovalRequest = {
            ...APPROVAL_FIXTURES.place!,
            payload: APPROVAL_FIXTURES.cancel!.payload,
        };
        expect(summarizeApproval(reversed)).toBeNull();
        expect(text(render(reversed))).not.toContain('刪除剩餘未成交');
    });

    it('限價缺價格顯示 —；只有 MKT／MKP 顯示市價', () => {
        const order = { ...(APPROVAL_FIXTURES.cancel!.payload as { order: object }).order } as Record<string, unknown>;
        delete order.price;
        const noPrice = { ...APPROVAL_FIXTURES.cancel!, payload: { ...(APPROVAL_FIXTURES.cancel!.payload as object), order } };
        const html = text(render(noPrice));
        expect(html).toContain('原委託 買進 — × 5 張');
        expect(html).not.toContain('市價');
        for (const priceType of ['MKT', 'MKP']) {
            const market = { ...APPROVAL_FIXTURES.cancel!, payload: { ...(APPROVAL_FIXTURES.cancel!.payload as object), order: { ...order, price_type: priceType } } };
            expect(text(render(market))).toContain('原委託 買進 市價 × 5 張');
        }
        const place = APPROVAL_FIXTURES.place!.payload as { futures_order: Record<string, unknown> };
        const { price: _omit, ...futuresOrder } = place.futures_order;
        const newNoPrice = text(render({ ...APPROVAL_FIXTURES.place!, payload: { ...place, futures_order: futuresOrder } }));
        expect(newNoPrice).toContain('價格 —');
        const newMarket = text(render({ ...APPROVAL_FIXTURES.place!, payload: { ...place, futures_order: { ...futuresOrder, price_type: 'MKT', order_type: 'IOC' } } }));
        expect(newMarket).toContain('價格 市價');
    });

    it('期貨刪單以口為單位', () => {
        const futures: ApprovalRequest = {
            ...APPROVAL_FIXTURES.cancel!,
            payload: {
                operation: 'cancel_order',
                remaining_quantity: 1,
                contract: { security_type: 'FUT', code: 'TXFJ6', exchange: 'TAIFEX' },
                order: { action: 'Sell', price: 23000, quantity: 3, price_type: 'LMT', order_type: 'ROD' },
                status: { status: 'PartFilled', order_quantity: 3, deal_quantity: 2, cancel_quantity: 0 },
                request: { trade_id: 'f1' },
            },
        };
        const html = text(render(futures));
        expect(html).toContain('原委託 賣出 23,000 × 3 口');
        expect(html).toContain('刪除剩餘未成交 1 口');
    });
});
