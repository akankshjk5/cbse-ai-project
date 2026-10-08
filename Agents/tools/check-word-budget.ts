import 'server-only';

import type { SlideSpec, Tool } from '../types';

/**
 * Counts the words a viewer actually reads on a slide.
 *
 * The budget is set at planning time and written to at design time, which
 * leaves exactly one thing missing: somebody checking. Asking the designer to
 * count its own words is asking a language model to do arithmetic on its own
 * output, and it will cheerfully report 48 for a slide with 90 on it. So the
 * count happens here, in code, and the number is not negotiable.
 *
 * Speaker notes are deliberately excluded. They are where detail is supposed
 * to go when a slide is over budget — counting them would remove the escape
 * hatch and turn "move this to the notes" into "delete this".
 */

export interface CheckWordBudgetInput {
  slideSpec: SlideSpec;
  /** Words this slide may carry, from its ContentPlan entry. */
  budget: number;
}

export interface WordCount {
  role: string;
  words: number;
}

export interface CheckWordBudgetOutput {
  slideNumber: number;
  words: number;
  budget: number;
  withinBudget: boolean;
  /** Per-element counts, so an over-budget slide says WHERE the words are. */
  breakdown: WordCount[];
}

/**
 * Words in a string.
 *
 * Whitespace-separated runs containing at least one letter or digit, so
 * bullets, dashes and stray punctuation are not counted as words. Close enough
 * to what a reader would count, which is the standard that matters.
 */
export function countWords(text: string | undefined): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export const checkWordBudget: Tool<CheckWordBudgetInput, CheckWordBudgetOutput> = {
  name: 'check_word_budget',
  description:
    "Counts every word a viewer reads on a slide — title, subtitle and all element text — and reports it against the slide's word budget. Speaker notes are excluded.",

  async execute({ slideSpec, budget }) {
    const breakdown: WordCount[] = [];

    const add = (role: string, words: number) => {
      if (words > 0) breakdown.push({ role, words });
    };

    add('title', countWords(slideSpec.title));
    add('subtitle', countWords(slideSpec.subtitle));

    for (const element of slideSpec.elements) {
      // An image element's prompt is instructions to a generator, not copy.
      if (element.type === 'image') continue;

      const words =
        countWords(element.text) +
        (element.items ?? []).reduce((total, item) => total + countWords(item), 0);

      add(element.role, words);
    }

    const words = breakdown.reduce((total, entry) => total + entry.words, 0);

    return {
      slideNumber: slideSpec.slideNumber,
      words,
      budget,
      withinBudget: words <= budget,
      breakdown,
    };
  },
};
