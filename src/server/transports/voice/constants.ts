/** The only Realtime model permitted by the private voice surface. */
export const VOICE_REALTIME_MODEL = 'gpt-realtime-2.1' as const;

export const VOICE_MAX_TOOL_ARGUMENT_BYTES = 8_192;

/**
 * Bounds on the rest of the function-call envelope. Unlike the argument blob
 * these are never truncated to fit: a truncated `call_id` names a different
 * call, and answering it would write a tool output against an identifier the
 * model never issued. Over the bound is refused, not trimmed.
 */
export const VOICE_MAX_TOOL_NAME_BYTES = 128;
export const VOICE_MAX_TOOL_CALL_ID_BYTES = 256;
export const VOICE_MAX_TOOL_OUTPUT_BYTES = 2_000;
export const VOICE_MAX_CALL_ID_LENGTH = 200;
export const VOICE_MAX_CONTEXT_TURNS = 12;
export const VOICE_MAX_CONTEXT_BYTES = 12_000;

/**
 * Largest provider sideband event the relay will parse. Anything above this is
 * dropped by the application without touching the session.
 */
export const VOICE_MAX_PROVIDER_EVENT_BYTES = 32_768;

/**
 * ws `maxPayload` for the sideband socket. Deliberately one KiB above the
 * application parse limit: ws closes the connection on an oversize frame, so if
 * the two limits were equal (or the frame ceiling were the lower of the two, as
 * it used to be) an oversize provider event would kill a live call instead of
 * being refused. The headroom keeps oversize input non-fatal while still
 * bounding how much the socket will buffer.
 */
export const VOICE_MAX_PROVIDER_FRAME_BYTES = VOICE_MAX_PROVIDER_EVENT_BYTES + 1_024;
