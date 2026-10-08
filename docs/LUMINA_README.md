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

Open <http://localhost:3000>. You should land on the **landing page** — it is
the only public route besides sign-in, sign-up and the webhook. Sign up, and
Clerk drops you at `/app`, your (empty) deck list.

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

## Where to read next

- **[CLAUDE.md](CLAUDE.md)** — the architecture, and the rules that are
  expensive to get wrong. Read it before changing code.
- `Agents/` — the pipeline. `Agents/Skills/*.md` are the specialists themselves:
  a prompt and a `model:` line each.
- `supabase/migrations/` — the schema, and the only place it is defined.
