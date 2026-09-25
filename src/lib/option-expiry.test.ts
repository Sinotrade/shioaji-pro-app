// src/lib/option-expiry.test.ts — 月選＋週選到期契約（issue #152）

import { describe, expect, it } from 'vitest';
import {
    buildExpiries,
    contractsForExpiry,
    daysLeftLabel,
    expiryTitle,
    groupByMonth,
    isChainContract,
    pickChainRoots,
    resolveExpiry,
    taipeiToday,
    type ChainContract,
} from './option-expiry';

// 模擬環境 options/roots（2026-09-25）的 TAIFEX 指數選擇權部分
const ROOTS = [
    { root: 'CDO', name: '台積電選擇權' },
    { root: 'TEO', name: '電子選擇權' },
    { root: 'TFO', name: '金融選擇權' },
    { root: 'TGO', name: '黃金選擇權' },
    { root: 'TX1', name: '臺指選擇權 週三W1' },
    { root: 'TX5', name: '臺指選擇權 週三W5' },
    { root: 'TXO', name: '臺指選擇權' },
    { root: 'TXU', name: '臺指選擇權 週五W1' },
    { root: 'TXY', name: '臺指選擇權 週五W4' },
];

function series(
    root: string,
    date: string,
    n: number,
    extra: Partial<ChainContract> = {},
): ChainContract[] {
    const rows: ChainContract[] = [];
    for (let i = 0; i < n; i++) {
        const strike = 40000 + Math.floor(i / 2) * 100;
        const right = i % 2 === 0 ? 'C' : 'P';
        rows.push({
            security_type: 'OPT',
            exchange: 'TAIFEX',
            code: `${root}${strike}${right}${date}`,
            target_code: null,
            name: `${root} ${strike} ${right}`,
            currency: 'TWD',
            limit_up: 0,
            limit_down: 0,
            reference: 0,
            day_trade: '',
            update_date: '2026-09-24',
            category: '',
            margin_trading_balance: 0,
            short_selling_balance: 0,
            root,
            delivery_month: date.slice(0, 7).replace('-', ''),
            delivery_date: date,
            strike_price: strike,
            option_right: right,
            underlying_code: 'IX0001',
            expiry_weekday: root === 'TXU' || root === 'TXY' ? 'Fri' : 'Wed',
            ...extra,
        });
    }
    return rows;
}

const TODAY = '2026-09-25';
const CONTRACTS = [
    ...series('TXO', '2026-10-21', 40),
    ...series('TXO', '2026-11-18', 30),
    ...series('TXO', '2026-09-16', 20), // 已到期
    ...series('TX1', '2026-10-07', 30),
    ...series('TX5', '2026-09-30', 30),
    ...series('TXU', '2026-10-02', 30),
    ...series('TXY', '2026-09-29', 30),
    ...series('TX2', '2026-10-14', 3), // 只有占位合約
    ...series('TEO', '2026-10-21', 30, { underlying_code: 'IX0027' }),
];

describe('pickChainRoots', () => {
    it('finds the monthly root first plus weekly roots, not other indices', () => {
        expect(pickChainRoots(ROOTS)).toEqual(['TXO', 'TX1', 'TX5', 'TXU', 'TXY']);
    });

    it('discovers new weekly roots by name even without the TX? convention', () => {
        const roots = [...ROOTS, { root: 'TZW', name: '臺指選擇權 週五W2' }];
        expect(pickChainRoots(roots)).toContain('TZW');
    });

    it('always keeps the monthly root when roots omit it', () => {
        expect(pickChainRoots([])).toEqual(['TXO']);
    });
});

describe('buildExpiries', () => {
    const expiries = buildExpiries(CONTRACTS, TODAY);

    it('lists monthly and weekly expiries sorted by date, keyed by root + date', () => {
        expect(expiries.map((e) => e.key)).toEqual([
            'TXY:2026-09-29',
            'TX5:2026-09-30',
            'TXU:2026-10-02',
            'TX1:2026-10-07',
            'TXO:2026-10-21',
            'TXO:2026-11-18',
        ]);
    });

    it('labels kind and days to expiry', () => {
        const byKey = new Map(expiries.map((e) => [e.key, e]));
        expect(byKey.get('TXY:2026-09-29')).toMatchObject({ kind: 'fri', daysLeft: 4, month: '202609' });
        expect(byKey.get('TX5:2026-09-30')).toMatchObject({ kind: 'wed', daysLeft: 5 });
        expect(byKey.get('TXO:2026-10-21')).toMatchObject({ kind: 'monthly', daysLeft: 26, contracts: 40 });
    });

    it('drops expired, placeholder-only and other-underlying series', () => {
        const keys = expiries.map((e) => e.key);
        expect(keys).not.toContain('TXO:2026-09-16');
        expect(keys).not.toContain('TX2:2026-10-14');
        expect(keys.some((k) => k.startsWith('TEO'))).toBe(false);
    });

    it('keeps an expiry on its delivery day and puts monthly first on a shared date', () => {
        const sameDay = [
            ...series('TX3', '2026-10-21', 20),
            ...series('TXO', '2026-10-21', 20),
        ];
        const list = buildExpiries(sameDay, '2026-10-21');
        expect(list.map((e) => e.key)).toEqual(['TXO:2026-10-21', 'TX3:2026-10-21']);
        expect(list[0]!.daysLeft).toBe(0);
        expect(daysLeftLabel(0)).toBe('今日');
    });

    it('returns only the contracts of the selected weekly expiry', () => {
        const rows = contractsForExpiry(CONTRACTS, 'TX1:2026-10-07');
        expect(rows).toHaveLength(30);
        expect(rows.every((c) => c.root === 'TX1')).toBe(true);
    });

    it('groups chips by delivery month in order', () => {
        expect(groupByMonth(expiries).map((g) => [g.month, g.items.length])).toEqual([
            ['202609', 2],
            ['202610', 3],
            ['202611', 1],
        ]);
    });

    it('describes an expiry for tooltips', () => {
        expect(expiryTitle(expiries[0]!)).toBe('2026/09/29 到期 · 週五週選（TXY）· 剩 4 天');
    });
});

describe('resolveExpiry', () => {
    const expiries = buildExpiries(CONTRACTS, TODAY);

    it('defaults to the nearest expiry', () => {
        expect(resolveExpiry(expiries, null)).toBe('TXY:2026-09-29');
    });

    it('keeps a remembered expiry that is still listed', () => {
        expect(resolveExpiry(expiries, 'TX1:2026-10-07')).toBe('TX1:2026-10-07');
    });

    it('falls back to the nearest expiry once the remembered one expired', () => {
        const later = buildExpiries(CONTRACTS, '2026-10-03');
        expect(resolveExpiry(later, 'TXU:2026-10-02')).toBe('TX1:2026-10-07');
        // 舊版只記月份的值也視為不存在
        expect(resolveExpiry(later, '202610')).toBe('TX1:2026-10-07');
    });

    it('is empty when nothing is listed', () => {
        expect(resolveExpiry([], 'TXO:2026-10-21')).toBe('');
    });
});

describe('helpers', () => {
    it('computes the Taipei calendar date', () => {
        // 2026-09-25 16:30 UTC = 2026-09-26 00:30 Taipei
        expect(taipeiToday(Date.UTC(2026, 8, 25, 16, 30))).toBe('2026-09-26');
        expect(taipeiToday(Date.UTC(2026, 8, 25, 15, 59))).toBe('2026-09-25');
    });

    it('accepts only options with a usable delivery date', () => {
        const [ok] = series('TX1', '2026-10-07', 1);
        expect(isChainContract(ok!)).toBe(true);
        expect(isChainContract({ ...ok!, delivery_date: '' })).toBe(false);
        expect(isChainContract({ ...ok!, security_type: 'FUT' })).toBe(false);
    });
});
