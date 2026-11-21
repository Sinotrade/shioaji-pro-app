// src/lib/shortcuts/keys.ts — 按鍵字串（chord）的解析、顯示與錄製
//
// 格式：`Mod+Shift+KeyZ`、`Alt+KeyT`、`KeyB`、`Escape*2`。
// - Mod 在 macOS 是 ⌘，其他平台是 Ctrl；`Ctrl` 只出現在 macOS 的 ⌃。
// - 主鍵用 KeyboardEvent.code（實體鍵位）：macOS 的 Option 會把 e.key 變成
//   特殊符號、注音輸入法與 Caps Lock 也會改 e.key，code 都不受影響。
// - `*2` 結尾表示 0.6 秒內連按兩次（目前只有全部刪單）。
// 修飾鍵固定排序 Ctrl → Mod → Alt → Shift，字串相等即同一個組合。

export type Platform = 'mac' | 'win';

export function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'win';
    const p = navigator.platform || navigator.userAgent || '';
    return /Mac|iPhone|iPad/i.test(p) ? 'mac' : 'win';
}

const MOD_ORDER = ['Ctrl', 'Mod', 'Alt', 'Shift'] as const;
type Modifier = (typeof MOD_ORDER)[number];

export interface ParsedChord {
    mods: Modifier[];
    code: string;
    twice: boolean;
}

export function parseChord(chord: string): ParsedChord | null {
    const twice = chord.endsWith('*2');
    const parts = (twice ? chord.slice(0, -2) : chord).split('+');
    const code = parts.pop();
    if (!code) return null;
    const mods: Modifier[] = [];
    for (const p of parts) {
        if (!(MOD_ORDER as readonly string[]).includes(p) || mods.includes(p as Modifier)) return null;
        mods.push(p as Modifier);
    }
    // 修飾鍵順序必須是標準順序，才能用字串比對判斷相同組合
    const sorted = [...mods].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    if (sorted.join() !== mods.join()) return null;
    if (!isValidCode(code)) return null;
    return { mods, code, twice };
}

const NAMED = new Set([
    'Escape', 'Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Backslash', 'Comma', 'Period', 'Semicolon',
    'Quote', 'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Backquote',
]);

function isValidCode(code: string): boolean {
    return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^Numpad[0-9]$/.test(code) || /^F([1-9]|1[0-9]|2[0-4])$/.test(code) || NAMED.has(code);
}

export const isValidChord = (chord: string) => parseChord(chord) !== null;

// ---- 顯示 ----

const MOD_CAP: Record<Platform, Record<Modifier, string>> = {
    mac: { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' },
    win: { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' },
};

const KEY_CAP: Record<string, string> = {
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    Space: 'Space',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Slash: '/',
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
};

function keyCap(code: string, platform: Platform): string {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
    if (platform === 'mac' && code === 'Enter') return '↩';
    if (platform === 'mac' && code === 'Backspace') return '⌫';
    return KEY_CAP[code] ?? code;
}

// 'Mod+Shift+KeyZ' → ['⌘', '⇧', 'Z']（macOS）／['Ctrl', 'Shift', 'Z']（Windows）
// 'Escape*2' → ['Esc', 'Esc']：連按兩次畫成兩顆鍵帽，比「×2」直覺
export function keyCaps(chord: string, platform: Platform): string[] {
    const p = parseChord(chord);
    if (!p) return [chord];
    const caps = [...p.mods.map((m) => MOD_CAP[platform][m]), keyCap(p.code, platform)];
    return p.twice ? [...caps, ...caps] : caps;
}

export function chordText(chord: string, platform: Platform): string {
    const p = parseChord(chord);
    if (!p) return chord;
    const caps = [...p.mods.map((m) => MOD_CAP[platform][m]), keyCap(p.code, platform)];
    const one = caps.join(platform === 'mac' ? '' : '+');
    return p.twice ? `${one} ${one}` : one;
}

// ---- 錄製／比對 ----

const MODIFIER_CODE = /^(Meta|Control|Alt|Shift|OS|CapsLock|Fn|NumLock|ScrollLock|ContextMenu)/;

// 部分遠端桌面與自動化環境 code 是空字串，退回用 key 推回實體鍵
function codeFromKey(key: string): string {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    const sym: Record<string, string> = { '/': 'Slash', '?': 'Slash', ',': 'Comma', '.': 'Period', ' ': 'Space', Esc: 'Escape' };
    return sym[key] ?? key;
}

export type KeyEventLike = Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

// 事件 → chord。只按修飾鍵、或無法辨識的鍵回 null。
// Caps Lock 不影響結果（看 code 與 shiftKey，不看 e.key 大小寫），
// 所以 Caps Lock 開著按 B 仍是 `KeyB`；Shift+B 是 `Shift+KeyB`。
export function chordFromEvent(e: KeyEventLike, platform: Platform): string | null {
    const code = e.code || codeFromKey(e.key ?? '');
    if (!code || MODIFIER_CODE.test(code) || !isValidCode(code)) return null;
    const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
    // macOS 的 ⌃ 是獨立修飾鍵；Windows 的 ⊞ Win 鍵屬於系統，不參與
    const ctrl = platform === 'mac' && e.ctrlKey;
    if (platform !== 'mac' && e.metaKey) return null;
    return [ctrl && 'Ctrl', mod && 'Mod', e.altKey && 'Alt', e.shiftKey && 'Shift', code].filter(Boolean).join('+');
}

export const baseChord = (chord: string) => chord.replace(/\*2$/, '');

export function strongModifierCount(chord: string): number {
    return parseChord(chord)?.mods.filter((m) => m !== 'Shift').length ?? 0;
}
