import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const DEV_ROOT = resolve(process.cwd());
const PKG_PATH = resolve(DEV_ROOT, 'package.json');

const REQUIRED_FILES = [
  'extension/dist/extension.cjs',
  'extension/dist/server/bundle.mjs',
  'extension/dist/client/index.html',
  'extension/dist/client/app.js',
  'extension/dist/client/styles.css',
  'extension/dist/client/vendor-socket.io.min.js',
  'extension/package.json',
  'extension/selectors.json',
  'extension/media/icon.png',
];

const FORBIDDEN_PATTERNS = [
  'node_modules/',
  '.env',
  'openvsx_token',
  'azure_token',
  'src/',
  'scripts/',
  '.cursor/',
];

function main(): void {
  const vsixArg = process.argv[2];
  let vsixPath: string;

  if (vsixArg) {
    vsixPath = resolve(DEV_ROOT, vsixArg);
  } else {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    vsixPath = resolve(DEV_ROOT, 'releases', `cursor-remote-${pkg.version}.vsix`);
  }

  console.log(`Verifying ${vsixPath}\n`);

  let listing: string;
  try {
    listing = execSync(`python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    for n in z.namelist():
        print(n)
" ${JSON.stringify(vsixPath)}`, { encoding: 'utf-8' });
  } catch {
    console.error(`✗ Could not read ${vsixPath}. Was it built?`);
    process.exit(1);
  }

  const files = listing.trim().split('\n');
  let errors = 0;

  console.log('— Required files —');
  for (const required of REQUIRED_FILES) {
    const found = files.some(f => f === required || f.endsWith('/' + required));
    if (found) {
      console.log(`  ✓ ${required}`);
    } else {
      console.error(`  ✗ MISSING: ${required}`);
      errors++;
    }
  }

  console.log('\n— Forbidden patterns —');
  for (const pattern of FORBIDDEN_PATTERNS) {
    const matches = files.filter(f => {
      const inner = f.replace(/^extension\//, '');
      if (pattern.endsWith('/')) {
        return inner.startsWith(pattern);
      }
      const segments = inner.split('/');
      return segments.some(seg => seg === pattern);
    });
    if (matches.length === 0) {
      console.log(`  ✓ No ${pattern}`);
    } else {
      console.error(`  ✗ FOUND ${matches.length} files matching "${pattern}":`);
      for (const m of matches.slice(0, 5)) console.error(`      ${m}`);
      if (matches.length > 5) console.error(`      … and ${matches.length - 5} more`);
      errors++;
    }
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  const innerPkgFile = files.find(f => f === 'extension/package.json');
  if (innerPkgFile) {
    const innerPkg = execSync(`python3 -c "
import zipfile, sys, json
with zipfile.ZipFile(sys.argv[1]) as z:
    data = json.loads(z.read('extension/package.json'))
    print(data.get('version', ''))
" ${JSON.stringify(vsixPath)}`, { encoding: 'utf-8' }).trim();
    if (innerPkg === pkg.version) {
      console.log(`\n✓ Version match: ${pkg.version}`);
    } else {
      console.error(`\n✗ Version mismatch: VSIX has ${innerPkg}, repo has ${pkg.version}`);
      errors++;
    }
  }

  const totalFiles = files.filter(f => !f.endsWith('/')).length;
  console.log(`\nTotal files in VSIX: ${totalFiles}`);

  if (errors > 0) {
    console.error(`\n✗ ${errors} verification error(s). Fix before publishing.`);
    process.exit(1);
  }

  console.log('\n✓ VSIX verification passed.');
}

main();
