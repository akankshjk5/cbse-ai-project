import { auth } from '@clerk/nextjs/server';
import {
  ArrowRight,
  Check,
  Eye,
  Images,
  Presentation,
  Ruler,
  Search,
  Sparkles,
  Wand2,
} from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DEFAULT_WORD_BUDGET } from '@agents/types';
import { STAGE_COST_USD, estimateDeckCost, formatUsd } from '@agents/cost';
import { TEMPLATE_IDS } from '@/lib/templates';

/**
 * The landing page. Public, and the only page that is.
 *
 * `/` used to be a protected gate that bounced everyone to /sign-in. That is
 * the right shape for an internal tool and the wrong one for a product: a
 * signed-out visitor arriving from a link, a search result or an ad saw a login
 * form for a product they had never heard of, which is the highest-drop-off
 * screen it is possible to ship. So `/` is public in `src/proxy.ts`, and this
 * page is what it renders.
 *
 * A signed-in visitor never sees it — they are forwarded to their decks, which
 * is what they came back for. That check is `auth()` here rather than a
 * redirect in the proxy, because the proxy runs on every request including the
 * ones that do not need to know who is asking.
 *
 * Everything claimed below is claimed from code, not from marketing copy: the
 * numbers come from `estimateDeckCost`, the template count from
 * `src/lib/templates.ts`, the word ceiling from `DEFAULT_WORD_BUDGET`. A
 * landing page that drifts from the product is worse than none, and the way it
 * drifts is by hardcoding what the product already knows.
 */

export const metadata = {
  title: 'Lumina — decks that research themselves',
  description:
    'Describe a lesson. Lumina researches it, plans it, writes it, illustrates it and hands you a PowerPoint you can edit — with a review step before the expensive half runs.',
};

/** A six-slide deck, priced from the same measured table the approval screen uses. */
const SAMPLE = estimateDeckCost(6);

const STAGES = [
  {
    icon: Search,
    title: 'Research',
    body: 'Reads your documents, and searches the live web when there are none. Every finding carries a confidence grade and a source, and what could not be established is listed as an open question rather than quietly invented.',
  },
  {
    icon: Sparkles,
    title: 'Outline',
    body: 'Turns the findings into a narrative: a slide list with a purpose, a key message and a word budget for each. This is where the deck is decided.',
  },
  {
    icon: Eye,
    title: 'You approve',
    body: 'The build stops and shows you the outline. Change it in plain language as many times as you like — a revision costs about a tenth of a cent, and it can only use facts the research actually found.',
  },
  {
    icon: Ruler,
    title: 'Design',
    body: 'You pick the composition, code computes the rectangles. Type is measured against the real font file, contrast is checked against what is actually behind it, and nothing overlaps because nothing is positioned by eye.',
  },
  {
    icon: Images,
    title: 'Illustrate',
    body: 'Every slide gets a picture, generated from one locked style block so twelve images look like one deck. Stray colours are pulled back into your palette.',
  },
  {
    icon: Presentation,
    title: 'Present',
    body: 'Download the .pptx, or present it here — full screen, remote-friendly, with per-element zoom animation you can tune by hand.',
  },
] as const;

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/app');

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            L
          </span>
          Lumina
        </span>

        <nav className="flex items-center gap-2">
          <Link
            href="/sign-in"
            className="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Get started
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pb-16 pt-14 text-center sm:pt-20">
        <p className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1 text-xs text-neutral-600 dark:border-white/15 dark:text-neutral-400">
          <Wand2 className="h-3.5 w-3.5" strokeWidth={2} />
          Research, outline, design, illustrate
        </p>

        <h1 className="mt-5 text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl">
          Decks that do their own
          <span className="text-indigo-600 dark:text-indigo-400"> homework</span>
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-lg">
          Describe a lesson. Lumina researches it, plans it, writes it to a word budget,
          designs every slide against real font metrics and illustrates it in one
          consistent style. You get a PowerPoint you can edit — not a picture of one.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/sign-up"
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
          >
            Build your first deck
            <ArrowRight className="h-4 w-4" strokeWidth={2} />
          </Link>
          <Link
            href="/sign-in"
            className="rounded-xl border border-black/10 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          >
            I have an account
          </Link>
        </div>

        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
          A six-slide deck costs about {formatUsd(SAMPLE.buildUsd)} of model time to build.
          You see that number, and the outline it is buying, before anything is spent.
        </p>
      </section>

      {/* The review gate — the thing that is actually different */}
      <section className="border-y border-black/8 bg-neutral-50 py-16 dark:border-white/10 dark:bg-neutral-900/40">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            It stops and asks you first
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-base">
            Research and planning cost about a cent. Everything after them costs twenty to
            thirty times that, almost all of it illustration. So the build pauses after the
            outline and shows it to you: the slide list, each slide&rsquo;s message, and what
            finishing it will cost. Approve it and the deck gets built. Change it and only the
            outline is rewritten, from the research that already exists — which is why asking
            for &ldquo;a slide on cost&rdquo; gets you a real figure or an honest
            &ldquo;not established&rdquo;, never an invented one.
          </p>

          <ul className="mt-6 space-y-2.5">
            {[
              // One content-planner call, which is what a revision actually is.
              `An outline revision is one model call — ${formatUsd(STAGE_COST_USD['content-planner'])}. Ask for as many as you like.`,
              `${SAMPLE.images} generated illustrations on a six-slide deck — the bulk of the bill, and never spent on a deck you have not read.`,
              'Nothing is charged for a deck you abandon at the outline.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-sm text-neutral-700 dark:text-neutral-300">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" strokeWidth={2.5} />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Pipeline */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Six specialists, in a fixed order
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Nothing runs in parallel, and that is the point: facts have to exist before a
          narrative can select from them, and the narrative before slides can be written to a
          budget. Each stage consumes the one before it.
        </p>

        <div className="mt-9 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {STAGES.map(({ icon: Icon, title, body }, position) => (
            <article
              key={title}
              className="rounded-2xl border border-black/8 p-5 dark:border-white/10"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
                  <Icon className="h-4 w-4" strokeWidth={2} />
                </span>
                <h3 className="text-sm font-semibold">
                  <span className="mr-1.5 tabular-nums text-neutral-400 dark:text-neutral-600">
                    {position + 1}
                  </span>
                  {title}
                </h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Craft details */}
      <section className="border-t border-black/8 py-16 dark:border-white/10">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: 'Your design system, two ways',
              body: `Pick one of ${TEMPLATE_IDS.length} built-in designs, or upload a screenshot of a deck you like and have its palette, type scale and visual language read off it. Either way the whole deck inherits one system.`,
            },
            {
              title: 'Text is measured, not guessed',
              body: 'The deck’s actual Google Font is downloaded and its glyphs measured, so line breaks in the preview match line breaks in the file. Type has a legibility floor, so nothing lands at a size you cannot read from the back of a room.',
            },
            {
              title: 'Slides say something',
              body: `Copy is capped at about ${DEFAULT_WORD_BUDGET} words a slide and floored too — three bare labels in three columns is measured as what it is, and sent back to be written properly.`,
            },
            {
              title: 'Every slide has a picture',
              body: 'Guaranteed in code, not hoped for in a prompt: an illustration where the layout has room, a dimmed backdrop where it does not. A deck where half the slides are illustrated reads as one that ran out of budget.',
            },
            {
              title: 'Someone looks at it',
              body: 'Before it ships, the deck is rendered to images and checked by a vision model for the things only a picture reveals — text off the edge, a title across a face, one illustration in the wrong style.',
            },
            {
              title: 'Animate and present',
              body: 'Zoom motion per element, authored by the pipeline and editable by hand, then a full-screen presentation mode that answers a clicker. The .pptx download stays a real, editable PowerPoint.',
            },
          ].map(({ title, body }) => (
            <div key={title}>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Close */}
      <section className="border-t border-black/8 px-6 py-16 text-center dark:border-white/10">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Start with one lesson
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Sign up, describe a topic, pick a design. You will have an outline to read in about
          a minute.
        </p>
        <Link
          href="/sign-up"
          className="mt-7 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
        >
          Get started
          <ArrowRight className="h-4 w-4" strokeWidth={2} />
        </Link>
      </section>

      <footer className="border-t border-black/8 px-6 py-8 text-center text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        Lumina Deck Pro
      </footer>
    </div>
  );
}
