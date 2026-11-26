import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('dev and QA launch commands explicitly use the isolated native config', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['desktop:dev']).toBe('tauri dev --config src-tauri/tauri.dev.conf.json');
    // QA bundle 與正式版同為 release profile（panic=abort、lto），不可帶 --debug（#453）
    expect(pkg.scripts['desktop:qa']).toBe('tauri build --config src-tauri/tauri.dev.conf.json --config scripts/tauri.qa.conf.json');
    expect(pkg.scripts['desktop:qa']).not.toContain('--debug');
    const launcher = readFileSync('scripts/build_and_run.sh', 'utf8');
    expect(launcher).not.toContain('pnpm tauri dev');
    expect(launcher.match(/pnpm desktop:dev/g)).toHaveLength(4);
});

it('QA bundle builds the frontend in qa mode and skips updater artifacts', () => {
    const qa = JSON.parse(readFileSync('scripts/tauri.qa.conf.json', 'utf8'));
    expect(qa.build.beforeBuildCommand).toBe('pnpm build --mode qa');
    expect(qa.bundle.createUpdaterArtifacts).toBe(false);
});
