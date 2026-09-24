// src/lib/code-highlight.ts — synchronous syntax highlighting for Markdown code
// blocks (AI Agent replies). lowlight on the highlight.js core with only the
// languages the app's users actually paste; no auto-detection, no wasm.
//
// Output is plain React elements (`<span className="hljs-…">`) built from the
// lowlight syntax tree: text goes through React's escaping, never innerHTML.
// Colours are the caller's job (theme tokens on the hljs-* classes).

import { createElement, type ReactNode } from 'react';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

/** Blocks longer than this render as plain text (highlighting is O(n)). */
export const HIGHLIGHT_MAX_LINES = 2000;

const lowlight = createLowlight({
    bash,
    diff,
    go,
    ini,
    javascript,
    json,
    python,
    rust,
    shell,
    sql,
    typescript,
    yaml,
});

const ALIASES: Record<string, string> = {
    py: 'python',
    python3: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    sh: 'bash',
    zsh: 'bash',
    console: 'shell',
    jsonc: 'json',
    yml: 'yaml',
    toml: 'ini',
    rs: 'rust',
    golang: 'go',
    patch: 'diff',
};

/** The registered grammar for a fence language, or null (→ plain text). */
export function resolveHighlightLanguage(lang?: string | null): string | null {
    const key = (lang ?? '').trim().toLowerCase();
    if (!key) return null;
    const name = ALIASES[key] ?? key;
    return lowlight.registered(name) ? name : null;
}

interface HastText {
    type: 'text';
    value: string;
}
interface HastElement {
    type: 'element';
    tagName: string;
    properties?: { className?: unknown };
    children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string };

function toReact(node: HastNode, key: number): ReactNode {
    if (node.type === 'text') return (node as HastText).value;
    if (node.type !== 'element') return null;
    const el = node as HastElement;
    const cls = el.properties?.className;
    const className = Array.isArray(cls)
        ? cls.filter((c): c is string => typeof c === 'string').join(' ')
        : undefined;
    // lowlight only emits <span>; anything else is rendered as a span too
    return createElement(
        'span',
        { key, className },
        el.children.map((child, i) => toReact(child, i)),
    );
}

/**
 * Highlighted children for a `<code>` element, or null when the block should
 * stay plain: unknown/absent language, or longer than HIGHLIGHT_MAX_LINES.
 */
export function highlightCode(code: string, lang?: string | null): ReactNode[] | null {
    const name = resolveHighlightLanguage(lang);
    if (!name) return null;
    let lines = 1;
    for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10 && ++lines > HIGHLIGHT_MAX_LINES) return null;
    }
    try {
        const tree = lowlight.highlight(name, code);
        return (tree.children as HastNode[]).map((child, i) => toReact(child, i));
    } catch {
        return null;
    }
}
