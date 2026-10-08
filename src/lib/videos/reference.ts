import 'server-only';

// Reference text for grounding a lesson. The local planner model confidently
// misremembers names, dates and numbers (for example a coronation year), and
// asking the same model to re-check itself cannot fix a fact it does not know.
// A short encyclopedia extract gives the writer and the fact checker real text
// to rely on. This is data retrieval, not remote inference: every model still
// runs locally. Any failure returns null and planning proceeds without it.

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'LuminaDeckPro/1.0 (educational lesson planner; reference lookup)';
const MAX_REFERENCE_CHARACTERS = 5_000;

export interface TopicReference {
  title: string;
  text: string;
}

async function wikipedia(params: Record<string, string>): Promise<unknown> {
  const url = new URL(WIKIPEDIA_API);
  for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
    url.searchParams.set(key, value);
  }
  const request = () => fetch(url, {
    cache: 'no-store',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  let response = await request();
  if (response.status === 429) {
    // Rate limited: wait briefly once, as the API asks, before giving up.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    response = await request();
  }
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`);
  return response.json();
}

async function extractFor(title: string): Promise<{ title: string; extract: string } | null> {
  const page = await wikipedia({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    exsectionformat: 'plain',
    redirects: '1',
    titles: title,
  }) as { query?: { pages?: { title?: string; missing?: boolean; extract?: string }[] } };
  const found = page.query?.pages?.[0];
  const extract = found?.extract?.replace(/\n{3,}/g, '\n\n').trim();
  if (!found || found.missing || !extract || extract.length < 200 || /may refer to:/i.test(extract.slice(0, 300))) {
    return null;
  }
  return { title: found.title ?? title, extract };
}

export async function fetchTopicReference(topic: string, subject: string): Promise<TopicReference | null> {
  try {
    // An exact title (following redirects) is far more reliable than search:
    // "Chhatrapati Shivaji Maharaj" redirects to "Shivaji", while search can
    // rank the airport named after him first.
    let article = await extractFor(topic.trim());
    if (!article) {
      const searchFor = async (query: string) => wikipedia({
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: '5',
        srinfo: 'suggestion',
      }) as Promise<{ query?: { search?: { title: string }[]; searchinfo?: { suggestion?: string } } }>;
      let search = await searchFor(topic);
      // Misspelled topics ("chathrapathi") return nothing but a spelling suggestion.
      const suggestion = search.query?.searchinfo?.suggestion;
      if (!search.query?.search?.length && suggestion) search = await searchFor(suggestion);
      const titles = (search.query?.search ?? []).map((result) => result.title)
        .filter((title) => !/\b(airport|station|railway|university|college|stadium|film|album|song|district|constituency)\b/i.test(title));
      for (const title of titles.slice(0, 2)) {
        article = await extractFor(title);
        if (article) break;
      }
    }
    if (!article) return null;
    return { title: article.title, text: article.extract.slice(0, MAX_REFERENCE_CHARACTERS) };
  } catch (error) {
    console.warn(`[lesson-reference] no reference for "${topic}" (${subject})`, error);
    return null;
  }
}

export function referenceBlock(reference: TopicReference | null): string {
  if (!reference) return '';
  return `\n\nReference text from the encyclopedia article "${reference.title}". Use it as the source of truth for names, dates, ages, places and numbers; when it disagrees with your memory, follow the reference. Ignore parts that are beyond the class level or unrelated to the topic, and never copy long passages.\n"""\n${reference.text}\n"""`;
}
