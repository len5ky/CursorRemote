/**
 * Known Realtime price versions.
 *
 * Admission to a paid voice session is gated on the operator naming a price
 * version this code actually knows. The previous gate — "the string is not
 * empty" — accepted anything an operator invented, which meant a session could
 * be admitted, billed and settled against pricing nobody had ever checked.
 *
 * The table is frozen deliberately: a price version is a claim about what a
 * minute of Realtime audio costs, and nothing at runtime is entitled to edit
 * that claim. Adding a version is a code change, reviewed like any other.
 *
 * `referenceUnitPriceCentsPerMinute` is the published rate this version was
 * written against, and it is the default for the *local* estimate used before
 * the provider reports actual usage. An operator may raise
 * `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE` to be more conservative; the
 * reference is what the version means.
 */

export interface VoicePriceEntry {
  /** Published rate this version was written against, in cents per minute. */
  readonly referenceUnitPriceCentsPerMinute: number;
  /** What the version covers, for the operator reading a startup failure. */
  readonly description: string;
}

export const VOICE_PRICE_TABLE: Readonly<Record<string, VoicePriceEntry>> = Object.freeze({
  'openai-realtime-2026-01': Object.freeze({
    referenceUnitPriceCentsPerMinute: 50,
    description: 'OpenAI Realtime audio, January 2026 published rate card',
  }),
});

/** The version the shipped defaults are written against. */
export const KNOWN_VOICE_PRICE_VERSION = 'openai-realtime-2026-01';

export function knownVoicePriceVersions(): readonly string[] {
  return Object.freeze(Object.keys(VOICE_PRICE_TABLE));
}

/**
 * Exact match only. A version is an identifier, not a search term: a
 * case-insensitive or prefix match would let `openai-realtime` stand in for a
 * rate card it is not.
 */
export function isKnownVoicePriceVersion(version: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOICE_PRICE_TABLE, version);
}

export function voicePriceEntry(version: string): VoicePriceEntry | undefined {
  return isKnownVoicePriceVersion(version) ? VOICE_PRICE_TABLE[version] : undefined;
}
