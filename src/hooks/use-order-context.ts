import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ContractBase } from '../lib/types/contract';

export const ORDER_CONTEXT_CHANGED_MESSAGE = '商品或交易單位已變更，已停止後續下單';

/** Capture a sending cycle. Switching away and back must not revive it;
 * layout cleanup also invalidates pending confirmations on unmount. */
export function useOrderContext(contract: ContractBase, lot: string) {
    const key = `${contract.security_type}:${contract.code}:${lot}`;
    const current = useRef(key);
    current.current = key;
    const generation = useRef(0);
    useLayoutEffect(() => {
        generation.current += 1;
        return () => { generation.current += 1; };
    }, [key]);
    return useCallback(() => {
        const startedKey = current.current;
        const startedGeneration = generation.current;
        return () => current.current === startedKey && generation.current === startedGeneration;
    }, []);
}
