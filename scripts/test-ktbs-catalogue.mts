/**
 * The Karnataka catalogue parser, checked offline.
 *
 * Every case here is a bug this parser actually had while being written
 * against the live portal, which is why each one names what it cost:
 *
 *  - Menu depth varies by year. Assuming four levels read 3 of 2024-25's 792
 *    books and reported a clean run.
 *  - That year's end date is four digits, so a greedy two-digit match turned
 *    "2024-2025" into a fifth academic year called "2024-20".
 *  - "SOCIAL SCIENCE" contains "SCIENCE", so rule order decided whether a
 *    teacher asking for Science got the Social Science book.
 *  - The page carries a second menu of RTI disclosures built from the same
 *    classes, so an unscoped parse files them as textbooks.
 *
 *   npm run test:ktbs
 */

import {
  mediumOf,
  normaliseClass,
  parseKtbsCatalogue,
  partOf,
  selectableCombinations,
  subjectOf,
  summarise,
  yearOf,
} from '../src/lib/textbooks/ktbs.ts';

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const SOURCE = 'https://textbooks.karnataka.gov.in/textbooks/en';
const pdf = (name: string) => `https://textbooks.karnataka.gov.in/uploads/${name}.pdf`;

/** A page shaped like the real one: an RTI menu, then the catalogue. */
function page(catalogueMenu: string): string {
  return `
    <ul class='navbar-nav menu deskmenu'>
      <li class='nav-item dropdown level_0'><a class='nav-link' href='#.'><i class=''></i> RTI</a>
        <ul class='dropdown-menu'>
          <li class='nav-item level_1'><a class='nav-link' href='${pdf('rti-2024')}'><i class=''></i> RTI 4(1) B-2024-25</a></li>
        </ul>
      </li>
    </ul>
    <div class='scms-acc'><ul class='navbar-nav dept_docssam'>${catalogueMenu}</ul></div>`;
}

/** Four-level year: year, class, group, book. */
const fourLevel = `
  <li class='nav-item dropdown  level_0'><a class='nav-link' href='#.'><i class=''></i> TEXTBOOKS 2026-27</a>
    <ul class='dropdown-menu sub-mnusam'>
      <li class='nav-item dropdown dropend  level_1'><a class='nav-link' href='#.'><i class=''></i> CLASS:10</a>
        <ul class='dropdown-menu sub-mnusam'>
          <li class='nav-item dropdown  level_2'><a class='nav-link' href='#.'><i class=''></i> ENGLISH MEDIUM TEXTBOOKS:10</a>
            <ul class='dropdown-menu sub-mnusam'>
              <li class='nav-item  level_3'><a class='nav-link' href='${pdf('sci1')}'><i class=''></i> ENGLISH SCIENCE PART:1</a></li>
              <li class='nav-item  level_3'><a class='nav-link' href='${pdf('soc1')}'><i class=''></i> ENGLISH SOCIAL SCIENCE PART:1</a></li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </li>`;

/** Five-level year: an extra grouping sits above the class. */
const fiveLevel = `
  <li class='nav-item dropdown  level_0'><a class='nav-link' href='#.'><i class='newgif'></i> TEXTBOOKS 2024-2025</a>
    <ul class='dropdown-menu sub-mnusam'>
      <li class='nav-item dropdown dropend  level_1'><a class='nav-link' href='#.'><i class=''></i> PRIMARY</a>
        <ul class='dropdown-menu sub-mnusam'>
          <li class='nav-item dropdown  level_2'><a class='nav-link' href='#.'><i class=''></i> CLASS-1</a>
            <ul class='dropdown-menu sub-mnusam'>
              <li class='nav-item dropdown dropstart  level_3'><a class='nav-link' href='#.'><i class=''></i> KANNADA MEDIUM TEXTBOOKS:1</a>
                <ul class='dropdown-menu sub-mnusam'>
                  <li class='nav-item  level_4'><a class='nav-link' href='${pdf('m1')}'><i class=''></i> MATHEMATICS TEXTBOOK PART:1</a></li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  </li>`;

// ── Depth is discovered, not assumed ───────────────────────────────────────

const both = parseKtbsCatalogue(page(fourLevel + fiveLevel), SOURCE);
check(both.books.length === 3, `expected 3 books across both depths, got ${both.books.length}`);
check(both.depthHistogram['3'] === 2 && both.depthHistogram['4'] === 1,
  `books must be found at depth 3 AND 4, got ${JSON.stringify(both.depthHistogram)}`);
console.log('depth: four-level and five-level years are both read');

const deep = both.books.find((b) => b.classLevel === '1');
check(deep, 'the five-level year produced no book');
check(deep!.academicYear === '2024-25',
  `a four-digit end year must normalise to 2024-25, got ${deep!.academicYear}`);
check(deep!.group === 'KANNADA MEDIUM TEXTBOOKS:1', `wrong group: ${deep!.group}`);
check(deep!.medium === 'Kannada', `wrong medium: ${deep!.medium}`);
console.log('year: a four-digit end year normalises rather than inventing a fifth edition');

// ── The RTI menu is not the catalogue ──────────────────────────────────────

check(!both.books.some((b) => /RTI/i.test(b.title)),
  'an RTI disclosure was filed as a textbook');
check(both.books.every((b) => /^20\d\d-\d\d$/.test(b.academicYear)),
  'every book must carry a well-formed academic year');
console.log('scope: the RTI menu on the same page is excluded');

// ── Social Science is not Science ──────────────────────────────────────────

check(subjectOf('ENGLISH SOCIAL SCIENCE PART:1') === 'Social Science',
  'SOCIAL SCIENCE must not be classified as Science');
check(subjectOf('ENGLISH SCIENCE PART:1') === 'Science', 'SCIENCE must be Science');
const byTitle = Object.fromEntries(both.books.map((b) => [b.title, b.subject]));
check(byTitle['ENGLISH SOCIAL SCIENCE PART:1'] === 'Social Science',
  'the parser handed back the wrong subject for Social Science');
console.log('subject: the more specific rule wins, so Science and Social Science stay apart');

// ── Medium is read, never guessed ──────────────────────────────────────────

check(mediumOf('ENGLISH MEDIUM TEXTBOOKS:10') === 'English', 'a named medium must be read');
check(mediumOf('LANGUAGE TEXTBOOKS:10') === null,
  'a group of language subjects is not a medium');
check(mediumOf('MATHEMATICS(KANNADA-ENGLISH)BILINGUAL TEXTBOOK') === null,
  'a bilingual book names two media, so neither may be guessed');
check(mediumOf('NALIKALI TEXTBOOKS:1') === null, 'Nalikali is not a medium');
console.log('medium: only a stated medium is recorded; ambiguous groups stay null');

// ── Class labels ───────────────────────────────────────────────────────────

for (const [raw, want] of [['CLASS:10', '10'], ['CLASS-1', '1'], ['CLASS 7', '7'],
                           ['10th STD', '10'], ['LKG', 'LKG'], ['UKG', 'UKG']] as const) {
  check(normaliseClass(raw) === want, `normaliseClass(${raw}) gave ${normaliseClass(raw)}`);
}
check(partOf('MATHEMATICS TEXTBOOK PART:2') === 2, 'part number must be read');
check(partOf('SCIENCE TEXTBOOK') === null, 'a book with no part must report null');
check(yearOf('TEXTBOOKS 2026-27') === '2026-27', 'two-digit end year');
check(yearOf('CLASS:10') === null, 'a class label is not a year');
console.log('labels: class, part and year parse across the portal\'s spellings');

// ── Selectors only offer what exists ───────────────────────────────────────

const selectable = selectableCombinations(both);
check(selectable['2026-27']?.['10']?.['English']?.includes('Science'),
  'Class 10 English Science must be selectable');
check(selectable['2026-27']?.['10']?.['English']?.includes('Social Science'),
  'Class 10 English Social Science must be selectable');
check(!selectable['2026-27']?.['9'], 'a class with no books must not be offered');
check(!selectable['2027-28'], 'a year with no books must not be offered');
console.log('selectors: only combinations a real book exists for are offered');

// ── A reshaped page fails loudly ───────────────────────────────────────────

let refused = false;
try { parseKtbsCatalogue('<ul class="something-else"></ul>', SOURCE); } catch { refused = true; }
check(refused, 'a page without the catalogue menu must throw, not return zero books');
console.log('reshape: a missing catalogue menu throws instead of reporting an empty syllabus');

// ── Summary ────────────────────────────────────────────────────────────────

const s = summarise(both);
check(s.total === 3, 'summary total must match');
check(s.byYear['2026-27'] === 2 && s.byYear['2024-25'] === 1, 'per-year counts must match');
check(s.withSubject === 3, 'all three sample books have a readable subject');
console.log(`summary: ${s.total} books, ${Object.keys(s.byYear).length} editions`);

console.log('\nOK');
