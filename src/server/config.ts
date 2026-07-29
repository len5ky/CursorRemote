import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ServerConfig, SelectorConfig } from './types.js';
import { VOICE_REALTIME_MODEL } from './transports/voice/constants.js';

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

export function loadConfig(): ServerConfig {
  const preRegisteredRaw = process.env.TELEGRAM_ALLOWED_USERS ?? '';
  const preRegisteredUsers = preRegisteredRaw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));

  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');

  assertPinnedVoiceModel();

  return {
    cdpUrl: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
    serverPort: parseInt(process.env.SERVER_PORT ?? '3000', 10),
    serverHost: process.env.SERVER_HOST ?? '127.0.0.1',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS ?? '150', 10),
    selectorsPath: process.env.SELECTORS_PATH ?? './selectors.json',
    logLevel: (process.env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    webappPassword: process.env.WEBAPP_PASSWORD ?? '',
    windowTitleQualifier: process.env.WINDOW_TITLE_QUALIFIER !== 'false',
    dataDir,
    telegram: {
      enabled: process.env.TELEGRAM_ENABLED === 'true',
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      preRegisteredUsers,
      impl: (process.env.TELEGRAM_IMPL === 'raw' ? 'raw' : 'grammy') as 'grammy' | 'raw',
    },
    voice: {
      enabled: process.env.VOICE_ENABLED === 'true',
      openaiApiKey: process.env.OPENAI_API_KEY ?? '',
      hermesReadContextUrl: process.env.HERMES_READ_CONTEXT_URL ?? '',
      hermesReadContextToken: process.env.HERMES_READ_CONTEXT_TOKEN ?? '',
      voice: process.env.VOICE_NAME ?? 'marin',
      // Conservative V1 defaults. Operators can only admit when this versioned price is known.
      usagePriceVersion: process.env.VOICE_USAGE_PRICE_VERSION ?? 'openai-realtime-2026-01',
      usageUnitPriceCentsPerMinute: parseInt(process.env.VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE ?? '50', 10),
      usageDailyCapCents: parseInt(process.env.VOICE_USAGE_DAILY_CAP_CENTS ?? '500', 10),
      usagePerSessionCapCents: parseInt(process.env.VOICE_USAGE_PER_SESSION_CAP_CENTS ?? '100', 10),
      sessionAbsoluteMs: parseInt(process.env.VOICE_SESSION_ABSOLUTE_MS ?? '1800000', 10),
      sessionIdleMs: parseInt(process.env.VOICE_SESSION_IDLE_MS ?? '120000', 10),
      sessionIdleGraceMs: parseInt(process.env.VOICE_SESSION_IDLE_GRACE_MS ?? '60000', 10),
      sessionLeaseMs: parseInt(process.env.VOICE_SESSION_LEASE_MS ?? '30000', 10),
      targetMaxAgeMs: parseInt(process.env.VOICE_TARGET_MAX_AGE_MS ?? '5000', 10),
    },
  };
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
