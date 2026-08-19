import { describe, expect, it } from 'vitest';
import { fmtMoney } from './format';

describe('money formatting', () => {
    it('keeps real zero distinct from unavailable account values', () => {
        expect(fmtMoney(0)).toBe('$0');
        expect(fmtMoney(null)).toBe('—');
    });
});
