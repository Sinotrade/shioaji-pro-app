import { describe, expect, it } from 'vitest';
import { isChildWindow } from './window-role';

describe('isChildWindow', () => {
    it('treats every popout query as a child window', () => {
        for (const search of ['?popout=chart&code=2330', '?popout=traypanel', '?popout=']) {
            expect(isChildWindow(search, null)).toBe(true);
            expect(isChildWindow(search, 'main')).toBe(true);
        }
    });

    it('treats any native label other than main as a child window', () => {
        for (const label of ['tray', 'popout-chart-1', 'popout-flashtile-7', 'agent-approval']) {
            expect(isChildWindow('', label)).toBe(true);
        }
    });

    it('only the main window (or a plain browser tab) is not a child', () => {
        expect(isChildWindow('', 'main')).toBe(false);
        expect(isChildWindow('?code=2330', null)).toBe(false);
    });
});
