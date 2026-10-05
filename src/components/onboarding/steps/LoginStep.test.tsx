import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginStep, type LoginStepProps } from './LoginStep';

vi.mock('../../../lib/tauri', () => ({ openExternalUrl: vi.fn() }));

// 格式合法但不是真實身分證字號的假資料。
const FAKE_ID = 'a100000000';
const FAKE_PASSWORD = 'fake-password';

const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('');
const alerts = (view: ReactTestRenderer) =>
  view.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'alert');
const field = (view: ReactTestRenderer, name: string) =>
  view.root.findAll((n) => n.type === 'input' && n.props.name === name)[0]!;
const eye = (view: ReactTestRenderer) =>
  view.root.findAll((n) => n.type === 'button' && /密碼$/.test(String(n.props['aria-label'] ?? '')))[0]!;
const button = (view: ReactTestRenderer, label: string) =>
  view.root.findAllByType('button').find((b) => text(b).includes(label));
const form = (view: ReactTestRenderer) => view.root.findByType('form');
const consentBox = (view: ReactTestRenderer) =>
  view.root.findAll((n) => n.type === 'input' && n.props.type === 'checkbox')[0];
const agree = (view: ReactTestRenderer, checked = true) =>
  act(async () => consentBox(view)!.props.onChange({ target: { checked } }));
const CONSENT_REQUIRED = '請先勾選「我已閱讀並同意憑證作業條款」。';
const idInput = (view: ReactTestRenderer) => field(view, 'sinopac-onboarding-id');
const passwordInput = (view: ReactTestRenderer) => field(view, 'sinopac-onboarding-password');

async function render(props: Partial<LoginStepProps> = {}, options?: Parameters<typeof create>[1]) {
  const onSubmit = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(LoginStep, { busy: false, onSubmit, ...props }), options);
  });
  return { view, onSubmit };
}
const type = (input: ReactTestInstance, value: string) =>
  act(async () => input.props.onChange({ target: { value } }));
const submit = (view: ReactTestRenderer) =>
  act(async () => form(view).props.onSubmit({ preventDefault: vi.fn() }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('LoginStep rendering', () => {
  it('shows the first-login form with an unticked TWCA consent checkbox', async () => {
    const { view } = await render({ onManual: vi.fn() });
    const all = text(view.root);
    expect(all).toContain('輸入帳號密碼');
    expect(all).not.toContain('用你原本的帳號密碼登入');
    expect(all).toContain('我已閱讀並同意憑證作業條款');
    expect(all).not.toContain('即表示你授權系統');
    expect(consentBox(view)?.props.checked).toBe(false);
    expect(all).not.toContain('整個流程最多只會送出 2 次登入');
    expect(all).not.toContain('密碼只用於這次連線');
    expect(button(view, '登入並繼續')?.props.type).toBe('submit');
    expect(button(view, '不想輸入密碼？改用引導方式')).toBeDefined();
    await act(async () => view.unmount());
  });

  it('names the consent checkbox with its label and the terms link', async () => {
    const { view } = await render();
    const box = consentBox(view)!;
    const [labelId, linkId] = String(box.props['aria-labelledby']).split(' ');
    const byId = (id: string) => view.root.findAll((n) => typeof n.type === 'string' && n.props.id === id)[0]!;
    expect(text(byId(labelId!))).toBe('我已閱讀並同意');
    expect(text(byId(linkId!))).toBe('憑證作業條款');
    expect(byId(labelId!).props.htmlFor).toBe(box.props.id);
    expect(button(view, '登入並繼續')?.props['aria-describedby']).toBeUndefined();
    await act(async () => view.unmount());
  });

  it('requires ticking the consent before logging in', async () => {
    const { view, onSubmit } = await render();
    await type(idInput(view), FAKE_ID);
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(alerts(view).map(text)).toEqual([CONSENT_REQUIRED]);
    expect(consentBox(view)!.props['aria-invalid']).toBe(true);
    expect(consentBox(view)!.props['aria-describedby']).toBe(alerts(view)[0]!.props.id);
    await agree(view);
    expect(alerts(view)).toHaveLength(0);
    await submit(view);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ idNumber: 'A100000000', password: FAKE_PASSWORD });
    await act(async () => view.unmount());
  });

  it('expands and collapses the full TWCA terms from the inline link', async () => {
    const { view } = await render();
    const link = () => button(view, '憑證作業條款')!;
    const panel = () => view.root.findAll((n) => n.props.role === 'region' && n.props['aria-label'] === '憑證作業條款全文')[0]!;
    expect(link().props['aria-expanded']).toBe(false);
    expect(link().props['aria-controls']).toBe(panel().props.id);
    expect(panel().props.hidden).toBe(true);
    await act(async () => link().props.onClick());
    expect(link().props['aria-expanded']).toBe(true);
    expect(panel().props.hidden).toBe(false);
    const terms = text(panel());
    expect(terms).toContain('一、本公司使用臺灣網路認證股份有限公司核發之電子憑證，提供您進行網路下單作業使用。');
    expect(terms).toContain('七、用戶若有違反本約定條款，本公司得主動廢止用戶憑證。');
    expect(panel().findByType('a').props.href).toBe('https://www.twca.com.tw/repository');
    await act(async () => link().props.onClick());
    expect(panel().props.hidden).toBe(true);
    await act(async () => view.unmount());
  });

  it('shows the relogin variant without consent notice or manual link', async () => {
    const { view } = await render({ relogin: true, onManual: vi.fn() });
    const all = text(view.root);
    expect(all).toContain('憑證建好了，再登入一次');
    expect(all).toContain('這是整個流程的第 2 次（也是最後一次）登入送出。');
    expect(all).toContain('步驟 ');
    expect(all).not.toContain('我已閱讀並同意');
    expect(consentBox(view)).toBeUndefined();
    expect(button(view, '重新登入')).toBeDefined();
    expect(button(view, '登入並繼續')).toBeUndefined();
    expect(button(view, '改用引導方式')).toBeUndefined();
    await act(async () => view.unmount());
  });

  it('hides the manual link when the parent gives no onManual', async () => {
    const { view } = await render();
    expect(button(view, '改用引導方式')).toBeUndefined();
    await act(async () => view.unmount());
  });

  it('labels both fields and keeps them out of password managers and autofill', async () => {
    const { view } = await render();
    const labels = view.root.findAllByType('label');
    for (const [name, label] of [
      ['sinopac-onboarding-id', '身分證字號'],
      ['sinopac-onboarding-password', '密碼'],
    ] as const) {
      const input = field(view, name);
      const owner = labels.find((l) => l.props.htmlFor === input.props.id);
      expect(owner && text(owner)).toBe(label);
      expect(input.props.type).toBe(name === 'sinopac-onboarding-id' ? 'text' : 'password');
      expect(input.props.autoComplete).toBe('off');
      expect(input.props['data-1p-ignore']).toBe(true);
      expect(input.props['data-lpignore']).toBe('true');
      expect(input.props['data-form-type']).toBe('other');
      expect(input.props.spellCheck).toBe(false);
    }
    expect(idInput(view).props.maxLength).toBe(10);
    expect(form(view).props.autoComplete).toBe('off');
    await act(async () => view.unmount());
  });

  it('toggles only the password with the eye button inside the password field', async () => {
    const { view } = await render();
    expect(eye(view).props['aria-label']).toBe('顯示密碼');
    expect(eye(view).props['aria-controls']).toBe(passwordInput(view).props.id);
    await act(async () => eye(view).props.onClick());
    expect(passwordInput(view).props.type).toBe('text');
    expect(idInput(view).props.type).toBe('text');
    expect(eye(view).props['aria-label']).toBe('隱藏密碼');
    expect(eye(view).props['aria-pressed']).toBe(true);
    await act(async () => eye(view).props.onClick());
    expect(passwordInput(view).props.type).toBe('password');
    await act(async () => view.unmount());
  });
});

describe('LoginStep busy state', () => {
  it('keeps the primary button focusable, shows an inline spinner and locks the fields', async () => {
    const onManual = vi.fn();
    const busy = await render({ busy: true, onManual });
    const primary = busy.view.root.findByProps({ 'data-primary': true });
    expect(primary.props['aria-disabled']).toBe(true);
    expect(primary.props.disabled).toBeUndefined();
    expect(text(primary)).toBe('處理中…');
    expect(primary.findAllByType('svg')).toHaveLength(1);
    expect(button(busy.view, '改用引導方式')?.props.disabled).toBe(true);
    expect(idInput(busy.view).props.readOnly).toBe(true);
    expect(passwordInput(busy.view).props.readOnly).toBe(true);
    expect(form(busy.view).props['aria-busy']).toBe(true);
    await act(async () => busy.view.unmount());
  });

  it('ignores a submit while busy and keeps what was typed', async () => {
    const { view, onSubmit } = await render({ busy: true });
    await type(idInput(view), FAKE_ID);
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(alerts(view)).toHaveLength(0);
    expect(passwordInput(view).props.value).toBe(FAKE_PASSWORD);
    await act(async () => view.unmount());
  });
});

describe('LoginStep validation', () => {
  it('rejects a malformed id and an empty password with fixed messages', async () => {
    const { view, onSubmit } = await render();
    await type(idInput(view), 'zz');
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(alerts(view).map(text)).toEqual([
      '身分證字號格式不正確，應為 1 個英文字母加 9 位數字。',
      '請輸入密碼。',
      CONSENT_REQUIRED,
    ]);
    expect(idInput(view).props['aria-invalid']).toBe(true);
    expect(passwordInput(view).props['aria-invalid']).toBe(true);
    expect(idInput(view).props['aria-describedby']).toBe(alerts(view)[0]!.props.id);
    await act(async () => view.unmount());
  });

  it('never echoes the typed id or password in any rendered text', async () => {
    const { view, onSubmit } = await render();
    await type(idInput(view), 'not-an-id');
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(alerts(view).map(text)).toEqual(['身分證字號格式不正確，應為 1 個英文字母加 9 位數字。', CONSENT_REQUIRED]);
    const visible = text(view.root);
    expect(visible).not.toContain(FAKE_PASSWORD);
    expect(visible).not.toContain('not-an-id');
    await act(async () => view.unmount());
  });

  it('moves focus to the first invalid field', async () => {
    const focus = vi.fn();
    const { view } = await render({}, { createNodeMock: () => ({ focus }) });
    focus.mockClear();
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });
});

describe('LoginStep submit', () => {
  it('submits the normalised credentials once and clears them from component state', async () => {
    const { view, onSubmit } = await render();
    await agree(view);
    await act(async () => eye(view).props.onClick());
    await type(idInput(view), ` ${FAKE_ID} `);
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ idNumber: 'A100000000', password: FAKE_PASSWORD });
    expect(idInput(view).props.value).toBe('');
    expect(passwordInput(view).props.value).toBe('');
    expect(passwordInput(view).props.type).toBe('password');
    expect(alerts(view)).toHaveLength(0);
    expect(text(view.root)).not.toContain(FAKE_PASSWORD);
    await act(async () => view.unmount());
  });

  it('clears earlier field errors once the next submit is valid', async () => {
    const { view, onSubmit } = await render({ relogin: true });
    await submit(view);
    expect(alerts(view)).toHaveLength(2);
    await type(idInput(view), FAKE_ID);
    await type(passwordInput(view), FAKE_PASSWORD);
    await submit(view);
    expect(alerts(view)).toHaveLength(0);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });

  it('calls onManual from the guided link', async () => {
    const onManual = vi.fn();
    const { view } = await render({ onManual });
    await act(async () => button(view, '改用引導方式')!.props.onClick());
    expect(onManual).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });
});

describe('LoginStep focus', () => {
  it('does not focus the id field while its panel is hidden', async () => {
    const focus = vi.fn();
    const { view } = await render({}, { createNodeMock: () => ({ focus, closest: () => ({}) }) });
    expect(focus).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('focuses the id field once on mount and does not steal focus while typing', async () => {
    const focus = vi.fn();
    const { view } = await render({}, { createNodeMock: () => ({ focus }) });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await type(idInput(view), 'A');
    await type(passwordInput(view), FAKE_PASSWORD);
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });
});
