import { describe, expect, it } from 'vitest';
import { describeServerEnvNotice, type ServerEnvNoticeInput } from './server-env-notice';

const base: ServerEnvNoticeInput = { target: null, switching: false, running: true, savedForRestart: false, environmentMismatch: false };

describe('describeServerEnvNotice', () => {
    it('names the target environment while switching', () => {
        expect(describeServerEnvNotice({ ...base, switching: true, target: { environment: 'production', accountOnly: false } }))
            .toEqual({ tone: 'progress', text: '正在切換到正式環境…' });
        expect(describeServerEnvNotice({ ...base, switching: true, target: { environment: 'simulation', accountOnly: false } }))
            .toEqual({ tone: 'progress', text: '正在切換到模擬環境…' });
    });
    it('does not claim an environment change for an account in the same environment', () => {
        expect(describeServerEnvNotice({ ...base, switching: true, target: { environment: 'simulation', accountOnly: true } })?.text).toBe('正在切換帳號…');
    });
    it('turns into an action once the switch stopped without finishing', () => {
        expect(describeServerEnvNotice({ ...base, running: false, target: { environment: 'simulation', accountOnly: false } }))
            .toEqual({ tone: 'action', text: '切換到模擬環境未完成，請開啟伺服器面板重試' });
        expect(describeServerEnvNotice({ ...base, running: false, target: { environment: 'simulation', accountOnly: true } })?.text)
            .toBe('切換帳號未完成，請開啟伺服器面板重試');
    });
    it('asks for the button that applies saved settings', () => {
        expect(describeServerEnvNotice({ ...base, running: false, savedForRestart: true })?.text).toContain('啟動');
        expect(describeServerEnvNotice({ ...base, savedForRestart: true, environmentMismatch: true })?.text).toContain('重啟');
    });
    it('stays out of the way otherwise', () => {
        expect(describeServerEnvNotice(base)).toBeNull();
        expect(describeServerEnvNotice({ ...base, running: false })).toBeNull();
        expect(describeServerEnvNotice({ ...base, environmentMismatch: true })).toBeNull();
        // same-environment settings saved on a running server: the panel's hint covers it
        expect(describeServerEnvNotice({ ...base, savedForRestart: true })).toBeNull();
    });
});
