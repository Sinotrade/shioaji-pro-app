// scripts/chart-fills-demo/vite.config.ts — dev-only demo of chart fill markers,
// for design screenshots and stress checks without a sidecar:
//   pnpm exec vite --config scripts/chart-fills-demo/vite.config.ts --port 5298
// then open /, with optional ?stress=N&live=R&quote=Q&mirror=1.
// fixture data only; every request except the fixture accounts/kbars is refused; never part of a build

import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.resolve(__dirname, '../..');

export default defineConfig({
    root: __dirname,
    plugins: [react(), vanillaExtractPlugin()],
    resolve: { alias: { '@modules': path.resolve(root, 'src/modules-stub/index.ts') } },
    define: {
        'process.env': {},
        __STATSIG_CLIENT_KEY__: JSON.stringify(''),
        __SHIOAJI_APP_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_BUILD_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_SERVER_VERSION__: JSON.stringify('demo'),
    },
    server: { host: '127.0.0.1', fs: { allow: [root] } },
});
