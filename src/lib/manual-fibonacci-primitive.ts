import type { ISeriesPrimitive, SeriesAttachedParameter, IPrimitivePaneView, IPrimitivePaneRenderer,
    ISeriesPrimitiveAxisView, UTCTimestamp } from 'lightweight-charts';
import { fibLevels, type FibAnchor, type FibDrawing } from './manual-fibonacci';

/** Price labels live on the right price axis, not on candle bodies. */
export class ManualFibonacciPrimitive implements ISeriesPrimitive {
    private target?: SeriesAttachedParameter;
    private levels;
    private axis: ISeriesPrimitiveAxisView[];
    private view: IPrimitivePaneView = { zOrder: () => 'top', renderer: () => this.renderer };
    private renderer: IPrimitivePaneRenderer = { draw: target => {
        const attached = this.target;
        if (!attached) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const coord = (point: FibAnchor) => ({ x: attached.chart.timeScale().timeToCoordinate(point.time as UTCTimestamp),
                y: attached.series.priceToCoordinate(point.price) });
            ctx.save();
            if (this.drawing) {
                const a = coord(this.drawing.start), b = coord(this.drawing.end);
                ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
                if (a.x !== null && a.y !== null && b.x !== null && b.y !== null) {
                    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                }
                for (const level of this.levels) {
                    const y = attached.series.priceToCoordinate(level.price);
                    if (y === null || y < 0 || y > mediaSize.height) continue;
                    ctx.strokeStyle = level.color; ctx.lineWidth = 1.5; ctx.setLineDash([7, 4]);
                    ctx.beginPath(); ctx.moveTo(Math.max(0, b.x ?? 0), y); ctx.lineTo(mediaSize.width, y); ctx.stroke();
                }
            }
            for (const point of this.drawing ? [this.drawing.start, this.drawing.end] : this.draft ? [this.draft] : []) {
                const { x, y } = coord(point);
                if (x === null || y === null) continue;
                ctx.setLineDash([]); ctx.fillStyle = '#101820'; ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
            ctx.restore();
        });
    } };
    constructor(private drawing: FibDrawing | null, private draft: FibAnchor | null = null) {
        this.levels = drawing ? fibLevels(drawing) : [];
        this.axis = this.levels.map(level => ({
            coordinate: () => Number(this.target?.series.priceToCoordinate(level.price) ?? -10000),
            text: () => `${(level.ratio * 100).toFixed(1).replace('.0', '')}% ${level.price.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`,
            textColor: () => '#0b1018', backColor: () => level.color,
        }));
    }
    attached(param: SeriesAttachedParameter) { this.target = param; param.requestUpdate(); }
    detached() { this.target = undefined; }
    paneViews() { return [this.view]; }
    priceAxisViews() { return this.axis; }
}
