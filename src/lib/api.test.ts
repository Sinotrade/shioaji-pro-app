import { describe, expect, it } from 'vitest';
import { shouldProxyAgentHarnessMutation } from './api';

describe('agent harness mutation routing', () => {
    it('keeps normal UI orders on the direct HTTP path while disabled', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                false,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });

    it('uses the native capability proxy only for enabled desktop mutations', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(true);
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/data/snapshots',
            ),
        ).toBe(false);
        expect(
            shouldProxyAgentHarnessMutation(
                false,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });
});
