import { readFileSync } from 'fs';
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

function commitAndTag(version: string, body: string): void {
  const message = body ? `v${version}\n\n${body}` : `v${version}`;
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: PUBLIC_ROOT, stdio: 'inherit' });

  try {
    execSync(`git tag v${version}`, { cwd: PUBLIC_ROOT, stdio: 'inherit' });
    console.log(`✓ Tagged v${version}`);
  } catch {
    console.log(`⚠ Tag v${version} already exists, skipping`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const doCommit = args.includes('--commit');
  const doPush = args.includes('--push');

  const version = getVersion();
  const changelogBody = getChangelogSection(version);

  console.log(`Publishing v${version} → ${PUBLIC_ROOT}`);

  if (!devTreeClean()) {
    console.warn('⚠ Dev repo has uncommitted changes. Proceeding anyway (syncing working tree).\n');
  }

  rsyncToPublic();

  if (!publicHasChanges()) {
    console.log('\nNo changes to publish. Public repo is up to date.');
    return;
  }

  console.log('\n— Public repo changes —');
  console.log(publicDiffSummary());

  if (!doCommit) {
    console.log('Files synced. Review the public repo, then run again with --commit:');
    console.log(`  npm run publish:public -- --commit`);
    console.log(`\nOr commit manually:`);
    console.log(`  cd ${PUBLIC_ROOT} && git add -A && git commit && git push`);
    return;
  }

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
    console.log('✓ Pushed to origin');
  } else {
    console.log(`\n✓ Committed v${version} to public repo`);
    console.log(`\nNext step:`);
    console.log(`  cd ${PUBLIC_ROOT} && git push && git push --tags`);
  }
}

main();
