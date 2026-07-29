/** The only Realtime model permitted by the private voice surface. */
export const VOICE_REALTIME_MODEL = 'gpt-realtime-2.1' as const;

/**
 * The pinned automatic-speech-recognition model for input transcription.
 *
 * This is not a second conversational model and must never become one: it turns
 * audio into the text this relay forwards to Hermes, and it is never asked to
 * answer anything. Hermes is the only source of assistant content.
 */
export const VOICE_TRANSCRIPTION_MODEL = 'whisper-1' as const;

/** Bound on the provider `item_id` the relay will accept as a turn key. */
export const VOICE_MAX_ITEM_ID_BYTES = 256;

export const VOICE_MAX_CALL_ID_LENGTH = 200;

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

/**
 * How many recent transcript item ids are remembered for dedupe.
 *
 * The provider can repeat a completed-transcription event; the relay must not
 * ask Hermes the same question twice. Bounded so a long call cannot grow the
 * set without limit.
 */
export const VOICE_MAX_TRANSCRIPT_ITEM_MEMORY = 128;

/**
 * How many superseded rendering turns are remembered as "cancel this on sight".
 *
 * A rendering can be interrupted in the window between the relay asking for it
 * and the provider acknowledging it, and the acknowledgement still arrives. The
 * turn id has to survive that window so the late `response.created` is
 * recognised as an expected-but-abandoned rendering — cancelled on arrival,
 * without being mistaken for an unauthorised response and failing the call.
 * Bounded so a long, chatty call cannot grow the set without limit.
 */
export const VOICE_MAX_INTERRUPTED_RENDER_MEMORY = 32;
