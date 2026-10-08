import 'server-only';

import { isWithinSlide } from '../pptx/positioning';
import { estimateLines } from '../pptx/theme';
import { themeFromStyleSpec } from '../pptx/theme-resolve';
import type { SlideSpec, StyleSpec, Tool } from '../types';

/**
 * Catches layout faults before the deck is built.
 *
 * Two things code can check that a model cannot reliably eyeball: whether a
 * box leaves the slide, and whether two boxes overlap. Text height is
 * *estimated* — we do not have a font metrics engine here — so it is reported
 * as an estimate and used to flag likely overflow, not to assert it.
 */

export interface CheckOverflowInput {
  slideSpec: SlideSpec;
  styleSpec: StyleSpec;
}

export interface OverflowIssue {
  role: string;
  kind: 'out-of-bounds' | 'overlap' | 'text-overflow';
  detail: string;
  /** For `text-overflow`: the height the text is estimated to need, in inches. */
  neededHeight?: number;
}

export interface CheckOverflowOutput {
  slideNumber: number;
  fits: boolean;
  issues: OverflowIssue[];
}

function overlaps(a: SlideSpec['elements'][number], b: SlideSpec['elements'][number]): boolean {
  return (
    a.box.x < b.box.x + b.box.w &&
    b.box.x < a.box.x + a.box.w &&
    a.box.y < b.box.y + b.box.h &&
    b.box.y < a.box.y + a.box.h
  );
}

export const checkOverflow: Tool<CheckOverflowInput, CheckOverflowOutput> = {
  name: 'check_overflow',
  description:
    'Checks a slide for out-of-bounds elements, overlapping elements, and likely text overflow.',

  async execute({ slideSpec, styleSpec }) {
    const theme = themeFromStyleSpec(styleSpec);
    const issues: OverflowIssue[] = [];

    for (const element of slideSpec.elements) {
      if (!isWithinSlide(styleSpec, element.box)) {
        issues.push({
          role: element.role,
          kind: 'out-of-bounds',
          detail: `Element extends past the slide edge at ${JSON.stringify(element.box)}`,
        });
      }

      const text = element.text ?? element.items?.join(' ') ?? '';
      if (text) {
        const fontSize =
          element.role === 'title'
            ? theme.sizes.title
            : element.role === 'subtitle'
              ? theme.sizes.subtitle
              : theme.sizes.body;

        const lines = estimateLines(text, element.box.w, fontSize);
        const neededHeight = (lines * fontSize * 1.2) / 72;

        if (neededHeight > element.box.h) {
          issues.push({
            role: element.role,
            kind: 'text-overflow',
            detail: `Text likely needs ~${neededHeight.toFixed(2)}in but the box is ${element.box.h.toFixed(2)}in`,
            neededHeight,
          });
        }
      }
    }

    // Cards/shapes are containers by design, so overlap between them and their
    // own text is expected; only flag text-on-text collisions.
    const textElements = slideSpec.elements.filter((e) => e.type === 'text');
    for (let i = 0; i < textElements.length; i++) {
      for (let j = i + 1; j < textElements.length; j++) {
        if (overlaps(textElements[i], textElements[j])) {
          issues.push({
            role: `${textElements[i].role}/${textElements[j].role}`,
            kind: 'overlap',
            detail: 'Two text elements occupy the same area',
          });
        }
      }
    }

    return { slideNumber: slideSpec.slideNumber, fits: issues.length === 0, issues };
  },
};
