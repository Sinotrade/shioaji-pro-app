// src/lib/types/health.ts

export interface Health {
    status: string;
    version: string;
    timestamp: string;
    token_expires_in_seconds: number;
    token_stale: boolean;
    contract_count: number;
    next_maintenance: string;
    agent_capabilities?: {
        version: number;
        mutation_auth_required: boolean;
        broker_transport: string;
        daemon_instance_id?: string;
    };
}
