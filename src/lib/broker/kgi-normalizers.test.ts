import { describe, expect, it } from 'vitest';
import {
    normalizeKgiAccount,
    normalizeKgiBidAsk,
    normalizeKgiSnapshot,
    normalizeKgiTick,
} from './kgi-normalizers';

describe('KGI broker normalizers', () => {
    it('maps KGI snapshots to the frontend Snapshot shape', () => {
        const snap = normalizeKgiSnapshot('2330', {
            exchange: 'TWSE',
            datetime: '20260817090102',
            price: 1205,
            open_price: 1200,
            high_price: 1210,
            low_price: 1195,
            bid_price: 1204,
            ask_price: 1205,
            bid_volume: 12,
            ask_volume: 8,
            volume: 3,
            total_volume: 9000,
            reference_price: 1200,
        });

        expect(snap).toMatchObject({
            code: '2330',
            exchange: 'TSE',
            close: 1205,
            change_price: 5,
            change_type: 'Up',
        });
    });

    it('normalizes tick and bid/ask timestamps from compact KGI datetimes', () => {
        const tick = normalizeKgiTick({
            symbol: '2330',
            datetime: '20260817090102',
            open: 1200,
            high: 1210,
            low: 1198,
            close: 1205,
            volume: 10,
            total_volume: 12345,
            price_chg: 5,
            pct_chg: 0.42,
        });
        const bidask = normalizeKgiBidAsk({
            symbol: '2330',
            datetime: '20260817090103',
            bid_prices: [1204, 1203],
            bid_volumes: [7, 6],
            ask_prices: [1205, 1206],
            ask_volumes: [8, 9],
        });

        expect(tick).toMatchObject({
            code: '2330',
            date: '2026-08-17',
            time: '09:01:02',
            close: '1205',
            tick_type: 0,
        });
        expect(bidask).toMatchObject({
            code: '2330',
            date: '2026-08-17',
            time: '09:01:03',
            bid_price: ['1204', '1203'],
            ask_volume: [8, 9],
        });
    });

    it('normalizes KGI account records without exposing credentials', () => {
        expect(
            normalizeKgiAccount({
                person_id: 'A123456789',
                broker_id: '9200',
                account: '1234567',
                account_flag: '證券',
                username: 'User',
            }),
        ).toMatchObject({
            account_type: 'S',
            broker_id: '9200',
            account_id: '1234567',
            signed: true,
        });
    });
});
