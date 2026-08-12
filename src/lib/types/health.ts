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
    // 1.7.2+
    ca_expires_in_days?: number;
    ca_expired?: boolean;
    agent_harness: {
        enabled: boolean;
        mode: 'off' | 'production' | 'all';
        capability_version: number;
        capability_header: string;
        digest_scheme: string;
        audience: string | null;
        max_ttl_seconds: number;
    };
}
