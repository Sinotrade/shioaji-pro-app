import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginRoot = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, pluginRoot), "utf8"));
}

test("Codex and Claude expose the same provider-neutral skill package", async () => {
  const codex = await readJson(".codex-plugin/plugin.json");
  const claude = await readJson(".claude-plugin/plugin.json");

  assert.equal(codex.name, "shioaji-pro");
  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version);
  assert.equal(claude.description, codex.description);
  assert.equal(codex.skills, "./skills/");
  assert.equal(claude.skills, codex.skills);

  for (const manifest of [codex, claude]) {
    for (const executableField of ["scripts", "hooks", "mcpServers"]) {
      assert.equal(executableField in manifest, false);
    }
  }
});

test("the shared skill and required safety references are bundled", async () => {
  const files = [
    "skills/shioaji-pro/SKILL.md",
    "skills/shioaji-pro/references/MCP_TOOLS.md",
    "skills/shioaji-pro/references/CONTENT_AND_BACKTEST.md",
    "skills/shioaji-pro/references/SAFETY.md",
    "skills/shioaji-pro/references/PRIVACY.md"
  ];

  for (const file of files) {
    const contents = await readFile(new URL(file, pluginRoot), "utf8");
    assert.ok(contents.trim().length > 0, `${file} must not be empty`);
  }
});

test("the skill routes native content and bounded backtest reads", async () => {
  const skill = await readFile(
    new URL("skills/shioaji-pro/SKILL.md", pluginRoot),
    "utf8"
  );
  const reference = await readFile(
    new URL(
      "skills/shioaji-pro/references/CONTENT_AND_BACKTEST.md",
      pluginRoot
    ),
    "utf8"
  );

  assert.match(skill, /CONTENT_AND_BACKTEST\.md/);
  for (const tool of [
    "save_custom_indicator",
    "save_strategy",
    "get_backtest_result",
    "list_backtest_symbol_results",
    "get_backtest_trades"
  ]) {
    assert.match(reference, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(reference, /ephemeral/);
  assert.match(reference, /not a Portfolio Run/);
  assert.match(reference, /maximum is 100/);
  assert.match(reference, /latest 500 trades per symbol/);
});
