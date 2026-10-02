import { describe, expect, it } from 'vitest';
import { checkInstance, INSTANCE_HEADER, instanceFromResponse } from './server-instance';

describe('X-Shioaji-Instance 標頭檢查', () => {
    const res = (h?: string) => new Response('{}', { headers: h === undefined ? {} : { [INSTANCE_HEADER]: h } });
    it('舊版 SDK 沒有標頭 → absent（不做任何事）', () => {
        expect(instanceFromResponse(res())).toBeNull();
        expect(checkInstance('abc', null)).toBe('absent');
        expect(checkInstance(undefined, null)).toBe('absent');
    });
    it('相同 → match；不同或沒有可比對的 instance → mismatch', () => {
        expect(instanceFromResponse(res(' abc '))).toBe('abc');
        expect(checkInstance('abc', 'abc')).toBe('match');
        expect(checkInstance('abc', 'def')).toBe('mismatch');
        expect(checkInstance(undefined, 'def')).toBe('mismatch');
    });
});
