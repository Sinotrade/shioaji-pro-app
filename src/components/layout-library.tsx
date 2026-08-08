// src/components/layout-library.tsx — 版面庫 dialog：預設版面＋我的版面，
// 卡片縮圖（SVG：分類色塊反映真實 grid 幾何）＋ hover flyout 放大預覽＋
// 底部「儲存目前版面」（所見即所存縮圖＋可選 icon）。幾何換算在
// lib/layout-thumb.ts（純函式，vitest 覆蓋）。

import {
    Bot,
    Briefcase,
    CandlestickChart,
    Check,
    Flame,
    LayoutGrid,
    type LucideIcon,
    Monitor,
    Pencil,
    Rocket,
    Star,
    Target,
    Trash2,
    X,
    Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { labelChars, thumbRects } from '../lib/layout-thumb';
import {
    BLOCK_META,
    LAYOUT_PRESETS,
    type PanelCategory,
    type Profile,
    type Workspace,
} from '../lib/workspace';
import { vars } from '../theme.css';
import * as hud from './hud-header.css';
import * as styles from './layout-library.css';

// 分類→色票：market 藍（accent）、trading 琥珀、account 綠、
// derivatives 紫、tools 灰。theme-vars 相容（紫色三主題皆可讀）。
const CATEGORY_COLORS: Record<PanelCategory, string> = {
    market: vars.color.accent,
    trading: vars.color.amber,
    account: vars.color.success,
    derivatives: '#8b5cf6',
    tools: vars.color.mutedForeground,
};

// 儲存版面可選角標 — lucide 名稱字串存進 Profile.icon
export const PROFILE_ICONS: Record<string, LucideIcon> = {
    LayoutGrid,
    CandlestickChart,
    Briefcase,
    Zap,
    Star,
    Monitor,
    Flame,
    Target,
    Rocket,
    Bot,
};

export function LayoutThumb({
    workspace,
    width,
    height,
    fontSize,
}: {
    workspace: Workspace;
    width: number;
    height: number;
    fontSize: number;
}) {
    const rects = thumbRects(workspace, width, height, fontSize > 8 ? 3 : 2);
    return (
        <svg
            className={styles.thumbSvg}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio='none'
        >
            {rects.map((r) => {
                const color = CATEGORY_COLORS[BLOCK_META[r.type].category];
                const chars = labelChars(r, fontSize);
                return (
                    <g key={r.id}>
                        <rect
                            x={r.x}
                            y={r.y}
                            width={r.w}
                            height={r.h}
                            rx={2}
                            fill={color}
                            fillOpacity={0.22}
                            stroke={color}
                            strokeWidth={1}
                        />
                        {chars > 0 && (
                            <text
                                x={r.x + r.w / 2}
                                y={r.y + r.h / 2}
                                textAnchor='middle'
                                dominantBaseline='central'
                                fill={color}
                                fontSize={fontSize}
                                fontFamily='inherit'
                            >
                                {r.label.length > chars
                                    ? r.label.slice(0, chars)
                                    : r.label}
                            </text>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}

type Hovered =
    | { kind: 'preset'; name: string }
    | { kind: 'profile'; name: string }
    | null;

function FlyoutPanelList({ workspace }: { workspace: Workspace }) {
    return (
        <div className={styles.flyoutList}>
            {workspace.blocks.map((b) => {
                const meta = BLOCK_META[b.type];
                return (
                    <span key={b.id} className={styles.flyoutItem}>
                        <span
                            className={styles.flyoutDot}
                            style={{
                                background: CATEGORY_COLORS[meta.category],
                            }}
                        />
                        {meta.label}
                        {b.pin && (
                            <span className={styles.flyoutPin}>
                                釘選 {b.pin}
                            </span>
                        )}
                    </span>
                );
            })}
        </div>
    );
}

export function LayoutLibrary({
    open,
    onClose,
    profiles,
    currentWorkspace,
    onSaveProfile,
    onLoadProfile,
    onDeleteProfile,
    onRenameProfile,
    onLoadPreset,
}: {
    open: boolean;
    onClose: () => void;
    profiles: Profile[];
    currentWorkspace: Workspace;
    onSaveProfile: (name: string, icon?: string) => void;
    onLoadProfile: (name: string) => void;
    onDeleteProfile: (name: string) => void;
    onRenameProfile: (oldName: string, newName: string) => void;
    onLoadPreset: (name: string) => void;
}) {
    const [hovered, setHovered] = useState<Hovered>(null);
    // two-stage delete: first click arms, second click deletes
    const [deleteArm, setDeleteArm] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameVal, setRenameVal] = useState('');
    const [saveName, setSaveName] = useState('');
    const [saveIcon, setSaveIcon] = useState<string | null>(null);
    // untouched picker + overwrite → keep the existing profile's icon;
    // only an explicit pick (or explicit un-pick) changes it
    const [iconTouched, setIconTouched] = useState(false);
    // saving over an existing name needs an explicit second click
    const [overwriteArm, setOverwriteArm] = useState(false);

    useEffect(() => {
        if (open) {
            setHovered(null);
            setDeleteArm(null);
            setRenaming(null);
            setSaveName('');
            setSaveIcon(null);
            setIconTouched(false);
            setOverwriteArm(false);
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const trimmed = saveName.trim();
    const nameTaken = profiles.some((p) => p.name === trimmed);

    const doSave = () => {
        if (!trimmed) return;
        if (nameTaken && !overwriteArm) {
            setOverwriteArm(true);
            return;
        }
        const icon = iconTouched
            ? (saveIcon ?? undefined)
            : (saveIcon ??
              profiles.find((p) => p.name === trimmed)?.icon);
        onSaveProfile(trimmed, icon);
        setSaveName('');
        setSaveIcon(null);
        setIconTouched(false);
        setOverwriteArm(false);
    };

    const commitRename = () => {
        const next = renameVal.trim();
        if (renaming && next && next !== renaming) {
            onRenameProfile(renaming, next);
        }
        setRenaming(null);
    };

    const hoveredWs: { ws: Workspace; title: string; desc?: string } | null =
        (() => {
            if (!hovered) return null;
            if (hovered.kind === 'preset') {
                const p = LAYOUT_PRESETS.find((x) => x.name === hovered.name);
                return p
                    ? { ws: p.workspace, title: p.name, desc: p.desc }
                    : null;
            }
            const p = profiles.find((x) => x.name === hovered.name);
            return p ? { ws: p.workspace, title: p.name } : null;
        })();

    return (
        <>
            <div className={styles.backdrop} onClick={onClose} />
            <div
                className={styles.shell}
                role='dialog'
                aria-label='版面庫'
            >
                <div className={styles.dialog}>
                    <div className={styles.titleRow}>
                        <LayoutGrid size={13} /> 版面庫
                        <button
                            className={`${hud.profileDelete} ${styles.titleClose}`}
                            title='關閉（Esc）'
                            onClick={onClose}
                        >
                            <X size={12} />
                        </button>
                    </div>
                    <div className={styles.body}>
                        <div className={styles.sectionHeader}>預設版面</div>
                        <div className={styles.cardGrid}>
                            {LAYOUT_PRESETS.map((p) => (
                                <button
                                    key={p.name}
                                    title={`套用預設版面「${p.name}」`}
                                    className={
                                        styles.card[
                                            hovered?.kind === 'preset' &&
                                            hovered.name === p.name
                                                ? 'active'
                                                : 'normal'
                                        ]
                                    }
                                    onMouseEnter={() =>
                                        setHovered({
                                            kind: 'preset',
                                            name: p.name,
                                        })
                                    }
                                    onClick={() => {
                                        onLoadPreset(p.name);
                                        onClose();
                                    }}
                                >
                                    <span className={styles.thumbFrame}>
                                        <LayoutThumb
                                            workspace={p.workspace}
                                            width={120}
                                            height={80}
                                            fontSize={7}
                                        />
                                    </span>
                                    <span className={styles.cardName}>
                                        {p.name}
                                    </span>
                                    <span className={styles.cardDesc}>
                                        {p.desc}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <div className={styles.sectionHeader}>我的版面</div>
                        {profiles.length === 0 ? (
                            <div className={styles.empty}>
                                尚無自訂版面 — 調整好目前版面後，在下方輸入
                                名稱儲存；儲存的版面會出現在這裡，點卡片即可
                                隨時切換。
                            </div>
                        ) : (
                            <div className={styles.cardGrid}>
                                {profiles.map((p) => {
                                    const Icon = p.icon
                                        ? PROFILE_ICONS[p.icon]
                                        : undefined;
                                    const isRenaming = renaming === p.name;
                                    return (
                                        <div
                                            key={p.name}
                                            role='button'
                                            tabIndex={0}
                                            title={`套用版面「${p.name}」`}
                                            className={
                                                styles.card[
                                                    hovered?.kind ===
                                                        'profile' &&
                                                    hovered.name === p.name
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            onMouseEnter={() =>
                                                setHovered({
                                                    kind: 'profile',
                                                    name: p.name,
                                                })
                                            }
                                            onMouseLeave={() =>
                                                setDeleteArm((cur) =>
                                                    cur === p.name
                                                        ? null
                                                        : cur,
                                                )
                                            }
                                            onClick={() => {
                                                if (isRenaming) return;
                                                onLoadProfile(p.name);
                                                onClose();
                                            }}
                                            onKeyDown={(e) => {
                                                if (
                                                    e.key === 'Enter' &&
                                                    !isRenaming
                                                ) {
                                                    onLoadProfile(p.name);
                                                    onClose();
                                                }
                                            }}
                                        >
                                            <span
                                                className={styles.thumbFrame}
                                            >
                                                <LayoutThumb
                                                    workspace={p.workspace}
                                                    width={120}
                                                    height={80}
                                                    fontSize={7}
                                                />
                                            </span>
                                            {isRenaming ? (
                                                <input
                                                    className={
                                                        styles.renameInput
                                                    }
                                                    value={renameVal}
                                                    autoFocus
                                                    onClick={(e) =>
                                                        e.stopPropagation()
                                                    }
                                                    onChange={(e) =>
                                                        setRenameVal(
                                                            e.target.value,
                                                        )
                                                    }
                                                    onKeyDown={(e) => {
                                                        e.stopPropagation();
                                                        if (e.key === 'Enter')
                                                            commitRename();
                                                        if (e.key === 'Escape')
                                                            setRenaming(null);
                                                    }}
                                                    onBlur={commitRename}
                                                />
                                            ) : (
                                                <span
                                                    className={styles.cardName}
                                                >
                                                    {Icon && (
                                                        <span
                                                            className={
                                                                styles.cardIcon
                                                            }
                                                        >
                                                            <Icon size={12} />
                                                        </span>
                                                    )}
                                                    {p.name}
                                                </span>
                                            )}
                                            <span className={styles.cardDesc}>
                                                {p.workspace.blocks.length}
                                                個面板
                                            </span>
                                            {!isRenaming && (
                                                <span
                                                    className={
                                                        styles.cardActions
                                                    }
                                                >
                                                    <button
                                                        className={
                                                            styles.actionBtn
                                                                .normal
                                                        }
                                                        title='改名'
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setRenaming(
                                                                p.name,
                                                            );
                                                            setRenameVal(
                                                                p.name,
                                                            );
                                                            setDeleteArm(null);
                                                        }}
                                                    >
                                                        <Pencil size={11} />
                                                    </button>
                                                    {deleteArm === p.name ? (
                                                        <button
                                                            className={
                                                                styles.actionBtn
                                                                    .danger
                                                            }
                                                            title='確認刪除此版面'
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setDeleteArm(
                                                                    null,
                                                                );
                                                                onDeleteProfile(
                                                                    p.name,
                                                                );
                                                            }}
                                                        >
                                                            確認刪除
                                                        </button>
                                                    ) : (
                                                        <button
                                                            className={
                                                                styles.actionBtn
                                                                    .normal
                                                            }
                                                            title='刪除（需二次確認）'
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setDeleteArm(
                                                                    p.name,
                                                                );
                                                            }}
                                                        >
                                                            <Trash2
                                                                size={11}
                                                            />
                                                        </button>
                                                    )}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    <div className={styles.saveBar}>
                        <span
                            className={styles.saveThumbFrame}
                            title='目前版面即時預覽（所見即所存）'
                        >
                            <LayoutThumb
                                workspace={currentWorkspace}
                                width={90}
                                height={60}
                                fontSize={6}
                            />
                        </span>
                        <div className={styles.saveFields}>
                            <div className={hud.saveRow}>
                                <input
                                    className={hud.saveInput}
                                    placeholder='儲存目前版面 — 輸入名稱'
                                    value={saveName}
                                    onChange={(e) => {
                                        setSaveName(e.target.value);
                                        setOverwriteArm(false);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') doSave();
                                    }}
                                />
                                <button
                                    className={
                                        overwriteArm
                                            ? styles.actionBtn.danger
                                            : hud.resetBtn
                                    }
                                    disabled={!trimmed}
                                    title={
                                        overwriteArm
                                            ? `已有同名版面「${trimmed}」— 再按一次覆蓋`
                                            : '儲存目前版面'
                                    }
                                    onClick={doSave}
                                >
                                    {overwriteArm ? (
                                        <>
                                            <Check
                                                size={11}
                                                style={{
                                                    verticalAlign: '-1px',
                                                }}
                                            />{' '}
                                            確認覆蓋
                                        </>
                                    ) : (
                                        '儲存'
                                    )}
                                </button>
                            </div>
                            <div className={styles.iconRow}>
                                {Object.entries(PROFILE_ICONS).map(
                                    ([name, Icon]) => (
                                        <button
                                            key={name}
                                            className={
                                                styles.iconOpt[
                                                    saveIcon === name
                                                        ? 'on'
                                                        : 'off'
                                                ]
                                            }
                                            title={`角標 icon：${name}（再點一次取消）`}
                                            onClick={() => {
                                                setIconTouched(true);
                                                setSaveIcon((cur) =>
                                                    cur === name
                                                        ? null
                                                        : name,
                                                );
                                            }}
                                        >
                                            <Icon size={13} />
                                        </button>
                                    ),
                                )}
                                <span className={styles.saveHint}>
                                    icon 可不選
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                {hoveredWs && (
                    <div className={styles.flyout}>
                        <span className={styles.flyoutThumbFrame}>
                            <LayoutThumb
                                workspace={hoveredWs.ws}
                                width={280}
                                height={190}
                                fontSize={10}
                            />
                        </span>
                        <span className={styles.flyoutTitle}>
                            {hoveredWs.title}
                        </span>
                        {hoveredWs.desc && (
                            <span className={styles.flyoutDesc}>
                                {hoveredWs.desc}
                            </span>
                        )}
                        <FlyoutPanelList workspace={hoveredWs.ws} />
                    </div>
                )}
            </div>
        </>
    );
}
