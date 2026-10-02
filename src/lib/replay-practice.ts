export interface ReplayPracticePosition {
    side: 'long' | 'short';
    entry: number;
    enteredAt: number;
    quantity: number;
}

export interface ReplayPracticeTrade extends ReplayPracticePosition {
    id: string;
    code: string;
    exit: number;
    exitedAt: number;
    points: number;
    estimatedPnl: number;
}

export function replayPoints(position: ReplayPracticePosition, exit: number): number {
    const direction = position.side === 'long' ? 1 : -1;
    return (exit - position.entry) * direction * position.quantity;
}

export function closeReplayPosition(
    position: ReplayPracticePosition,
    code: string,
    exit: number,
    exitedAt: number,
    multiplier: number,
): ReplayPracticeTrade {
    const points = replayPoints(position, exit);
    return {
        ...position,
        id: `${code}-${exitedAt}-${Math.random().toString(36).slice(2, 8)}`,
        code,
        exit,
        exitedAt,
        points,
        estimatedPnl: points * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1),
    };
}

export function loadReplayTrades(raw: string | null): ReplayPracticeTrade[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((row): row is ReplayPracticeTrade => {
            const r = row as Partial<ReplayPracticeTrade>;
            return (
                typeof r.id === 'string' &&
                typeof r.code === 'string' &&
                (r.side === 'long' || r.side === 'short') &&
                [r.entry, r.exit, r.enteredAt, r.exitedAt, r.quantity, r.points, r.estimatedPnl].every(
                    (v) => typeof v === 'number' && Number.isFinite(v),
                )
            );
        }).slice(-500);
    } catch {
        return [];
    }
}
