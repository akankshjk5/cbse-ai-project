/**
 * Upload limits, shared by the three places that have to agree on them.
 *
 * `next.config.ts` sets the Server Action body cap from this, the dialog
 * rejects an oversized file before submitting, and the Server Action checks it
 * again because a client-side check is a courtesy, not a control. If these ever
 * disagree the symptom is a runtime "Body exceeded" error that no `try/catch`
 * in the action can turn into a form message — the request dies before the
 * action runs.
 *
 * No imports: this file is pulled into the Next config, which is evaluated
 * outside the app's module graph.
 */

/** Largest reference image accepted, in bytes. */
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The Server Action body cap.
 *
 * Deliberately larger than the file limit: the cap applies to the RAW request
 * body, which carries the other form fields plus multipart boundaries and part
 * headers on top of the image. Set equal to `MAX_REFERENCE_IMAGE_BYTES`, a file
 * of exactly that size would be refused by the framework — the one failure the
 * form cannot turn into a message, since the request dies before the action
 * runs. 1MB of slack is far more than the ~10-20KB of overhead the Next docs
 * quote, and costs nothing until someone actually sends a 10MB image.
 */
export const SERVER_ACTION_BODY_LIMIT_BYTES = MAX_REFERENCE_IMAGE_BYTES + 1024 * 1024;

/** MIME types accepted for a reference image, matching the deck-uploads bucket. */
export const REFERENCE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb < 10 ? 1 : 0)}MB` : `${Math.round(bytes / 1024)}KB`;
}

/** Null when the file is acceptable, otherwise the message to show the user. */
export function referenceImageError(file: { size: number; type: string }): string | null {
  if (file.size === 0) return 'That file is empty.';

  if (!(REFERENCE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.type || 'That file'} is not supported. Use a PNG, JPEG or WebP.`;
  }

  if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
    return `That image is ${formatBytes(file.size)}. The limit is ${formatBytes(
      MAX_REFERENCE_IMAGE_BYTES,
    )} — try a screenshot or a resized copy.`;
  }

  return null;
}
