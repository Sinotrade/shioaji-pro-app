// src/lib/types/health.ts

export interface Health {
    status: string;
    version: string;
    timestamp: string;
    token_expires_in_seconds: number;
    token_stale: boolean;
    // Contract V2 loads lazily, so newer servers may omit the old eager-load
    // count from their health response.
    contract_count?: number;
    next_maintenance: string;
}
