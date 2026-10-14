# Lumina Deck Pro

An AI presentation generator. You describe a lesson; a pipeline of specialist
agents researches it, plans it, writes it, designs every slide, illustrates it
and hands back a real PowerPoint — with a review step in the middle so nobody
pays for a deck they have not read.

This file is **how to get it running**. For how it works and why — the agent
pipeline, the layout engine, the auth boundary — read [CLAUDE.md](CLAUDE.md).

- **Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4
- **Auth:** Clerk · **Data:** Supabase (Postgres + Storage) · **Models:** OpenRouter

---

## 1. What you need before you start

### Accounts

| Service | What it does here | Required? | Cost |
|---|---|---|---|
| [OpenRouter](https://openrouter.ai) | **Every** model call — text, vision, image generation, and the researcher's web search | **Yes** | Pay-as-you-go. Needs credit on the account. A six-slide deck is roughly **$0.25**, ~90% of it illustration |
| [Clerk](https://clerk.com) | Sign-in and sign-up, and the identity Supabase's row-level security trusts | **Yes** | Free tier is enough to develop on |
| [Supabase](https://supabase.com) | Postgres, storage buckets, realtime build progress | **Yes** | Free tier is enough to develop on |
| [Vercel](https://vercel.com) | Hosting, if you deploy | No | Free tier is enough to start |
| [Google AI Studio](https://aistudio.google.com) | `GENAI_API_KEY`, for the RAG corpus | **Not yet** | Free tier. The `documents` tables and the 1536-dim vector column exist, but **nothing embeds anything today** — skip it until that path is wired |

### Tools

| Tool | Why | Check |
|---|---|---|
| Node.js 20+ | Runs the app (built on Node 24) | `node -v` |
| npm | Ships with Node | `npm -v` |
| [Supabase CLI](https://supabase.com/docs/guides/local-development) | Applies migrations, generates types | `supabase --version` |
| Docker Desktop | Only if you run Postgres locally instead of against a hosted project | `docker --version` |
| [Clerk CLI](https://clerk.com/docs/cli/overview) | Optional, but `clerk doctor` and local webhook testing are worth it | `clerk --version` |

On Windows, run the commands below in **Git Bash** or **PowerShell** — both work.

---

## 2. Clone and install

```bash
git clone https://github.com/gauravbshet/lumina-deck-pro.git
cd lumina-deck-pro
npm install
cp .env.example .env
```

**`.env`, not `.env.local`.** The smoke-test scripts run outside Next, through
`tsx --env-file=.env`, and read nothing Next would have loaded for them.

Keep `.env` open as you work through the next steps — each one fills in part of it.

---

## 3. OpenRouter — the model key

Every model call in the pipeline goes through one provider, so this is one key
and one bill.

1. Sign up at [openrouter.ai](https://openrouter.ai).
2. **Add credit.** Settings → Credits. Without a balance every build fails on
   its first call. Start with $5 — about twenty decks.
3. Create a key: [openrouter.ai/keys](https://openrouter.ai/keys) → **Create Key**.
4. Put it in `.env`:

```ini
OPENROUTER_API_KEY=sk-or-v1-...
```

You do **not** need a separate search API key. The researcher's live web search
is billed through the same OpenRouter call.

> **Want to try it without spending much?** Set `OPENROUTER_IMAGE_TIER=off` in
> `.env`. That skips illustration, which is ~90% of a deck's cost, and brings a
> six-slide deck down to about 1.5 cents. The decks are plainer, and everything
> else in the pipeline still runs.

---

## 4. Clerk — authentication

1. Sign up at [clerk.com](https://clerk.com) and create an application.
   Enable whichever sign-in methods you want (email + Google is a fine start).
2. In the dashboard, open **Configure → API keys** and copy both keys into `.env`:

```ini
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

3. Note your **instance domain** — it looks like
   `something-something-1234.clerk.accounts.dev` and appears on the same page.
   You need it twice in step 6, so record it now:

```ini
CLERK_INSTANCE_DOMAIN=your-instance.clerk.accounts.dev
```

4. The routing variables are already filled in by `.env.example` and should be
   left alone unless you move the sign-in pages. They point Clerk at this app's
   own `/sign-in` and `/sign-up` routes instead of Clerk's hosted pages:

```ini
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/app
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/app
```

> `CLERK_SECRET_KEY` is a secret. Never prefix it with `NEXT_PUBLIC_`, and never
> import it into a Client Component.

---

## 5. Supabase — database and storage

1. Sign up at [supabase.com](https://supabase.com) and create a project. Pick a
   region near you and **save the database password** — you need it in step 7.
2. Open **Project Settings → API keys** and copy into `.env`:

```ini
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

The service-role key **bypasses row-level security entirely**. It belongs on the
server only — it is used by the build worker, which has no user session of its
own — and must never reach the browser.

You do not need to create any storage buckets by hand. The migrations in step 7
create `deck-assets`, `deck-uploads` and `deck-exports` with their size limits,
MIME types and access policies.

---

## 6. Connect Clerk to Supabase

**This is the step everything else depends on.** Supabase has to be told to
trust Clerk's session tokens, or every authenticated query fails with a
permission error that looks like a bug in the app.

Follow Clerk's own guide — [clerk.com/setup/supabase](https://clerk.com/setup/supabase) —
which comes down to two settings that must name the **same domain**:

1. **In the Supabase dashboard:** Authentication → Third Party Auth → **Add
   provider → Clerk**, and enter your Clerk instance domain from step 4.
2. **In this repo,** if you run Postgres locally: open `supabase/config.toml`
   and set the same domain:

```toml
[auth.third_party.clerk]
enabled = true
domain = "your-instance.clerk.accounts.dev"
```

Why it matters, in one line: a Clerk user id is text like `user_2abc…`, not a
uuid, so `auth.uid()` cannot be used — every policy in this schema calls
`public.clerk_user_id()`, which reads the `sub` claim out of the token Postgres
just verified.

---

## 7. Apply the database schema

Choose one. **Hosted** is the shorter path and matches production; **local**
gives you a throwaway database and needs Docker running.

### Option A — hosted project

```bash
npm run db:link      # asks for your project ref and database password
npm run db:push      # applies every migration in supabase/migrations
npm run db:types     # regenerates src/lib/supabase/database.types.ts
```

### Option B — local stack (Docker)

```bash
npm run db:start     # starts Postgres, Storage and Studio in Docker
npm run db:reset     # applies every migration, then seed.sql
```

`db:start` prints a local API URL and keys — use those in `.env` instead of the
hosted ones while you work locally.

> **Rule for later:** never edit a migration that has already been applied
> anywhere, and never change the schema through the dashboard SQL editor. Write
> a new migration (`npm run db:diff -- <name>`), apply it, re-run
> `npm run db:types`, and commit the regenerated types with it.

---

## 8. Clerk webhook — account lifecycle

Without this the app still runs, but **deleting an account leaves its data
behind**: once a Clerk user is gone there is no session left to delete their
decks with, and their research, slides and generated art sit in Postgres and
three storage buckets indefinitely.

1. In the Clerk dashboard: **Configure → Webhooks → Add Endpoint**.
2. URL: `https://your-domain.com/api/webhooks/clerk`
3. Subscribe to exactly two events: **`user.created`** and **`user.deleted`**.
4. Copy the endpoint's **Signing Secret** into `.env`:

```ini
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
```

To test it against your machine, tunnel it with the Clerk CLI and add the
printed relay URL as the endpoint instead:

```bash
clerk webhooks listen --token "$(clerk webhooks token)" \
  --forward-to http://localhost:3000/api/webhooks/clerk
```

---

## 9. Run it

```bash
npm run dev
```

Open <http://localhost:3000>. You are sent straight to the **sign-in** page
(there is no landing page). Choose sign up, and Clerk drops you at `/app`,
your (empty) deck list. A signed-in visitor to `/` goes straight to `/app`.

Before you trust anything, run the checks:

```bash
npm run typecheck
npm run lint
npm run build
npm run smoke      # skills, layout arithmetic, a real .pptx build + validation
clerk doctor       # confirms the Clerk side of the setup above
```

`npm run smoke` makes **no model calls** and costs nothing.

---

## 10. Build your first deck

1. Click **Create PPTX**.
2. Fill in the topic, subject, board and class.
3. **Pick a template or upload a reference image.** One or the other is
   required — a deck needs a design system before a slide can be written, and
   there is no fallback aesthetic. A reference image can be a screenshot of any
   deck whose look you want; its palette, type scale and visual language are
   read off it.
4. Submit. The card appears immediately and follows the build live.
5. **The build stops for you.** In about a minute the deck reaches
   *awaiting review*: open it and you get the outline, what each slide will say,
   and what finishing it will cost. Chat to change it — a revision is one model
   call, and it can only use facts the research actually found.
6. **Approve.** The expensive half runs (a few minutes), and you get slides, a
   `.pptx` download, per-element zoom animation you can edit, and a full-screen
   **Present** mode.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every query fails with a permission error | Supabase does not trust Clerk yet | Redo step 6 — the domain must match in both places |
| `Missing environment variable X` | That variable has no default | Add it to `.env`; the message names it |
| Build fails on its first model call | No OpenRouter credit, or a retired model slug | Top up; or override the stage with `OPENROUTER_MODEL_<SKILL>` |
| Webhook returns 400 | Signing secret missing or wrong | Re-copy `CLERK_WEBHOOK_SIGNING_SECRET` from that exact endpoint |
| A route 404s once in `next dev` | The proxy recompiled | It is a compile-window artifact; confirm with `npm run build && npm start` |
| "You already have 2 decks building" | Per-account limit, working as intended | Wait for one to finish (`src/lib/limits.ts`) |

---

## Costs and the switches that control them

A six-slide deck is roughly **$0.25**, and about 90% of that is illustration.
Everything is set in `.env`:

| Variable | Default | Effect |
|---|---|---|
| `OPENROUTER_IMAGE_TIER` | `on` | `off` skips illustration — the real cost switch, ~$0.25 → ~$0.015 |
| `OPENROUTER_VISUAL_REVIEW` | `on` | `off` skips the render-and-look-at-it QA pass (~$0.003) |
| `OPENROUTER_SEARCH_TIER` | `on` | `off` forbids live web search; research falls back to `Documents/` and model knowledge |
| `OPENROUTER_REASONING_EFFORT` | `medium` | `minimal` is cheaper and produces worse decks with an empty trace |

Per-account limits — two concurrent builds, 25 a day, 200 decks — live in
`src/lib/limits.ts` and are enforced at `startJob`, the one chokepoint every
build passes through.

---

## Scripts

| Command | What it does | Costs money? |
|---|---|---|
| `npm run dev` | Development server | — |
| `npm run build` / `npm start` | Production build and serve | — |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint | — |
| `npm run smoke` | Skills, layout arithmetic, real .pptx build + validation | No |
| `npm run smoke:render` | Builds a deck offline and writes the .pptx *and* the browser preview to compare by eye | No |
| `npm run smoke:research` | Live researcher, word budgets, locked style block | A few cents |
| `npm run smoke:deck` | The whole pipeline end to end, printing per-stage cost | ~$0.25 |
| `npm run db:*` | `start`, `reset`, `link`, `push`, `types`, `diff`, `lint` | — |

---

## Deploying to Vercel

1. Import the repository at [vercel.com/new](https://vercel.com/new).
2. Add **every** variable from your `.env` under Project Settings → Environment
   Variables. `vercel env pull` then keeps your local copy in sync.
3. Set `NEXT_PUBLIC_SITE_URL` to the deployed URL.
4. Point the Clerk webhook endpoint (step 8) at
   `https://your-domain.com/api/webhooks/clerk` and copy that endpoint's signing
   secret into Vercel too — it is a different secret from your local one.
5. Use Clerk **production** keys for a production deployment, and add the
   production instance domain to Supabase's Third Party Auth list as well.

One caveat worth knowing before real traffic: a deck build runs inside the web
request's process via `after()`, not in a job queue, so it is bounded by the
function timeout and does not survive a deploy mid-build. The per-account limits
keep that safe at small scale; past that, the job row already models a queue and
what is missing is a worker. See the generation-flow section of
[CLAUDE.md](CLAUDE.md).

---

## Cloud lesson preparation worker (Step 4)

This worker prepares the separate `cloud_lesson_*` engine. It calls Gemini for
the English lesson, factual review, visual directions, Hindi/Kannada translation,
and scene-aligned narration. It uses no RunPod service and generates no images
or video itself. Successful preparation queues the image jobs for the next stage.

Prerequisites: dependencies installed, the cloud lesson migration applied, and
server-side `.env` configuration:

- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the worker.
- `CLOUD_LESSON_GEMINI_BACKEND=aistudio` with `GEMINI_API_KEY`, or
  `CLOUD_LESSON_GEMINI_BACKEND=vertex` with `GOOGLE_VERTEX_API_KEY`.
- Optional `CLOUD_LESSON_TTS_MODEL`, `CLOUD_LESSON_TTS_VOICE`,
  `CLOUD_LESSON_GEMINI_CONCURRENCY`, and per-skill model overrides from
  `.env.example`. Verify model access and billing on the chosen Google project.

From the repository root:

```powershell
npm run test:cloud-prepare
npm run worker:cloud-prepare
# Process at most one queued preparation job and exit:
npm run worker:cloud-prepare -- --once
```

The worker validates all cloud skill files before claiming jobs. Heartbeats run
every 15 seconds; cancellation or lost ownership stops further provider calls and
completion writes. Ctrl+C leaves unfinished work for database lease recovery.
Each narration upload has a unique filename beneath the project id, so an expired
worker cannot overwrite another worker's audio. The completion RPC atomically
saves the eight scenes and releases scene 1's image job.

For a **live, billable** preparation smoke test (local output only, no database
jobs or Higgsfield requests):

```powershell
npm run smoke:cloud-prepare -- --confirm-spend --class 6 --subject Science --topic "Water cycle" --language en-IN
```

Use `hi-IN` or `kn-IN` to check translation and pronunciation. Output goes into
`generated/cloud-prepare/<run>/lesson.json` and `narration.wav`. Without
`--confirm-spend`, the smoke prints instructions and makes no API calls. Listen
to each scene and review the facts before displaying the lesson to students.
Job metadata records the reference, warnings, per-scene speech timing, and known
Gemini cost with an unpriced-call count. Retry attempts can repeat paid planning
or speech calls; the current worker does not cache preparation between attempts.

## Where to read next

- **[CLAUDE.md](CLAUDE.md)** — the architecture, and the rules that are
  expensive to get wrong. Read it before changing code.
- `Agents/` — the pipeline. `Agents/Skills/*.md` are the specialists themselves:
  a prompt and a `model:` line each.
- `supabase/migrations/` — the schema, and the only place it is defined.


### Cloud lesson Step 5: scene images

Run the image worker alongside the preparation worker (CPU only):

```bash
npm run worker:cloud-image
# Process at most one queued image, then exit:
npm run worker:cloud-image -- --once
# Offline lifecycle and image validation checks:
npm run test:cloud-image
```

This worker uses the same Gemini backend/key and Supabase service-role setup as
Step 4. `CLOUD_LESSON_IMAGE_MODEL` defaults to `gemini-nano-banana-2.1`.
It requests 2K, 16:9 images, decodes and strips metadata with Sharp, and saves
2560x1440 PNGs. Undersized responses fail rather than being upscaled.
Scene 1 runs first; the completion RPC releases scenes 2–8 with its image as
their photographic style reference. Reference downloads are limited to this
Supabase project's public cloud-lesson-assets bucket and the current lesson's
media directory; redirects and oversized downloads are refused.

Each claim generates one image and runs the keyframe-checker skill. Rejected
images retry through the existing queue (three attempts, two-second delay).
Unsafe images or images containing writing are never accepted. On the final
attempt, a safe image without writing may be accepted with a warning if the
checker reports subject/style mismatch. All Gemini calls are metered. Heartbeats
continue during generation; cancellation or lost ownership prevents further
calls and completion. Unique non-overwriting upload paths protect replacement
workers. Uploads interrupted before completion can leave unused storage objects.

Successful image completion queues Step 6 video jobs automatically. Step 5 does
not call Higgsfield; animation and final video assembly require Step 6.
Running this worker makes billable Gemini calls; the tests use fake responses
and do not spend money or write to Supabase. Live image quality has not yet been
verified. Retried preparation/image jobs may repeat provider work; they do not
have provider-side idempotency or resume checkpoints.


### Cloud lesson Step 6: animation and final video

The separate `worker:cloud-media` process claims only cloud `video` and
`assemble` jobs. Existing RunPod workers, queues and compositor files are
unchanged. Up to six scenes get five-second native 1080p Kling 2.5 Turbo Pro
clips through Higgsfield; still scenes use CPU pan/zoom. Each scene is composed
at 1920x1080, 24 fps, for exactly 7.5 seconds, with captions and deterministic
teaching overlays. Animated scenes hold the final frame for the remainder of
the slot. Eight clips are joined with cuts at the narration boundaries; the
prepared narration is mixed into a 60-second H.264/AAC MP4. Raw provider clips
are uploaded separately and their URLs retained in video-job metadata.

On a CPU Ubuntu host, install Node plus Python, FFmpeg and Pillow with libraqm:

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv ffmpeg libraqm0 fonts-dejavu-core
python3 -m venv .venv-cloud
.venv-cloud/bin/pip install -r ops/cloud/requirements.txt
```

Set `CLOUD_LESSON_PYTHON` to the absolute `.venv-cloud/bin/python` path. Put the
following open-source font files into `ops/cloud/fonts` (or set
`CLOUD_LESSON_FONTS_DIR`): `Kalam-Bold.ttf`, `NotoSansDevanagari.ttf`,
`NotoSansKannada.ttf`, and `DejaVuSans-Bold.ttf`. Kalam is available from
[Google Fonts](https://github.com/google/fonts/tree/main/ofl/kalam); the Noto
files are available from [Noto Devanagari](https://github.com/notofonts/devanagari)
and [Noto Kannada](https://github.com/notofonts/kannada). Copy the system's
DejaVu bold font into that directory. Font files are deployment assets, not
bundled in this repository. Hindi/Kannada require Pillow's RAQM shaping support;
preflight refuses to claim jobs without it or without any required fonts.

On Windows, use `.venv-cloud\Scripts\python.exe` for `CLOUD_LESSON_PYTHON`,
install `ops/cloud/requirements.txt`, and configure the absolute FFmpeg/FFprobe
paths in `.env`. Pillow's Windows wheel also requires a separate FriBiDi DLL.
For 64-bit Python, download the
[MSYS2 FriBiDi 1.0.17 package](https://mirror.msys2.org/mingw/mingw64/mingw-w64-x86_64-fribidi-1.0.17-1-any.pkg.tar.zst),
verify SHA256 `707f6a2f9a49c83938271bfd92a11f80bd4c18c4837210173fcb39e9d841e5ac`,
and extract `mingw64/bin/libfribidi-0.dll` into `.venv-cloud/Scripts`.
Keep the package's `mingw64/share/licenses/fribidi/COPYING` when distributing
the DLL. The compositor loads this virtual-environment-local DLL before Pillow
initializes, enabling RAQM without modifying Windows system directories or PATH.
All four font files above are still required. Run `worker:cloud-media -- --preflight`
to verify the complete configuration before starting a worker.

Set `HF_CREDENTIALS=KEY_ID:KEY_SECRET` in `.env`. Alternatives are `HF_KEY` or
`HF_API_KEY_ID` plus `HF_API_KEY_SECRET`. The existing `HIGGSFIELD` variable is
also accepted when it contains `KEY_ID:KEY_SECRET`. Use API credentials from the Higgsfield
console, not the website subscription. Service-role Supabase configuration is
the same as Steps 4/5. Do not expose these credentials to the browser.

```bash
npm run worker:cloud-media -- --preflight  # Local dependencies only; no paid calls
npm run test:cloud-media                 # Offline lifecycle/provider tests
npm run worker:cloud-media               # Claim cloud video and assembly jobs
npm run worker:cloud-media -- --once     # At most one job
npm run worker:cloud-media -- --assemble-only # Does not require Higgsfield credentials
```

Provider submissions use the fixed model
`kling-video/v2.5-turbo/pro/image-to-video`, five seconds and cfg_scale 0.5.
The job UUID supplies a stable `Idempotency-Key`, so ambiguous submissions and
lease recovery replay the same generation intent. The provider request UUID
is saved through the heartbeat RPC before polling, and existing IDs are resumed.
Documented terminal failures are retained rather than silently submitting a
new paid generation. Transient requests have bounded retries/backoff and polling
has a twenty-minute deadline per claim. The account's real API availability
and charges still need verification with a paid sample.

Cancellation prevents further downloads, rendering and completion. A queued
Higgsfield request is cancelled on a best-effort basis; Higgsfield cannot cancel
requests that have already started. Those may still incur a charge. Lease loss
never cancels the shared provider request or writes to the replacement job.
Provider costs stored in the queue are **estimates**, using
`CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND` (default 0.035, promotional price checked
2026-10-10), and are labelled accordingly in metadata. Invoices are authoritative;
unobserved completion after cancellation/crash may not be reflected in the total.

Downloads are bounded and restricted to the current lesson's Supabase assets
or allowlisted provider CDN domains, with redirects refused. If Higgsfield
returns another CDN, add its exact verified domain to
`CLOUD_LESSON_PROVIDER_MEDIA_HOSTS`; the default is
`higgsfield.ai,higgs.ai,cloudfront.net`. Uploads use unique non-overwriting names.
Incomplete uploads can leave orphan objects; successful raw clips are retained
for later visual reuse. This worker requires a persistent CPU process, rather
than a short-lived web request. Windows users need FFmpeg/FFprobe and a Python
build with RAQM; Ubuntu is the recommended deployment environment.


### Cloud lesson Step 7: Lesson Video page, cache and language reuse

Open `/app/cloud-lessons` or choose **Lesson Video** in the sidebar. Select
class, subject, English/Hindi/Kannada and a topic. Lessons are always eight
7.5-second scenes, with narration and a final 1080p video. The separate page
shows stage counts, progress, recorded costs, cancellation and playback.
The existing Videos page and RunPod queue remain unchanged.

Apply `20261011090000_cloud_lesson_reuse.sql` and regenerate database types
when setting up another database. The migration retains the original reservation
and completion checks as private helpers. The public reservation RPC atomically
returns exact completed or active matches before creating new work, using the
existing owner lock and generation limits. Caches only use the signed-in owner's
lessons. Cancellation does not refund already incurred provider charges.

Exact completed matches can be opened with no new generation charge. For a
matching lesson in another language, the worker reuses the audited English
source plan, eight keyframes and stored raw animations. It only regenerates
translation, speech, captions and CPU composition. Sources need the canonical
`sourcePlan` metadata introduced in Step 7; older lessons without it generate
fresh visuals. Original source URLs remain referenced; do not delete source
assets while language variants depend on them.

Start the app and each worker in its own terminal from the project directory:

```powershell
npm run dev
npm run worker:cloud-prepare
npm run worker:cloud-image
npm run worker:cloud-media
```

Restart already-running workers after updating code. The page queues work;
it does not start workers. Preparation needs Gemini credentials, the image
worker needs an image-capable Gemini model, and the media worker needs the
Windows/Ubuntu dependencies documented above plus Higgsfield credentials.
No RunPod services are required for this page. Run preflight before starting
media work. The first genuinely new submission triggers paid provider calls.

APIs: `GET/POST /api/cloud-lessons`, `GET/DELETE /api/cloud-lessons/[id]`,
and `GET /api/cloud-lessons/cache?classLevel=6&subject=Science&topic=Water+cycle&languageCode=en-IN`.
Each uses Clerk authentication and owner-scoped Supabase reads/RPCs; provider
keys, request IDs and worker identities are never returned to the browser.
Progress refreshes every five seconds and survives reloads through the stored
queue and selected lesson URL. Animation allowances and recorded animation costs
are estimates; invoices are authoritative, and Gemini costs are additional.

Validation: `npm run test:cloud-ui`, all other `test:cloud-*` scripts,
`npm run typecheck`, `npm run lint`, and `npm run build`. For rollback-only
Postgres ownership/cache/reuse tests, run `supabase db query --linked --file
scripts/test-cloud-cache.sql`. Its fixtures remain uncommitted and invisible
to workers, then are rolled back, so it cannot trigger generation.


### Cloud lesson duration and presentation

Lesson Video now offers 30 seconds (four scenes) or 60 seconds (eight scenes).
Every scene retains its 7.5-second narration slot. Scripts are written for the
selected length; a short lesson explains one focused idea and ends with a recap.

The default **2D illustrated explainer** uses bold outlines, a shared teal/coral/
amber palette, a clean pale-blue frame, timed caption reveals, animated teaching
overlays, gentle camera motion and short fades. Higgsfield animates at most two
scenes for 30 seconds or three for 60 seconds. **Editorial photographs** preserves
the original warm-paper look and permits up to four/six provider animations.
Static illustrations use camera motion and overlays; the compositor does not
independently animate arbitrary objects inside a generated image.

Apply `20261011120000_cloud_lesson_duration_style.sql` after the cloud reuse
migration, then regenerate database types. Existing projects keep the editorial
style. Cache lookup and visual reuse are scoped to the same owner, duration and
style; only language may differ for visual reuse. Restart the web app and all
three cloud workers after upgrading so existing processes reload the new code
and prompts. No new provider keys or GPU dependencies are needed.

Offline checks: `npm run test:cloud-prepare`, `npm run test:cloud-media`, and
`npm run test:cloud-ui`. Database checks in `scripts/test-cloud-duration.sql`
use fixtures inside a rolled-back transaction, so workers cannot claim them.
`ops/cloud/test_compositor.py` with the FFmpeg, FFprobe and fonts arguments also
renders synthetic 30- and 60-second 1080p videos with audio, without model calls.


### Cloud lesson Storybook style

**Storybook** is a third Lesson Video style, built for history and story topics:
black-and-white pen-and-ink engravings on sepia paper, two pictures a scene with
slow camera moves and dissolves between them, a ribbon chapter title on every
scene, a storyteller voice and an optional quiet music bed. It is part of the
cloud engine only. The illustrated and editorial styles, the RunPod lesson
engine and the deck generator are unchanged; Storybook has its own skill files,
compositor module (`ops/cloud/storybook.py`) and shot table.

How a Storybook lesson is made:

1. **Plan.** The writer and auditor run as for every style; then
   `cloud-lesson-storybook-director` gives each scene a 2–4 word chapter title
   and exactly two shots (a shot size, a camera move and a picture). Chapter
   titles are translated with the captions. At most one scene of a 30-second
   lesson (two of 60 seconds) is animated.
2. **Pictures.** The image worker draws shot 1 of scene 1 first. Every other
   shot is then drawn with that picture as its style reference, so the lesson
   looks like one engraver drew it. `cloud-lesson-storybook-checker` refuses
   pictures with lettering or unsafe content and asks for a redraw of a wrong
   or off-style one. Pictures are 2K; 1K loses the fine hatching.
3. **Scenes.** The media worker sends shot 1 of an animated scene to Higgsfield,
   then composes each scene from both shots: 8 seconds (a 7.5-second slot plus a
   half-second tail for the dissolve), sepia grade, paper texture, banner and
   caption.
4. **Final video.** Scenes are joined with half-second dissolves on the
   narration boundaries and trimmed to exactly 30 or 60 seconds, with the
   narration and, when configured, one music track ducked under it.

**Setup.** Apply `20261011150000_cloud_lesson_storybook.sql` and
`20261011170000_cloud_lesson_storybook_cheaper.sql` after the earlier cloud
migrations (`npx supabase db push --dry-run` lists what is pending, then
`npm run db:push`), run `npm run db:types`, and restart the web app and all
three cloud workers so they load the new skills. No new keys are needed.

- **Fonts:** the same four files as Step 6. Hindi and Kannada titles use the
  Noto fonts. For English titles you may add a display face of your choice as
  `ops/cloud/fonts/StorybookTitle.ttf` (an OFL serif such as IM Fell or Cinzel
  suits the look); without it the banner uses Kalam.
- **Music (optional):** set `CLOUD_LESSON_MUSIC_DIR` to a folder of `.wav` or
  `.m4a` tracks **you have the rights to use**. Each lesson gets one track,
  picked from the lesson id (a retry gets the same one), faded in and out and
  ducked under the voice. Unset, or an empty folder, means narration only.
  `npm run worker:cloud-media -- --preflight` refuses a setting that is not a
  folder. Only Storybook lessons get music.

**Cost and time.** Measured with live calls in October 2026: plan about
$0.035, voice $0.006 per 30 seconds, each 2K picture with its check about
$0.061. A 30-second lesson draws 8 pictures and animates 1 scene, about $0.70;
60 seconds draws 16 and animates 2, about $1.40. The animation part comes from
`CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND`, so set it to your account's real
Kling 2.5 Turbo Pro rate; redraws and retries add to the total. The form shows
this estimate before a teacher starts. On a CPU host, scene composition takes
about 16–24 seconds a scene and assembly about a minute; with picture and
animation queues, a 30-second lesson is usually ready in 6–10 minutes.

**Checks.**

```bash
npm run test:cloud-storybook        # director, checker, preparation and image paths; offline
npm run test:cloud-media            # includes storybook scenes, reuse and music; offline
npm run test:cloud-ui               # style option, picture progress, estimates, report; offline
.venv-cloud/bin/python ops/cloud/test_storybook.py \
  --ffmpeg ffmpeg --ffprobe ffprobe --fonts ops/cloud/fonts   # real 30-second encode, no APIs
supabase db query --linked --file scripts/test-cloud-storybook.sql   # rolled back, cannot trigger work
npm run smoke:cloud-storybook -- --confirm-spend   # LIVE: one plan, voice, 3 pictures, about $0.25
```

**First live lesson.** With the migrations applied and the three workers
running, open `/app/cloud-lessons`, choose Storybook, 30 seconds, and a story
topic (for example Class 7 History, "Shivaji Maharaj's escape from Agra").
When it finishes, read its real cost and time from the queue:

```bash
npm run report:cloud-lesson -- --latest --style storybook
npm run report:cloud-lesson -- <lesson-id>
```

The report is read-only. It lists each stage's jobs, retries, recorded cost
and time, the total against the form's estimate, and how many scenes Higgsfield
animated. The Higgsfield figure is an estimate until it is compared with the
API invoice; update `CLOUD_LESSON_HIGGSFIELD_USD_PER_SECOND` if they differ.
