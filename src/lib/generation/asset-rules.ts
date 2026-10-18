/**
 * What an asset must look like before it is worth storing.
 *
 * Pure predicates over bytes, kept out of `asset-store.ts` because that module
 * is `server-only` and these are the part worth testing without a Supabase
 * project. Nothing here does IO.
 *
 * The signature checks matter more than they look. A worker whose upstream
 * stage failed does not return nothing — it returns an error page or a JSON
 * body, with a plausible length and a content type nobody set deliberately.
 * Stored without inspection, that becomes a lesson whose video is HTML, and
 * the first person to find out is a teacher in front of a class.
 */

import { createHash } from 'node:crypto';

export type AssetKind = 'video' | 'pptx' | 'keyframe' | 'clip' | 'narration' | 'subtitle';

/** What the bucket accepts, mirrored so a bad type fails before the upload. */
const MIME_FOR: Record<AssetKind, readonly string[]> = {
  video: ['video/mp4', 'video/webm'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  keyframe: ['image/png', 'image/jpeg', 'image/webp'],
  clip: ['video/mp4', 'video/webm'],
  narration: ['audio/wav', 'audio/x-wav'],
  subtitle: ['text/vtt', 'application/x-subrip'],
};

/** Magic bytes, so a provider that returned JSON cannot become a "video". */
const SIGNATURE: Partial<Record<AssetKind, (bytes: Uint8Array) => boolean>> = {
  video: (b) => isMp4(b) || isWebm(b),
  clip: (b) => isMp4(b) || isWebm(b),
  keyframe: (b) => isPng(b) || isJpeg(b) || isWebp(b),
  narration: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE',
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,     // zip container
};

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return Array.from(bytes.slice(from, to)).map((c) => String.fromCharCode(c)).join('');
}
const isPng = (b: Uint8Array) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG';
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
const isWebp = (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP';
const isMp4 = (b: Uint8Array) => ascii(b, 4, 8) === 'ftyp';
const isWebm = (b: Uint8Array) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class AssetRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AssetRejected';
  }
}


/** Throws unless the declared type is one the bucket accepts for this kind. */
export function mimeAllowed(kind: AssetKind, mimeType: string): void {
  const allowed = MIME_FOR[kind];
  if (!allowed.includes(mimeType)) {
    throw new AssetRejected(`${mimeType} is not a ${kind}; expected ${allowed.join(' or ')}`);
  }
}

/** Throws unless the bytes carry the magic number their kind requires. */
export function signatureMatches(kind: AssetKind, bytes: Uint8Array): void {
  const signature = SIGNATURE[kind];
  if (signature && !signature(bytes)) {
    throw new AssetRejected(
      `bytes do not look like ${kind}; the upstream step probably failed`);
  }
}
