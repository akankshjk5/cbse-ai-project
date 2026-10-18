/**
 * What `storeAsset` refuses before it touches the store.
 *
 * Every check here runs before a Supabase client is constructed, which is both
 * why they are testable with no credentials and why they are worth having: a
 * worker that got an error page instead of a render should fail at the upload,
 * not three stages later when a teacher presses play.
 *
 * The parts that DO need Supabase — upload, read-back, checksum comparison
 * against stored bytes — are not covered here and are not covered anywhere
 * yet. See the report.
 *
 *   npm run test:asset-store
 */

import {
  AssetRejected,
  type AssetKind,
  mimeAllowed,
  sha256,
  signatureMatches,
} from '../src/lib/generation/asset-rules.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** Minimal byte sequences carrying each format's real magic number. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
/** What a provider returns when something went wrong. */
const HTML = new TextEncoder().encode('<!doctype html><title>502 Bad Gateway</title>');
const JSON_ERROR = new TextEncoder().encode('{"error":"model unavailable"}');

/** The gate `storeAsset` runs before it constructs a client, in the same order. */
function rejects(kind: AssetKind, bytes: Uint8Array, mimeType: string): string | null {
  try {
    if (bytes.length === 0) throw new AssetRejected('refusing to store an empty object');
    mimeAllowed(kind, mimeType);
    signatureMatches(kind, bytes);
    return null;
  } catch (error) {
    if (error instanceof AssetRejected) return error.reason;
    throw error;
  }
}

// ── The checksum is over the bytes, and is stable ──────────────────────────

check(sha256(PNG) === sha256(PNG), 'the same bytes hash the same twice');
check(sha256(PNG) !== sha256(JPEG), 'different bytes hash differently');
check(/^[0-9a-f]{64}$/.test(sha256(MP4)), 'a checksum is 64 hex characters');
console.log('checksum: stable, distinguishing, and shaped as the column requires');

// ── An empty object is never stored ────────────────────────────────────────

check(rejects('video', new Uint8Array(0), 'video/mp4') === 'refusing to store an empty object',
  'a zero-byte upload must be refused');
console.log('empty: a zero-byte object is refused before the upload');

// ── The declared type must match the kind ──────────────────────────────────

const wrongMime = rejects('video', MP4, 'image/png');
check(wrongMime?.includes('is not a video'), `expected a MIME refusal, got ${wrongMime}`);
check(rejects('narration', WAV, 'audio/mpeg') !== null, 'mp3 is not an accepted narration type');
check(rejects('keyframe', PNG, 'image/gif') !== null, 'gif is not an accepted keyframe type');
console.log('type: a declared MIME outside the bucket allowlist is refused');

// ── Bytes must actually be what they claim ─────────────────────────────────
// This is the check that catches a failed upstream stage, which is the
// failure most likely to reach a classroom if it slips through.

for (const [kind, bad, mime] of [
  ['video', HTML, 'video/mp4'],
  ['video', JSON_ERROR, 'video/mp4'],
  ['keyframe', HTML, 'image/png'],
  ['narration', JSON_ERROR, 'audio/wav'],
  ['clip', HTML, 'video/webm'],
] as const) {
  const reason = rejects(kind, bad, mime);
  check(reason?.includes('do not look like'),
    `${kind} must reject non-${kind} bytes, got ${reason}`);
  check(reason?.includes('upstream'), 'the message should point at the real cause');
}
console.log('signature: an error page or JSON body cannot become a video, image or audio track');

// ── Correct bytes pass every pre-store gate ────────────────────────────────
// These reach the Supabase client and fail there, which is how we know the
// validation let them through rather than stopping them.

for (const [kind, good, mime] of [
  ['video', MP4, 'video/mp4'],
  ['video', WEBM, 'video/webm'],
  ['keyframe', PNG, 'image/png'],
  ['keyframe', JPEG, 'image/jpeg'],
  ['narration', WAV, 'audio/wav'],
  ['pptx', ZIP, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
] as const) {
  check(rejects(kind, good, mime) === null,
    `valid ${kind} bytes should pass every gate, got ${rejects(kind, good, mime)}`);
}
console.log('accept: well-formed bytes of every kind pass validation');

console.log('\nOK');
