import { describe, expect, it } from 'vitest';
import { contractLinkKey, isUsKey, parseContractLinkKey, sameContract, usLinkKey } from './contract-key';

describe('contract link key', () => {
    it('keeps TW codes bare and prefixes US codes', () => {
        expect(contractLinkKey({ code: '2330', region: 'TW' })).toBe('2330');
        expect(contractLinkKey({ code: '2330' })).toBe('2330');
        expect(contractLinkKey({ code: 'aapl', region: 'US' })).toBe('US:AAPL');
        expect(usLinkKey(' nvda ')).toBe('US:NVDA');
    });
    it('round-trips', () => {
        expect(parseContractLinkKey('US:AAPL')).toEqual({ region: 'US', code: 'AAPL' });
        expect(parseContractLinkKey('TXFR1')).toEqual({ region: 'TW', code: 'TXFR1' });
        expect(isUsKey('US:A')).toBe(true);
        expect(isUsKey('2330')).toBe(false);
    });
    it('never equates a US symbol with a TW code of the same text', () => {
        expect(sameContract({ code: 'T', region: 'US' }, { code: 'T', region: 'TW' })).toBe(false);
        expect(sameContract({ code: 'T', region: 'US' }, { code: 't', region: 'US' })).toBe(true);
    });
});
