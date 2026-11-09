// The background engine's refusal codes for warrants (private engine #217)
// read as plain Chinese, never as the raw code.
import { expect, it, vi } from 'vitest';

vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener: () => undefined, removeEventListener: () => undefined };
    g.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
});
vi.mock('../trade', () => ({ notify: vi.fn() }));
vi.mock('../main-window-commands', () => ({ isMainWindow: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
const { rejectionText } = await import('./background');

it('warrant refusals of the engine have their own text', () => {
    expect(rejectionText('rejected.warrantOddLot')).toBe('權證沒有零股，只能整張');
    expect(rejectionText('rejected.warrantCredit')).toBe('權證只能現股，不能融資融券或當沖先賣');
    expect(rejectionText('rejected.warrantMarket')).toBe('外國標的權證不能下市價，請用限價');
    expect(rejectionText('rejected.warrantOffTick')).toBe('價格不在權證升降單位上');
});

it('an unknown code still says the engine refused, with the code', () => {
    expect(rejectionText('rejected.somethingNew')).toBe('背景執行未接受（rejected.somethingNew）');
});
