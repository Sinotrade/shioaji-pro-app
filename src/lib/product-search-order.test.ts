import { describe, expect, it } from 'vitest';
import { orderResults, parseProductQuery, pickAnchor, type ProductSuggestion, type ResultParts } from './product-search';
import type { StockMeta } from './stock-index';
import type { ContractInfo } from './types/contract';

// Pure query, identity and ordering rules: no source, cache or timer is involved.
function contract(code: string, type: 'STK' | 'FUT' | 'WRT', rest: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, name: code, security_type: type, exchange: type === 'FUT' ? 'TAIFEX' : 'TSE',
        target_code: null, currency: 'TWD', limit_up: 0, limit_down: 0, reference: 0, day_trade: '',
        update_date: '', category: '', margin_trading_balance: 0, short_selling_balance: 0, ...rest,
    };
}
const stock = (code: string, name: string, fields: Partial<StockMeta> = {}): StockMeta =>
    ({ code, name, exchange: 'TSE', category: '', ...fields });
const row = (code: string, security_type: ProductSuggestion['security_type']): ProductSuggestion =>
    ({ code, name: code, security_type, exchange: 'TSE', detail: '' });
const codes = (rows: { code: string }[]) => rows.map(item => item.code);

const tsmc = stock('2330', '台積電');
// Synthetic names/codes make the small root sort first by code and root-name
// length, so passing cannot rely on CDF/QFF letters.
const ordered = [
    contract('ZZZR1', 'FUT', { root: 'ZZZ', name: '測試一般期貨 近月', delivery_month: '202610', target_code: 'ZZZJ6' }),
    contract('AAAR1', 'FUT', { root: 'AAA', name: '小型測試期貨 近月', delivery_month: '202610', target_code: 'AAAJ6' }),
    contract('ZZZR2', 'FUT', { root: 'ZZZ', name: '測試一般期貨 次月', delivery_month: '202611', target_code: 'ZZZK6' }),
    contract('AAAR2', 'FUT', { root: 'AAA', name: '小型測試期貨 次月', delivery_month: '202611', target_code: 'AAAK6' }),
];
const exactTsmc = pickAnchor(parseProductQuery('台積電'), [tsmc], null);
const futuresOf = (futures: ContractInfo[], limit = 10) =>
    codes(orderResults(exactTsmc, { priority: [], stocks: [], futures }, limit));

describe('parseProductQuery', () => {
    it.each([
        ['臺積電期貨', { raw: '台積電期貨', lookup: '台積電', wantsFutures: true, wantsOptions: false, wantsWarrants: false }],
        ['台積電個股期', { lookup: '台積電', wantsFutures: true }],
        ['台指期', { lookup: '台指', wantsFutures: true }],
        ['2330選擇權', { lookup: '2330', wantsOptions: true, wantsFutures: false }],
        ['台積電權證', { lookup: '台積電', wantsWarrants: true }],
        [' tsmc warrant ', { raw: 'TSMC WARRANT', lookup: 'TSMC', wantsWarrants: true }],
        ['期貨', { lookup: '期貨', wantsFutures: true }],
        ['ＩＸ００４３', { raw: 'IX0043', lookup: 'IX0043', exactIndex: false }],
    ])('%s', (query, expected) => {
        expect(parseProductQuery(query)).toMatchObject(expected);
    });

    it('marks only a complete index name as exact, so index codes use the direct lookup', () => {
        expect(parseProductQuery('臺指選擇權波動率指數')).toMatchObject({ exactIndex: true });
        expect(parseProductQuery('櫃買指數').exactIndex).toBe(true);
        expect(parseProductQuery('櫃買').exactIndex).toBe(false);
        expect(parseProductQuery('IX0001').exactIndex).toBe(false);
    });
});

describe('pickAnchor', () => {
    it('anchors an exact name and a unique name prefix, and then lets futures lead', () => {
        for (const query of ['台積電', '臺積電', '2330', '台積']) {
            expect(pickAnchor(parseProductQuery(query), [tsmc], null)).toMatchObject({ exactStock: tsmc, futuresFirst: true });
        }
    });

    it.each([
        ['an ambiguous prefix', '台積', [tsmc, stock('FIXTURE', '台積其他測試股')]],
        ['a unique non-prefix substring', '積電', [tsmc]],
        ['a fuzzy first character', '台', [tsmc, stock('1301', '台塑')]],
        ['a code-only name fallback', '233', [tsmc, stock('2337', '2337')]],
    ])('does not anchor %s', (_label, query, catalog) => {
        expect(pickAnchor(parseProductQuery(query), catalog, null)).toMatchObject({ exactStock: undefined, futuresFirst: false });
    });

    it('falls back to a direct stock identity when the catalog has none', () => {
        const direct = contract('2330', 'STK', { name: '台積電', exchange: null });
        expect(pickAnchor(parseProductQuery('2330'), [], direct).exactStock).toMatchObject({ code: '2330', exchange: '', category: '' });
        expect(pickAnchor(parseProductQuery('CDFR1'), [], contract('CDFR1', 'FUT')).exactStock).toBeUndefined();
    });

    it('keeps 期貨 inside an exact ETF name instead of stripping it into a futures query', () => {
        const fund = stock('00999F', '測試期貨ETF', { kind: 'ETF', aliases: ['測試期貨正式名稱'] });
        for (const query of ['測試期貨ETF', '測試期貨正式名稱']) {
            expect(pickAnchor(parseProductQuery(query), [fund], null)).toMatchObject({
                exactStock: fund, query: { lookup: parseProductQuery(query).raw, wantsFutures: false, wantsOptions: false },
            });
        }
    });

    it.each(['台指', '台股期貨'])('uses the verified IX0001 underlying for %s without promoting a stock prefix', query => {
        expect(pickAnchor(parseProductQuery(query), [stock('9999', '台指測試股')], null)).toMatchObject({
            exactStock: undefined, indexFutureUnderlying: 'IX0001', futuresFirst: true,
        });
    });
});

describe('orderResults futures', () => {
    it('orders regular near, small near, regular next, small next regardless of input order', () => {
        expect(futuresOf([ordered[3]!, ordered[1]!, ordered[2]!, ordered[0]!])).toEqual(codes(ordered));
        expect(futuresOf([...ordered].reverse().map(item => ({ ...item, delivery_month: undefined })))).toEqual(codes(ordered));
    });

    it.each(['ZZZ', 'AAA'])('keeps near before next when only root %s is available', root => {
        expect(futuresOf(ordered.filter(item => item.root === root).reverse())).toEqual([`${root}R1`, `${root}R2`]);
    });

    it('keeps each month together in regular, small, micro order without mutating identities', () => {
        const dated = contract('ZZZJ6', 'FUT', { name: '測試一般期貨 202610', delivery_month: '202610' });
        const micro = contract('MMMR1', 'FUT', { name: '微型測試期貨 近月', delivery_month: '202610', target_code: 'MMMJ6' });
        const source = [dated, micro, ...ordered].reverse();
        const before = structuredClone(source);
        const rows = orderResults(exactTsmc, { priority: [], stocks: [], futures: source }, 10);
        expect(codes(rows)).toEqual(['ZZZR1', 'AAAR1', 'MMMR1', 'ZZZR2', 'AAAR2']);
        expect(source).toEqual(before);
        expect(rows.find(item => item.code === 'MMMR1')?.contract).toBe(micro);
        expect(rows.map(item => item.detail)).toEqual(['期貨 · 近月', '期貨 · 近月', '期貨 · 近月', '期貨 · 次月', '期貨 · 次月']);
    });

    it.each([4, undefined])('does not let a weekly mini future evict micro next month (week=%s)', week => {
        const monthly = ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFR2'];
        const rows = [
            contract('MX4R1', 'FUT', { name: '小型臺指期貨 202610 W4 近月', week_of_month: week, target_code: 'MX4J6' }),
            ...monthly.map((code, i) => contract(code, 'FUT', { name: ['臺股期貨', '小型臺指期貨', '微型臺指期貨'][i % 3] })),
        ];
        expect(futuresOf(rows)).toEqual(monthly);
    });
});

describe('orderResults groups', () => {
    const futures = ordered;
    const warrants = ['W1', 'W2', 'W3'].map(code => row(code, 'WRT'));
    const indices = [row('IX0043', 'IND')];

    it('lists an exact stock, its futures, other matching stocks, warrants, then indices', () => {
        const anchor = pickAnchor(parseProductQuery('南亞'), [stock('1303', '南亞'), stock('2408', '南亞科')], null);
        const rows = orderResults(anchor, {
            priority: [row('1303', 'STK')], stocks: [stock('1303', '南亞'), stock('2408', '南亞科')],
            futures, warrants, indices,
        }, 20);
        expect(codes(rows)).toEqual(['1303', ...codes(ordered), '2408', 'W1', 'W2', 'W3', 'IX0043']);
    });

    it('lets matching stocks lead when there is no anchor', () => {
        const anchor = pickAnchor(parseProductQuery('台'), [tsmc, stock('1301', '台塑')], null);
        const rows = orderResults(anchor, { priority: [], stocks: [tsmc, stock('1301', '台塑')], futures, warrants: [], indices }, 20);
        expect(codes(rows)).toEqual(['2330', '1301', ...codes(ordered), 'IX0043']);
    });

    it('returns only the stable prefix before a still-loading source, each a prefix of the final rows', () => {
        const base = { priority: [row('2330', 'STK')], stocks: [tsmc] };
        const stages: ResultParts[] = [base, { ...base, futures }, { ...base, futures, warrants }, { ...base, futures, warrants, indices }];
        const [first, second, third, final] = stages.map(parts => codes(orderResults(exactTsmc, parts, 8)));
        expect(first).toEqual(['2330']);
        expect(second).toEqual(['2330', ...codes(ordered)]);
        expect(third).toEqual(['2330', ...codes(ordered), 'W1', 'W2', 'W3']);
        for (const prefix of [first!, second!, third!]) expect(final!.slice(0, prefix.length)).toEqual(prefix);
    });

    it('removes duplicate identities and applies the limit after grouping', () => {
        const rows = orderResults(exactTsmc, {
            priority: [row('2330', 'STK'), row('2330', 'STK')], stocks: [tsmc], futures, warrants, indices,
        }, 6);
        expect(codes(rows)).toEqual(['2330', ...codes(ordered), 'W1']);
    });

    it.each([
        ['選擇權', 'options'], ['權證', 'warrants'],
    ] as const)('round-robins %s, indices and stocks after the direct row', (word, source) => {
        const anchor = pickAnchor(parseProductQuery(`台積電${word}`), [tsmc], null);
        const primary = ['A', 'B', 'C'].map(code => row(code, source === 'options' ? 'OPT' : 'WRT'));
        const parts: ResultParts = { priority: [row('2330', 'STK')], stocks: [tsmc, stock('2331', '台積電二')], indices, [source]: primary };
        expect(codes(orderResults(anchor, parts, 10))).toEqual(['2330', 'A', 'IX0043', 'B', '2331', 'C']);
        expect(codes(orderResults(anchor, { ...parts, indices: undefined }, 10))).toEqual(['2330']);
    });
});
