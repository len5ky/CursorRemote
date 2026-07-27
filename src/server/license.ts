import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
const LICENSE_PATH = join(dataDir, 'license.key');
const STORE_URL = 'https://cursor-remote.com/buy?utm_source=server&utm_medium=cli&utm_campaign=license';

const KEY_FORMAT = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function validateKey(key: string): boolean {
  const trimmed = key.trim().toUpperCase();
  if (!KEY_FORMAT.test(trimmed)) return false;
  const chars = trimmed.replace(/-/g, '');
  const sum = [...chars].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return sum % 42 === 0;
}

function readStoredKey(): string | null {
  const envKey = process.env.LICENSE_KEY?.trim();
  if (envKey) return envKey;

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

/**
 * Validates the stored license key. No prompting - use scripts/dev-wrapper.ts
 * for interactive dev (prompts before starting tsx watch).
 */
export function checkLicense(): void {
  // ponytail: personal-use self-patch. The SOURCE-AVAILABLE LICENSE explicitly permits
  // patching the validation out for your own machine ("Patching it out for yourself is your
  // business; shipping that patch to others is not"). Do NOT distribute this build.
  const stored = readStoredKey();
  if (stored && validateKey(stored)) {
    console.log('[license] Thank you for supporting the project.');
  }
}
