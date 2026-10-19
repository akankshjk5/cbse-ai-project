/**
 * Signed-URL resolution, against a FAKE storage client.
 *
 * MOCK, NOT SUPABASE. The client below records what it was asked for and
 * returns URLs it makes up. Nothing is uploaded, no bucket is read, and no
 * bucket visibility is changed anywhere by this file.
 *
 * What it proves: that `signed` mode never returns a permanent URL, that the
 * expiry is bounded at both ends, that a value stored by an older worker as an
 * absolute public URL still resolves, and that a reference belonging to another
 * bucket is refused instead of being served from this one.
 *
 * What it cannot prove: that the deployed buckets are private. They are not.
 *
 *   npm run test:asset-url
 */

import {
  DEFAULT_SIGNED_TTL_SECONDS,
  MAX_SIGNED_TTL_SECONDS,
  MIN_SIGNED_TTL_SECONDS,
  StorageUrlError,
  objectPathFor,
  resolveAssetUrl,
  signedTtlSeconds,
  storageUrlMode,
  type StorageLike,
} from '../src/lib/storage/asset-url.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function refuses(body: () => unknown | Promise<unknown>): Promise<StorageUrlError | null> {
  try { await body(); return null; } catch (error) {
    return error instanceof StorageUrlError ? error : null;
  }
}

const BUCKET = 'lesson-video-assets';
const HOST = 'https://abcdefgh.supabase.co';

interface Fake extends StorageLike {
  signed: { path: string; expiresIn: number }[];
  publicAsked: string[];
}

function fakeStorage(options: { failSigning?: boolean } = {}): Fake {
  const signed: { path: string; expiresIn: number }[] = [];
  const publicAsked: string[] = [];
  return {
    signed,
    publicAsked,
    from() {
      return {
        async createSignedUrl(path: string, expiresIn: number) {
          signed.push({ path, expiresIn });
          if (options.failSigning) return { data: null, error: { message: 'object not found' } };
          return {
            data: { signedUrl: `${HOST}/storage/v1/object/sign/${BUCKET}/${path}?token=fake.jwt` },
            error: null,
          };
        },
        getPublicUrl(path: string) {
          publicAsked.push(path);
          return { data: { publicUrl: `${HOST}/storage/v1/object/public/${BUCKET}/${path}` } };
        },
      };
    },
  };
}

// ── Reading a path out of what columns actually hold ───────────────────────

const PATH = 'lesson/9f2/narration-kn-IN.wav';
for (const [label, stored] of [
  ['a bare path', PATH],
  ['a leading slash', `/${PATH}`],
  ['a bucket-prefixed path', `${BUCKET}/${PATH}`],
  ['an absolute public URL', `${HOST}/storage/v1/object/public/${BUCKET}/${PATH}`],
  ['an absolute signed URL', `${HOST}/storage/v1/object/sign/${BUCKET}/${PATH}?token=x`],
  ['an authenticated URL', `${HOST}/storage/v1/object/authenticated/${BUCKET}/${PATH}`],
] as const) {
  check(objectPathFor(stored, BUCKET) === PATH,
    `${label} must resolve to the object path, got ${objectPathFor(stored, BUCKET)}`);
}
console.log('paths: bare, slashed, bucket-prefixed, public, signed and authenticated all resolve');

check(objectPathFor(`${HOST}/storage/v1/object/public/deck-assets/${PATH}`, BUCKET) === null,
  'a reference to a different bucket must not resolve to this one');
check(objectPathFor('https://api.higgsfield.ai/results/abc.mp4', BUCKET) === null,
  'a provider URL that was never downloaded must not resolve to a bucket path');
check(objectPathFor('', BUCKET) === null, 'an empty reference must not resolve');
check(objectPathFor('   ', BUCKET) === null, 'a blank reference must not resolve');
console.log('paths: a foreign bucket, a provider URL and an empty value all refuse to resolve');

// Percent-encoding survives the round trip: Kannada filenames are real.
const encoded = `${HOST}/storage/v1/object/public/${BUCKET}/lesson/%E0%B2%AA%E0%B2%BE%E0%B2%A0.wav`;
check(objectPathFor(encoded, BUCKET) === 'lesson/ಪಾಠ.wav',
  `a percent-encoded path must decode, got ${objectPathFor(encoded, BUCKET)}`);
console.log('paths: a percent-encoded Kannada filename decodes to its real name');

// ── Mode and expiry parsing ───────────────────────────────────────────────

check(storageUrlMode(undefined) === 'public', 'the default mode must be public');
check(storageUrlMode('') === 'public', 'an empty mode must be public');
check(storageUrlMode('Signed') === 'signed', 'the mode must be case-insensitive');
check(await refuses(() => storageUrlMode('private')), 'an unknown mode must be refused, not defaulted');
console.log('mode: defaults to public, and an unknown value is refused rather than guessed');

check(signedTtlSeconds(undefined) === DEFAULT_SIGNED_TTL_SECONDS, 'the default TTL applies');
check(signedTtlSeconds(`${MIN_SIGNED_TTL_SECONDS}`) === MIN_SIGNED_TTL_SECONDS, 'the floor is allowed');
check(signedTtlSeconds(`${MAX_SIGNED_TTL_SECONDS}`) === MAX_SIGNED_TTL_SECONDS, 'the ceiling is allowed');
for (const bad of ['0', '59', `${MIN_SIGNED_TTL_SECONDS - 1}`, `${MAX_SIGNED_TTL_SECONDS + 1}`, 'soon', '60.5', '-3600']) {
  check(await refuses(() => signedTtlSeconds(bad)), `TTL "${bad}" must be refused`);
}
console.log(`expiry: bounded to ${MIN_SIGNED_TTL_SECONDS}..${MAX_SIGNED_TTL_SECONDS}s; a short, long or malformed value is refused`);

// ── public mode is exactly today's behaviour ──────────────────────────────

const publicStored = `${HOST}/storage/v1/object/public/${BUCKET}/${PATH}`;
let storage = fakeStorage();
check(await resolveAssetUrl(storage, BUCKET, publicStored, { mode: 'public' }) === publicStored,
  'public mode must return a stored absolute URL untouched');
check(storage.signed.length === 0, 'public mode must not sign anything');
console.log('public: a stored absolute URL is returned untouched and nothing is signed');

storage = fakeStorage();
const fromPath = await resolveAssetUrl(storage, BUCKET, PATH, { mode: 'public' });
check(fromPath.includes(`/public/${BUCKET}/${PATH}`), `a bare path must become a public URL, got ${fromPath}`);
console.log('public: a bare path becomes the public URL the workers write today');

// ── signed mode ───────────────────────────────────────────────────────────

storage = fakeStorage();
const signedUrl = await resolveAssetUrl(storage, BUCKET, publicStored, { mode: 'signed', ttlSeconds: 900 });
check(storage.signed.length === 1, 'signed mode must sign exactly once');
check(storage.signed[0]!.path === PATH, `the signed path must be the object path, got ${storage.signed[0]!.path}`);
check(storage.signed[0]!.expiresIn === 900, 'the requested TTL must reach the client');
check(storage.publicAsked.length === 0, 'signed mode must never ask for a public URL');
check(signedUrl.includes('token='), 'a signed URL must carry a token');
check(!signedUrl.includes('/object/public/'), 'a signed URL must not be a public URL');
console.log('signed: an old public URL is converted to a signed one with an expiry, and nothing public is requested');

// The property that matters most: signed mode has no path back to a permanent
// URL. A deployment that asked for signed URLs must fail loudly rather than
// quietly hand out one that never expires.
storage = fakeStorage();
let refusal = await refuses(() =>
  resolveAssetUrl(storage, BUCKET, 'https://api.higgsfield.ai/results/abc.mp4', { mode: 'signed' }));
check(refusal, 'a foreign URL must be refused in signed mode');
check(/would hand out a permanent link/.test(refusal!.message),
  `the refusal should say why falling back is worse: ${refusal!.message}`);
check(storage.publicAsked.length === 0, 'a refusal must not have fallen back to a public URL');
console.log('signed: a reference it cannot sign is refused, never served as a permanent URL');

storage = fakeStorage({ failSigning: true });
refusal = await refuses(() => resolveAssetUrl(storage, BUCKET, PATH, { mode: 'signed' }));
check(refusal, 'a signing failure must raise');
check(/object not found/.test(refusal!.message), 'the underlying reason must survive');
check(storage.publicAsked.length === 0, 'a signing failure must not fall back to a public URL');
console.log('signed: a signing failure surfaces the reason and does not fall back');

// A token must never be echoed into an error message.
storage = fakeStorage();
refusal = await refuses(() => resolveAssetUrl(
  storage, BUCKET, 'https://elsewhere.example/x/y?token=super-secret-token-value', { mode: 'signed' }));
check(refusal && !refusal.message.includes('super-secret-token-value'),
  'a refusal must not echo a token from the value it refused');
console.log('signed: a refusal does not echo a token out of the value it rejected');

console.log('\nOK — FAKE storage client. No bucket was read, written or made private.');
