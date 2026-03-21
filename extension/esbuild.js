import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

async function main() {
  const extCtx = await esbuild.context({
    ...shared,
    entryPoints: ['extension/src/extension.ts'],
    outfile: 'dist/extension.cjs',
    external: ['vscode'],
  });

  const serverCtx = await esbuild.context({
    ...shared,
    format: 'esm',
    entryPoints: ['src/server/index.ts'],
    outfile: 'dist/server/bundle.mjs',
    banner: { js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __fu } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join('\n') },
  });

  if (watch) {
    await Promise.all([extCtx.watch(), serverCtx.watch()]);
    console.log('[esbuild] Watching for changes...');
  } else {
    await Promise.all([extCtx.rebuild(), serverCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), serverCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
