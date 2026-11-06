import { describe, expect, it } from 'vitest';
import { isTradingLimitsWindowError } from './trading-limits-error';

describe('isTradingLimitsWindowError', () => {
    it.each([
        // the real payload, after throwApiError prefixed the status (#381)
        '500 Query error: QCredit:Query fail{StartTime=83000, EndTime=150000}',
        'Query error: QCredit:Query fail{StartTime=83000, EndTime=150000}',
        // a moved window or reformatted message is still the same answer
        'qcredit: query fail {starttime=90000,endtime=133000}',
        'QCredit Query fail{EndTime: 150000, StartTime: 83000}',
    ])('recognises %s', message => {
        expect(isTradingLimitsWindowError(message)).toBe(true);
    });

    it.each([
        null, undefined, '',
        'Failed to fetch',
        'TypeError: NetworkError when attempting to fetch resource.',
        '503 Service Unavailable',
        '500 Query error: session disconnected',
        '500 Query error: QCredit:Query fail{timeout}',
        '500 Query error: QCredit:Query fail',
        '500 Query error: QCredit connection lost',
        '500 Query error: AccountBalance:Query fail{StartTime=83000, EndTime=150000}',
        '500 Query error: QCredit:Query fail{StartTime=83000}',
    ])('keeps %s a real error', message => {
        expect(isTradingLimitsWindowError(message)).toBe(false);
    });
});
