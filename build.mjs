import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  outdir: 'dist',
};

const ctx = await esbuild.context({
  ...shared,
  entryPoints: {
    background: 'src/background.ts',
    'options/options': 'src/options/options.ts',
  },
});

// Copy static assets (manifest, icons, options html/css)
await cp('static', 'dist', { recursive: true });
await cp('src/options/options.html', 'dist/options/options.html');
await cp('src/options/options.css', 'dist/options/options.css');

if (watch) {
  await ctx.watch();
  console.log('watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('built to dist/');
}
