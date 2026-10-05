import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BirthdayStep, type BirthdayStepProps } from './BirthdayStep';

// 格式合法但不對應任何人的假日期。
const FAKE_BIRTHDAY = '19000101';
const BAD_COPY = '請輸入 8 碼西元年月日，例如 19900101。';

const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('');
const alerts = (view: ReactTestRenderer) =>
  view.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'alert');
const input = (view: ReactTestRenderer) => view.root.findByType('input');
const button = (view: ReactTestRenderer) => view.root.findByType('button');
const form = (view: ReactTestRenderer) => view.root.findByType('form');

async function render(props: Partial<BirthdayStepProps> = {}, options?: Parameters<typeof create>[1]) {
  const onSubmit = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(BirthdayStep, { busy: false, onSubmit, ...props }), options);
  });
  return { view, onSubmit };
}
const type = (view: ReactTestRenderer, value: string) =>
  act(async () => input(view).props.onChange({ target: { value } }));
const submit = (view: ReactTestRenderer) =>
  act(async () => form(view).props.onSubmit({ preventDefault: vi.fn() }));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('BirthdayStep', () => {
  it('renders the copy, a labelled numeric field and the privacy note', async () => {
    const { view } = await render();
    const all = text(view.root);
    expect(all).toContain('輸入生日驗證');
    expect(all).toContain('請輸入 8 碼西元生日。');
    expect(all).toContain('配合主管機關落實資訊安全防護機制，憑證申請將採行「OTP」認證機制，以維護投資人權益。');
    const label = view.root.findByType('label');
    expect(text(label)).toBe('生日（西元年月日）');
    expect(label.props.htmlFor).toBe(input(view).props.id);
    expect(input(view).props.inputMode).toBe('numeric');
    expect(input(view).props.maxLength).toBe(8);
    expect(input(view).props.autoComplete).toBe('off');
    expect(text(button(view))).toBe('下一步');
    await act(async () => view.unmount());
  });

  it('rejects malformed or impossible dates with a fixed message that never echoes the input', async () => {
    const { view, onSubmit } = await render();
    for (const bad of ['1234', '20001301', '19990230', '99991231', 'abcdefgh']) {
      await type(view, bad);
      await submit(view);
      expect(alerts(view).map(text)).toEqual([BAD_COPY]);
      expect(text(view.root)).not.toContain(bad);
      expect(input(view).props['aria-invalid']).toBe(true);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('keeps the OTP notice linked to the field and adds the error when invalid', async () => {
    const { view } = await render();
    const hint = view.root.findAll((n) => n.type === 'p' && text(n).startsWith('配合主管機關'))[0]!;
    expect(input(view).props['aria-describedby']).toBe(hint.props.id);
    await submit(view);
    const error = alerts(view)[0]!;
    expect(input(view).props['aria-describedby']).toBe(`${hint.props.id} ${error.props.id}`);
    await act(async () => view.unmount());
  });

  it('submits eight digits once, strips separators and clears the field', async () => {
    const { view, onSubmit } = await render();
    await type(view, '1900/01/01');
    await submit(view);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(FAKE_BIRTHDAY);
    expect(input(view).props.value).toBe('');
    expect(alerts(view)).toHaveLength(0);
    expect(text(view.root)).not.toContain(FAKE_BIRTHDAY);
    await act(async () => view.unmount());
  });

  it('clears an earlier error after a valid submit', async () => {
    const { view, onSubmit } = await render();
    await submit(view);
    expect(alerts(view)).toHaveLength(1);
    await type(view, FAKE_BIRTHDAY);
    await submit(view);
    expect(alerts(view)).toHaveLength(0);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });

  it('locks the field and button while busy and ignores a forced submit', async () => {
    const busy = await render({ busy: true });
    expect(button(busy.view).props['aria-disabled']).toBe(true);
    expect(text(button(busy.view))).toBe('處理中…');
    expect(input(busy.view).props.readOnly).toBe(true);
    expect(form(busy.view).props['aria-busy']).toBe(true);
    await type(busy.view, FAKE_BIRTHDAY);
    await submit(busy.view);
    expect(busy.onSubmit).not.toHaveBeenCalled();
    expect(alerts(busy.view)).toHaveLength(0);
    await act(async () => busy.view.unmount());
  });

  it('focuses the field on mount only, and again when validation fails', async () => {
    const focus = vi.fn();
    const { view } = await render({}, { createNodeMock: () => ({ focus }) });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    await type(view, '1');
    await type(view, '19');
    expect(focus).toHaveBeenCalledTimes(1);
    await submit(view);
    expect(focus).toHaveBeenCalledTimes(2);
    await act(async () => view.unmount());
  });
});
