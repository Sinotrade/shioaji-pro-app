import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TermsStep, type TermsStepProps } from './TermsStep';

const TERMS = '  第一條 憑證用途  \n\n第二條 使用者責任\n<b>不是標籤</b>\n';

interface Box {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('');
const alerts = (view: ReactTestRenderer) =>
  view.root.findAll((n) => typeof n.type === 'string' && n.props.role === 'alert');
const region = (view: ReactTestRenderer) =>
  view.root.findAll((n) => n.type === 'div' && n.props.role === 'region')[0]!;
const agree = (view: ReactTestRenderer) => view.root.findAll((n) => n.type === 'input')[0]!;
const submitButton = (view: ReactTestRenderer) => view.root.findByType('button');
const form = (view: ReactTestRenderer) => view.root.findByType('form');

async function render(props: Partial<TermsStepProps> = {}, box?: Box) {
  const onSubmit = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(TermsStep, { termsText: TERMS, busy: false, onSubmit, ...props }), {
      createNodeMock: (el) => (el.type === 'div' && box ? box : null),
    });
  });
  return { view, onSubmit };
}
const scrollTo = (view: ReactTestRenderer, box: Box, top: number) =>
  act(async () => {
    box.scrollTop = top;
    region(view).props.onScroll();
  });
const check = (view: ReactTestRenderer, checked: boolean) =>
  act(async () => agree(view).props.onChange({ target: { checked } }));
const submit = (view: ReactTestRenderer) =>
  act(async () => form(view).props.onSubmit({ preventDefault: vi.fn() }));

// 條款長到需要捲動：scrollHeight 1000、可視 200，捲到 796 以上才算讀到最底（容許 4px）。
const longBox = (): Box => ({ scrollTop: 0, clientHeight: 200, scrollHeight: 1000 });

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('TermsStep rendering', () => {
  it('renders the third-party text as trimmed plain paragraphs in a focusable labelled region', async () => {
    const { view } = await render({}, longBox());
    const paragraphs = region(view).findAllByType('p').map((p) => p.children);
    expect(paragraphs).toEqual([['第一條 憑證用途'], ['第二條 使用者責任'], ['<b>不是標籤</b>']]);
    expect(region(view).props.tabIndex).toBe(0);
    expect(region(view).props['aria-label']).toBe('憑證作業條款全文');
    expect(text(view.root)).toContain('憑證作業條款');
    expect(text(view.root)).toContain('這是臺灣網路認證公司（TWCA）電子憑證的法律同意，必須由你本人閱讀並勾選。');
    expect(text(submitButton(view))).toBe('同意並繼續');
    await act(async () => view.unmount());
  });

  it.each([null, '', ' \n \n '])('stops with an alert when there is no readable text (%j)', async (termsText) => {
    const { view, onSubmit } = await render({ termsText });
    expect(alerts(view).map(text)).toEqual([
      '沒有讀到條款內容，無法繼續。請取消後重新開始，或改在永豐金證券官網自己完成。',
    ]);
    expect(view.root.findAllByType('input')).toHaveLength(0);
    expect(view.root.findAllByType('button')).toHaveLength(0);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });
});

describe('TermsStep consent gate', () => {
  it('keeps the checkbox and button locked until the text is scrolled to the end', async () => {
    const box = longBox();
    const { view, onSubmit } = await render({}, box);
    expect(agree(view).props.disabled).toBe(true);
    expect(submitButton(view).props.disabled).toBe(true);
    expect(text(view.root)).toContain('請先把條款捲到最底部，才能勾選。');
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();

    await scrollTo(view, box, 795);
    expect(agree(view).props.disabled).toBe(true);

    await scrollTo(view, box, 796);
    expect(agree(view).props.disabled).toBe(false);
    expect(text(view.root)).not.toContain('請先把條款捲到最底部');
    expect(submitButton(view).props.disabled).toBe(true);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('submits exactly once after reaching the end and ticking the box', async () => {
    const box = longBox();
    const { view, onSubmit } = await render({}, box);
    await scrollTo(view, box, 800);
    await check(view, true);
    expect(submitButton(view).props.disabled).toBe(false);
    await submit(view);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await check(view, false);
    expect(submitButton(view).props.disabled).toBe(true);
    await submit(view);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => view.unmount());
  });

  it('treats text that fits without scrolling as already read', async () => {
    const { view } = await render({}, { scrollTop: 0, clientHeight: 200, scrollHeight: 120 });
    expect(agree(view).props.disabled).toBe(false);
    expect(text(view.root)).not.toContain('請先把條款捲到最底部');
    await act(async () => view.unmount());
  });

  it('does not submit while busy even when everything is ticked', async () => {
    const box = longBox();
    const { view, onSubmit } = await render({ busy: true }, box);
    await scrollTo(view, box, 800);
    await check(view, true);
    expect(submitButton(view).props['aria-disabled']).toBe(true);
    expect(text(submitButton(view))).toBe('處理中…');
    expect(form(view).props['aria-busy']).toBe(true);
    await submit(view);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });
});
