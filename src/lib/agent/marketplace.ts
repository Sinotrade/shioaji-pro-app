// src/lib/agent/marketplace.ts — install agent skills from a Claude-plugin
// style marketplace repo (e.g. github.com/Sinotrade/Shioaji):
//   .claude-plugin/marketplace.json → plugins[] → <source>/skills/<name>/
//       SKILL.md + references/*.md
// We store SKILL.md plus a reference INDEX (names + raw URLs) — reference
// bodies are fetched on demand by the read_skill_reference tool, mirroring
// Claude Code's progressive disclosure instead of hardcoding domain docs.

import { isTauri } from '../runtime';

export interface SkillPackage {
    id: string; // `${repo}#${skillName}`
    name: string;
    description: string;
    repo: string; // 'Sinotrade/Shioaji'
    version: string;
    skillMd: string;
    references: { name: string; rawUrl: string }[];
    installedAt: number;
}

const KEY = 'sj-agent-skill-packages-v1';

let packages: SkillPackage[] = [];
try {
    const raw = localStorage.getItem(KEY);
    if (raw) packages = JSON.parse(raw) as SkillPackage[];
} catch {
    packages = [];
}

const listeners = new Set<() => void>();

function persist() {
    try {
        localStorage.setItem(KEY, JSON.stringify(packages));
    } catch {
        // quota — drop reference bodies are already external, just give up
    }
    listeners.forEach((l) => l());
}

export function subscribePackages(l: () => void): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function getPackages(): SkillPackage[] {
    return packages;
}

export function findPackage(name: string): SkillPackage | undefined {
    const n = name.trim().toLowerCase();
    return packages.find((p) => p.name.toLowerCase() === n);
}

export function removePackage(id: string) {
    packages = packages.filter((p) => p.id !== id);
    persist();
}

// ---- GitHub fetch (Tauri HTTP plugin on desktop dodges CORS) ----

async function ghFetch(url: string): Promise<Response> {
    const init: RequestInit = {
        headers: { Accept: 'application/vnd.github+json' },
    };
    if (isTauri) {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch(url, init);
    }
    return fetch(url, init);
}

async function ghJson<T>(path: string): Promise<T> {
    const res = await ghFetch(`https://api.github.com/${path}`);
    if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
    return res.json() as Promise<T>;
}

function b64utf8(b64: string): string {
    const bin = atob(b64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

interface GhFile {
    name: string;
    type: string;
    content?: string;
    download_url?: string;
}

// SKILL.md frontmatter: --- name: ... description: ... ---
function parseFrontmatter(md: string): {
    name?: string;
    description?: string;
    body: string;
} {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
    if (!m) return { body: md };
    const fm = m[1] ?? '';
    const get = (key: string) => {
        const r = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
        return r?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    };
    return {
        name: get('name'),
        description: get('description'),
        body: md.slice(m[0].length),
    };
}

export interface InstallResult {
    installed: string[]; // skill names
    repo: string;
}

// install every skill found in a marketplace repo
export async function installFromRepo(repo: string): Promise<InstallResult> {
    const clean = repo
        .trim()
        .replace(/^https?:\/\/github\.com\//, '')
        .replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) {
        throw new Error('請輸入 owner/repo 或 GitHub 網址');
    }
    // marketplace.json → plugin sources & versions
    const mpFile = await ghJson<GhFile>(
        `repos/${clean}/contents/.claude-plugin/marketplace.json`,
    );
    const mp = JSON.parse(b64utf8(mpFile.content ?? '')) as {
        plugins?: { name: string; source?: string; version?: string }[];
    };
    const installed: string[] = [];
    for (const plugin of mp.plugins ?? []) {
        const src = (plugin.source ?? '.').replace(/^\.\//, '').replace(/\/$/, '');
        const skillsPath = src ? `${src}/skills` : 'skills';
        let dirs: GhFile[] = [];
        try {
            dirs = await ghJson<GhFile[]>(
                `repos/${clean}/contents/${skillsPath}`,
            );
        } catch {
            continue; // plugin without skills
        }
        for (const dir of dirs.filter((d) => d.type === 'dir')) {
            const base = `${skillsPath}/${dir.name}`;
            const skillFile = await ghJson<GhFile>(
                `repos/${clean}/contents/${base}/SKILL.md`,
            ).catch(() => null);
            if (!skillFile?.content) continue;
            const md = b64utf8(skillFile.content);
            const fm = parseFrontmatter(md);
            const refs = await ghJson<GhFile[]>(
                `repos/${clean}/contents/${base}/references`,
            ).catch(() => [] as GhFile[]);
            const pkg: SkillPackage = {
                id: `${clean}#${dir.name}`,
                name: fm.name ?? dir.name,
                description: (fm.description ?? '').slice(0, 300),
                repo: clean,
                version: plugin.version ?? '',
                skillMd: fm.body.trim(),
                references: refs
                    .filter((r) => r.type === 'file' && r.download_url)
                    .map((r) => ({ name: r.name, rawUrl: r.download_url! })),
                installedAt: Date.now(),
            };
            packages = [
                ...packages.filter((p) => p.id !== pkg.id),
                pkg,
            ];
            installed.push(pkg.name);
        }
    }
    if (installed.length === 0) {
        throw new Error('找不到任何技能（需要 .claude-plugin/marketplace.json 與 skills/*/SKILL.md）');
    }
    persist();
    return { installed, repo: clean };
}

// reference bodies are fetched lazily and memory-cached for the session
const refCache = new Map<string, string>();

export async function readReference(
    skillName: string,
    fileName: string,
): Promise<string> {
    const pkg = findPackage(skillName);
    if (!pkg) throw new Error(`沒有安裝技能包「${skillName}」`);
    const ref = pkg.references.find(
        (r) => r.name.toLowerCase() === fileName.trim().toLowerCase(),
    );
    if (!ref) {
        throw new Error(
            `技能包「${skillName}」沒有 ${fileName}；可用：${pkg.references.map((r) => r.name).join(', ')}`,
        );
    }
    const hit = refCache.get(ref.rawUrl);
    if (hit) return hit;
    const res = await ghFetch(ref.rawUrl);
    if (!res.ok) throw new Error(`下載失敗 ${res.status}`);
    let text = await res.text();
    // keep tool results sane — the agent can ask for specifics it needs
    const MAX = 60_000;
    if (text.length > MAX) {
        text = `${text.slice(0, MAX)}\n\n…（文件過長已截斷，共 ${text.length} 字元）`;
    }
    refCache.set(ref.rawUrl, text);
    return text;
}

// pre-install the shioaji skill once（背景靜默，失敗下次再試）
const PREINSTALL_KEY = 'sj-agent-preinstall-done';

export function ensureShioajiPackage() {
    if (findPackage('shioaji')) return;
    try {
        if (localStorage.getItem(PREINSTALL_KEY)) return;
    } catch {
        return;
    }
    void installFromRepo('Sinotrade/Shioaji')
        .then(() => {
            try {
                localStorage.setItem(PREINSTALL_KEY, '1');
            } catch {
                // ignore
            }
        })
        .catch(() => {
            // offline — retry on next app start
        });
}
