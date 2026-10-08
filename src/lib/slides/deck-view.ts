import { MIN_BACKDROP_DIM, themeFromStyleSpec, type PPTXTheme } from '@agents/pptx/theme-resolve';
import { SLIDE_SIZES, styleSpecSchema } from '@agents/types';

import { parseBlocks } from './blocks';
import type { RenderableSlide } from '@/components/slides/slide-canvas';
import type { Deck, Slide } from '@/lib/supabase/types';

/**
 * Turns stored rows into something the renderer can draw.
 *
 * The pipeline's own types are the source of truth for how a deck looks, so
 * this reads `decks.style_spec` back through the same Zod schema that
 * validated it on the way in. It is not paranoia: `style_spec` is `jsonb`, the
 * column predates several shapes of that spec, and a viewer that assumes the
 * current one crashes on a deck built last week.
 *
 * A deck with no usable spec still renders — in the fallback theme below —
 * because "we cannot draw your deck" is a worse answer than "here it is in
 * plain type", and a half-built deck is exactly when someone wants to look.
 */

/** A slide plus the things around the canvas rather than on it. */
export interface DeckViewSlide extends RenderableSlide {
  id: string;
  imagePrompt: string | null;
  speakerNotes: string | null;
}

export interface DeckView {
  theme: PPTXTheme;
  slideSize: { width: number; height: number };
  slides: DeckViewSlide[];
}

/**
 * What a deck looks like before its style has been extracted.
 *
 * Deliberately neutral rather than pretty: it should read as "this deck has no
 * style yet", not as a design choice somebody made.
 */
const FALLBACK_THEME: PPTXTheme = {
  fonts: {
    heading: 'Georgia',
    body: 'Arial',
    headingFallbacks: ['Times New Roman', 'serif'],
    bodyFallbacks: ['Helvetica', 'sans-serif'],
  },
  colors: {
    background: '#ffffff',
    text: '#111827',
    secondaryText: '#6b7280',
    accent: '#4f46e5',
    surface: '#f9fafb',
    border: '#e5e7eb',
  },
  sizes: { title: 40, subtitle: 24, body: 18, caption: 14 },
  spacing: { outerMargin: 0.5, sectionGap: 0.35, elementGap: 0.2, paragraphGap: 0.12 },
};

/** Backdrop dim, when the row does not carry the one the designer chose. */
const DEFAULT_DIM = 0.55;

export function toDeckView(deck: Pick<Deck, 'style_spec'>, slides: Slide[]): DeckView {
  const parsed = styleSpecSchema.safeParse(deck.style_spec);

  const theme = parsed.success ? themeFromStyleSpec(parsed.data) : FALLBACK_THEME;
  const slideSize = parsed.success
    ? { width: parsed.data.slideSize.width, height: parsed.data.slideSize.height }
    : SLIDE_SIZES['16:9'];

  return {
    theme,
    slideSize,
    slides: [...slides]
      .sort((a, b) => a.position - b.position)
      .map((slide) => ({
        id: slide.id,
        title: slide.title,
        subtitle: slide.subtitle,
        blocks: parseBlocks(slide.blocks),
        backgroundUrl: slide.background_url,
        backgroundDim: dimFrom(slide.metadata),
        imagePrompt: slide.image_prompt,
        speakerNotes: slide.speaker_notes,
      })),
  };
}

/**
 * The backdrop's dim, if the row recorded one.
 *
 * `metadata` is free-form jsonb, so this reads defensively and falls back to
 * the same default the schema uses. A scrim that is slightly wrong is a
 * cosmetic difference; a viewer that throws on an unexpected key is not.
 */
function dimFrom(metadata: unknown): number {
  if (metadata && typeof metadata === 'object' && 'backgroundDim' in metadata) {
    const value = (metadata as { backgroundDim: unknown }).backgroundDim;
    // Floored, not trusted: decks built before that floor existed have dims as
    // low as 0.25 stored against them, and they are drawn by this same
    // renderer. Fixing it here fixes them too.
    if (typeof value === 'number' && value >= 0 && value <= 1) {
      return Math.max(value, MIN_BACKDROP_DIM);
    }
  }
  return DEFAULT_DIM;
}
