import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** HttpOnly cookie name; must match client expectations only for non-HttpOnly flows (we use server-side parse). */
export const WEBAPP_SESSION_COOKIE = 'cursor_remote_session';

const MAX_SESSIONS = 128;
const TOKEN_HEX_LEN = 64; // randomBytes(32).toString('hex')

export interface WebappSessionStore {
  has(token: string): boolean;
  add(token: string): void;
}

export function createWebappSessionStore(dataDir: string): WebappSessionStore {
  const filePath = join(dataDir, 'webapp-sessions.json');
  const tokens = new Set<string>();

  function load(): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { tokens?: unknown };
      if (!Array.isArray(data.tokens)) return;
      for (const t of data.tokens) {
        if (typeof t === 'string' && isTokenShape(t)) tokens.add(t);
      }
    } catch {
      // ignore corrupt or missing file
    }
  }

  function save(): void {
    try {
      mkdirSync(dataDir, { recursive: true });
      const arr = [...tokens];
      writeFileSync(filePath, JSON.stringify({ tokens: arr }) + '\n', 'utf-8');
    } catch (e) {
      console.error('[relay] Failed to persist web app sessions:', e);
    }
  }

  load();

  return {
    has(token: string): boolean {
      return isTokenShape(token) && tokens.has(token);
    },
    add(token: string): void {
      if (!isTokenShape(token)) return;
      if (tokens.has(token)) return;
      tokens.add(token);
      while (tokens.size > MAX_SESSIONS) {
        const first = tokens.values().next().value as string | undefined;
        if (first !== undefined) tokens.delete(first);
      }
      save();
    },
  };
}

function isTokenShape(s: string): boolean {
  return s.length === TOKEN_HEX_LEN && /^[a-f0-9]+$/i.test(s);
}

export function parseSessionCookie(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}
