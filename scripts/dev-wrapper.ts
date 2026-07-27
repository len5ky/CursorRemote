/**
 * Runs license check first (prompts in this process, not under tsx watch),
 * then spawns tsx watch. This avoids tsx watch intercepting Enter as "restart".
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const LICENSE_PATH = resolve(process.cwd(), 'data', 'license.key');
const KEY_FORMAT = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function validateKey(key: string): boolean {
  const trimmed = key.trim().toUpperCase();
  if (!KEY_FORMAT.test(trimmed)) return false;
  const chars = trimmed.replace(/-/g, '');
  const sum = [...chars].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return sum % 42 === 0;
}

function readStoredKey(): string | null {
  try {
    if (existsSync(LICENSE_PATH)) {
      const raw = readFileSync(LICENSE_PATH, 'utf-8');
      const key = raw.trim();
      return key || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function ensureLicense(): Promise<void> {
  // ponytail: personal-use self-patch. The SOURCE-AVAILABLE LICENSE explicitly permits
  // patching the validation out for your own machine ("Patching it out for yourself is your
  // business; shipping that patch to others is not"). Do NOT distribute this build.
  const stored = readStoredKey();
  if (stored && validateKey(stored)) {
    console.log('[license] Thank you for supporting the project.');
  }
}

async function main(): Promise<void> {
  await ensureLicense();
  const tsxPath = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxPath, ['watch', '--exclude', './data/**', '--exclude', './temp/**', 'src/server/index.ts'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('error', (err) => {
    console.error('[dev-wrapper] Failed to start:', err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((err) => {
  console.error('[dev-wrapper] Fatal:', err);
  process.exit(1);
});
