// /health can return HTTP 200 while the broker session is unavailable.
// A recovering session also rejects data requests, so neither state may
// trigger the post-start reload or be shown as ready.
export function serverHealthReady(health: {
    status?: string;
    session_recovering?: boolean;
}): boolean {
    return (health.status === 'healthy' || health.status === 'degraded') &&
        health.session_recovering !== true;
}
