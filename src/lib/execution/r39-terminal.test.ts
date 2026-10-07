import { expect, it } from 'vitest';
import { initialState, step } from './core';
import type { ExecEvent } from './model';
import seed from './scenarios/r38-external-own-partial-terminal-late-fill.json';
import { bracketPlansFromPrograms } from './native-view';
import { bracketPhase, protectionQuantity, unprotectedQuantity, needsAttention } from '../bracket-core';
it('r39 native mirrors never label inert exposure protected', () => {
    let state=initialState();
    for (const item of seed.steps.slice(0,3)) state=step(state,item.event as ExecEvent).state;
    const p=state.programs[0]!;const lv=p.levels[0]!;
    lv.phase='done';lv.entryFilled=1;lv.position=1;lv.orders[0]!.status='ended';
    const inert=bracketPlansFromPrograms([p])[0]!;
    expect(protectionQuantity(inert)).toBe(0);expect(unprotectedQuantity(inert)).toBe(1);
    expect(bracketPhase(inert)).not.toBe('protected');expect(needsAttention(inert)).toBe(true);
    lv.phase='holding';const active=bracketPlansFromPrograms([p])[0]!;
    expect(protectionQuantity(active)).toBe(1);expect(bracketPhase(active)).toBe('protected');
    p.status='paused';const paused=bracketPlansFromPrograms([p])[0]!;
    expect(protectionQuantity(paused)).toBe(0);expect(unprotectedQuantity(paused)).toBe(1);
});
