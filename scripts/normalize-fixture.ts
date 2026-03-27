/**
 * Sanitize a recording JSONL into a stable fixture for regression tests.
 *
 * Usage:
 *   npx tsx scripts/normalize-fixture.ts data/recording-2025-xx.jsonl [--out fixtures/recordings/name.jsonl]
 *
 * Normalizations applied:
 *   - Strip the header line (metadata)
 *   - Reset all timestamps to monotonic offsets from 0
 *   - Redact _rawSignals textPreview to first 40 chars
 *   - Normalize volatile IDs (approval-*, tool-call-*)
 *   - Remove window/connection metadata that varies per machine
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';

interface SnapshotLine {
  ts: number;
  state: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
}

function normalizeIds(obj: unknown, idMap: Map<string, string>, prefix: string): unknown {
  if (typeof obj === 'string') {
    if (idMap.has(obj)) return idMap.get(obj)!;
    if (/^[0-9a-f-]{20,}$/i.test(obj)) {
      const next = `${prefix}-${idMap.size}`;
      idMap.set(obj, next);
      return next;
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(v => normalizeIds(v, idMap, prefix));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'id' || k === 'toolCallId' || k === 'composerId' || k === 'approvalId') {
        out[k] = normalizeIds(v as string, idMap, k.replace('Id', ''));
      } else {
        out[k] = normalizeIds(v, idMap, prefix);
      }
    }
    return out;
  }
  return obj;
}

function stripMachineFields(state: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...state };
  delete copy.windows;
  delete copy.activeWindowId;
  copy.connected = true;
  copy.extractorStatus = 'ok';
  copy.lastExtractionAt = null;
  copy.consecutiveExtractionFailures = 0;
  copy.lastExtractionError = null;
  return copy;
}

function main() {
  const args = process.argv.slice(2);
  const inPath = args.find(a => !a.startsWith('-'));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  if (!inPath) {
    console.error('Usage: npx tsx scripts/normalize-fixture.ts <recording.jsonl> [--out <fixture.jsonl>]');
    process.exit(1);
  }

  const lines = readFileSync(resolve(inPath), 'utf-8').trim().split('\n');
  const parsed = lines.map(l => JSON.parse(l));
  const hasHeader = parsed[0]?.header != null;
  const data: SnapshotLine[] = hasHeader ? parsed.slice(1) : parsed;

  if (data.length === 0) {
    console.error('No data lines found');
    process.exit(1);
  }

  const baseTs = data[0].ts;
  const idMap = new Map<string, string>();
  const normalized: string[] = [];

  for (const line of data) {
    const out: SnapshotLine = {
      ts: line.ts - baseTs,
      state: line.state ? stripMachineFields(
        normalizeIds(line.state, idMap, 'id') as Record<string, unknown>
      ) : null,
    };
    normalized.push(JSON.stringify(out));
  }

  const dest = outPath ?? resolve('fixtures/recordings', basename(inPath));
  writeFileSync(dest, normalized.join('\n') + '\n');
  console.log(`Wrote ${normalized.length} normalized snapshots to ${dest}`);
}

main();
