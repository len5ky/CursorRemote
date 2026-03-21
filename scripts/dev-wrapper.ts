/**
 * Runs license check first (prompts in this process, not under tsx watch),
 * then spawns tsx watch. This avoids tsx watch intercepting Enter as "restart".
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline';

const LICENSE_PATH = resolve(process.cwd(), 'data', 'license.key');
const STORE_URL = 'https://cursor-remote.com/buy?utm_source=server&utm_medium=dev_cli&utm_campaign=license';
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

function saveKey(key: string): boolean {
  const dir = dirname(LICENSE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const toWrite = key.trim().toUpperCase();
  writeFileSync(LICENSE_PATH, toWrite, 'utf-8');
  const verify = readFileSync(LICENSE_PATH, 'utf-8').trim();
  return verify === toWrite;
}

function promptKey(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('License key: ', (answer) => {
      rl.close();
      resolve((answer ?? '').trim());
    });
  });
}

async function ensureLicense(): Promise<void> {
  const stored = readStoredKey();
  if (stored && validateKey(stored)) {
    console.log('[license] Thank you for supporting the project.');
    return;
  }
  if (stored && !validateKey(stored)) {
    console.log('[license] Stored key is invalid. Please enter a new one.');
  }
  console.log();
  console.log('  No valid license key found. Grab a key here:');
  console.log(`  ${STORE_URL}`);
  console.log();
  while (true) {
    const input = await promptKey();
    if (!input) {
      console.log('[license] (Press Ctrl+C to exit)');
      continue;
    }
    if (validateKey(input)) {
      if (!saveKey(input)) {
        console.warn('[license] Warning: key may not have saved correctly. If it disappears, re-enter it.');
      }
      console.log('[license] Thank you for supporting the project.');
      return;
    }
    console.log('[license] Invalid format. Expected XXXX-XXXX-XXXX-XXXX-XXXX');
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
