import { createElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingPlan } from '../../../lib/sinopac-onboarding/types';
import { PlanStep } from './PlanStep';
import { buttonByText, change, click, dump, mount, textOf } from './steps-b.test-helpers';

const IP = '203.0.113.42';
const ACK = '我了解：開放交易後，持有這組金鑰的人都可以下單。';
const UNLIMITED_HINT = '一般家用或行動網路的 IP 會變動，請選無限制 IP；有固定 IP 再改選限制 IP。';
const RESTRICTED_HINT = '請填入會使用這組金鑰的固定 IPv4，最多 5 組。';
const PRESETS = ['90 天', '180 天', '1 年'];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 12));
});
afterEach(() => vi.useRealTimers());

async function setup(busy = false) {
    const onSubmit = vi.fn<(plan: OnboardingPlan) => void>();
    const view = await mount(createElement(PlanStep, { busy, onSubmit }));
    return { view, onSubmit };
}

const checkboxes = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'input' && n.props.type === 'checkbox');
const checkboxFor = (view: ReactTestRenderer, label: string) =>
    checkboxes(view).find((box) => textOf(box.parent!).startsWith(label))!;
const tick = (view: ReactTestRenderer, label: string, checked = true) =>
    change(checkboxFor(view, label), { checked });
const radios = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'input' && n.props.type === 'radio');
const chooseIp = (view: ReactTestRenderer, label: '無限制 IP' | '限制 IP') =>
    change(radios(view).find((radio) => textOf(radio.parent!) === label)!, { checked: true });
const submitButton = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'button' && n.props.type === 'submit')[0]!;
const ipInputs = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'input' && n.props.inputMode === 'decimal');
const submitForm = (view: ReactTestRenderer) =>
    act(async () => {
        view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
const dateInput = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'input' && n.props.type === 'date')[0]!;
const nameInput = (view: ReactTestRenderer) =>
    view.root.findAll((n) => n.type === 'input' && typeof n.props.id === 'string' && n.props.id.endsWith('-name'))[0]!;

describe('PlanStep defaults', () => {
    it('starts with every permission and account ticked, unlimited IP, named ShioajiPro plus the date, expiring in one year, and submits that plan after the risk acknowledgement', async () => {
        const { view, onSubmit } = await setup();
        expect(nameInput(view).props.value).toBe('ShioajiPro1005');
        expect(dateInput(view).props.value).toBe('2027-10-05');
        expect(dateInput(view).props.min).toBe('2026-10-06');
        expect(view.root.findAll((n) => n.props['data-risk'] !== undefined)).toHaveLength(0);
        expect(textOf(view.root)).not.toContain('風險');
        expect(submitButton(view).props.disabled).toBe(false);
        expect(textOf(submitButton(view))).toBe('下一步：API 金鑰申請驗證');

        // 開放交易的唯一關卡：沒勾風險確認就不送出。
        await submitForm(view);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(textOf(view.root)).toContain('開放交易前，請先勾選確認。');

        await tick(view, '我了解');
        await submitForm(view);
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
            name: 'ShioajiPro1005',
            expiresOn: '2027-10-05',
            permissions: { quote: true, account: true, trade: true, prod: true },
            accountTypes: ['stock', 'futures', 'overseas'],
            ip: { mode: 'unlimited', addresses: [] },
        });
    });

    it('lays permissions and accounts out as plain checkboxes, and the IP choice as one labelled radio group', async () => {
        const { view } = await setup();
        // 交易確認是「權限勾選」群組裡、依附在「交易」之下的一列。
        expect(checkboxes(view).map((box) => textOf(box.parent!))).toEqual([
            '行情／資料',
            '帳務',
            '交易',
            '正式環境',
            ACK,
            '證券戶',
            '期貨戶',
            '海外股票',
        ]);
        expect(checkboxes(view).map((box) => box.props.checked)).toEqual([true, true, true, true, false, true, true, true]);
        const permissions = view.root.find((n) => n.type === 'fieldset' && textOf(n.findByType('legend')) === '權限勾選');
        expect(permissions.findAll((n) => n.type === 'input' && n.props.type === 'checkbox').map((box) => textOf(box.parent!))).toContain(ACK);

        expect(radios(view).map((radio) => textOf(radio.parent!))).toEqual(['無限制 IP', '限制 IP']);
        expect(radios(view).map((radio) => radio.props.checked)).toEqual([true, false]);
        // 同一個 name 才是同一組（方向鍵切換）；外層 fieldset 的 legend 是群組名稱。
        const [first, second] = radios(view);
        expect(first!.props.name).toEqual(expect.any(String));
        expect(second!.props.name).toBe(first!.props.name);
        const group = view.root.find(
            (n) => n.type === 'fieldset' && n.findAll((c) => c.type === 'input' && c.props.type === 'radio').length > 0,
        );
        expect(textOf(group.findByType('legend'))).toBe('允許的 IP');
    });

    it('drops the default-selection hint and the old trade-needs-restricted-IP banner and wording', async () => {
        const { view } = await setup();
        const text = textOf(view.root);
        for (const gone of ['同步程式', 'GitHub', '雲端', 'finhub', '預設只讀取', '交易權限需要限制 IP', '不允許交易金鑰']) {
            expect(text + dump(view)).not.toContain(gone);
        }
        expect(text).not.toContain('預設全選');
        expect(text).not.toContain('自動略過');
        expect(text).toContain(UNLIMITED_HINT);
        expect(text).not.toContain(RESTRICTED_HINT);
        expect(ipInputs(view)).toHaveLength(0);
    });

    it('warns when the production environment is unticked', async () => {
        const { view } = await setup();
        expect(textOf(view.root)).not.toContain('只能用模擬環境');
        await tick(view, '正式環境', false);
        expect(textOf(view.root)).toContain('只能用模擬環境');
    });

    it('fills the expiry from the quick buttons', async () => {
        const { view } = await setup();
        await click(buttonByText(view, '90 天'));
        expect(dateInput(view).props.value).toBe('2027-01-03');
        await click(buttonByText(view, '180 天'));
        expect(dateInput(view).props.value).toBe('2027-04-03');
        await click(buttonByText(view, '1 年'));
        expect(dateInput(view).props.value).toBe('2027-10-05');
    });

    it('marks the quick option that matches the date as pressed, and none for a custom date', async () => {
        const { view } = await setup();
        const pressed = () => PRESETS.filter((label) => buttonByText(view, label).props['aria-pressed'] === true);
        expect(pressed()).toEqual(['1 年']);
        await click(buttonByText(view, '90 天'));
        expect(pressed()).toEqual(['90 天']);
        await change(dateInput(view), { value: '2027-02-14' });
        expect(pressed()).toEqual([]);
        expect(PRESETS.map((label) => buttonByText(view, label).props['aria-pressed'])).toEqual([false, false, false]);
        // 分段選項以既有的「到期日」標籤命名，不另加文字。
        const presets = view.root.find((n) => n.props.role === 'group');
        expect(textOf(view.root.find((n) => n.type === 'label' && n.props.id === presets.props['aria-labelledby']))).toBe('到期日');
    });
});

describe('PlanStep IP mode', () => {
    it('shows the IP rows only for 限制 IP, needs a valid IP there, then sends restricted mode', async () => {
        const { view, onSubmit } = await setup();
        await tick(view, '我了解');
        await chooseIp(view, '限制 IP');
        expect(radios(view).map((radio) => radio.props.checked)).toEqual([false, true]);
        expect(ipInputs(view)).toHaveLength(1);
        expect(ipInputs(view)[0]!.props.value).toBe('');
        expect(ipInputs(view)[0]!.props.placeholder).toBe('例如 203.0.113.42');
        expect(textOf(view.root)).toContain(RESTRICTED_HINT);
        expect(textOf(view.root)).not.toContain(UNLIMITED_HINT);
        expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(0);

        await submitForm(view);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(textOf(view.root)).toContain('請輸入正確的 IPv4 位址');
        expect(ipInputs(view)[0]!.props['aria-invalid']).toBe(true);

        await change(ipInputs(view)[0]!, { value: ` ${IP} ` });
        await submitForm(view);
        expect(onSubmit).toHaveBeenCalledOnce();
        const plan = onSubmit.mock.calls[0]![0];
        expect(plan.permissions.trade).toBe(true);
        expect(plan.ip).toEqual({ mode: 'restricted', addresses: [IP] });
    });

    it('switching back to 無限制 IP hides the rows and submits no addresses, even with an IP typed', async () => {
        const { view, onSubmit } = await setup();
        await tick(view, '我了解');
        await chooseIp(view, '限制 IP');
        await change(ipInputs(view)[0]!, { value: IP });
        await chooseIp(view, '無限制 IP');
        expect(ipInputs(view)).toHaveLength(0);
        expect(textOf(view.root)).toContain(UNLIMITED_HINT);

        await submitForm(view);
        expect(onSubmit).toHaveBeenCalledOnce();
        expect(onSubmit.mock.calls[0]![0].ip).toEqual({ mode: 'unlimited', addresses: [] });

        // 再切回限制 IP，剛才輸入的 IP 還在。
        await chooseIp(view, '限制 IP');
        expect(ipInputs(view)[0]!.props.value).toBe(IP);
    });

    it('can add and remove IP rows up to the limit', async () => {
        const { view } = await setup();
        await chooseIp(view, '限制 IP');
        for (let i = 0; i < 4; i += 1) await click(buttonByText(view, '新增另一組 IP'));
        expect(ipInputs(view)).toHaveLength(5);
        expect(view.root.findAll((n) => n.type === 'button' && textOf(n).includes('新增另一組 IP'))).toHaveLength(0);
        await click(view.root.findAll((n) => n.type === 'button' && textOf(n) === '移除')[0]!);
        expect(ipInputs(view)).toHaveLength(4);
    });
});

describe('PlanStep trade permission', () => {
    it('without trade there is no acknowledgement to tick and the plan submits right away', async () => {
        const { view, onSubmit } = await setup();
        await tick(view, '交易', false);
        expect(checkboxes(view).map((box) => textOf(box.parent!))).not.toContain(ACK);
        await submitForm(view);
        expect(onSubmit).toHaveBeenCalledOnce();
        expect(onSubmit.mock.calls[0]![0].permissions.trade).toBe(false);
    });

    it('forgets the risk acknowledgement after trade is unticked', async () => {
        const { view } = await setup();
        await tick(view, '我了解');
        await tick(view, '交易', false);
        await tick(view, '交易');
        expect(checkboxFor(view, '我了解').props.checked).toBe(false);
    });
});

describe('PlanStep validation', () => {
    it('rejects an empty account selection, a long name and an empty permission set only after a submit attempt', async () => {
        const { view, onSubmit } = await setup();
        for (const label of ['證券戶', '期貨戶', '海外股票']) await tick(view, label, false);
        await change(nameInput(view), { value: 'x'.repeat(16) });
        for (const label of ['行情／資料', '帳務', '交易', '正式環境']) await tick(view, label, false);
        expect(dump(view)).not.toContain('至少綁定一種帳戶');
        await submitForm(view);

        const text = textOf(view.root);
        expect(text).toContain('至少綁定一種帳戶。');
        expect(text).toContain('名稱最多 15 個字元。');
        expect(text).toContain('至少選一項權限。');
        expect(onSubmit).not.toHaveBeenCalled();
    });
});

describe('PlanStep while busy', () => {
    it('disables the submit button and ignores a forced submit', async () => {
        const { view, onSubmit } = await setup(true);
        expect(submitButton(view).props.disabled).toBe(true);
        await submitForm(view);
        expect(onSubmit).not.toHaveBeenCalled();
    });
});
