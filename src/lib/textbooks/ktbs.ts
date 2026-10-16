/**
 * Reading the Karnataka Textbook Society catalogue.
 *
 * The portal publishes its whole catalogue on one page as a nested menu, and
 * every book is a direct link to an official PDF. One page load yields the lot,
 * so this is a parser rather than a crawler: no link-following, no rate
 * limiting, nothing fetched but the index itself.
 *
 * What this module does NOT do is download a textbook. It reads titles and
 * URLs. That distinction matters: a catalogue of what exists and where is not
 * republication, and the portal's copyright policy requires prior permission
 * before anything here is reproduced. See `ReuseRights`.
 */

/** Where a textbook's reproduction rights stand. Nothing publishes at `unresolved`. */
export type ReuseRights = 'unresolved' | 'link_only' | 'granted' | 'refused';

export interface KtbsBook {
  /** Academic year as the portal writes it, e.g. "2026-27". */
  academicYear: string;
  /** "LKG", "UKG", "1".."10", or a programme grouping such as NSQF. */
  classLevel: string;
  /** The portal's own grouping, e.g. "ENGLISH MEDIUM TEXTBOOKS:10". */
  group: string;
  title: string;
  /** Teaching medium, derived from the group where the portal states one. */
  medium: string | null;
  /** Subject, derived from the title. Null when it cannot be read confidently. */
  subject: string | null;
  part: number | null;
  url: string;
}

export interface KtbsCatalogue {
  retrievedAt: string;
  sourceUrl: string;
  books: KtbsBook[];
  /** Menu depths at which books were found, for noticing a page reshape. */
  depthHistogram: Record<string, number>;
}

/**
 * Menu depth is NOT fixed, and assuming it was cost 789 books.
 *
 * 2026-27, 2025-26 and 2023-24 nest four deep (year, class, group, book), but
 * 2024-25 nests five: it inserts an extra grouping above the class. A parser
 * pinned to four levels reads three books out of that year's 792 and reports a
 * clean run, which is the worst kind of wrong, because the count looks
 * plausible. So depth is discovered rather than declared, and the histogram
 * goes into the output so a future reshape is visible rather than silent.
 */
const MAX_DEPTH = 12;

/**
 * The catalogue lives in its own menu.
 *
 * The page carries a second navigation menu (About us, RTI, department links)
 * built from the same level classes, and it contains PDFs of its own. Those are
 * RTI disclosures, not textbooks. Parsing the whole document would file them as
 * books, so the scan starts at the catalogue's container.
 */
const CATALOGUE_CONTAINER = 'dept_docssam';

/**
 * A fresh scanner per parse.
 *
 * A module-level global regex carries `lastIndex` between calls, which makes a
 * second parse in the same process start halfway through the page. Building it
 * per call costs nothing and removes that class of bug entirely.
 */
function tagScanner(): RegExp {
  return /<li\b[^>]*class=['"]([^'"]*)['"][^>]*>|<a\b[^>]*href=['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/a>/gi;
}

function text(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/‎|‏/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "CLASS:10", "CLASS-1", "10th" all name a class; "LKG" names itself. */
export function normaliseClass(raw: string): string {
  const cleaned = text(raw).toUpperCase();
  const numbered = cleaned.match(/CLASS\s*[:\-]?\s*(\d{1,2})/);
  if (numbered) return numbered[1] as string;
  const ordinal = cleaned.match(/^(\d{1,2})(ST|ND|RD|TH)\b/);
  if (ordinal) return ordinal[1] as string;
  if (/^LKG/.test(cleaned)) return 'LKG';
  if (/^UKG/.test(cleaned)) return 'UKG';
  return cleaned;
}

const MEDIA = ['KANNADA', 'ENGLISH', 'HINDI', 'URDU', 'MARATHI', 'TAMIL', 'TELUGU'];

/**
 * The medium a group teaches in, or null.
 *
 * Only groups that actually name one are mapped. "LANGUAGE TEXTBOOKS" is a
 * group of language subjects rather than a medium, and "BILINGUAL" names two at
 * once. Guessing either would put a book in front of a teacher who cannot read
 * it, so both return null and are surfaced for review instead.
 */
export function mediumOf(group: string): string | null {
  const g = text(group).toUpperCase();
  if (/BILINGUAL|NALIKALI|LANGUAGE TEXTBOOKS/.test(g)) return null;
  for (const m of MEDIA) {
    if (g.includes(m + ' MEDIUM')) return m.charAt(0) + m.slice(1).toLowerCase();
  }
  return null;
}

/**
 * Ordered, and the order is load-bearing.
 *
 * "SOCIAL SCIENCE" contains "SCIENCE", so a Science rule placed first claims
 * the Social Science books and a teacher asking for Science is handed the
 * wrong one. The most specific pattern always goes above the one it contains.
 */
const SUBJECTS: Array<[RegExp, string]> = [
  [/MATHEMATIC|MATHS\b/, 'Mathematics'],
  [/SOCIAL SCIENCE|\bSOCIAL\b/, 'Social Science'],
  [/\bSCIENCE\b/, 'Science'],
  [/\bEVS\b|ENVIRONMENTAL/, 'EVS'],
  [/PHYSIC/, 'Physics'],
  [/CHEMIST/, 'Chemistry'],
  [/BIOLOG/, 'Biology'],
  [/COMPUTER/, 'Computer Science'],
  [/\bKANNADA\b/, 'Kannada'],
  [/\bENGLISH\b/, 'English'],
  [/\bHINDI\b/, 'Hindi'],
  [/\bURDU\b/, 'Urdu'],
  [/\bSANSKRIT\b/, 'Sanskrit'],
  [/\bMARATHI\b/, 'Marathi'],
  [/\bTAMIL\b/, 'Tamil'],
  [/\bTELUGU\b/, 'Telugu'],
  [/\bARABIC\b/, 'Arabic'],
  [/\bPERSIAN\b/, 'Persian'],
  [/PHYSICAL EDUCATION/, 'Physical Education'],
];

export function subjectOf(title: string): string | null {
  const t = text(title).toUpperCase();
  for (const pair of SUBJECTS) {
    if (pair[0].test(t)) return pair[1];
  }
  return null;
}

export function partOf(title: string): number | null {
  const m = text(title).toUpperCase().match(/PART\s*[:\-]?\s*(\d)/);
  return m ? Number(m[1]) : null;
}

/**
 * The academic year a label names, always as "2024-25".
 *
 * The portal is not consistent: most years are written "2026-27", but 2024-25
 * is written with a four-digit end year. Matching two digits greedily turns
 * "2024-2025" into "2024-20", which then looks like a fifth academic year and
 * splits that edition's books away from themselves.
 */
export function yearOf(label: string): string | null {
  const m = text(label).match(/(20\d\d)\s*[-–]\s*(\d{2,4})/);
  if (!m) return null;
  const end = m[2] as string;
  return (m[1] as string) + '-' + (end.length === 4 ? end.slice(2) : end);
}

function looksLikeClass(label: string): string | null {
  const c = normaliseClass(label);
  return /^(\d{1,2}|LKG|UKG)$/.test(c) ? c : null;
}

/**
 * Every book the index page lists.
 *
 * Walks the page once, tracking the innermost label seen at each menu depth.
 * The portal emits the menu depth-first, so a book belongs to whatever year,
 * class and group were last seen above it. An entry whose ancestors are
 * incomplete is skipped rather than guessed.
 */
export function parseKtbsCatalogue(
  html: string,
  sourceUrl: string,
  now: Date = new Date(),
): KtbsCatalogue {
  const start = html.indexOf(CATALOGUE_CONTAINER);
  if (start < 0) {
    throw new Error(
      'The catalogue menu (.' + CATALOGUE_CONTAINER + ') is not on this page. '
      + 'The portal has changed shape; re-read it before trusting any count.',
    );
  }
  const scope = html.slice(start);

  const path: Array<string | null> = new Array(MAX_DEPTH).fill(null);
  const books: KtbsBook[] = [];
  const depthHistogram: Record<string, number> = {};
  let pendingLevel: number | null = null;

  const nearest = (from: number, test: (label: string) => string | null): string | null => {
    for (let d = from; d >= 0; d -= 1) {
      const label = path[d];
      if (!label) continue;
      const got = test(label);
      if (got) return got;
    }
    return null;
  };

  const scanner = tagScanner();
  let m = scanner.exec(scope);
  while (m !== null) {
    const liClass = m[1];
    const href = m[2];
    const anchorText = m[3];

    if (liClass !== undefined) {
      const level = liClass.match(/level_(\d+)/);
      if (level) {
        const depth = Number(level[1]);
        if (depth < MAX_DEPTH) {
          pendingLevel = depth;
          for (let d = depth; d < MAX_DEPTH; d += 1) path[d] = null;
        }
      }
    } else if (href !== undefined && pendingLevel !== null) {
      const depth = pendingLevel;
      const label = text(anchorText || '');
      path[depth] = label;
      pendingLevel = null;

      if (label && /\.pdf(\?|$)/i.test(href)) {
        const academicYear = nearest(depth, yearOf);
        const classLevel = nearest(depth, looksLikeClass)
          // A programme such as NSQF names no class; fall back to the year's
          // own child so the book is still filed where a person can find it.
          ?? (path[1] ? normaliseClass(path[1]) : null);
        const group = path[depth - 1] ?? path[1] ?? null;

        if (academicYear && classLevel && group) {
          depthHistogram[String(depth)] = (depthHistogram[String(depth)] ?? 0) + 1;
          books.push({
            academicYear,
            classLevel,
            group: text(group),
            title: label,
            medium: mediumOf(group),
            subject: subjectOf(label),
            part: partOf(label),
            url: new URL(href, sourceUrl).toString(),
          });
        }
      }
    }

    m = scanner.exec(scope);
  }

  return { retrievedAt: now.toISOString(), sourceUrl, books, depthHistogram };
}

export interface CatalogueSummary {
  total: number;
  byYear: Record<string, number>;
  byClass: Record<string, number>;
  withMedium: number;
  withSubject: number;
  /** Titles whose subject could not be read; these need a human. */
  unreadableSubjects: string[];
}

export function summarise(catalogue: KtbsCatalogue): CatalogueSummary {
  const byYear: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const unreadable = new Set<string>();
  let withMedium = 0;
  let withSubject = 0;

  for (const b of catalogue.books) {
    byYear[b.academicYear] = (byYear[b.academicYear] ?? 0) + 1;
    byClass[b.classLevel] = (byClass[b.classLevel] ?? 0) + 1;
    if (b.medium) withMedium += 1;
    if (b.subject) withSubject += 1;
    else unreadable.add(b.title);
  }

  return {
    total: catalogue.books.length,
    byYear,
    byClass,
    withMedium,
    withSubject,
    unreadableSubjects: [...unreadable].sort(),
  };
}

/**
 * The combinations a teacher may actually pick, for the dependent selectors.
 *
 * Built from the catalogue rather than from a hand-written list, so the form
 * can only offer a year, class, medium and subject that a real book exists for.
 * A book whose medium or subject could not be read is left out: offering a
 * selection that resolves to nothing is worse than not offering it.
 */
export function selectableCombinations(
  catalogue: KtbsCatalogue,
): Record<string, Record<string, Record<string, string[]>>> {
  const tree: Record<string, Record<string, Record<string, Set<string>>>> = {};
  for (const b of catalogue.books) {
    if (!b.medium || !b.subject) continue;
    const year = (tree[b.academicYear] ??= {});
    const cls = (year[b.classLevel] ??= {});
    (cls[b.medium] ??= new Set<string>()).add(b.subject);
  }
  const out: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const [year, classes] of Object.entries(tree)) {
    out[year] = {};
    for (const [cls, media] of Object.entries(classes)) {
      out[year][cls] = {};
      for (const [medium, subjects] of Object.entries(media)) {
        out[year][cls][medium] = [...subjects].sort();
      }
    }
  }
  return out;
}
