import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const DEV_ROOT = resolve(process.cwd());
const PUBLIC_ROOT = resolve(process.env.HOME ?? '~', 'Dev', 'CursorRemote');
const PKG_PATH = resolve(DEV_ROOT, 'package.json');
const CHANGELOG_PATH = resolve(DEV_ROOT, 'CHANGELOG.md');

const EXCLUDE = [
  'temp/',
  'temp2',
  '.cursor/',
  'marketing/',
  '.git/',
  'node_modules/',
  'dist/',
  'data/',
  'releases/',
  '.env',
  'scripts/generate-keys.ts',
  'azure_token',
  'openvsx_token',
  '*.vsix',
];

function getVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return pkg.version as string;
}

function getChangelogSection(version: string): string {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf-8');
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);
  if (start === -1) return '';

  const afterHeader = changelog.indexOf('\n', start);
  const nextSection = changelog.indexOf('\n## [', afterHeader + 1);
  const body = nextSection === -1
    ? changelog.slice(afterHeader + 1)
    : changelog.slice(afterHeader + 1, nextSection);

  return body.trim();
}

function devTreeClean(): boolean {
  const status = execSync('git status --porcelain', { cwd: DEV_ROOT, encoding: 'utf-8' });
  return status.trim().length === 0;
}

function rsyncToPublic(): void {
  const excludeFlags = EXCLUDE.map(e => `--exclude='${e}'`).join(' ');
  const cmd = `rsync -av --delete ${excludeFlags} '${DEV_ROOT}/' '${PUBLIC_ROOT}/'`;
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit' });
}

function publicDiffSummary(): string {
  return execSync('git diff --stat && echo "---" && git diff --cached --stat && echo "---" && git status --short', {
    cwd: PUBLIC_ROOT,
    encoding: 'utf-8',
  });
}

function publicHasChanges(): boolean {
  execSync('git add -A', { cwd: PUBLIC_ROOT, stdio: 'inherit' });
  const status = execSync('git status --porcelain', { cwd: PUBLIC_ROOT, encoding: 'utf-8' });
  return status.trim().length > 0;
}

function ensureTag(version: string, cwd: string, label: string): void {
  try {
    execSync(`git tag v${version}`, { cwd, stdio: 'inherit' });
    console.log(`✓ Tagged v${version} in ${label}`);
  } catch {
    console.log(`⚠ Tag v${version} already exists in ${label}, skipping`);
  }
}

function commitAndTag(version: string, body: string): void {
  const message = body ? `v${version}\n\n${body}` : `v${version}`;
  const msgFile = resolve(PUBLIC_ROOT, '.git', 'COMMIT_MSG_TMP');
  writeFileSync(msgFile, message, 'utf-8');
  try {
    execSync(`git commit -F ${JSON.stringify(msgFile)}`, { cwd: PUBLIC_ROOT, stdio: 'inherit' });
  } finally {
    try { unlinkSync(msgFile); } catch {}
  }

  ensureTag(version, PUBLIC_ROOT, 'public');
  ensureTag(version, DEV_ROOT, 'dev');
}

const OVSX_TOKEN_PATH = resolve(DEV_ROOT, 'openvsx_token');
const RELEASES_DIR = resolve(DEV_ROOT, 'releases');

function vsixPath(version: string): string {
  return resolve(RELEASES_DIR, `cursor-remote-${version}.vsix`);
}

function packageVsix(version: string): string {
  const out = vsixPath(version);
  console.log('\n— Packaging .vsix —');
  execSync(`npx @vscode/vsce package --no-dependencies --out ${JSON.stringify(out)}`, {
    cwd: DEV_ROOT,
    stdio: 'inherit',
  });
  return out;
}

function publishToOpenVsx(vsix: string): void {
  if (!existsSync(OVSX_TOKEN_PATH)) {
    console.error('✗ openvsx_token file not found. Create it with your Open VSX access token.');
    process.exit(1);
  }

  const token = readFileSync(OVSX_TOKEN_PATH, 'utf-8').trim();
  if (!token) {
    console.error('✗ openvsx_token file is empty.');
    process.exit(1);
  }

  console.log('\n— Publishing to Open VSX —');
  execSync(`npx ovsx publish ${JSON.stringify(vsix)} -p ${token}`, {
    cwd: DEV_ROOT,
    stdio: 'inherit',
  });

  console.log('✓ Published to Open VSX');
}

function createGitHubRelease(version: string, body: string, vsix: string): void {
  console.log('\n— Creating GitHub Release —');
  const notesFile = resolve(PUBLIC_ROOT, '.git', 'RELEASE_NOTES_TMP');
  writeFileSync(notesFile, body, 'utf-8');
  try {
    execSync(
      `gh release create v${version} ${JSON.stringify(vsix)} --title "v${version}" --notes-file ${JSON.stringify(notesFile)} --latest`,
      { cwd: PUBLIC_ROOT, stdio: 'inherit' },
    );
  } finally {
    try { unlinkSync(notesFile); } catch {}
  }
  console.log(`✓ Created GitHub Release v${version} with .vsix asset`);
}

function main(): void {
  const args = process.argv.slice(2);
  const doCommit = args.includes('--commit');
  const doPush = args.includes('--push');
  const doOvsx = args.includes('--ovsx');

  const version = getVersion();
  const changelogBody = getChangelogSection(version);

  console.log(`Publishing v${version} → ${PUBLIC_ROOT}`);

  if (!devTreeClean()) {
    console.warn('⚠ Dev repo has uncommitted changes. Proceeding anyway (syncing working tree).\n');
  }

  rsyncToPublic();

  if (!publicHasChanges()) {
    console.log('\nNo changes to publish. Public repo is up to date.');
  } else {
    console.log('\n— Public repo changes —');
    console.log(publicDiffSummary());

    if (!doCommit) {
      console.log('Files synced. Review the public repo, then run again with --commit:');
      console.log(`  npm run publish:public -- --commit`);
      console.log(`\nOr commit manually:`);
      console.log(`  cd ${PUBLIC_ROOT} && git add -A && git commit && git push`);
      if (!doOvsx) return;
    } else {
      if (!changelogBody) {
        console.error(`✗ No changelog entry found for v${version}.`);
        console.error(`  Write a concise entry under [Unreleased] in CHANGELOG.md, then run:`);
        console.error(`  npm run release -- patch|minor|major`);
        console.error(`  npm run publish:public -- --commit`);
        process.exit(1);
      }

      commitAndTag(version, changelogBody);

      if (doPush) {
        execSync('git push && git push --tags', { cwd: PUBLIC_ROOT, stdio: 'inherit' });
        console.log('✓ Pushed public repo to origin');
        execSync('git push && git push --tags', { cwd: DEV_ROOT, stdio: 'inherit' });
        console.log('✓ Pushed dev repo to origin');
      } else {
        console.log(`\n✓ Committed v${version} to public repo`);
        console.log(`\nNext steps:`);
        console.log(`  cd ${PUBLIC_ROOT} && git push && git push --tags`);
        console.log(`  cd ${DEV_ROOT} && git push --tags`);
      }
    }
  }

  if (doOvsx) {
    const vsix = existsSync(vsixPath(version))
      ? vsixPath(version)
      : packageVsix(version);

    publishToOpenVsx(vsix);

    if (changelogBody && doPush) {
      createGitHubRelease(version, changelogBody, vsix);
    }
  }
}

main();
