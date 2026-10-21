import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('dev and QA launch commands explicitly use the isolated native config', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['desktop:dev']).toBe('tauri dev --config src-tauri/tauri.dev.conf.json');
    expect(pkg.scripts['desktop:qa']).toBe('tauri build --debug --config src-tauri/tauri.dev.conf.json');
    const launcher = readFileSync('scripts/build_and_run.sh', 'utf8');
    expect(launcher).not.toContain('pnpm tauri dev');
    expect(launcher.match(/pnpm desktop:dev/g)).toHaveLength(4);
});
