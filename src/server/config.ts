import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ServerConfig, SelectorConfig } from './types.js';
import { VOICE_REALTIME_MODEL } from './transports/voice/constants.js';
import { normalizeVoiceOrigin } from './transports/voice/origin-policy.js';
import {
  assertVoiceHermesRoute,
  HERMES_CAPABILITIES_PATH,
  HERMES_TOOLSETS_PATH,
  VOICE_HERMES_POLICY_TIMEOUT_MS,
} from './transports/voice/hermes-chat.js';
import {
  KNOWN_VOICE_PRICE_VERSION,
  isKnownVoicePriceVersion,
  knownVoicePriceVersions,
  voicePriceEntry,
} from './transports/voice/pricing.js';

export interface IntegerEnvSpec {
  min: number;
  max: number;
  fallback: number;
}

/**
 * Read a numeric setting, or refuse to start.
 *
 * `parseInt(process.env.X ?? '500', 10)` returns `NaN` for `abc`, `12` for
 * `12abc`, and quietly truncates `4.5` to `4`. Every one of those became a cap
 * or an interval: a `NaN` daily cap compares false against everything, so the
 * budget brake it was supposed to apply simply never engaged. A misconfigured
 * bound is a startup failure, never a silently disabled one.
 */
export function readIntegerEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  name: string,
  spec: IntegerEnvSpec,
): number {
  const raw = env[name];
  if (raw === undefined) return spec.fallback;
  // A canonical decimal integer and nothing else: no hex, no exponent, no
  // trailing units, no leading whitespace that hides a copy-paste error.
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number between ${spec.min} and ${spec.max} (got "${raw}")`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`${name} must be a whole number between ${spec.min} and ${spec.max} (got "${raw}")`);
  }
  return value;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * The stable budget account identity.
 *
 * It is deliberately *not* a secret and deliberately *not* derived from a
 * session: it only has to be the same string tomorrow as it is today, so the
 * daily cost cap survives a logout, a restart and a cookie change. It is hashed
 * before it reaches the ledger or the provider's `safety_identifier`.
 */
export function normalizeVoiceAccountId(raw: string | undefined): string {
  if (raw === undefined) return 'default-operator';
  if (!ACCOUNT_ID_PATTERN.test(raw)) {
    throw new Error(
      `VOICE_ACCOUNT_ID must be 1-64 characters from [A-Za-z0-9._@-] (got "${raw.slice(0, 32)}")`
    );
  }
  return raw;
}

/**
 * A paid session may only be admitted against pricing this code knows.
 *
 * The runtime gate used to be "the operator typed something", so any invented
 * version admitted, billed and settled a real call against a rate card nobody
 * had checked. See `transports/voice/pricing.ts`.
 */
export function assertKnownVoicePriceVersion(version: string): void {
  if (isKnownVoicePriceVersion(version)) return;
  throw new Error(
    `VOICE_USAGE_PRICE_VERSION must name a known price version (got "${version}"). `
    + `Known versions: ${knownVoicePriceVersions().join(', ')}.`
  );
}

/**
 * A known price version carries a frozen reference rate. An operator may set a
 * higher local estimate as a safety margin, but may not lower the cost floor
 * that the reviewed version represents.
 */
export function assertVoicePriceFloor(version: string, unitPriceCentsPerMinute: number): void {
  const entry = voicePriceEntry(version);
  if (!entry) return;
  if (unitPriceCentsPerMinute < entry.referenceUnitPriceCentsPerMinute) {
    throw new Error(
      `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE must be at least `
      + `${entry.referenceUnitPriceCentsPerMinute} for ${version} `
      + `(got ${unitPriceCentsPerMinute}).`
    );
  }
}

/**
 * The private voice surface has no configurable model: every Realtime call is
 * pinned to VOICE_REALTIME_MODEL. VOICE_MODEL survives only as a deployment
 * tripwire — an operator who sets it to anything else gets a startup failure
 * rather than a silently ignored value or a fallback model.
 */
export function assertPinnedVoiceModel(env: NodeJS.ProcessEnv = process.env): void {
  const configured = env.VOICE_MODEL;
  if (configured !== undefined && configured !== VOICE_REALTIME_MODEL) {
    throw new Error(
      `VOICE_MODEL must be exactly ${VOICE_REALTIME_MODEL} (got "${configured}"). ` +
      'The private voice surface has no fallback or mini model.'
    );
  }
}

/**
 * The private voice surface mints paid provider sessions and reads Hermes
 * context, so it has no meaningful unauthenticated mode. Tailscale is defence
 * in depth, not the authentication layer: an operator who enables voice without
 * WEBAPP_PASSWORD gets a startup failure rather than an open voice endpoint.
 */
export function assertVoicePrivateAuth(
  config: Pick<ServerConfig, 'webappPassword' | 'voice'>
): void {
  if (!config.voice?.enabled) return;
  if (config.webappPassword.trim().length === 0) {
    throw new Error(
      'VOICE_ENABLED requires WEBAPP_PASSWORD to be set to a non-empty value. ' +
      'The private voice surface refuses to run unauthenticated.'
    );
  }
}

export function loadConfig(): ServerConfig {
  const preRegisteredRaw = process.env.TELEGRAM_ALLOWED_USERS ?? '';
  const preRegisteredUsers = preRegisteredRaw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');

  assertPinnedVoiceModel();

  // Validated at startup so a malformed canonical origin is a boot failure
  // rather than a silently widened (or silently empty) allow set.
  const rawPublicOrigin = (process.env.VOICE_PUBLIC_ORIGIN ?? '').trim();
  const voicePublicOrigin = rawPublicOrigin.length > 0 ? normalizeVoiceOrigin(rawPublicOrigin) : '';

  const priceVersion = process.env.VOICE_USAGE_PRICE_VERSION ?? KNOWN_VOICE_PRICE_VERSION;
  // The known table supplies the default local estimate, so the shipped default
  // and the documented rate card cannot drift apart.
  const referencePrice = voicePriceEntry(priceVersion)?.referenceUnitPriceCentsPerMinute ?? 50;

  const usageDailyCapCents = readIntegerEnv(process.env, 'VOICE_USAGE_DAILY_CAP_CENTS', { min: 1, max: 10_000_000, fallback: 500 });
  const usagePerSessionCapCents = readIntegerEnv(process.env, 'VOICE_USAGE_PER_SESSION_CAP_CENTS', { min: 1, max: 10_000_000, fallback: 100 });
  const usageUnitPriceCentsPerMinute = readIntegerEnv(process.env, 'VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE', { min: 1, max: 100_000, fallback: referencePrice });
  assertVoicePriceFloor(priceVersion, usageUnitPriceCentsPerMinute);

  const config: ServerConfig = {
    cdpUrl: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
    serverPort: readIntegerEnv(process.env, 'SERVER_PORT', { min: 1, max: 65_535, fallback: 3000 }),
    serverHost: process.env.SERVER_HOST ?? '127.0.0.1',
    pollIntervalMs: readIntegerEnv(process.env, 'POLL_INTERVAL_MS', { min: 10, max: 600_000, fallback: 300 }),
    debounceMs: readIntegerEnv(process.env, 'DEBOUNCE_MS', { min: 0, max: 600_000, fallback: 150 }),
    selectorsPath: process.env.SELECTORS_PATH ?? './selectors.json',
    logLevel: (process.env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    webappPassword: process.env.WEBAPP_PASSWORD ?? '',
    windowTitleQualifier: process.env.WINDOW_TITLE_QUALIFIER !== 'false',
    dataDir,
    trustTailscaleIdentity: process.env.TAILSCALE_SERVE_IDENTITY === 'true',
    telegram: {
      enabled: process.env.TELEGRAM_ENABLED === 'true',
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      preRegisteredUsers,
      impl: (process.env.TELEGRAM_IMPL === 'raw' ? 'raw' : 'grammy') as 'grammy' | 'raw',
    },
    voice: {
      enabled: process.env.VOICE_ENABLED === 'true',
      openaiApiKey: process.env.OPENAI_API_KEY ?? '',
      publicOrigin: voicePublicOrigin,
      hermes: {
        apiUrl: process.env.VOICE_HERMES_API_URL ?? '',
        apiKey: process.env.VOICE_HERMES_API_KEY ?? '',
        sessionId: process.env.VOICE_HERMES_SESSION_ID ?? '',
        sessionKey: process.env.VOICE_HERMES_SESSION_KEY ?? '',
        capabilitiesPath: HERMES_CAPABILITIES_PATH,
        toolsetsPath: HERMES_TOOLSETS_PATH,
        policyTimeoutMs: readIntegerEnv(process.env, 'VOICE_HERMES_POLICY_TIMEOUT_MS', {
          min: 100,
          max: 120_000,
          fallback: VOICE_HERMES_POLICY_TIMEOUT_MS,
        }),
      },
      voice: process.env.VOICE_NAME ?? 'marin',
      accountId: normalizeVoiceAccountId(process.env.VOICE_ACCOUNT_ID),
      // Conservative V1 defaults. Operators can only admit when this versioned price is known.
      usagePriceVersion: priceVersion,
      usageUnitPriceCentsPerMinute,
      usageDailyCapCents,
      usagePerSessionCapCents,
      sessionAbsoluteMs: readIntegerEnv(process.env, 'VOICE_SESSION_ABSOLUTE_MS', { min: 1_000, max: 86_400_000, fallback: 1_800_000 }),
      sessionIdleMs: readIntegerEnv(process.env, 'VOICE_SESSION_IDLE_MS', { min: 1_000, max: 86_400_000, fallback: 120_000 }),
      sessionIdleGraceMs: readIntegerEnv(process.env, 'VOICE_SESSION_IDLE_GRACE_MS', { min: 0, max: 86_400_000, fallback: 60_000 }),
      sessionLeaseMs: readIntegerEnv(process.env, 'VOICE_SESSION_LEASE_MS', { min: 1_000, max: 86_400_000, fallback: 30_000 }),
    },
  };

  // A per-session reservation larger than the whole day's cap can never be
  // reserved, so voice would be permanently unavailable for a reason the
  // operator would have to read the ledger code to discover.
  if (usagePerSessionCapCents > usageDailyCapCents) {
    throw new Error(
      `VOICE_USAGE_PER_SESSION_CAP_CENTS (${usagePerSessionCapCents}) must not exceed `
      + `VOICE_USAGE_DAILY_CAP_CENTS (${usageDailyCapCents}).`
    );
  }

  assertVoicePrivateAuth(config);
  if (config.voice.enabled) {
    assertKnownVoicePriceVersion(config.voice.usagePriceVersion);
    // The private Hermes deployment is the only conversational authority the
    // voice surface has. Without a complete server-only route there is nothing
    // to speak on its behalf, so this is a boot failure rather than a call that
    // fails once the operator is already talking.
    assertVoiceHermesRoute(config.voice.hermes);
  }

  if (config.voice.enabled && config.voice.publicOrigin.length === 0) {
    console.warn(
      '[config] VOICE_ENABLED without VOICE_PUBLIC_ORIGIN — only loopback origins are accepted. ' +
      'Set VOICE_PUBLIC_ORIGIN to your https://<machine>.<tailnet>.ts.net origin for Tailscale Serve.'
    );
  }

  return config;
}

export function loadSelectors(config: ServerConfig): SelectorConfig {
  const fullPath = resolve(config.selectorsPath);
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw) as SelectorConfig;
  } catch (err) {
    console.warn(`[config] Could not load selectors from ${fullPath}, using defaults`);
    return getDefaultSelectors();
  }
}

function getDefaultSelectors(): SelectorConfig {
  return {
    chatContainer: {
      strategies: [
        "#workbench\\.parts\\.auxiliarybar",
        "div.composer-bar.editor",
        "[class*='composer-bar']",
        "[class*='composer-panel']",
        "[class*='chat-widget']",
      ],
    },
    approveButton: {
      strategies: [
        "button[aria-label*='Accept']",
        "button[aria-label*='Approve']",
        "button[aria-label*='Run']",
        "button[aria-label*='Allow']",
      ],
      textMatch: ['Accept', 'Approve', 'Run', 'Allow', 'Accept All'],
    },
    rejectButton: {
      strategies: [
        "button[aria-label*='Reject']",
        "button[aria-label*='Deny']",
        "button[aria-label*='Cancel']",
      ],
      textMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    },
    chatInput: {
      strategies: [
        "textarea[class*='input']",
        "[contenteditable='true']",
        "[role='textbox']",
        "textarea",
      ],
    },
    agentStatus: {
      strategies: [
        "[class*='status']",
        "[class*='thinking']",
        "[class*='spinner']",
        "[class*='loading']",
      ],
    },
  };
}
