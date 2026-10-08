import 'server-only';

import PptxGenJS from 'pptxgenjs';

import { AgentError, type SlideElement, type SlideSpec, type StyleSpec } from '../types';
import { placementFor, shrinkToFit } from './theme';
import {
  TEXT_SCRIM_OPACITY,
  readableOn,
  stripHash,
  themeFromStyleSpec,
  type PPTXTheme,
} from './theme-resolve';
import { contains, isWithinSlide, overlaps } from './positioning';

/**
 * Turns SlideSpec[] into a .pptx.
 *
 * This layer is deterministic on purpose: no model calls, no content
 * decisions. It reads the spec and the theme and emits PowerPoint objects, so
 * its behaviour is testable without an LLM in the loop.
 */

/** Theme size for an element's semantic role. */
function sizeForRole(theme: PPTXTheme, role: string): number {
  switch (role) {
    case 'title':
      return theme.sizes.title;
    case 'subtitle':
      return theme.sizes.subtitle;
    case 'caption':
    case 'label':
      return theme.sizes.caption;
    default:
      return theme.sizes.body;
  }
}

function fontForRole(theme: PPTXTheme, role: string): string {
  return role === 'title' || role === 'subtitle' ? theme.fonts.heading : theme.fonts.body;
}

function colorForRole(theme: PPTXTheme, role: string): string {
  if (role === 'caption' || role === 'label') return theme.colors.secondaryText;
  if (role === 'accent') return theme.colors.accent;
  return theme.colors.text;
}

/**
 * The colour actually behind an element.
 *
 * Not always the slide background: a text element dropped inside a card sits on
 * the surface colour, and one over a generated backdrop sits on whatever the
 * scrim leaves. Getting this wrong is how a secondary-grey caption ends up
 * invisible on a grey card — the builder draws it, the validator passes it,
 * and it ships.
 *
 * A backdrop resolves to the deck's background colour because that is what the
 * scrim blends the image toward; the darker the deck wants its text, the more
 * scrim there is. It is an approximation, but it is the one the slide is
 * designed around.
 */
function surfaceUnder(element: SlideElement, slide: SlideSpec, theme: PPTXTheme): string {
  if (slide.background?.imagePath) return theme.colors.background;

  // Text over a picture gets a scrim of the background colour (see `addScrim`),
  // which is precisely so that this question has an answer.
  if (overText(element, slide)) return theme.colors.background;

  const container = slide.elements.find(
    (other) =>
      other !== element &&
      (other.type === 'card' || other.type === 'shape') &&
      contains(other.box, element.box),
  );

  return container ? (container.fill ?? theme.colors.surface) : theme.colors.background;
}

/** An element's words as one string, for measuring. */
function plainText(element: SlideElement): string {
  return element.items?.length ? element.items.join(' ') : (element.text ?? '');
}

/**
 * A card's content, as PptxGenJS text.
 *
 * `items` becomes bullets and `text` a paragraph, exactly as for a standalone
 * text element — a card is a container, and what goes in it is ordinary copy.
 */
function cardLabel(element: SlideElement): string | { text: string; options: { bullet: boolean } }[] | null {
  if (element.items?.length) {
    // A single item is a label, not a list; a bullet on its own looks like a
    // mistake in a box that already sets the content apart.
    if (element.items.length === 1) return element.items[0];
    return element.items.map((text) => ({ text, options: { bullet: true } }));
  }

  return element.text ?? null;
}

/** True when this element sits on top of a picture rather than on the slide. */
function overText(element: SlideElement, slide: SlideSpec): boolean {
  return slide.elements.some(
    (other) => other !== element && other.type === 'image' && overlaps(other.box, element.box),
  );
}

/**
 * Lays a panel of the background colour over the picture, where the words go.
 *
 * PowerPoint draws in insertion order, so this has to be added after the image
 * and before the text. See `TEXT_SCRIM_OPACITY` for why it exists at all.
 */
function addScrim(
  slide: PptxGenJS.Slide,
  box: SlideElement['box'],
  theme: PPTXTheme,
  spec: StyleSpec,
): void {
  slide.addShape('roundRect', {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fill: {
      color: stripHash(theme.colors.background),
      transparency: Math.round((1 - TEXT_SCRIM_OPACITY) * 100),
    },
    line: { type: 'none' },
    rectRadius: spec.shapes.cornerRadius ?? 0,
  });
}

/** Where this element's text sits — its own choice, else the role's convention. */
function placement(element: SlideElement) {
  const fallback = placementFor(element.type, element.role, {
    text: element.text,
    items: element.items,
  });
  return {
    align: element.align ?? fallback.align,
    valign: element.valign ?? fallback.valign,
  };
}

function addElement(
  slide: PptxGenJS.Slide,
  element: SlideElement,
  theme: PPTXTheme,
  spec: StyleSpec,
  slideSpec: SlideSpec,
): void {
  const { box } = element;

  if (!isWithinSlide(spec, box)) {
    throw new AgentError(
      `Element (${element.type}/${element.role}) at ${JSON.stringify(box)} falls outside the slide`,
      'ELEMENT_OUT_OF_BOUNDS',
      'pptx-builder',
    );
  }

  const position = { x: box.x, y: box.y, w: box.w, h: box.h };

  switch (element.type) {
    case 'text':
    case 'statistic': {
      // `items` renders as bullets; `text` as a single paragraph.
      const body = element.items?.length
        ? element.items.map((t) => ({ text: t, options: { bullet: true } }))
        : (element.text ?? '');

      const { align, valign } = placement(element);

      if (overText(element, slideSpec)) addScrim(slide, box, theme, spec);

      // `fontSize` was measured against the real font file at build time (see
      // ./text-metrics). The estimate is only the fallback for a deck built
      // before that pass, or one whose fonts could not be downloaded.
      const intended = sizeForRole(theme, element.role);
      const plain = element.items?.length ? element.items.join(' ') : (element.text ?? '');
      const resolved =
        element.fontSize ?? Math.round(intended * shrinkToFit(plain, box, intended));

      slide.addText(body, {
        ...position,
        fontFace: fontForRole(theme, element.role),
        // The size the web renderer also draws, so the file and the preview
        // break lines in exactly the same places.
        //
        // Deliberately NOT `fit: 'shrink'`. That writes an `<a:normAutofit>`
        // flag for PowerPoint to interpret at open/edit time — neither
        // pptxgenjs nor python-pptx computes the scale themselves — so the
        // number PowerPoint lands on is one `SlideCanvas` has no way to
        // reproduce. Pre-fitting in code is the only approach where the file
        // and the preview can agree, which is the invariant this whole
        // rendering pair exists to keep.
        fontSize: resolved,
        color: stripHash(
          readableOn(
            element.color ?? colorForRole(theme, element.role),
            surfaceUnder(element, slideSpec, theme),
            theme,
          ),
        ),
        align,
        valign,
      });
      break;
    }

    case 'card':
    case 'shape': {
      slide.addShape('roundRect', {
        ...position,
        fill: { color: stripHash(element.fill ?? theme.colors.surface) },
        line: { color: stripHash(theme.colors.border), width: 1 },
        rectRadius: spec.shapes.cornerRadius ?? 0,
      });
      // A card's content is `text` OR `items` — designers use both, and a card
      // that only ever read `text` drew an empty box for the other half of
      // them. Silently: the shape rendered, the validator passed it, and the
      // deck shipped with three blank rectangles on a slide.
      const label = cardLabel(element);

      if (label) {
        const { align, valign } = placement(element);
        const size = theme.sizes.body;

        slide.addText(label, {
          ...position,
          fontFace: theme.fonts.body,
          fontSize:
            element.fontSize ?? Math.round(size * shrinkToFit(plainText(element), box, size)),
          // Its own fill, not the slide's — that is the whole point of a card.
          color: stripHash(
            readableOn(
              element.color ?? theme.colors.text,
              element.fill ?? theme.colors.surface,
              theme,
            ),
          ),
          align,
          valign,
          // Otherwise a long label runs to the very edge of its own box.
          margin: 6,
        });
      }
      break;
    }

    case 'image': {
      if (!element.imagePath) {
        throw new AgentError(
          'Image element has no imagePath',
          'IMAGE_PATH_MISSING',
          'pptx-builder',
        );
      }
      slide.addImage({ ...position, path: element.imagePath, sizing: { type: 'cover', w: box.w, h: box.h } });
      break;
    }

    case 'divider': {
      slide.addShape('line', {
        ...position,
        line: { color: stripHash(theme.colors.border), width: spec.shapes.borderWidth ?? 1 },
      });
      break;
    }

    // Diagrams and charts are composed from primitives by the Slide Designer
    // until dedicated helpers exist; render their text so nothing is silently
    // dropped from the deck.
    case 'diagram':
    case 'chart': {
      if (element.text) {
        const { align, valign } = placement(element);

        slide.addText(element.text, {
          ...position,
          fontFace: theme.fonts.body,
          fontSize: theme.sizes.body,
          color: stripHash(
            readableOn(
              element.color ?? theme.colors.text,
              surfaceUnder(element, slideSpec, theme),
              theme,
            ),
          ),
          align,
          valign,
        });
      }
      break;
    }
  }
}

/**
 * Stacking order within a slide.
 *
 * PowerPoint draws in insertion order and has no z-index, so a caption written
 * before the card it belongs to disappears behind it. Containers go down
 * first, then everything else on top of them.
 */
function layer(element: SlideElement): number {
  if (element.type === 'image') return 0;
  if (element.type === 'card' || element.type === 'shape') return 1;
  return 2;
}

export interface BuildResult {
  slideCount: number;
}

/** Writes the deck to `outputPath`. */
export async function buildPptx(
  slideSpecs: SlideSpec[],
  styleSpec: StyleSpec,
  outputPath: string,
): Promise<BuildResult> {
  if (slideSpecs.length === 0) {
    throw new AgentError('Cannot build a deck with no slides', 'NO_SLIDES', 'pptx-builder');
  }

  const theme = themeFromStyleSpec(styleSpec);
  const pptx = new PptxGenJS();

  pptx.defineLayout({
    name: 'STYLE_SPEC',
    width: styleSpec.slideSize.width,
    height: styleSpec.slideSize.height,
  });
  pptx.layout = 'STYLE_SPEC';

  for (const spec of [...slideSpecs].sort((a, b) => a.slideNumber - b.slideNumber)) {
    const slide = pptx.addSlide();
    slide.background = { color: stripHash(theme.colors.background) };

    // A generated backdrop sits under everything, with a scrim of the
    // background colour over it. Without the scrim the deck's own text loses
    // contrast against whatever the image happens to be doing behind it.
    if (spec.background?.imagePath) {
      slide.addImage({
        path: spec.background.imagePath,
        x: 0,
        y: 0,
        w: styleSpec.slideSize.width,
        h: styleSpec.slideSize.height,
        sizing: { type: 'cover', w: styleSpec.slideSize.width, h: styleSpec.slideSize.height },
      });

      slide.addShape('rect', {
        x: 0,
        y: 0,
        w: styleSpec.slideSize.width,
        h: styleSpec.slideSize.height,
        fill: {
          color: stripHash(theme.colors.background),
          transparency: Math.round((1 - spec.background.dim) * 100),
        },
        line: { type: 'none' },
      });
    }

    // Cards and shapes first, so a label placed on top of one is drawn on top
    // of it rather than under it. PowerPoint has no z-index — the order things
    // are added IS the stacking order.
    const ordered = [...spec.elements].sort(
      (a, b) => layer(a) - layer(b),
    );

    for (const element of ordered) {
      addElement(slide, element, theme, styleSpec, spec);
    }

    if (spec.speakerNotes) slide.addNotes(spec.speakerNotes);
  }

  await pptx.writeFile({ fileName: outputPath });

  return { slideCount: slideSpecs.length };
}
