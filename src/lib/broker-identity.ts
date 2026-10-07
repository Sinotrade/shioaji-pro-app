// Broker identity is shared by both execution cores and the window bracket runtime.
export function brokerIdentityMatches(a: { seqno?: string; ordno?: string }, b: { seqno?: string; ordno?: string }): boolean {
    const pairs = [ [a.seqno?.trim(), b.seqno?.trim()], [a.ordno?.trim(), b.ordno?.trim()] ];
    return pairs.some(([x, y]) => !!x && x === y) && pairs.every(([x, y]) => !x || !y || x === y);
}

/** A conflicting broker identifier always beats a reused trade id. Only a
 * currently confirmed legacy binding can use that id as a fallback. */
export function externalIdentity(a: { orderId: string; seqno?: string; ordno?: string; confirmed?: boolean },
    b: { orderId: string; seqno?: string; ordno?: string; confirmed?: boolean }): 'same' | 'different' | 'unknown' {
    const pairs = [[a.seqno?.trim(), b.seqno?.trim()], [a.ordno?.trim(), b.ordno?.trim()]];
    if (pairs.some(([x, y]) => !!x && !!y && x !== y)) return 'different';
    if (brokerIdentityMatches(a, b)) return 'same';
    const stableA = !!(a.seqno?.trim() || a.ordno?.trim());
    const stableB = !!(b.seqno?.trim() || b.ordno?.trim());
    if (stableA || stableB || a.orderId !== b.orderId) return 'unknown';
    return a.confirmed !== false && b.confirmed !== false ? 'same' : 'unknown';
}
