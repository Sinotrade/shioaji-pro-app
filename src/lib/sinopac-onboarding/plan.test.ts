import { describe, expect, it } from 'vitest';
import {
    ACCOUNT_TYPE_LABELS,
    ACCOUNT_TYPE_ORDER,
    PERMISSION_ORDER,
    addDays,
    createPlanForm,
    enabledPermissions,
    permissionLabels,
    planFromForm,
    toDateKey,
} from './plan';
import { validateOnboardingPlan } from './types';

const NOW = new Date(2026, 9, 5);

describe('createPlanForm', () => {
    it('defaults to every permission and account type, unlimited IP, named ShioajiPro plus the month and day, with no IP prefilled and no risk acknowledgement', () => {
        expect(createPlanForm(NOW)).toEqual({
            permissions: { quote: true, account: true, trade: true, prod: true },
            accountTypes: { stock: true, futures: true, overseas: true },
            ipMode: 'unlimited',
            ips: [''],
            name: 'ShioajiPro1005',
            expiresOn: '2027-10-05',
            tradeAck: false,
        });
    });

    it('does not share mutable state between forms', () => {
        const a = createPlanForm(NOW);
        a.permissions.trade = false;
        a.accountTypes.overseas = false;
        expect(createPlanForm(NOW).permissions.trade).toBe(true);
        expect(createPlanForm(NOW).accountTypes.overseas).toBe(true);
    });

    it('formats dates in local time', () => {
        expect(toDateKey(new Date(2026, 0, 2))).toBe('2026-01-02');
        expect(toDateKey(addDays(new Date(2026, 11, 31), 1))).toBe('2027-01-01');
    });
});

describe('planFromForm', () => {
    it('the default form is a valid trade plan on every account type with unlimited IP', () => {
        const plan = planFromForm(createPlanForm(NOW));
        expect(plan).toEqual({
            name: 'ShioajiPro1005',
            expiresOn: '2027-10-05',
            permissions: { quote: true, account: true, trade: true, prod: true },
            accountTypes: ['stock', 'futures', 'overseas'],
            ip: { mode: 'unlimited', addresses: [] },
        });
        expect(validateOnboardingPlan(plan, NOW)).toEqual({});
    });

    it('restricted mode sends the trimmed, non-empty addresses', () => {
        const form = createPlanForm(NOW);
        form.ipMode = 'restricted';
        form.ips = [' 203.0.113.42 ', '', '  '];
        const plan = planFromForm(form);
        expect(plan.ip).toEqual({ mode: 'restricted', addresses: ['203.0.113.42'] });
        expect(validateOnboardingPlan(plan, NOW)).toEqual({});
    });

    it('restricted mode without any IP fails validation on the IP field only', () => {
        const form = createPlanForm(NOW);
        form.ipMode = 'restricted';
        const errors = validateOnboardingPlan(planFromForm(form), NOW);
        expect(Object.keys(errors)).toEqual(['ip']);
    });

    it('ignores typed IPs in unlimited mode, whatever the trade permission', () => {
        const form = createPlanForm(NOW);
        form.ips = ['203.0.113.42'];
        expect(planFromForm(form).ip).toEqual({ mode: 'unlimited', addresses: [] });
        form.permissions.trade = false;
        expect(planFromForm(form).ip).toEqual({ mode: 'unlimited', addresses: [] });
    });

    it('trims the name and keeps account order', () => {
        const form = createPlanForm(NOW);
        form.name = '  my-key  ';
        form.accountTypes = { stock: false, futures: true, overseas: true };
        const plan = planFromForm(form);
        expect(plan.name).toBe('my-key');
        expect(plan.accountTypes).toEqual(ACCOUNT_TYPE_ORDER.filter((t) => t !== 'stock'));
    });
});

describe('labels', () => {
    it('uses the short account names of the broker form', () => {
        expect(ACCOUNT_TYPE_ORDER.map((type) => ACCOUNT_TYPE_LABELS[type])).toEqual(['證券戶', '期貨戶', '海外股票']);
    });

    it('lists permissions in a fixed order', () => {
        expect(permissionLabels(['prod', 'quote'])).toEqual(['行情／資料', '正式環境']);
        const plan = planFromForm(createPlanForm(NOW));
        expect(enabledPermissions(plan)).toEqual(PERMISSION_ORDER);
        expect(enabledPermissions({ ...plan, permissions: { ...plan.permissions, trade: false } })).toEqual(
            PERMISSION_ORDER.filter((k) => k !== 'trade'),
        );
    });

    it('pads the month and day in the default name, which stays within the name limit', () => {
        expect(createPlanForm(new Date(2026, 0, 2)).name).toBe('ShioajiPro0102');
        expect(createPlanForm(new Date(2026, 11, 31)).name).toBe('ShioajiPro1231');
        expect(validateOnboardingPlan(planFromForm(createPlanForm(NOW)), NOW).name).toBeUndefined();
    });
});
