import { describe, expect, it } from 'vitest';
import {
    normalizeQuoteState,
    normalizeScannerItem,
} from './quote-model';
import type { ContractInfo } from './types/contract';
import type { ScannerItem, Snapshot } from './types/market';

const contract: ContractInfo = {
    region: 'TW',
    exchange: 'TSE',
    code: '2330',
    security_type: 'STK',
    target_code: null,
    name: '台積電',
    currency: 'TWD',
    limit_up: 1100,
    limit_down: 900,
    reference: 1000,
    day_trade: 'Yes',
    update_date: '2026-08-18',
    category: '',
    margin_trading_balance: 0,
    short_selling_balance: 0,
};

function snapshot(patch: Partial<Snapshot>): Snapshot {
    return {
        code: '2330',
        exchange: 'TSE',
        datetime: '2026-08-18T09:01:00',
        open: 970,
        high: 980,
        low: 965,
        close: 975,
        average_price: 972,
        buy_price: 974,
        buy_volume: 10,
        sell_price: 975,
        sell_volume: 12,
        volume: 1,
        total_volume: 1000,
        amount: 975000,
        total_amount: 975000000,
        change_price: 5,
        change_rate: 0.515,
        change_type: 'Up',
        tick_type: '0',
        volume_ratio: 0,
        yesterday_volume: 0,
        ...patch,
    };
}

function scannerItem(patch: Partial<ScannerItem>): ScannerItem {
    return {
        code: '6225',
        name: '天瀚',
        date: '2026-08-18',
        close: 12,
        open: 10,
        high: 12,
        low: 10,
        change_price: 2,
        change_rate: undefined,
        change_type: 1,
        average_price: 11,
        price_range: 2,
        rank_value: 20,
        total_volume: 1000,
        total_amount: 12000000,
        volume_ratio: 1,
        yesterday_volume: 100,
        tick_type: 0,
        buy_price: 12,
        sell_price: 12.05,
        ...patch,
    };
}

describe('frontend quote normalization', () => {
    it('colors stock snapshots from real snapshot change instead of stale contract reference', () => {
        const quote = normalizeQuoteState(
            undefined,
            snapshot({ close: 975, change_price: 5 }),
            contract,
        );

        expect(quote.reference).toBe(970);
        expect(quote.change).toBe(5);
        expect(quote.changePercent).toBeCloseTo(0.51546, 4);
        expect(quote.direction).toBe('up');
    });

    it('keeps exact zero change flat rather than falling through to stale data', () => {
        const quote = normalizeQuoteState(
            {
                tick: {
                    code: '2330',
                    date: '2026-08-18',
                    time: '09:02:00',
                    open: '1000',
                    high: '1000',
                    low: '1000',
                    close: '1000',
                    volume: 1,
                    total_volume: 10,
                    tick_type: 0,
                    price_chg: '0',
                },
                lastDir: 0,
                seq: 1,
                flashSeq: 1,
            },
            snapshot({ close: 990, change_price: -10 }),
            contract,
        );

        expect(quote.change).toBe(0);
        expect(quote.changePercent).toBe(0);
        expect(quote.direction).toBe('flat');
    });

    it('does not invent a percent when neither reference nor change is valid', () => {
        const quote = normalizeQuoteState(
            undefined,
            snapshot({ close: 100, change_price: Number.NaN }),
            { ...contract, reference: 0 },
        );

        expect(quote.price).toBe(100);
        expect(quote.reference).toBeNull();
        expect(quote.change).toBeNull();
        expect(quote.changePercent).toBeNull();
        expect(quote.direction).toBe('flat');
    });

    it('normalizes weighted-index fields for header rendering', () => {
        const quote = normalizeQuoteState({
            index: {
                code: 'IX0001',
                exchange: 'TSE',
                date: '2026-08-18',
                time: '13:30:00',
                reference: '45857.27',
                close: '45308.68',
                change_price: '-548.59',
                open: '45922.4',
                high: '46064.09',
                low: '45225.42',
            },
            lastDir: 0,
            seq: 1,
            flashSeq: 1,
        });

        expect(quote.price).toBe(45308.68);
        expect(quote.change).toBe(-548.59);
        expect(quote.changePercent).toBeCloseTo(-1.1963, 4);
        expect(quote.direction).toBe('down');
    });

    it('normalizes ranking rows with close-change reference math', () => {
        const quote = normalizeScannerItem(
            scannerItem({ close: 100, change_price: -5 }),
        );

        expect(quote.reference).toBe(105);
        expect(quote.changePercent).toBeCloseTo(-4.7619, 4);
        expect(quote.direction).toBe('down');
    });

    it('prefers explicit backend ranking percent when present', () => {
        const quote = normalizeScannerItem(
            scannerItem({
                close: 48.8,
                change_price: 18.76,
                change_rate: 38.442622950819676,
            }),
        );

        expect(quote.changePercent).toBeCloseTo(38.4426, 4);
        expect(quote.direction).toBe('up');
    });
});
