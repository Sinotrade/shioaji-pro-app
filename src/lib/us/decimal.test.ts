import { describe, expect, it } from 'vitest';
import { decAdd, decCompare, decFractionDigits, decIsWhole, decMul, decNormalize, decRound, decSub, decToInt, fmtDec } from './decimal';

describe('US decimal strings', () => {
    it('adds and subtracts without float drift', () => {
        expect(decAdd('0.1', '0.2')).toBe('0.3');
        expect(decSub('10', '3.5')).toBe('6.5');
        expect(decSub('3', '3.000')).toBe('0');
        expect(decAdd('1', 2)).toBe('3');
    });

    it('compares across scales', () => {
        expect(decCompare('173.9700', '173.97')).toBe(0);
        expect(decCompare('1.0001', '1')).toBe(1);
        expect(decCompare('-1', '0')).toBe(-1);
        expect(Number.isNaN(decCompare('abc', '1'))).toBe(true);
    });

    it('multiplies for estimated amounts and rounds half up', () => {
        expect(decMul('173.97', '10')).toBe('1739.7');
        expect(decRound('1.23456', 4)).toBe('1.2346');
        expect(decRound('2.5', 0)).toBe('3');
    });

    it('detects whole shares and fraction digits', () => {
        expect(decIsWhole('10.000')).toBe(true);
        expect(decIsWhole('10.5')).toBe(false);
        expect(decToInt('12')).toBe(12);
        expect(decToInt('1.5')).toBeNull();
        expect(decFractionDigits('1.23450')).toBe(5);
        expect(decNormalize(' 007.500 ')).toBe('7.5');
    });

    it('formats with separators and keeps the given digits', () => {
        expect(fmtDec('12345.6', { minFraction: 2 })).toBe('12,345.60');
        expect(fmtDec('0.0001')).toBe('0.0001');
        expect(fmtDec(null)).toBe('—');
        expect(fmtDec('-1234.5')).toBe('-1,234.5');
    });
});
