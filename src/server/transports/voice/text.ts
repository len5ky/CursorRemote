/**
 * Cut a string to a UTF-8 *byte* ceiling without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cap written as
 * `slice(0, N)` let N characters of non-ASCII text weigh up to 3N bytes (4N with
 * astral characters) on the wire — the ceiling the provider and the sideband are
 * sized against was silently blown by any non-English content. Rewinding off
 * continuation bytes keeps the result decodable: a string ending in half a
 * character is not something the model can read back.
 *
 * Exported because every byte cap on this surface has exactly the same problem
 * and must be cut the same way. A second, hand-rolled copy is how one of them
 * drifts back to `slice`.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte, so the cut landed mid-character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.toString('utf8', 0, end);
}

/** True when `value` is a plain object — not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A non-empty string within a UTF-8 byte bound, or null.
 *
 * Content that breaks the bound is **refused, not truncated**. On this surface
 * every bounded string is either something the operator actually said or
 * something Hermes actually answered; a trimmed version of either is a
 * different utterance, and speaking it would be a fabrication.
 */
export function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > maxBytes) return null;
  return trimmed;
}
