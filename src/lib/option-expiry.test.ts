// src/lib/option-expiry.test.ts — 月選＋週選到期契約（issue #152）

import { describe, expect, it } from 'vitest';
import {
    buildExpiries,
    chainUnderlying,
    chooseAtmReference,
    migrateLegacyMonth,
    msUntilNextBoundary,
    taipeiClock,
    contractsForExpiry,
    daysLeftLabel,
    expiryTitle,
    groupByMonth,
    identifiedChainRoots,
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

    it('requires the 臺指選擇權 name prefix and uses the TX? pattern only without a name', () => {
        const roots = [
            { root: 'TXO', name: '臺指選擇權' },
            { root: 'TXQ', name: '其他選擇權' },
            { root: 'TX9', name: '' },
            { root: 'TXAB' },
        ];
        expect(pickChainRoots(roots)).toEqual(['TXO', 'TX9']);
        // no monthly row: the family name still gates named roots
        expect(pickChainRoots([{ root: 'TX1', name: '臺指選擇權 週三W1' }, { root: 'TXQ', name: '其他' }])).toEqual(['TXO', 'TX1']);
    });

    it('always keeps the monthly root when roots omit it', () => {
        expect(pickChainRoots([])).toEqual(['TXO']);
    });
});

describe('identifiedChainRoots', () => {
    it('keeps named family roots and known weekly codes, not unnamed TX? guesses', () => {
        const roots = [
            ...ROOTS,
            { root: 'TXN', name: '' },
            { root: 'TX2' },
            { root: 'TXQ', name: '其他選擇權' },
        ];
        expect(pickChainRoots(roots)).toContain('TXN');
        expect(identifiedChainRoots(roots)).toEqual(['TXO', 'TX1', 'TX5', 'TXU', 'TXY', 'TX2']);
    });
});

describe('buildExpiries without underlying_code (fail closed)', () => {
    const noUnderlying = (root: string, date: string, n: number) =>
        series(root, date, n, { underlying_code: undefined });

    it('lists only the monthly when an unnamed TX? root cannot be verified', () => {
        const contracts = [
            ...noUnderlying('TXO', '2026-10-21', 30),
            ...noUnderlying('TXN', '2026-10-09', 30),
        ];
        const identified = identifiedChainRoots([
            { root: 'TXO', name: '臺指選擇權' },
            { root: 'TXN' },
        ]);
        expect(buildExpiries(contracts, TODAY, { identified }).map((e) => e.key)).toEqual([
            'TXO:2026-10-21',
        ]);
        // 未提供 identified 時也從嚴
        expect(buildExpiries(contracts, TODAY).map((e) => e.key)).toEqual(['TXO:2026-10-21']);
    });

    it('still lists named weeklies and known weekly codes', () => {
        const contracts = [
            ...noUnderlying('TXO', '2026-10-21', 30),
            ...noUnderlying('TXU', '2026-10-02', 30),
            ...noUnderlying('TX1', '2026-10-07', 30),
            ...noUnderlying('TXN', '2026-10-09', 30),
        ];
        const identified = identifiedChainRoots([
            { root: 'TXO', name: '臺指選擇權' },
            { root: 'TXU', name: '臺指選擇權 週五W1' },
            { root: 'TX1' },
            { root: 'TXN' },
        ]);
        expect(buildExpiries(contracts, TODAY, { identified }).map((e) => e.key)).toEqual([
            'TXU:2026-10-02',
            'TX1:2026-10-07',
            'TXO:2026-10-21',
        ]);
    });

    it('admits an unnamed root once its underlying matches the monthly', () => {
        const contracts = [...series('TXO', '2026-10-21', 30), ...series('TXN', '2026-10-09', 30)];
        const identified = ['TXO'];
        expect(buildExpiries(contracts, TODAY, { identified }).map((e) => e.key)).toEqual([
            'TXN:2026-10-09',
            'TXO:2026-10-21',
        ]);
    });

    it('does not let an unidentified root pick the underlying when the monthly is missing', () => {
        const contracts = [
            ...series('TXN', '2026-10-09', 60, { underlying_code: 'IX0027' }),
            ...series('TXU', '2026-10-02', 30),
        ];
        const identified = ['TXO', 'TXU'];
        expect(chainUnderlying(contracts, { identified })).toBe('IX0001');
        expect(buildExpiries(contracts, TODAY, { identified }).map((e) => e.key)).toEqual([
            'TXU:2026-10-02',
        ]);
        // 沒有任何可確認的 underlying：無名代碼也不列
        const onlyUnnamed = series('TXN', '2026-10-09', 30, { underlying_code: 'IX0027' });
        expect(chainUnderlying(onlyUnnamed, { identified })).toBeUndefined();
        expect(buildExpiries(onlyUnnamed, TODAY, { identified })).toEqual([]);
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
        // 模擬資料：TXY 原定週五，實際 09/29 是週二（遇假日調整）
        expect(expiryTitle(expiries[0]!)).toBe(
            '2026/09/29（二）到期 · 週五週選（TXY） · 原定週五，遇假日調整為週二 · 剩 4 天',
        );
        expect(expiries[0]!.shiftedFrom).toBe(5);
        expect(expiries.find((e) => e.key === 'TXU:2026-10-02')!.shiftedFrom).toBeNull();
    });

    it('falls back to the delivery date weekday when expiry_weekday is missing', () => {
        const list = buildExpiries(
            [
                ...series('TXA', '2026-10-09', 30, { expiry_weekday: undefined }),
                ...series('TXB', '2026-10-14', 30, { expiry_weekday: undefined }),
                ...series('TXO', '2026-10-21', 30),
            ],
            TODAY,
        );
        expect(list.map((e) => [e.root, e.kind, e.shiftedFrom])).toEqual([
            ['TXA', 'fri', null],
            ['TXB', 'wed', null],
            ['TXO', 'monthly', null],
        ]);
    });

    it('drops contracts without underlying_code once the monthly has one', () => {
        const list = buildExpiries(
            [...series('TXO', '2026-10-21', 30), ...series('TX1', '2026-10-07', 30, { underlying_code: undefined })],
            TODAY,
        );
        expect(list.map((e) => e.key)).toEqual(['TXO:2026-10-21']);
    });

    it('keeps an expiry until the 13:45 close on its delivery day', () => {
        const before = buildExpiries(CONTRACTS, { date: '2026-09-29', minutes: 13 * 60 + 44 });
        const after = buildExpiries(CONTRACTS, { date: '2026-09-29', minutes: 13 * 60 + 45 });
        expect(before[0]!.key).toBe('TXY:2026-09-29');
        expect(resolveExpiry(before, null)).toBe('TXY:2026-09-29');
        expect(after.map((e) => e.key)).not.toContain('TXY:2026-09-29');
        expect(resolveExpiry(after, 'TXY:2026-09-29')).toBe('TX5:2026-09-30');
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

describe('legacy month memory', () => {
    const expiries = buildExpiries(CONTRACTS, TODAY);

    it('maps an old YYYYMM to that month\'s monthly expiry', () => {
        expect(migrateLegacyMonth(expiries, '202610')).toBe('TXO:2026-10-21');
        expect(migrateLegacyMonth(expiries, '202611')).toBe('TXO:2026-11-18');
    });

    it('returns null when the old month is gone or unset', () => {
        expect(migrateLegacyMonth(expiries, '202609')).toBeNull();
        expect(migrateLegacyMonth(expiries, null)).toBeNull();
    });
});

describe('chooseAtmReference', () => {
    it('takes the first usable price in order', () => {
        expect(
            chooseAtmReference([
                { label: '加權', value: undefined },
                { label: 'TXF', value: 40500, change: -20 },
            ]),
        ).toEqual({ label: 'TXF', value: 40500, change: -20 });
        expect(chooseAtmReference([{ label: '加權', value: 0 }, { label: 'TXF', value: Number.NaN }])).toBeNull();
    });
});

describe('helpers', () => {
    it('reports the Taipei clock and the next close/midnight boundary', () => {
        const at = Date.UTC(2026, 8, 25, 5, 0); // 13:00 Taipei
        expect(taipeiClock(at)).toEqual({ date: '2026-09-25', minutes: 13 * 60 });
        expect(msUntilNextBoundary(at)).toBe(45 * 60_000);
        const evening = Date.UTC(2026, 8, 25, 12, 0); // 20:00 Taipei
        expect(msUntilNextBoundary(evening)).toBe(4 * 3600_000);
    });

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
