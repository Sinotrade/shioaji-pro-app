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

    it('payload 宣告的操作優先，缺資料時顯示 — 而非猜測', () => {
        const summary = summarizeApproval({
            operation: 'cancel_order',
            payload: { operation: 'cancel_order', request: { trade_id: 'x' } },
        });
        expect(summary).toMatchObject({ kind: 'modify', remaining: null, code: null });
        const html = text(
            render({ ...APPROVAL_FIXTURES.cancel!, payload: { request: { trade_id: 'x' } } }),
        );
        expect(html).toContain('刪除剩餘未成交 —');
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
