// Narration is read aloud by a voice model and translated first, so digits and
// symbols are rewritten as plain spoken English in code instead of asking the
// planner to avoid them (it often cannot for history years or worked math).

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_EXCEPTIONS: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};

function belowHundred(value: number): string {
  if (value < 20) return ONES[value];
  const tens = TENS[Math.floor(value / 10)];
  return value % 10 ? `${tens}-${ONES[value % 10]}` : tens;
}

function belowThousand(value: number): string {
  if (value < 100) return belowHundred(value);
  const rest = value % 100;
  return `${ONES[Math.floor(value / 100)]} hundred${rest ? ` ${belowHundred(rest)}` : ''}`;
}

export function integerToWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return String(value);
  if (value < 1000) return belowThousand(value);
  const scales: [number, string][] = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1_000, 'thousand']];
  const parts: string[] = [];
  let rest = value;
  for (const [size, name] of scales) {
    if (rest >= size) {
      parts.push(`${belowThousand(Math.floor(rest / size))} ${name}`);
      rest %= size;
    }
  }
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

/** Years are spoken in pairs: 1674 -> "sixteen seventy-four", 1905 -> "nineteen oh five". */
function yearToWords(value: number): string {
  const high = Math.floor(value / 100);
  const low = value % 100;
  if (low === 0) return `${belowHundred(high)} hundred`;
  return `${belowHundred(high)} ${low < 10 ? `oh ${ONES[low]}` : belowHundred(low)}`;
}

function ordinal(words: string): string {
  const parts = words.split(/([ -])/);
  const last = parts[parts.length - 1];
  const replaced = ORDINAL_EXCEPTIONS[last]
    ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  parts[parts.length - 1] = replaced;
  return parts.join('');
}

function numberToWords(raw: string, followingWord = ''): string {
  const clean = raw.replace(/,/g, '');
  if (clean.includes('.')) {
    const [whole, fraction] = clean.split('.');
    return `${integerToWords(Number(whole || '0'))} point ${[...fraction].map((digit) => ONES[Number(digit)]).join(' ')}`;
  }
  const value = Number(clean);
  const looksLikeYear = /^\d{4}$/.test(clean) && value >= 1100 && value <= 1999
    && !/^(people|years|km|kilometres|kilometers|metres|meters|grams|kg|rupees|soldiers|square)/i.test(followingWord);
  return looksLikeYear ? yearToWords(value) : integerToWords(value);
}

export function spokenNarration(text: string): string {
  let result = text;
  result = result.replace(/(\d+)\s*°\s*C\b/g, '$1 degrees Celsius');
  result = result.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');
  result = result.replace(/\^\s*2\b/g, ' squared').replace(/\^\s*3\b/g, ' cubed');
  result = result.replace(/\^\s*(\d+)/g, ' to the power $1');
  result = result.replace(/\s*(?:<=|≤)\s*/g, ' is less than or equal to ');
  result = result.replace(/\s*(?:>=|≥)\s*/g, ' is greater than or equal to ');
  result = result.replace(/\s*<\s*/g, ' is less than ').replace(/\s*>\s*/g, ' is greater than ');
  result = result.replace(/\s*=\s*/g, ' equals ');
  result = result.replace(/\s*\+\s*/g, ' plus ');
  result = result.replace(/\s*[×*]\s*/g, ' times ');
  result = result.replace(/(\w)\s*[÷/]\s*(\w)/g, '$1 divided by $2');
  result = result.replace(/(\w)\s+[−-]\s+(\w)/g, '$1 minus $2');
  result = result.replace(/(^|[\s(])[−-](\d)/g, '$1minus $2');
  result = result.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_match, digits: string) => ordinal(integerToWords(Number(digits))));
  // "2x" -> "2 x" so the variable is spoken separately from its coefficient.
  result = result.replace(/\b(\d+(?:\.\d+)?)([a-z])\b/gi, '$1 $2');
  result = result.replace(/\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (match, offset: number, whole: string) => {
    const following = whole.slice(offset + match.length).trim().split(/\s+/)[0] ?? '';
    return numberToWords(match, following);
  });
  return result.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}
