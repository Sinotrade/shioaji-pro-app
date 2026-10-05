import { describe, expect, it } from 'vitest';
import { TWCA_TERMS, matchesTwcaTerms } from './twca-terms';

// 頁面上的條款：有標題、換行與網址，內容和登入畫面那份一致。
const PAGE = `憑證作業條款\n${TWCA_TERMS.join('\n').replace('網址為', '網址為 https://www.twca.com.tw/repository 。')}`;

describe('matchesTwcaTerms', () => {
    it('accepts the exact clauses with a title, line breaks and the CPS link', () => {
        expect(matchesTwcaTerms(PAGE)).toBe(true);
    });

    it('rejects a page with an extra numbered clause', () => {
        expect(matchesTwcaTerms(`${PAGE}\n八、本公司得隨時修改本條款。`)).toBe(false);
    });

    it('rejects a page missing a clause', () => {
        expect(matchesTwcaTerms(`憑證作業條款\n${TWCA_TERMS.slice(0, -1).join('\n')}`)).toBe(false);
    });

    it('rejects empty text', () => {
        expect(matchesTwcaTerms(null)).toBe(false);
        expect(matchesTwcaTerms('')).toBe(false);
    });
});
