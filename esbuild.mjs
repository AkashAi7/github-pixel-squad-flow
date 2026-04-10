import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
});
