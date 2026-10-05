import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, type OnboardingStep } from '../../../lib/sinopac-onboarding/types';
import { FLOW_STAGES, FlowStepper, flowStage } from './FlowStepper';
import { dump, mount, textOf } from './steps-b.test-helpers';

describe('flowStage', () => {
  it('maps the 10 server steps onto the 6 visible stages', () => {
    expect(
      Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, flowStage(step)])),
    ).toEqual({
      login: 1,
      birthday: 2,
      cert_otp: 3,
      terms: 3,
      relogin: 3,
      plan: 4,
      key_otp: 5,
      creating: 5,
      done: 6,
      stopped: 1,
    });
  });
});

const items = (view: Awaited<ReturnType<typeof mount>>) => view.root.findAllByType('li');

describe('FlowStepper', () => {
  it('marks exactly one stage as current for every active step', async () => {
    for (const step of ONBOARDING_STEPS.filter((s) => s !== 'stopped')) {
      const view = await mount(createElement(FlowStepper, { step, sawCert: true }));
      const current = items(view).filter((li) => li.props['aria-current'] === 'step');
      expect(current).toHaveLength(1);
      expect(textOf(current[0]!)).toContain(FLOW_STAGES[flowStage(step) - 1]);
    }
  });

  it('renders nothing once the flow has stopped', async () => {
    const view = await mount(createElement(FlowStepper, { step: 'stopped', sawCert: false }));
    expect(view.toJSON()).toBeNull();
  });

  it('marks the certificate stage as skipped only when no WebCA flow appeared and the flow moved past it', async () => {
    const skipped = (step: OnboardingStep, sawCert: boolean) =>
      mount(createElement(FlowStepper, { step, sawCert })).then((view) => dump(view).includes('（略過）'));
    expect(await skipped('plan', false)).toBe(true);
    expect(await skipped('key_otp', false)).toBe(true);
    expect(await skipped('plan', true)).toBe(false);
    // 還在登入或憑證流程中時還不能下結論。
    expect(await skipped('login', false)).toBe(false);
    expect(await skipped('birthday', false)).toBe(false);
    expect(await skipped('relogin', false)).toBe(false);
  });

  it('skips both the birthday and certificate stages, but nothing else', async () => {
    const view = await mount(createElement(FlowStepper, { step: 'plan', sawCert: false }));
    const labels = items(view)
      .filter((li) => textOf(li).includes('（略過）'))
      .map((li) => textOf(li).replace(/（.*?）|›/g, ''));
    expect(labels).toEqual(['生日', '憑證']);
  });

  it('labels the list and lists all six stages in order', async () => {
    const view = await mount(createElement(FlowStepper, { step: 'login', sawCert: false }));
    expect(view.root.findByType('ol').props['aria-label']).toBe('進度');
    expect(items(view).map((li) => textOf(li).replace(/（.*?）/g, '').replace(/›$/, ''))).toEqual(
      FLOW_STAGES.map((label, index) => `${index + 1}${label}`),
    );
  });
});
