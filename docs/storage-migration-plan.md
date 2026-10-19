# Making the asset buckets private, bucket by bucket

Written 2026-10-20. **No bucket has been flipped. All three are still
`public = true`, and every object in them is still served to anyone holding the
URL, unauthenticated and without expiry.** Nothing in this document, and
nothing in the code it describes, has changed that.

`docs/private-buckets-migration.md` is the original finding. This is the
executable plan: what each bucket holds, who writes it, who reads it, what
breaks on a flip, and how to get back.

---

## What already exists

| Piece | State | Where |
|---|---|---|
| One place that turns a stored reference into a URL | built, unit-tested | `src/lib/storage/asset-url.ts`, `npm run test:asset-url` (11 properties) |
| `STORAGE_URL_MODE=public\|signed` switch | built, defaults to `public` | same |
| Owner-scoped read policies for `cloud-lesson-assets` | **added 2026-10-20**, inert while public | `20261020120000_cloud_lesson_assets_policies.sql` |
| Tenant-isolation properties | 9 passing against PostgreSQL 18.1 | `supabase/tests/storage_isolation.sql` |
| Signed-URL expiry bounds | 10 min floor, 7 day ceiling | `asset-url.ts` |

What does **not** exist: any flip, any re-pointing of stored columns, and any
test against deployed Supabase.

---

## The three buckets

### 1. `cloud-lesson-assets` — the one that matters

Declared `public = true` in `20261010120000_cloud_lesson_engine.sql:861`.

| | |
|---|---|
| **Holds** | narration WAV, scene keyframes (PNG), raw and composed clips (MP4), assembled lesson video, and now the deck (PPTX) |
| **Path convention** | `<project_id>/<kind>/<job_id>-<uuid>.<ext>` — all four writers agree |
| **Writers** | `worker.ts:79` (narration), `image-worker.ts:110` (keyframe), `media-worker.ts:147` (clip), `deck-worker.ts:149` (deck) — all via service role |
| **URL producers** | the same four, each calling `getPublicUrl` and storing the absolute URL in a database column |
| **Consumers** | `cloud-lesson-studio.tsx:164` (`<video src>`, and an `<a href>` download link), `lesson-video-studio.tsx:264,274` (`<video>`, `<img>`) |
| **Policies before 2026-10-20** | **none at all** |

The missing policies were the real blocker. The other two buckets each carry an
explicit set; this one carried the bucket row and nothing else. Flipping it
first would have produced a total outage — with RLS on and no policy, the owner
sees nothing either — and the outage would have looked like a bug in the
player.

The policies now exist and are inert: a public bucket serves reads through an
endpoint that never consults RLS. They are the prerequisite, not the flip.

**What still breaks on a flip:** every stored column holds an absolute
`/object/public/...` URL. Those 404 the moment the bucket is private, so the
flip must be paired with resolving through `resolveAssetUrl` at read time.
`objectPathFor` already reads a path out of the old absolute URLs, so the
columns do **not** have to be rewritten first — which matters, because a
migration that required rewriting every row before it could start would never
be run.

### 2. `lesson-video-assets`

Declared public in `20260922150000_narrated_lesson_videos.sql:575`.

| | |
|---|---|
| **Holds** | narration WAV, scene images, final MP4 for the older lesson-video pipeline |
| **URL producer** | `src/app/api/lesson-videos/route.ts:115` |
| **Policies** | `public read`, `owner narration insert` (same migration, :602, :605) |

It already has a read policy to replace, so the flip is a policy edit rather
than a policy addition. Lower risk than bucket 1, and it should go **second**:
the same mechanism, proven on the bucket whose consumers are better understood.

### 3. `deck-assets`

Declared public in `20260827000600_storage.sql:16`.

| | |
|---|---|
| **Holds** | deck images for the slide-deck product |
| **URL producer** | `src/lib/generation/run.ts:258` |
| **Policies** | `public read`, `owner write`, `owner update`, `owner delete` — the most complete set of the three |
| **Consumers** | `slide-canvas.tsx` (`<img src>`, `<video src>`, background URLs) at :370, :383, :642, :673, :686 |

Most consumers, and they are inside an editor where a URL can be held in React
state across a long session. **Signed URLs expire; an editor open for two hours
with a one-hour TTL shows broken images after an hour.** This bucket needs a
refresh path, not just a resolver, and should go **last**.

---

## The order, and why

1. **`cloud-lesson-assets`** — policies already added. Few consumers, all
   playback rather than editing, and short-lived pages.
2. **`lesson-video-assets`** — same shape, existing policy to edit.
3. **`deck-assets`** — last, because it needs URL refresh inside a live editor.

Do not do all three at once. The first flip is where the unknowns are.

---

## Per-bucket procedure

Each step is reversible on its own. Nothing below has been executed.

**Step 0 — before touching anything.**
```bash
npm run test:db -- --suite storage_isolation   # 9 properties, local Postgres
npm run test:asset-url                          # 11 properties, fake client
```
Both must pass. They prove the policies hold and the resolver refuses to fall
back to a permanent URL — not that the deployed project behaves, which is
untested.

**Step 1 — confirm the consumer list is still the consumer list.**
```bash
grep -rn "from('<bucket>')" --include='*.ts' --include='*.tsx' src scripts Agents
grep -rnE "video_url|image_url|narration_url|final_video_url" --include='*.tsx' src
```
A consumer added since this document was written is the likeliest cause of a
failed flip.

**Step 2 — turn on signed URLs while the bucket is still public.**
```
STORAGE_URL_MODE=signed
STORAGE_SIGNED_URL_TTL_SECONDS=3600
```
This is the important step and it is **fully reversible by one variable**. The
bucket is still public, so if signing is broken, playback still works through
the old URLs and nothing is lost. Watch for: a reference the resolver refuses
(it raises rather than falling back), and expiry during playback.

**Rollback:** `STORAGE_URL_MODE=public`. Immediate, no data change.

**Step 3 — flip the bucket.**
```sql
update storage.buckets set public = false where id = '<bucket>';
```
**This is the irreversible-in-effect step.** Flipping back restores access, but
any URL that leaked while the bucket was public stays valid for whoever has it,
and remains valid after the flip-back. Making a leaked URL useless requires
moving or renaming the object, which is a separate job.

**Rollback:** `update storage.buckets set public = true where id = '<bucket>';`
Restores playback within seconds. Do this first and diagnose afterwards.

**Step 4 — verify, as the teacher and as a stranger.**
- Owner can play their lesson and download their deck.
- A second account gets 403 on the first account's object URL.
- A signed-out request gets 403.
- An expired signed URL gets 403, and the page recovers by asking for a new one.

**Step 5 — only then consider the leaked-URL problem.** Rotate object names for
anything sensitive. Until that is done, "the bucket is private" means new
requests are authorised, not that old URLs stopped working.

---

## What is not solved

- **Deployed Supabase is untested.** Every property is local PostgreSQL with
  `supabase/tests/00_supabase_shim.sql` standing in for the auth and storage
  schemas. The shim's `storage.foldername` is a reimplementation; confirm the
  real one splits paths the same way before trusting a policy that depends on
  it.
- **Expiry inside a long editing session.** `deck-assets` needs a refresh path.
  Not designed.
- **Already-leaked URLs.** Unknowable in extent. Anything served publicly may
  have been fetched, cached or indexed.
- **The `<a href>` download link** in `cloud-lesson-studio.tsx:165` hands the
  URL to the browser. With a signed URL that link is valid until it expires and
  is shareable until then — shorter than forever, but not private.

## One sentence to keep

A signed-URL code path does not make public objects private. The three buckets
are public today; the mechanism, the policies and the tests exist so that the
flip is a decision rather than a rewrite.
