/**
 * If `agentActivityText` stays identical across polls for this long, it is cleared
 * for relay state (web UI). Matches TelegramTransport ephemeral activity cleanup.
 */
export const AGENT_ACTIVITY_STALE_MS = 30_000;
