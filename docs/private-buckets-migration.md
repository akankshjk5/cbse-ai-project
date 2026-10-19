# Making lesson media private without breaking playback

**Status: the mechanism exists; the flip has not happened.** Bucket visibility
is production configuration and flipping it is not reversible for URLs already
handed out, so it is written down for a decision rather than done.

Changed on 2026-10-19: `src/lib/storage/asset-url.ts` is the one place that
turns a stored asset reference into a playable URL. `STORAGE_URL_MODE` defaults
to `public`, so nothing behaves differently today, and `signed` switches the
whole application to time-limited URLs without touching a worker or a player.

`npm run test:asset-url` covers it against a fake storage client: paths are
read out of the absolute public URLs that columns already hold, including
percent-encoded Kannada filenames; the expiry is bounded at both ends
(10 minutes to 7 days); an unknown mode is refused rather than defaulted; and
signed mode has **no** path back to a permanent URL — a reference it cannot
sign raises instead of falling back. That last one is mutation-tested, because
a silent fallback would mean a deployment that believes it serves signed URLs
quietly serving permanent ones.

**The three buckets are still `public = true`.** Every object in them is still
served to anyone with the URL, with no authentication and no expiry. Signing
protects objects from the moment a bucket is private and not one moment
earlier, and anyone already holding a public URL keeps the bytes until the
object is moved or renamed.

## The finding

Three buckets are declared `public = true`:

| Bucket | Declared in | Holds |
|---|---|---|
| `lesson-video-assets` | `20260922150000_narrated_lesson_videos.sql:575` | narration WAV, scene images, final MP4 |
| `cloud-lesson-assets` | `20261010120000_cloud_lesson_engine.sql` | keyframes, clips, assembled video |
| `deck-assets` | `20260827000600_storage.sql` | deck images |

A public Supabase bucket serves every object to anyone who has the URL, with
no authentication and no expiry. The row-level rules proven in
`supabase/tests/asset_lifecycle.sql` govern who may read the *database rows*;
they say nothing about who may fetch the *object*. Those tests are not
evidence that this media is protected, and should not be cited as if they
were.

This matters more than usual here because the reuse system is built on sharing
lessons between teachers under explicit permission, and the textbook material
those lessons derive from carries `reuseRights: unresolved`. A permission model
in the database is not worth much while the bytes are world-readable.

## Why it cannot simply be switched off

Five call sites write a permanent public URL into a database column:

```
src/app/api/lesson-videos/route.ts:115   → narration_url
src/lib/cloud-lesson/image-worker.ts:112 → scenes.image_url
src/lib/cloud-lesson/media-worker.ts:151 → scenes.video_url
src/lib/cloud-lesson/worker.ts:82        → final_video_url
src/lib/generation/run.ts:258            → deck asset URLs
```

Two UI components read those columns straight into `<video src>` and
`<img src>`: `cloud-lesson-studio.tsx` and `lesson-video-studio.tsx`.

So flipping `public` to `false` would, in order: break every URL already stored
in the database, blank both studio pages for every existing lesson, and leave
no way to play anything that was generated before the change. The data would be
safe and the product would be broken.

A signed URL is not a drop-in replacement either. `createSignedUrl` returns a
URL with an expiry, and a 10-minute signature handed to a `<video>` element
fails mid-playback for anyone who pauses, or whose connection is slow enough
that the browser re-requests a byte range after it lapses.

## What already points the right way

`lesson_assets` stores `storage_bucket` and `storage_key` rather than a URL.
That was deliberate: a key can be resolved to whatever kind of URL the
deployment needs, while a stored URL is a decision frozen at write time. The
new write path (`src/lib/generation/asset-store.ts`) never calls
`getPublicUrl`.

`createSignedUrl` is already used once, in `src/lib/data/generation.ts:446`
with a ten-minute expiry, so the pattern and its ergonomics are established.

## Proposed sequence

Each step is independently deployable and leaves the product working.

**1. Resolve, don't store.** Add an authenticated route — say
`GET /api/lesson-assets/:id/url` — that checks the caller may read the asset's
project, mints a signed URL, and returns it with its expiry. The check is the
existing RLS: query `lesson_assets` as the user, and a row they cannot see
yields nothing to sign.

**2. Teach the players to refresh.** Both studio components fetch the URL
instead of reading a column, and re-fetch when it is close to expiring. Use an
expiry comfortably longer than a lesson — these are 30-second videos, so an
hour is generous — and refresh on `error` as a backstop. This step works while
the buckets are still public, which is what makes it safe to ship first.

**3. Backfill keys.** For every existing row holding a public URL, derive the
storage key and write a `lesson_assets` row for it. The URL format is stable
(`/storage/v1/object/public/<bucket>/<key>`), so this is a parse rather than a
re-upload. Verify each one with `verifyAsset()` and record anything that no
longer resolves as `missing` rather than quietly dropping it.

**4. Stop writing public URLs.** Change the five call sites to return storage
keys, and store those. At this point nothing new depends on bucket visibility.

**5. Flip one bucket and watch.** `cloud-lesson-assets` first: it is the
newest, has the fewest consumers, and its contents are regenerable. Leave
`lesson-video-assets` until the first has been quiet for a week, because it
holds the older lessons with the most stored URLs.

**6. `deck-assets` last, or never.** Deck images may legitimately be public if
decks are shared by link. That is a product decision, not a security one, and
it should be made deliberately rather than swept along.

## What to decide

- **Is cross-school reuse intended?** If lessons are shared only within a
  school, the signed-URL check can additionally require shared membership. If
  across schools, the permission model needs to be explicit before the bytes
  are locked down, or step 1 will block legitimate reuse.
- **How long should a signature last?** Longer is friendlier to playback and
  weaker as a control. An hour is a reasonable starting point for a
  thirty-second video.
- **Does any external system fetch these URLs?** A webhook, an LMS embed or a
  cached CDN entry would break at step 5. Nothing in this repository does, but
  this repository is not the whole deployment.

## What has been verified, and what has not

Verified against PostgreSQL 18.1: that `lesson_assets` rows are invisible
across teachers, and that an asset cannot be marked ready without a checksum.

Not verified, and not verifiable without Supabase credentials: bucket policies,
signed URL behaviour, whether an object is reachable without authentication,
and whether an aborted upload leaves a readable object. No part of this
proposal has been tested against a real Supabase project.
