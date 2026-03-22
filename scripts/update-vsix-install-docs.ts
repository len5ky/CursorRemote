import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.cwd();

/** Files that document the VSIX install CLI one-liner */
const DOC_FILES = [
  resolve(ROOT, 'README.md'),
  resolve(ROOT, 'docs/setup-guide.md'),
] as const;

/**
 * Matches `cursor` or `code` plus semver or the README placeholder X.Y.Z.
 * (Multiline: ^ applies to each line via /m.)
 */
const INSTALL_LINE_RE =
  /^(cursor|code) --install-extension cursor-remote-(?:\d+\.\d+\.\d+|X\.Y\.Z)\.vsix$/gm;

/**
 * Set the documented VSIX filename and CLI to match package.json after a version bump.
 * Uses `cursor --install-extension` (Cursor CLI); VS Code users can substitute `code`.
 */
export function updateVsixInstallDocs(version: string): void {
  const replacement = `cursor --install-extension cursor-remote-${version}.vsix`;

  for (const filePath of DOC_FILES) {
    const before = readFileSync(filePath, 'utf-8');
    const after = before.replace(INSTALL_LINE_RE, replacement);
    if (after !== before) {
      writeFileSync(filePath, after, 'utf-8');
      const rel = filePath.startsWith(ROOT + '/') ? filePath.slice(ROOT.length + 1) : filePath;
      console.log(`✓ Updated ${rel}`);
    }
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };
  updateVsixInstallDocs(pkg.version);
}
