// src/lib/price-band.ts — series primitive：在主圖畫「水平價格帶」
// （上下兩個價位之間的橫式長方形區域，整個 pane 寬）。
// lightweight-charts v5 沒有內建 box/fill-between，這裡用官方 plugin
// primitive 機制補上；attach 到任一 series 即可（用該 series 的價格座標）。
// TXO 牆這類「價位區域」都走這個，不再用細線模擬。

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';

export interface PriceBandOptions {
    top: number; // 區域上緣價位
    bottom: number; // 區域下緣價位
    fillColor: string; // 半透明填色（rgba）
    borderColor: string; // 上下緣線色
    borderStyle: 'solid' | 'dashed';
    borderWidth: number;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

class PriceBandRenderer implements IPrimitivePaneRenderer {
    constructor(
        private readonly _opts: PriceBandOptions,
        private readonly _series: ISeriesApi<SeriesType> | null,
    ) {}

    draw(target: DrawTarget): void {
        const series = this._series;
        if (!series) return;
        const o = this._opts;
        const yTop = series.priceToCoordinate(Math.max(o.top, o.bottom));
        const yBot = series.priceToCoordinate(Math.min(o.top, o.bottom));
        if (yTop === null || yBot === null) return;
        target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;
            const w = scope.bitmapSize.width;
            const y1 = Math.round(yTop * vr);
            const y2 = Math.round(yBot * vr);
            // 填色（整個 pane 寬）
            ctx.fillStyle = o.fillColor;
            ctx.fillRect(0, y1, w, Math.max(y2 - y1, 1));
            // 上下緣
            ctx.strokeStyle = o.borderColor;
            ctx.lineWidth = o.borderWidth * hr;
            ctx.setLineDash(
                o.borderStyle === 'dashed' ? [4 * hr, 4 * hr] : [],
            );
            for (const y of [y1, y2]) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(w, y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        });
    }
}

class PriceBandView implements IPrimitivePaneView {
    constructor(private readonly _band: PriceBandPrimitive) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'bottom'; // 區域墊在 K 棒底下，不遮價格
    }
    renderer(): IPrimitivePaneRenderer {
        return new PriceBandRenderer(this._band.options, this._band.series);
    }
}

export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
    series: ISeriesApi<SeriesType> | null = null;
    private readonly _views: PriceBandView[];
    private _requestUpdate: (() => void) | null = null;

    constructor(public options: PriceBandOptions) {
        this._views = [new PriceBandView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this.series = param.series;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.series = null;
        this._requestUpdate = null;
    }

    applyOptions(opts: Partial<PriceBandOptions>): void {
        this.options = { ...this.options, ...opts };
        this._requestUpdate?.();
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }
}
