import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = async (path) =>
  (await readFile(new URL(path, root), 'utf8')).replace(/\r\n?/g, '\n');

function parseSemanticSections(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const sections = new Map();
  for (const [, heading, body] of text.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
    sections.set(heading, body);
  }
  return sections;
}

test('Claude and Codex manifests agree and describe a safe skill', async () => {
  const claude = JSON.parse(await read('.claude-plugin/plugin.json'));
  const codex = JSON.parse(await read('.codex-plugin/plugin.json'));
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills']) {
    assert.deepEqual(codex[key], claude[key], `${key} differs between manifests`);
  }
  assert.equal(claude.name, 'shioaji-pro');
  assert.match(claude.version, /^\d+\.\d+\.\d+$/);
  assert.equal(claude.skills, './skills/');
  assert.match(claude.description, /safe.*capability-scoped/i);
  assert.match(codex.interface.shortDescription, /safe/i);
  assert.match(codex.interface.longDescription, /capability-scoped permissions/i);
  for (const manifest of [claude, codex]) {
    for (const field of ['commands', 'scripts', 'hooks', 'mcpServers']) {
      assert.ok(!Object.hasOwn(manifest, field), `${field} must not be bundled`);
    }
  }
});

test('every SKILL.md reference exists', async () => {
  const skill = await read('skills/shioaji-pro/SKILL.md');
  const references = [...skill.matchAll(/\]\(references\/([^#)]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of new Set(references)) {
    assert.ok((await read(`skills/shioaji-pro/references/${reference}`)).trim().length > 0, reference);
  }
  for (const required of ['MCP_TOOLS.md', 'CONTENT_AND_BACKTEST.md', 'CONTENT_AUTHORING.md', 'SAFETY.md', 'PRIVACY.md']) {
    assert.ok(references.includes(required), `${required} must be referenced`);
  }
});

test('semantic reference retains capability, names, and bounded backtest sections', async () => {
  const markdown = await read('skills/shioaji-pro/references/MCP_TOOLS.md');
  const sections = parseSemanticSections(markdown);
  for (const heading of ['Tool Families', 'Capability Rules', 'Composition', 'v1 semantic names']) {
    assert.ok(sections.has(heading), `missing ${heading}`);
  }
  const names = sections.get('v1 semantic names');
  for (const label of ['Market', 'Account', 'App state', 'Workspace mutation', 'Watchlists', 'Native content', 'Chart indicators', 'Backtest reads', 'Reusable skills', 'Background tasks', 'Trading']) {
    assert.match(names, new RegExp(`^- ${label}:`, 'm'), `missing ${label}`);
  }
  assert.match(names, /`trade\.preview`:[\s\S]*`trade\.execute`:/);
  assert.match(names, /bounded, paged/);
  assert.deepEqual(parseSemanticSections(markdown.replace(/\n/g, '\r\n')), sections);
});
