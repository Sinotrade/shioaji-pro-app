// src/components/shortcuts/key-caps.tsx — 鍵帽（設定頁、提示頁、下單面板共用）

import { MousePointerClick } from 'lucide-react';
import { Fragment } from 'react';
import { keyCaps, parseChord, type Platform } from '../../lib/shortcuts/keys';
import type { ShortcutDef } from '../../lib/shortcuts/registry';
import * as styles from './shortcuts.css';

export function Chord({ chord, platform, small }: { chord: string; platform: Platform; small?: boolean }) {
    const p = parseChord(chord);
    const caps = keyCaps(chord, platform);
    const cls = small ? `${styles.cap} ${styles.capSm}` : styles.cap;
    if (p?.twice) {
        // 連按兩次：Esc → Esc
        const half = caps.slice(0, caps.length / 2);
        return (
            <span className={styles.combo} aria-label={`連按兩次 ${half.join(' ')}`}>
                {half.map((c, i) => <kbd key={`a${i}`} className={cls}>{c}</kbd>)}
                <span className={styles.capThen}>×2</span>
            </span>
        );
    }
    return (
        <span className={styles.combo}>
            {caps.map((c, i) => <kbd key={i} className={cls}>{c}</kbd>)}
        </span>
    );
}

export function KeyCaps({ def, keys, platform }: { def: ShortcutDef; keys: readonly string[]; platform: Platform }) {
    if (def.gesture) {
        return (
            <span className={styles.gesture}>
                <MousePointerClick size={12} /> {platform === 'mac' ? def.gesture.replace(/^Alt/, '⌥') : def.gesture}
            </span>
        );
    }
    if (!keys.length) return <span className={styles.unset}>未設定</span>;
    return (
        <span className={styles.keys}>
            {keys.map((chord, i) => (
                <Fragment key={chord}>
                    {i > 0 && <span className={styles.capOr}>或</span>}
                    <Chord chord={chord} platform={platform} />
                </Fragment>
            ))}
        </span>
    );
}
