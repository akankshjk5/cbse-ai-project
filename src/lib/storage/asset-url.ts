/**
 * Turning a stored asset reference into a URL a browser can play.
 *
 * Three buckets are `public = true` today, and every worker writes the result
 * of `getPublicUrl()` straight into a database column. So the stored value is
 * an absolute, permanent, unauthenticated URL, and the rows that reference it
 * are protected while the bytes are not.
 *
 * `docs/private-buckets-migration.md` explains why flipping the buckets is not
 * a one-line change: the URLs already handed out keep working after a flip
 * only if nothing re-reads them, and every stored column holds one. This module
 * is the part that has to exist first — one place that decides how an asset
 * reference becomes a playable URL, so the flip becomes configuration rather
 * than a rewrite of every worker and every player.
 *
 * It changes nothing by itself. `STORAGE_URL_MODE` defaults to `public`, which
 * returns exactly what is stored today.
 *
 * What this module does NOT do, and must not be described as doing: it does not
 * make an existing public URL private. Anyone holding one keeps the bytes until
 * the bucket is flipped and the object is moved or renamed. Signing new URLs
 * protects objects served through this path from the moment the bucket is
 * private, and not one moment earlier.
 */

/** How a stored reference should be turned into a playable URL. */
export type StorageUrlMode = 'public' | 'signed';

export const DEFAULT_SIGNED_TTL_SECONDS = 60 * 60;

/**
 * Ten minutes is the floor. A lesson video is up to 40 seconds, but a teacher
 * opening one on a slow connection, pausing, and resuming is ordinary, and an
 * expiry that fires mid-playback reads as a broken video rather than as a
 * security control.
 */
export const MIN_SIGNED_TTL_SECONDS = 600;

/** A week. Beyond this a signed URL is a public URL with extra steps. */
export const MAX_SIGNED_TTL_SECONDS = 60 * 60 * 24 * 7;

export class StorageUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUrlError';
  }
}

export function storageUrlMode(raw: string | undefined = process.env.STORAGE_URL_MODE): StorageUrlMode {
  const value = (raw ?? 'public').trim().toLowerCase();
  if (value === 'public' || value === '') return 'public';
  if (value === 'signed') return 'signed';
  throw new StorageUrlError(
    `STORAGE_URL_MODE must be "public" or "signed", not "${raw}".`);
}

export function signedTtlSeconds(
  raw: string | undefined = process.env.STORAGE_SIGNED_URL_TTL_SECONDS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SIGNED_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new StorageUrlError(`STORAGE_SIGNED_URL_TTL_SECONDS must be a whole number of seconds, not "${raw}".`);
  }
  if (value < MIN_SIGNED_TTL_SECONDS || value > MAX_SIGNED_TTL_SECONDS) {
    throw new StorageUrlError(
      `STORAGE_SIGNED_URL_TTL_SECONDS must be between ${MIN_SIGNED_TTL_SECONDS} and `
      + `${MAX_SIGNED_TTL_SECONDS} seconds; got ${value}.`);
  }
  return value;
}

/**
 * The object path inside a bucket, given what a column actually holds.
 *
 * Columns hold a mixture: rows written before this module hold an absolute
 * `.../storage/v1/object/public/<bucket>/<path>` URL, and anything written
 * after can hold a bare path. Both have to resolve, because a migration that
 * required rewriting every row first would never be run.
 *
 * Returns null when the value belongs to a different bucket or a different
 * host entirely — a provider URL that was stored without being downloaded, for
 * instance. The caller decides what to do about that; guessing a path here
 * would turn a foreign URL into a confident 404.
 */
export function objectPathFor(stored: string, bucket: string): string | null {
  const value = stored.trim();
  if (value === '') return null;

  if (!/^https?:\/\//i.test(value)) {
    // Already a path. Strip a leading bucket segment if a caller stored one.
    const path = value.replace(/^\/+/, '');
    return path.startsWith(`${bucket}/`) ? path.slice(bucket.length + 1) : path;
  }

  let url: URL;
  try { url = new URL(value); } catch { return null; }

  // Supabase serves objects at /storage/v1/object/<public|sign>/<bucket>/<path>
  const match = url.pathname.match(
    /\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, foundBucket, path] = match;
  if (foundBucket !== bucket) return null;
  return decodeURIComponent(path);
}

/** The subset of the Supabase storage client this module needs. */
export interface StorageLike {
  from(bucket: string): {
    createSignedUrl(path: string, expiresIn: number):
      Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
}

export interface ResolveOptions {
  mode?: StorageUrlMode;
  ttlSeconds?: number;
}

/**
 * A playable URL for one stored asset reference.
 *
 * In `public` mode an absolute stored URL is returned untouched — the bytes are
 * public, re-deriving the URL would only risk getting it wrong, and this is the
 * behaviour every current deployment has.
 *
 * In `signed` mode the path is extracted and signed. A value that cannot be
 * resolved to a path in this bucket is an error rather than a silent fallback
 * to the public URL: falling back would mean a deployment that believes it is
 * serving signed URLs quietly serving permanent ones, which is the failure this
 * module exists to prevent.
 */
export async function resolveAssetUrl(
  storage: StorageLike,
  bucket: string,
  stored: string,
  options: ResolveOptions = {},
): Promise<string> {
  const mode = options.mode ?? storageUrlMode();
  if (mode === 'public') {
    if (/^https?:\/\//i.test(stored.trim())) return stored.trim();
    const path = objectPathFor(stored, bucket);
    if (path === null) {
      throw new StorageUrlError(`Could not read an object path out of ${describe(stored)}.`);
    }
    return storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  const path = objectPathFor(stored, bucket);
  if (path === null) {
    throw new StorageUrlError(
      `Refusing to serve ${describe(stored)} from "${bucket}": it is not an object in that `
      + `bucket, and falling back to a public URL would hand out a permanent link `
      + `from a deployment that asked for signed ones.`);
  }

  const ttl = options.ttlSeconds ?? signedTtlSeconds();
  const { data, error } = await storage.from(bucket).createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    throw new StorageUrlError(
      `Could not sign "${path}" in "${bucket}": ${error?.message ?? 'no URL returned'}.`);
  }
  return data.signedUrl;
}

/** A stored value, shortened, without a query string that may carry a token. */
function describe(stored: string): string {
  const value = stored.trim();
  const withoutQuery = value.split('?')[0] ?? value;
  return withoutQuery.length > 80 ? `"${withoutQuery.slice(0, 77)}..."` : `"${withoutQuery}"`;
}
