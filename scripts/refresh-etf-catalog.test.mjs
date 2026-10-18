import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEtfCatalog as transform } from './refresh-etf-catalog.mjs';
import { buildEtfCatalog as normalize } from '../src/lib/etf-catalog-normalizer.mjs';

// Synthetic transformer fixtures, not real instruments or market observations.
const tse = [{ 基金代號: 'ETF1', 基金簡稱: '測試基金', 基金中文名稱: '測試基金完整名稱', 出表日期: '1151016' }];
const otc = { status: 'success', data: [{ stockNo: 'ETF2', stockName: '測試上櫃基金' }] };
const at = '2026-10-17T06:00:00.000Z';
const quotes = [{ Date: '1151016', Code: 'ETF1', Name: '測試基金' }];
const buildEtfCatalog = (rows, response, time) => transform(rows, response, time, quotes);

describe('ETF snapshot generator validation', () => {
    it('reuses the exact pure normalizer used by the runtime, not a second implementation', () => {
        assert.equal(transform, normalize);
    });
    it('keeps only public identity names and explicit source dates', () => {
        const out = buildEtfCatalog(tse, otc, at);
        assert.equal(out.entries.length, 2);
        assert.equal(out.sources[0].dataDate, '2026-10-16');
        assert.equal(out.sources[1].dataDate, null);
        assert.equal(out.retrievedAt, at);
        assert.deepEqual(out.entries.find(row => row.code === 'ETF1').aliases, ['測試基金完整名稱']);
        assert.deepEqual(Object.keys(out.entries[0]).sort(), ['code', 'exchange', 'name']);
    });
    it('rejects empty or failed sources instead of overwriting the snapshot', () => {
        assert.throws(() => buildEtfCatalog([], otc, at), /non-empty/);
        assert.throws(() => buildEtfCatalog(tse, { status: 'fail', data: [] }, at), /non-empty/);
    });
    it('rejects duplicate identities and malformed names/codes', () => {
        assert.throws(() => buildEtfCatalog([...tse, ...tse], otc, at), /Duplicate/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 基金代號: '<script>' }], otc, at), /Invalid/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 基金簡稱: '' }], otc, at), /Invalid/);
    });
    it('rejects invalid or inconsistent market dates', () => {
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 出表日期: '1150231' }], otc, at), /Invalid TWSE/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 出表日期: undefined }], otc, at), /date/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 出表日期: '1151016' }, { ...tse[0], 基金代號: 'ETF3', 出表日期: '1151015' }], otc, at), /inconsistent/);
    });
    it('decodes official HTML and numeric entities as plain text, never HTML markup', () => {
        const out = transform([{ ...tse[0], 基金簡稱: 'S&amp;P&#174;', 基金中文名稱: '測試&#63754;&#xAE;' }], otc, at, [{ ...quotes[0], Name: 'S&amp;P&#174;' }]);
        assert.equal(out.entries.find(row => row.code === 'ETF1').name, 'S&P®');
        assert.deepEqual(out.entries.find(row => row.code === 'ETF1').aliases, ['測試金®']);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 基金簡稱: '&unrecognized;' }], otc, at), /Unknown/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 基金簡稱: '&constructor;' }], otc, at), /Unknown/);
        assert.throws(() => buildEtfCatalog([{ ...tse[0], 基金簡稱: '&#99999999;' }], otc, at), /Invalid name character/);
    });
    it('keeps renamed daily names plus the prior fund name, without inventing ETFs from the daily table', () => {
        const daily = [{ ...quotes[0], Name: '更名後測試基金' }, { Date: '1151016', Code: 'STK1', Name: 'Synthetic ordinary equity' }];
        const out = transform(tse, otc, at, daily);
        assert.equal(out.entries.length, 2);
        const fund = out.entries.find(row => row.code === 'ETF1');
        assert.equal(fund.name, '更名後測試基金');
        assert.deepEqual(fund.aliases, ['測試基金', '測試基金完整名稱']);
        assert.equal(out.sources[2].dataDate, '2026-10-16');
        assert.throws(() => transform(tse, otc, at, []), /non-empty/);
        assert.throws(() => transform(tse, otc, at, [{ ...quotes[0], Date: '1151015' }]), /older/);
        assert.throws(() => transform(tse, otc, at, [...quotes, ...quotes]), /Duplicate TWSE daily/);
    });
    it('shares runtime hardening for malformed rows, future dates and control characters', () => {
        assert.throws(() => transform([null], otc, at, quotes), /Invalid ETF source row/);
        assert.throws(() => transform(tse, { status: 'success', data: [null] }, at, quotes), /Invalid ETF source row/);
        assert.throws(() => transform(tse, otc, at, [null]), /Invalid ETF source row/);
        assert.throws(() => transform(tse.map(row => ({ ...row, 出表日期: '1151018' })), otc, at,
            quotes.map(row => ({ ...row, Date: '1151018' }))), /future/);
        assert.throws(() => transform(tse, otc, at, quotes.map(row => ({ ...row, Name: '名稱&#10;換行' }))), /Invalid ETF name/);
    });
    it('shares previous-source shrink and date-regression guards, accepting an exact 20% reduction', () => {
        const funds = Array.from({ length: 5 }, (_, index) => ({ ...tse[0], 基金代號: `ETF${index + 1}` }));
        const prior = transform(funds, otc, at, quotes);
        assert.equal(transform(funds.slice(0, 4), otc, at, quotes, prior).entries.length, 5);
        assert.throws(() => transform(funds.slice(0, 3), otc, at, quotes, prior), /shrank/);
        assert.throws(() => transform(funds.map(row => ({ ...row, 出表日期: '1151015' })), otc, at,
            quotes.map(row => ({ ...row, Date: '1151015' })), prior), /became older/);
        assert.equal(prior.sources[0].count, 5);
        assert.equal(prior.sources[0].dataDate, '2026-10-16');
    });
    it('retains reviewed aliases only for identities still present in the refreshed official ETF source', () => {
        const funds = Array.from({ length: 5 }, (_, index) => ({ ...tse[0], 基金代號: `ETF${index + 1}` }));
        const prior = transform(funds, otc, at, quotes);
        const renamed = funds.slice(0, 4).map(row => ({ ...row, 基金簡稱: '合成新簡稱', 基金中文名稱: '合成新全名' }));
        const daily = quotes.map(row => ({ ...row, Name: '合成新每日名稱' }));
        const current = transform(renamed, otc, at, daily, prior);
        assert.deepEqual(current.entries.find(row => row.code === 'ETF1').aliases,
            ['合成新簡稱', '合成新全名', '測試基金', '測試基金完整名稱']);
        assert.equal(current.entries.some(row => row.code === 'ETF5'), false);
        assert.deepEqual(transform(renamed, otc, at, daily, current).entries, current.entries);
    });
});
