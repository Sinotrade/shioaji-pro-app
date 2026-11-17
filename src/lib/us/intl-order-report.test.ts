// IntlOrder／IntlDeal（美股）SSE 回報的正規化與文案
import { describe, expect, it } from 'vitest';
import fx from './__fixtures__/intl-order-events.json';
import { describeOrderReport, normalizeOrderEvent } from '../order-report';
import { reportBody } from '../portfolio-projection';

describe('IntlOrder / IntlDeal normalization', () => {
    it('keeps decimal strings and time_in_force for US orders', () => {
        const r = normalizeOrderEvent(fx.orderNew)!;
        expect(r).toMatchObject({ kind: 'order', market: 'us', opType: 'New', code: 'NVDA', id: '4cb2f7e1',
            priceText: '173.97', quantityText: '200', orderQuantityText: '200', timeInForce: 'DAY', eventId: 'v1:IO:A1EGUioPh:BTZhXIe:1' });
        expect(reportBody(r)?.order).toMatchObject({ account: { account_type: 'H' } });
        const d = describeOrderReport(r);
        expect(d.kind).toBe('ok');
        expect(d.lines[0]!.text).toBe('買進 NVDA 200 股 @ 173.97');
        expect(d.lines[1]!.text).toContain('美股 DAY');
    });

    it('reports reductions and cancels in shares', () => {
        const u = normalizeOrderEvent(fx.orderUpdateQty)!;
        expect(describeOrderReport(u).lines[0]!.text).toBe('買進 NVDA 減量 50 股');
        const c = normalizeOrderEvent(fx.orderCancel)!;
        expect(c.kind === 'order' && c.orderQuantityText).toBe('0');
        expect(describeOrderReport(c).lines[0]!.text).toBe('買進 NVDA 已取消 150 股');
    });

    it('shows a rejection op_msg verbatim', () => {
        const f = normalizeOrderEvent(fx.orderNewFailed)!;
        expect(f.kind === 'order' && f.failed).toBe(true);
        const d = describeOrderReport(f);
        expect(d.kind).toBe('err');
        expect(d.lines[1]!.text).toBe('REJECTED（代碼 8）');
    });

    it('normalizes fractional deals without float rounding', () => {
        const d = normalizeOrderEvent(fx.deal)!;
        expect(d).toMatchObject({ kind: 'deal', market: 'us', tradeId: '4cb2f7e1', priceText: '173.95', quantityText: '0.5' });
        expect(describeOrderReport(d).lines[0]!.text).toBe('買進 NVDA 0.5 股 @ 173.95');
        expect(reportBody(d)?.exchange_seq).toBe('107283171');
    });
});
