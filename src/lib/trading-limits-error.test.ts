import { describe, expect, it } from 'vitest';
import { classifyAccountQueryError, classifyBrokerQueryError, isBrokerServiceUnavailableError, isTradingLimitsWindowError } from './trading-limits-error';

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

const AS400 = '500 Query error: QCredit:Query fail{no AS400Query Connection (RouteID=M|N, WebID=094, MachineID=H05)}';

describe('classifyBrokerQueryError（交易額度）', () => {
    it('時段錯誤 → window', () => {
        expect(classifyBrokerQueryError('500 Query error: QCredit:Query fail{StartTime=83000, EndTime=150000}')).toBe('window');
    });
    it.each([AS400, 'Query fail{No AS400Query Connection}', 'no AS400 Query Connection'])('AS400 未連線 %s → unavailable', m => {
        expect(classifyBrokerQueryError(m)).toBe('unavailable');
        expect(isBrokerServiceUnavailableError(m)).toBe(true);
    });
    it.each([null, '', 'Failed to fetch', '500 Query error: QCredit:Query fail{timeout}', '500 Internal Server Error', '503 Service Unavailable', 'AS400 connection reset'])(
        '%s 仍是真錯誤', m => { expect(classifyBrokerQueryError(m)).toBeNull(); });
});

describe('classifyAccountQueryError（交割、預收）', () => {
    it.each([
        '500 Internal Server Error',
        '500',
        '503 Service Unavailable',
        '503 6044 無法取得交易狀態',
        '500 6044',
        '500 Query error: 無法取得交易狀態',
    ])('%s → temporary', m => { expect(classifyAccountQueryError(m)).toBe('temporary'); });
    it('AS400 → unavailable、時段 → window', () => {
        expect(classifyAccountQueryError(AS400)).toBe('unavailable');
        expect(classifyAccountQueryError('QCredit:Query fail{StartTime=83000, EndTime=150000}')).toBe('window');
    });
    it.each([null, '', 'Failed to fetch', '500 Query error: session disconnected', '500 Internal Server Error: account not found',
        '帳戶交割日期不一致，合計待確認', '502 Bad Gateway', '404 Not Found', '60440 something'])('%s 仍是真錯誤', m => {
        expect(classifyAccountQueryError(m)).toBeNull();
    });
});
