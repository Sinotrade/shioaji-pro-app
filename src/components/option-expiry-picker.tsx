// src/components/option-expiry-picker.tsx — T 字報價的到期契約選擇器（issue #152／#154）
//
// 收合時只佔一列：‹ [MM/DD 週五 週選 剩 3 天 ▾] ›。‹／› 依到期日順序
// 切換上一個／下一個到期，兩端停用。點主按鈕展開下拉清單：依月份分組、
// 每列 MM/DD、星期、月選／週選標記與右側剩餘天數；遇假日順延的到期加註
// 「順延」，詳情在 tooltip。清單 portal 到所在視窗的 body（獨立視窗亦同）
// 並以 fixed 定位，不被面板的 overflow 或 grid 的 transform 裁切。
//
// 鍵盤：主按鈕 Enter／Space／↓ 展開；清單內 ↑↓ 移動、Home／End、Enter
// 選取、Esc 關閉並把焦點還給主按鈕；點清單外關閉。Esc 走 modal stack
// （useEscClose），關閉清單的那一下不會武裝 Esc-Esc 全刪單。

import {
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react';
import { useAnchoredPopup } from '../hooks/use-anchored-popup';
import { useEscClose } from '../hooks/use-esc-close';
import {
    daysLeftLabel,
    expiryTitle,
    groupByMonth,
    kindBadge,
    monthGroupLabel,
    weekdayLabel,
    type OptionExpiry,
} from '../lib/option-expiry';
import * as styles from './option-expiry-picker.css';

const mmdd = (e: OptionExpiry) => `${e.date.slice(5, 7)}/${e.date.slice(8, 10)}`;

// 清單最多高度（px）與距視窗邊緣的留白
const LIST_MAX_HEIGHT = 320;
const EDGE = 8;

function Summary({ e, trigger }: { e: OptionExpiry; trigger?: boolean }) {
    const today = e.daysLeft <= 0;
    return (
        <>
            <span
                className={styles.date[e.shiftedFrom === null ? 'normal' : 'shifted']}
                data-shifted={e.shiftedFrom !== null || undefined}
            >
                {mmdd(e)}
            </span>
            <span className={styles.weekday}>{weekdayLabel(e)}</span>
            <span className={styles.badge[e.kind === 'monthly' ? 'monthly' : 'weekly']}>
                {kindBadge(e)}
            </span>
            {!trigger && e.shiftedFrom !== null && (
                <span className={styles.shiftedNote} data-shifted-note>
                    順延
                </span>
            )}
            <span
                className={`${styles.days[today ? 'today' : 'normal']} ${
                    trigger ? styles.triggerDays : styles.optionDays
                }`}
                data-today={today || undefined}
            >
                {daysLeftLabel(e.daysLeft)}
            </span>
        </>
    );
}

export function OptionExpiryPicker({
    expiries,
    value,
    onChange,
}: {
    expiries: OptionExpiry[];
    value: string;
    onChange: (key: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const listId = useId();

    const idx = expiries.findIndex((e) => e.key === value);
    const current = idx >= 0 ? expiries[idx] : undefined;
    const prev = idx > 0 ? expiries[idx - 1] : undefined;
    const next = idx >= 0 ? expiries[idx + 1] : expiries[0];
    const empty = expiries.length === 0;

    useEffect(() => {
        if (empty) setOpen(false);
    }, [empty]);

    const close = (restoreFocus: boolean) => {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    };

    return (
        <div ref={anchorRef} className={styles.picker} role="group" aria-label="到期契約">
            <button
                type="button"
                className={styles.step}
                aria-label="上一個到期"
                title={prev ? `上一個到期：${expiryTitle(prev)}` : '已是最近的到期'}
                disabled={!prev}
                onClick={() => prev && onChange(prev.key)}
            >
                ‹
            </button>
            <button
                ref={triggerRef}
                type="button"
                className={styles.trigger}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                data-expiry={current?.key}
                title={current ? expiryTitle(current) : undefined}
                disabled={empty}
                onClick={() => setOpen((o) => !o)}
                onKeyDown={(ev) => {
                    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                        ev.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                {current ? (
                    <Summary e={current} trigger />
                ) : (
                    <span className={styles.empty}>{empty ? '無到期契約' : '選擇到期'}</span>
                )}
                <span className={styles.caret} aria-hidden>
                    ▾
                </span>
            </button>
            <button
                type="button"
                className={styles.step}
                aria-label="下一個到期"
                title={next ? `下一個到期：${expiryTitle(next)}` : '已是最遠的到期'}
                disabled={!next}
                onClick={() => next && onChange(next.key)}
            >
                ›
            </button>
            {open && !empty && (
                <ExpiryList
                    id={listId}
                    expiries={expiries}
                    value={value}
                    anchor={anchorRef.current}
                    onSelect={(key) => {
                        close(true);
                        if (key !== value) onChange(key);
                    }}
                    onClose={close}
                />
            )}
        </div>
    );
}

function ExpiryList({
    id,
    expiries,
    value,
    anchor,
    onSelect,
    onClose,
}: {
    id: string;
    expiries: OptionExpiry[];
    value: string;
    anchor: HTMLElement | null;
    onSelect: (key: string) => void;
    onClose: (restoreFocus: boolean) => void;
}) {
    const listRef = useRef<HTMLDivElement | null>(null);
    // 以契約 key 記住目前的鍵盤位置：清單開著時到期清單更新（例如到期
    // 契約下架）也不會錯位到別的契約
    const [activeKey, setActiveKey] = useState<string | undefined>(() => value);
    const found = expiries.findIndex((e) => e.key === activeKey);
    const active = found >= 0 ? found : Math.max(0, expiries.findIndex((e) => e.key === value));
    const setActive = (next: number | ((a: number) => number)) =>
        setActiveKey(expiries[typeof next === 'function' ? next(active) : next]?.key);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEscClose(() => onClose(true));

    // 依錨點位置擺放：預設在下方，下方太擠且上方較寬時翻到上方
    const { style: pos, portal } = useAnchoredPopup({
        anchor,
        place: (target, { width: vw, height: vh }) => {
            const r = target.getBoundingClientRect();
            const below = vh - r.bottom - EDGE;
            const above = r.top - EDGE;
            const up = below < 160 && above > below;
            const width = Math.min(Math.max(r.width, 240), vw - EDGE * 2);
            const left = Math.min(Math.max(EDGE, r.left), vw - width - EDGE);
            return {
                left,
                width,
                maxHeight: Math.max(96, Math.min(LIST_MAX_HEIGHT, up ? above - 4 : below - 4)),
                ...(up ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
            };
        },
    });

    // 開啟時聚焦清單、選取列捲入可見；點清單與錨點以外即關閉
    useEffect(() => {
        const list = listRef.current;
        list?.focus({ preventScroll: true });
        list
            ?.querySelector('[aria-selected="true"]')
            ?.scrollIntoView?.({ block: 'center' });
        const doc = anchor?.ownerDocument;
        if (!doc) return;
        const onDown = (ev: PointerEvent) => {
            const t = ev.target as Node | null;
            if (t && (listRef.current?.contains(t) || anchor.contains(t))) return;
            closeRef.current(false);
        };
        doc.addEventListener('pointerdown', onDown, true);
        return () => doc.removeEventListener('pointerdown', onDown, true);
    }, [anchor]);

    useEffect(() => {
        const key = expiries[active]?.key;
        if (!key) return;
        listRef.current
            ?.querySelector(`[data-expiry="${key}"]`)
            ?.scrollIntoView?.({ block: 'nearest' });
    }, [active, expiries]);

    const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
        const last = expiries.length - 1;
        switch (ev.key) {
            case 'ArrowDown':
                setActive((a) => Math.min(last, a + 1));
                break;
            case 'ArrowUp':
                setActive((a) => Math.max(0, a - 1));
                break;
            case 'Home':
                setActive(0);
                break;
            case 'End':
                setActive(last);
                break;
            case 'Enter':
            case ' ': {
                const e = expiries[active];
                if (e) onSelect(e.key);
                break;
            }
            case 'Escape':
                // 瀏覽器中已由 modal stack 處理（defaultPrevented）
                if (ev.defaultPrevented) return;
                onClose(true);
                break;
            case 'Tab':
                // 焦點先回到按鈕，再讓 Tab 照常移到下一個（Shift+Tab 上一個）控制項
                onClose(true);
                return;
            default:
                return;
        }
        ev.preventDefault();
        ev.stopPropagation();
    };

    const groups = groupByMonth(expiries);
    const first = groups[0]?.month ?? '';
    const activeOptionKey = expiries[active]?.key;
    const optionId = (key: string) => `${id}-${key.replace(/[^A-Za-z0-9]/g, '')}`;

    const list = (
        <div
            ref={listRef}
            id={id}
            role="listbox"
            aria-label="到期契約"
            tabIndex={-1}
            aria-activedescendant={activeOptionKey ? optionId(activeOptionKey) : undefined}
            className={styles.list}
            style={pos}
            onKeyDown={onKeyDown}
        >
            {groups.map((g, gi) => (
                <div
                    key={g.month}
                    role="group"
                    aria-label={`${g.month.slice(0, 4)}年${Number(g.month.slice(4))}月`}
                >
                    <div
                        className={`${styles.groupLabel} ${gi === 0 ? styles.firstGroupLabel : ''}`}
                        aria-hidden
                    >
                        {monthGroupLabel(g.month, first)}
                    </div>
                    {g.items.map((e) => {
                        const i = expiries.indexOf(e);
                        return (
                            <div
                                key={e.key}
                                id={optionId(e.key)}
                                role="option"
                                aria-selected={e.key === value}
                                data-active={i === active}
                                data-expiry={e.key}
                                title={expiryTitle(e)}
                                className={styles.option}
                                onMouseMove={() => i !== active && setActive(i)}
                                onClick={() => onSelect(e.key)}
                            >
                                <Summary e={e} />
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );

    // 測試（無 DOM）時就地渲染；瀏覽器中 portal 到錨點所在文件的 body
    return portal(list);
}
