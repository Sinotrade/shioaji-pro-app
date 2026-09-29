import type { ISeriesPrimitive, SeriesAttachedParameter, IPrimitivePaneView, IPrimitivePaneRenderer, UTCTimestamp } from 'lightweight-charts';

export interface ResearchVerticalLine { time: number; text: string; color: string; dashed?: boolean; }

/** Labels occupy two dedicated lanes above the candles. The chart redraws
 * this primitive on scroll, zoom and resize; it never affects price scaling. */
export class ResearchTransitionPrimitive implements ISeriesPrimitive {
    private attachedTo?: SeriesAttachedParameter;
    private view: IPrimitivePaneView = { zOrder: () => 'top', renderer: () => this.renderer };
    private renderer: IPrimitivePaneRenderer = { draw: target => {
        const chart = this.attachedTo?.chart;
        if (!chart) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            // Reserve the left corner for existing indicator legends.
            const right = [190, 190];
            ctx.save();
            ctx.font = 'bold 12px system-ui';
            const visible = this.lines.map(line => ({ ...line, x: chart.timeScale().timeToCoordinate(line.time as UTCTimestamp) }))
                .filter(line => line.x !== null && line.x >= 0 && line.x <= mediaSize.width);
            for (const line of visible) {
                const x = Number(line.x);
                ctx.strokeStyle = line.color;
                ctx.lineWidth = line.dashed ? 1.5 : 1;
                ctx.setLineDash(line.dashed ? [6, 4] : []);
                ctx.globalAlpha = .65;
                ctx.beginPath(); ctx.moveTo(x, 38); ctx.lineTo(x, mediaSize.height * .81); ctx.stroke();
                ctx.globalAlpha = 1;
                const width = ctx.measureText(line.text).width + 10;
                const left = Math.max(0, Math.min(x + 3, mediaSize.width - width));
                const lane = right.findIndex(edge => left >= edge + 4);
                if (lane < 0) continue; // dense flips keep lines without overlapping text
                right[lane] = left + width;
                const y = 2 + lane * 18;
                ctx.fillStyle = '#101820'; ctx.fillRect(left, y, width, 17);
                ctx.fillStyle = line.color; ctx.fillText(line.text, left + 5, y + 13);
            }
            ctx.restore();
        });
    } };
    constructor(private lines: ResearchVerticalLine[]) {}
    attached(param: SeriesAttachedParameter) { this.attachedTo = param; param.requestUpdate(); }
    detached() { this.attachedTo = undefined; }
    paneViews() { return [this.view]; }
}
