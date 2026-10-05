import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingOtpTarget } from '../../../lib/sinopac-onboarding/types';
import { OtpStep, type OtpStepProps } from './OtpStep';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString();

// 非連續的 index：onSend 必須收到 target.index，而不是陣列位置。
const TARGETS: OnboardingOtpTarget[] = [
  { channel: 'sms', index: 3, masked: '09**-***-111' },
  { channel: 'sms', index: 7, masked: '09**-***-222' },
  { channel: 'email', index: 5, masked: 'f***@example.test' },
];
const FAKE_CODE = 'a1b2c3';

const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('');
const alerts = (view: ReactTestRenderer) =>
  view.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'alert');
const buttons = (view: ReactTestRenderer) => view.root.findAllByType('button');
const button = (view: ReactTestRenderer, label: string) => buttons(view).find((b) => text(b) === label);
const radios = (view: ReactTestRenderer) =>
  view.root.findAll((n) => n.type === 'input' && n.props.type === 'radio');
const codeInput = (view: ReactTestRenderer) =>
  view.root.findAll((n) => n.type === 'input' && n.props.name === 'sinopac-onboarding-otp')[0];
const select = (view: ReactTestRenderer) => view.root.findByType('select');
const options = (view: ReactTestRenderer) =>
  view.root.findAllByType('option').map((o) => [o.props.value, text(o)]);
const fieldset = (view: ReactTestRenderer) => view.root.findByType('fieldset');

async function render(props: Partial<OtpStepProps> = {}, options?: Parameters<typeof create>[1]) {
  const base: OtpStepProps = {
    purpose: 'cert',
    targets: TARGETS,
    otp: null,
    now: NOW,
    busy: false,
    onSend: vi.fn(),
    onVerify: vi.fn(),
  };
  const all = { ...base, ...props };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(OtpStep, all), options);
  });
  const update = (next: Partial<OtpStepProps>) =>
    act(async () => view.update(createElement(OtpStep, { ...all, ...next })));
  return { view, update, onSend: all.onSend as ReturnType<typeof vi.fn>, onVerify: all.onVerify as ReturnType<typeof vi.fn> };
}
const sentOtp = (over: Partial<NonNullable<OtpStepProps['otp']>> = {}): OtpStepProps['otp'] => ({
  purpose: 'cert',
  channel: 'email',
  targetIndex: 5,
  expiresAt: iso(125),
  ...over,
});
const type = (view: ReactTestRenderer, value: string) =>
  act(async () => codeInput(view)!.props.onChange({ target: { value } }));
const verify = (view: ReactTestRenderer) =>
  act(async () => view.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('OtpStep before a code is sent', () => {
  it('offers only the channels and masked targets that were read from the page', async () => {
    const { view } = await render();
    expect(radios(view).map((r) => [r.props.value, r.props.checked])).toEqual([
      ['sms', true],
      ['email', false],
    ]);
    expect(options(view)).toEqual([
      [3, '09**-***-111'],
      [7, '09**-***-222'],
    ]);
    expect(text(view.root)).toContain('收碼的手機號碼');
    expect(text(view.root)).toContain('輸入驗證碼');
    expect(button(view, '寄送驗證碼')?.props.disabled).toBe(false);
    expect(fieldset(view).props.disabled).toBe(false);
    expect(codeInput(view)).toBeUndefined();
    await act(async () => view.unmount());
  });

  it('shows only the channel that actually has targets', async () => {
    const { view } = await render({ targets: [TARGETS[2]!] });
    expect(radios(view).map((r) => r.props.value)).toEqual(['email']);
    expect(text(view.root)).toContain('收碼的信箱');
    expect(options(view)).toEqual([[5, 'f***@example.test']]);
    await act(async () => view.unmount());
  });

  it('sends the real target.index of the first target by default', async () => {
    const { view, onSend } = await render();
    await act(async () => button(view, '寄送驗證碼')!.props.onClick());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('sms', 3);
    await act(async () => view.unmount());
  });

  it('sends the picked target index, not its position', async () => {
    const { view, onSend } = await render();
    await act(async () => select(view).props.onChange({ target: { value: '7' } }));
    expect(select(view).props.value).toBe(7);
    await act(async () => button(view, '寄送驗證碼')!.props.onClick());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('sms', 7);
    await act(async () => view.unmount());
  });

  it('switches target list and resets the pick when the channel changes', async () => {
    const { view, onSend } = await render();
    await act(async () => select(view).props.onChange({ target: { value: '7' } }));
    await act(async () => radios(view)[1]!.props.onChange());
    expect(radios(view).map((r) => r.props.checked)).toEqual([false, true]);
    expect(options(view)).toEqual([[5, 'f***@example.test']]);
    expect(text(view.root)).toContain('收碼的信箱');
    await act(async () => button(view, '寄送驗證碼')!.props.onClick());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('email', 5);
    await act(async () => view.unmount());
  });

  it('shows the key-stage copy for purpose=key', async () => {
    const { view } = await render({ purpose: 'key' });
    expect(text(view.root)).toContain('API 金鑰申請驗證');
    expect(text(view.root)).toContain('為了安全，建立 API Key 前永豐金證券會要求再驗證一次。驗證碼一律由你本人輸入。');
    await act(async () => view.unmount());
  });

  it('never invents targets: an empty list shows an alert and nothing to send', async () => {
    const { view, onSend } = await render({ targets: [] });
    expect(alerts(view).map(text)).toEqual(['沒有讀到可用的收碼方式。請取消後重新開始，或改在永豐金證券官網自己完成。']);
    expect(radios(view)).toHaveLength(0);
    expect(buttons(view)).toHaveLength(0);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('disables the controls while busy and ignores a forced send', async () => {
    const { view, onSend } = await render({ busy: true });
    expect(button(view, '處理中…')?.props['aria-disabled']).toBe(true);
    expect(fieldset(view).props.disabled).toBe(true);
    expect(select(view).props.disabled).toBe(true);
    await act(async () => button(view, '處理中…')!.props.onClick());
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('ignores a code that belongs to the other purpose', async () => {
    const { view } = await render({ purpose: 'cert', otp: sentOtp({ purpose: 'key' }) });
    expect(codeInput(view)).toBeUndefined();
    expect(text(view.root)).not.toContain('剩餘');
    expect(text(view.root)).not.toContain('驗證碼已過期');
    expect(button(view, '寄送驗證碼')).toBeDefined();
    await act(async () => view.unmount());
  });
});

describe('OtpStep countdown', () => {
  it('locks the choice to the sent target and shows the remaining time from expiresAt', async () => {
    const { view, update } = await render({ otp: sentOtp() });
    expect(text(view.root.findByProps({ role: 'timer' }))).toBe('2:05');
    expect(text(view.root)).toContain('驗證碼已寄出，請在時間內輸入。');
    expect(fieldset(view).props.disabled).toBe(true);
    expect(radios(view).map((r) => [r.props.value, r.props.checked])).toEqual([
      ['sms', false],
      ['email', true],
    ]);
    expect(select(view).props.disabled).toBe(true);
    expect(select(view).props.value).toBe(5);
    expect(button(view, '寄送驗證碼')).toBeUndefined();
    expect(codeInput(view)).toBeDefined();
    await update({ now: NOW + 65_000 });
    expect(text(view.root.findByProps({ role: 'timer' }))).toBe('1:00');
    await update({ now: NOW + 124_001 });
    expect(text(view.root.findByProps({ role: 'timer' }))).toBe('0:01');
    await act(async () => view.unmount());
  });

  it('keeps the sent target even if the user had picked another one before', async () => {
    const { view, update } = await render();
    await act(async () => select(view).props.onChange({ target: { value: '7' } }));
    await update({ otp: sentOtp({ channel: 'sms', targetIndex: 3 }) });
    expect(select(view).props.value).toBe(3);
    expect(radios(view)[0]!.props.checked).toBe(true);
    await act(async () => view.unmount());
  });

  it('turns into the resend state with an alert once the time is up', async () => {
    const { view, update, onSend } = await render({ otp: sentOtp() });
    await update({ now: NOW + 125_000 });
    expect(codeInput(view)).toBeUndefined();
    expect(alerts(view).map(text)).toEqual(['驗證碼已過期。請重新寄送一組。']);
    expect(fieldset(view).props.disabled).toBe(false);
    expect(button(view, '寄送驗證碼')).toBeUndefined();
    // 解鎖後回到預設選項；送出的一定是畫面上選中的那一組。
    expect(radios(view).map((r) => r.props.checked)).toEqual([true, false]);
    expect(select(view).props.value).toBe(3);
    await act(async () => button(view, '重新寄送驗證碼')!.props.onClick());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('sms', 3);
    await act(async () => view.unmount());
  });

  it('treats an unparsable expiresAt as already expired rather than counting down', async () => {
    const { view } = await render({ otp: sentOtp({ expiresAt: 'soon' }) });
    expect(codeInput(view)).toBeUndefined();
    expect(button(view, '重新寄送驗證碼')).toBeDefined();
    await act(async () => view.unmount());
  });
});

describe('OtpStep verification', () => {
  it('rejects too short, too long and non-alphanumeric codes with a fixed message', async () => {
    const { view, onVerify } = await render({ otp: sentOtp() });
    for (const bad of ['', '123', '1234567890123', '12 34', '12-34']) {
      await type(view, bad);
      await verify(view);
      expect(alerts(view).map(text)).toEqual(['請輸入簡訊或 Email 收到的驗證碼。']);
      expect(codeInput(view)!.props['aria-invalid']).toBe(true);
    }
    expect(onVerify).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('never echoes the typed code in rendered text', async () => {
    const { view } = await render({ otp: sentOtp() });
    await type(view, '12 34');
    await verify(view);
    expect(text(view.root)).not.toContain('12 34');
    await act(async () => view.unmount());
  });

  it('submits the trimmed code once and clears the field', async () => {
    const { view, onVerify } = await render({ otp: sentOtp() });
    await type(view, ` ${FAKE_CODE} `);
    await verify(view);
    expect(onVerify).toHaveBeenCalledExactlyOnceWith(FAKE_CODE);
    expect(codeInput(view)!.props.value).toBe('');
    expect(alerts(view)).toHaveLength(0);
    expect(text(view.root)).not.toContain(FAKE_CODE);
    await act(async () => view.unmount());
  });

  it('locks the code field and submit while busy and ignores a forced submit', async () => {
    const { view, onVerify } = await render({ otp: sentOtp(), busy: true });
    expect(codeInput(view)!.props.readOnly).toBe(true);
    expect(button(view, '處理中…')?.props['aria-disabled']).toBe(true);
    await type(view, FAKE_CODE);
    await verify(view);
    expect(onVerify).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('labels the code field and requests a one-time-code autofill', async () => {
    const { view } = await render({ otp: sentOtp() });
    const input = codeInput(view)!;
    const label = view.root.findAllByType('label').find((l) => l.props.htmlFor === input.props.id);
    expect(label && text(label)).toBe('驗證碼');
    expect(input.props.autoComplete).toBe('one-time-code');
    expect(input.props.maxLength).toBe(12);
    await act(async () => view.unmount());
  });
});

describe('OtpStep focus', () => {
  it('focuses the send button on mount, then the code field once the code is sent', async () => {
    const focus = vi.fn();
    const { view, update } = await render({}, { createNodeMock: (el) => ({ focus, tag: el.type }) });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    focus.mockClear();
    await update({ otp: sentOtp() });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await type(view, '1');
    await type(view, '12');
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });
});
