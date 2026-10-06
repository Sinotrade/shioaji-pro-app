import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./command-palette.css', () => ({ overlay: '', box: '', input: '', results: '', result: '', resultActive: '', resultCode: '', resultName: '', resultType: '', hint: '', err: '' }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: vi.fn() }));
vi.mock('../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('does not offer research-only industry observation in the standard command palette', async () => {
    vi.stubEnv('VITE_V9_RESEARCH_MODE', 'false'); vi.resetModules();
    const { CommandPalette } = await import('./command-palette');
    const add = vi.fn(); const close = vi.fn(); const jump = vi.fn(async () => undefined);
    await act(async () => { renderer = create(<CommandPalette open onClose={close} onJump={jump} onAddPanel={add} />); });
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: '產業觀察' } }));
    expect(renderer!.root.findAllByType('button')).toHaveLength(0); expect(add).not.toHaveBeenCalled();
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'K 線圖' } }));
    expect(renderer!.root.findAllByType('button')).toHaveLength(1);
    await act(async () => renderer!.root.findByType('button').props.onClick());
    expect(add).toHaveBeenCalledWith('chart'); expect(close).toHaveBeenCalledTimes(1); expect(jump).not.toHaveBeenCalled();
});
it('offers the optional observation panel in the research palette and only emits that add action', async () => {
    vi.stubEnv('VITE_V9_RESEARCH_MODE', 'true'); vi.resetModules();
    const { CommandPalette } = await import('./command-palette');
    const add = vi.fn(); const close = vi.fn(); const jump = vi.fn(async () => undefined);
    await act(async () => { renderer = create(<CommandPalette open onClose={close} onJump={jump} onAddPanel={add} />); });
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: '產業觀察' } }));
    expect(renderer!.root.findAllByType('button')).toHaveLength(1);
    await act(async () => renderer!.root.findByType('button').props.onClick());
    expect(add).toHaveBeenCalledTimes(1); expect(add).toHaveBeenCalledWith('industrywatch'); expect(close).toHaveBeenCalledTimes(1); expect(jump).not.toHaveBeenCalled();
});
