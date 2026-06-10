// src/lib/shioaji.ts

import { apiGet, apiPost } from './api';
import type {
    ContractBase,
    ContractInfo,
    SecurityType,
} from './types/contract';
import type { Health } from './types/health';
import type { HistoryTicks } from './types/tick';

export function fetchHealth() {
    return apiGet<Health>('/api/v1/health');
}

export function fetchContract(
    code: string,
    securityType: SecurityType = 'STK',
) {
    const qs = new URLSearchParams({ security_type: securityType ?? '' });
    return apiGet<ContractInfo>(
        `/api/v1/data/contracts/${encodeURIComponent(code)}?${qs.toString()}`,
    );
}

export function fetchHistoryTicks(contract: ContractBase, date: string) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: {
            security_type: contract.security_type,
            exchange: contract.exchange,
            code: contract.code,
        },
        date,
    });
}
