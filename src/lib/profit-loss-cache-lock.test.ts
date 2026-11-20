// 同帳戶的 profit_loss／沖銷明細依序執行；不同帳戶不互等；失敗不卡住後面的
import { expect, it } from 'vitest';
import { profitLossCacheKey, withProfitLossCache } from './profit-loss-cache-lock';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

it('runs same-account jobs one after another and lets other accounts through', async () => {
    const order: string[] = [];
    const gate = deferred();
    const a1 = withProfitLossCache('BR:1', async () => { order.push('a1 start'); await gate.promise; order.push('a1 end'); });
    const a2 = withProfitLossCache('BR:1', async () => { order.push('a2'); });
    const b1 = withProfitLossCache('BR:2', async () => { order.push('b1'); });
    await b1;
    expect(order).toEqual(['a1 start', 'b1']);
    gate.resolve();
    await Promise.all([a1, a2]);
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2']);
});

it('a failed job does not block the next one and still rejects to its caller', async () => {
    const failed = withProfitLossCache('BR:3', async () => { throw new Error('503'); });
    const next = withProfitLossCache('BR:3', async () => 'ok');
    await expect(failed).rejects.toThrow('503');
    await expect(next).resolves.toBe('ok');
});

it('keys by broker and account like the SDK cache', () => {
    expect(profitLossCacheKey({ broker_id: '9A95', account_id: '1' }, 'S')).toBe('9A95:1');
    expect(profitLossCacheKey(undefined, 'F')).toBe('default:F');
});
