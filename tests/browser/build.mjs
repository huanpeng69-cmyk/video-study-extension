// 仅构建测试夹具，产物不进入扩展包。
import { build } from 'vite';
import { resolve } from 'node:path';
await build({ configFile: false, base: './', esbuild: { jsx: 'automatic' },
  build: { target: 'es2022', outDir: 'Temp/browser-auto', emptyOutDir: true,
    rollupOptions: { input: resolve('tests/browser/auto-summary.html') } } });
