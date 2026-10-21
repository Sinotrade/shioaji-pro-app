// src/lib/heatmap-export.ts — 產業全景匯出 PNG
//
// tile 只是矩形＋文字，直接在 2× canvas 上重畫（比把 DOM 轉圖清楚、也不
// 受 transition 中途狀態影響）：上方標題列（標題、副標、時間、圖例），
// 下方是 treemap。桌面版用 Tauri 存檔對話框，網頁版走瀏覽器下載。

import type { Rect } from './heat-layout';
import { isTauri } from './runtime';

export interface ExportTile {
    rect: Rect;
    fill: string;
    ink: string;
    name: string;
    pctText: string | null;
    mode: 'both' | 'name' | 'code' | 'none';
    code: string;
    fontSize: number;
}

export interface ExportSector {
    rect: Rect;
    header: Rect | null;
    name: string;
    pctText: string | null;
    pctColor: string;
}

export interface ExportScene {
    width: number;
    height: number;
    title: string;
    subtitle: string;
    caption: string;
    legend: { colors: string[]; low: string; high: string };
    background: string;
    headerFill: string;
    foreground: string;
    muted: string;
    sectors: ExportSector[];
    tiles: ExportTile[];
}

const FONT_BODY =
    "'Inter', system-ui, -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif";
const FONT_MONO =
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const EXPORT_SCALE = 2;
const PAD = 16;
const HEAD = 58;

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number) {
    if (ctx.measureText(text).width <= max) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > max) {
        out = out.slice(0, -1);
    }
    return `${out}…`;
}

export function drawHeatmapScene(
    ctx: CanvasRenderingContext2D,
    scene: ExportScene,
): void {
    const totalW = scene.width + PAD * 2;
    const totalH = scene.height + HEAD + PAD;
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, totalW, totalH);

    // 標題列
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = scene.foreground;
    ctx.font = `600 16px ${FONT_BODY}`;
    ctx.fillText(scene.title, PAD, 26);
    const titleW = ctx.measureText(scene.title).width;
    ctx.fillStyle = scene.muted;
    ctx.font = `12px ${FONT_BODY}`;
    ctx.fillText(scene.subtitle, PAD + titleW + 10, 26);
    // 圖例（右上）
    const cell = 18;
    const legendW = cell * scene.legend.colors.length;
    ctx.font = `11px ${FONT_MONO}`;
    const highW = ctx.measureText(scene.legend.high).width;
    const legendX = totalW - PAD - highW - 6 - legendW;
    scene.legend.colors.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(legendX + i * cell, 16, cell, 10);
    });
    ctx.fillStyle = scene.muted;
    ctx.fillText(scene.legend.high, legendX + legendW + 6, 25);
    const lowW = ctx.measureText(scene.legend.low).width;
    ctx.fillText(scene.legend.low, legendX - 6 - lowW, 25);
    ctx.font = `11px ${FONT_BODY}`;
    ctx.fillText(
        ellipsize(ctx, scene.caption, totalW - PAD * 2),
        PAD,
        46,
    );

    ctx.save();
    ctx.translate(PAD, HEAD);
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    // 產業標題列
    for (const sector of scene.sectors) {
        if (!sector.header) continue;
        const h = sector.header;
        ctx.fillStyle = scene.headerFill;
        ctx.fillRect(h.x, h.y, h.w, h.h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(h.x, h.y, h.w, h.h);
        ctx.clip();
        ctx.textBaseline = 'middle';
        ctx.font = `600 11px ${FONT_BODY}`;
        ctx.fillStyle = scene.foreground;
        ctx.fillText(sector.name, h.x + 5, h.y + h.h / 2 + 0.5);
        const nameW = ctx.measureText(sector.name).width;
        if (sector.pctText && h.w >= nameW + 60) {
            ctx.font = `11px ${FONT_MONO}`;
            ctx.fillStyle = sector.pctColor;
            ctx.fillText(sector.pctText, h.x + 5 + nameW + 6, h.y + h.h / 2 + 0.5);
        }
        ctx.restore();
    }
    // 個股 tile
    for (const tile of scene.tiles) {
        const r = tile.rect;
        ctx.fillStyle = tile.fill;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (tile.mode === 'none') continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.fillStyle = tile.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const fs = tile.fontSize;
        if (tile.mode === 'both' && tile.pctText) {
            const pfs = Math.round(fs * 0.86);
            ctx.font = `600 ${fs}px ${FONT_BODY}`;
            ctx.fillText(tile.name, cx, cy - pfs * 0.62);
            ctx.font = `500 ${pfs}px ${FONT_MONO}`;
            ctx.fillText(tile.pctText, cx, cy + fs * 0.6);
        } else {
            ctx.font = `600 ${fs}px ${FONT_BODY}`;
            ctx.fillText(tile.mode === 'code' ? tile.code : tile.name, cx, cy);
        }
        ctx.restore();
    }
    ctx.restore();
}

export async function renderHeatmapPng(scene: ExportScene): Promise<Blob> {
    const canvas = document.createElement('canvas');
    const w = scene.width + PAD * 2;
    const h = scene.height + HEAD + PAD;
    canvas.width = Math.round(w * EXPORT_SCALE);
    canvas.height = Math.round(h * EXPORT_SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 無法使用');
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
    if (document.fonts?.ready) await document.fonts.ready;
    drawHeatmapScene(ctx, scene);
    return new Promise((resolve, reject) =>
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('PNG 產生失敗'))),
            'image/png',
        ),
    );
}

export function exportFileName(label: string, at: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
    return `產業全景-${label}-${stamp}.png`;
}

/** 存檔：桌面版開存檔對話框；網頁版直接下載。使用者取消回傳 null */
export async function saveHeatmapPng(
    blob: Blob,
    fileName: string,
): Promise<string | null> {
    if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({
            title: '匯出產業全景',
            defaultPath: fileName,
            filters: [{ name: 'PNG 圖片', extensions: ['png'] }],
        });
        if (!path) return null;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        return path;
    }
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return fileName;
}
