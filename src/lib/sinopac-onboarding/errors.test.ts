import { describe, expect, it } from 'vitest';
import { OnboardingApiError } from './api';
import {
    ERROR_COPY,
    NOTICE_CREATE_ENDED,
    NOTICE_ENDED,
    NOTICE_LOGIN_UNSURE,
    NOTICE_OFFLINE,
    NOTICE_OTP_INVALID_ENDED,
    NOTICE_RESYNCED,
    isOnboardingErrorCode,
    onboardingErrorCode,
} from './errors';
import { ONBOARDING_ERROR_CODES } from './types';

describe('ERROR_COPY', () => {
    it('covers every ONBOARDING_* code plus the wizard-only stop codes with fixed Chinese copy', () => {
        expect(Object.keys(ERROR_COPY).sort()).toEqual(
            [...ONBOARDING_ERROR_CODES, 'MANUAL', 'KEY_UNSURE', 'GENERIC'].sort(),
        );
        for (const copy of Object.values(ERROR_COPY)) {
            expect(copy.title).toMatch(/[一-鿿]/);
            expect(copy.message).toMatch(/[一-鿿]/);
        }
    });

    it('only possibly-created keys carry the delete-key hint', () => {
        const hinted = Object.entries(ERROR_COPY).filter(([, c]) => c.deleteKeyHint).map(([k]) => k);
        expect(hinted.sort()).toEqual(['KEY_UNSURE', 'ONBOARDING_KEY_CAPTURE_FAILED']);
    });

    it('keeps the retry policy of each kind', () => {
        expect(ERROR_COPY.ONBOARDING_INVALID_STATE.kind).toBe('resync');
        for (const code of ['ONBOARDING_BAD_CREDENTIALS', 'ONBOARDING_OTP_INVALID', 'ONBOARDING_OTP_EXPIRED', 'ONBOARDING_BROWSER_BUSY', 'ONBOARDING_INVALID_REQUEST'] as const)
            expect(ERROR_COPY[code].kind).toBe('inline');
        for (const code of ['ONBOARDING_ACCOUNT_LOCKED', 'ONBOARDING_SESSION_EXPIRED', 'ONBOARDING_RECAPTCHA_CHALLENGE', 'ONBOARDING_KEY_CAPTURE_FAILED', 'ONBOARDING_KEY_LIMIT_REACHED', 'ONBOARDING_NO_ACCOUNT_TYPE'] as const)
            expect(ERROR_COPY[code].kind).toBe('stop');
    });

    it('tells the user the chosen account types are missing instead of a generic format error, and offers a restart', () => {
        expect(ERROR_COPY.ONBOARDING_NO_ACCOUNT_TYPE).toEqual({
            title: '這個帳號沒有你選的帳戶類型',
            message: '永豐金證券的表單上沒有你勾選的任何帳戶類型。請重新開始，只勾選你實際擁有的帳戶。',
            kind: 'stop',
            fallback: false,
        });
        expect(isOnboardingErrorCode('ONBOARDING_NO_ACCOUNT_TYPE')).toBe(true);
    });
});

describe('local browser wording', () => {
    it('uses the fixed Chrome and session copy and never mentions a remote browser, connector or cloud', () => {
        expect(ERROR_COPY.ONBOARDING_QUOTA_EXHAUSTED.message).toBe(
            '無法啟動本機 Chrome。請確認已安裝 Google Chrome，或用環境變數 SINOPAC_CHROME_PATH 指定瀏覽器路徑後再試。',
        );
        expect(ERROR_COPY.ONBOARDING_SESSION_EXPIRED.message).toBe('瀏覽器工作階段已中斷，請重新開始。');
        const all = JSON.stringify([
            ERROR_COPY,
            NOTICE_OFFLINE,
            NOTICE_LOGIN_UNSURE,
            NOTICE_RESYNCED,
            NOTICE_OTP_INVALID_ENDED,
            NOTICE_ENDED,
            NOTICE_CREATE_ENDED,
        ]);
        for (const gone of ['遠端', '連接器', '雲端', '資料來源']) expect(all).not.toContain(gone);
    });
});

describe('error code helpers', () => {
    it('isOnboardingErrorCode accepts only known codes', () => {
        expect(isOnboardingErrorCode('ONBOARDING_OTP_INVALID')).toBe(true);
        for (const value of ['MANUAL', 'REQUEST_FAILED', 'NETWORK_ERROR', '', 1, null, undefined])
            expect(isOnboardingErrorCode(value)).toBe(false);
    });

    it('onboardingErrorCode extracts known codes from OnboardingApiError only', () => {
        expect(onboardingErrorCode(new OnboardingApiError('ONBOARDING_SITE_CHANGED', 502))).toBe('ONBOARDING_SITE_CHANGED');
        expect(onboardingErrorCode(new OnboardingApiError('NETWORK_ERROR', 0))).toBeNull();
        expect(onboardingErrorCode(new OnboardingApiError('REQUEST_FAILED', 500))).toBeNull();
        expect(onboardingErrorCode(Object.assign(new Error('x'), { code: 'ONBOARDING_SITE_CHANGED' }))).toBeNull();
        expect(onboardingErrorCode('ONBOARDING_SITE_CHANGED')).toBeNull();
        expect(onboardingErrorCode(null)).toBeNull();
    });
});
