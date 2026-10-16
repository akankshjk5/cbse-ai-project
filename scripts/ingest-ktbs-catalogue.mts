/**
 * Build the Karnataka textbook catalogue from the official index page.
 *
 *   npm run catalogue:ktbs                    # fetch the live index
 *   npm run catalogue:ktbs -- --from page.html
 *   npm run catalogue:ktbs -- --out data/ktbs-catalogue.json
 *
 * Reads the index page only. It records titles and official URLs; it does not
 * download a textbook, and every entry it writes carries `reuseRights:
 * "unresolved"` until someone records a permission decision. The portal's
 * copyright policy requires prior written permission before anything here is
 * reproduced, so a catalogue is as far as this goes on its own.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  parseKtbsCatalogue,
  selectableCombinations,
  summarise,
} from '../src/lib/textbooks/ktbs.ts';

const INDEX_URL = 'https://textbooks.karnataka.gov.in/textbooks/en';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const from = arg('from');
const out = arg('out') ?? 'data/ktbs-catalogue.json';

const html = from
  ? await readFile(from, 'utf8')
  : await (async () => {
      const response = await fetch(INDEX_URL, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Index page returned ${response.status}`);
      return response.text();
    })();

console.log(`source: ${from ?? INDEX_URL} (${(html.length / 1024).toFixed(0)} KB)`);

const catalogue = parseKtbsCatalogue(html, INDEX_URL);
const summary = summarise(catalogue);

console.log(`\nbooks: ${summary.total}`);
console.log('\nby academic year');
for (const [year, n] of Object.entries(summary.byYear).sort()) {
  console.log(`  ${year}  ${String(n).padStart(4)}`);
}
console.log('\nby class (current edition only)');
const current = Object.keys(summary.byYear).sort().at(-1)!;
const byClass: Record<string, number> = {};
for (const b of catalogue.books) {
  if (b.academicYear === current) byClass[b.classLevel] = (byClass[b.classLevel] ?? 0) + 1;
}
const order = (k: string) => (k === 'LKG' ? -2 : k === 'UKG' ? -1 : Number(k) || 99);
for (const [cls, n] of Object.entries(byClass).sort((a, b) => order(a[0]) - order(b[0]))) {
  console.log(`  ${cls.padEnd(6)} ${String(n).padStart(4)}`);
}

console.log(`\nmedium readable: ${summary.withMedium}/${summary.total}`);
console.log(`subject readable: ${summary.withSubject}/${summary.total}`);
if (summary.unreadableSubjects.length) {
  console.log(`\ntitles needing a human (${summary.unreadableSubjects.length} shown):`);
  for (const t of summary.unreadableSubjects.slice(0, 12)) console.log(`  ${t}`);
}

const payload = {
  ...catalogue,
  // Nothing may be reproduced until a permission decision is recorded against
  // each edition. The catalogue itself is metadata, which is why it can exist.
  reuseRights: 'unresolved' as const,
  rightsNote:
    'KTBS copyright policy requires prior permission to republish, permits republication '
    + '"as it is" only, and excludes third-party material. Deep linking is explicitly allowed.',
  selectable: selectableCombinations(catalogue),
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`\nwrote ${out}`);
