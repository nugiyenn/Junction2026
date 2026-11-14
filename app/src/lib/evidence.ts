import type { Product, VerifiedStatement } from '../types/index.ts';

// Pure helpers for checking what a language model claims a web page says. The model extracts statements;
// code decides whether each one is really on the page, whether the page is about the product, and whether
// it disagrees with the catalog.

/** Allergen names the model may use, mapped to the GS1 codes the catalog uses. */
export const ALLERGEN_CODES: Record<string, string> = {
  milk: 'AM',
  egg: 'AE',
  fish: 'AF',
  crustaceans: 'AC',
  'tree nuts': 'AN',
  peanuts: 'AP',
  sesame: 'AS',
  soy: 'AY',
  gluten: 'AW',
  celery: 'BC',
  mustard: 'BM',
  sulphites: 'AU',
};

const CODE_NAMES = Object.fromEntries(Object.entries(ALLERGEN_CODES).map(([name, code]) => [code, name]));
export const allergenWord = (code: string) => CODE_NAMES[code] ?? code;

/** Lowercase, one space between words, markdown and typographic marks removed, so quotes survive formatting. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`#>\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sites whose product pages may clear an unknown allergen: the maker and the Finnish grocery and wholesale shops seen in
 * practice. A page anywhere else can only make an order stricter ("contains", "may contain", a disagreement), never looser.
 * Otherwise a page that says "free from nuts" in a sentence the model copies, true or planted, could clear a nut-blocking buyer.
 */
export const TRUSTED_SOURCE_HOSTS = [
  'valio.fi', 'valio.com', 'valioaimo.fi', 'kespro.com', 'valotilaus.fi', 'k-ruoka.fi', 's-kaupat.fi', 'prisma.fi', 'foodie.fi',
];

export function isTrustedSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return TRUSTED_SOURCE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** True when the quoted passage really appears in the page. Too short to mean anything counts as not found. */
export function evidenceAppears(evidence: string, page: string): boolean {
  const quote = normalize(evidence);
  return quote.length >= 12 && normalize(page).includes(quote);
}

/** True when the page is about this product: it shows the GTIN, or most of the product name's distinctive words. */
export function pageMatchesProduct(page: string, product: Pick<Product, 'nameEn' | 'nameFi' | 'gtin'>): boolean {
  const text = normalize(page);
  if (product.gtin && text.includes(product.gtin)) return true;

  const words = [...new Set(normalize(product.nameEn ?? product.nameFi).split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length >= 4 && !/^\d+$/.test(w)
  );
  if (words.length < 2) return false;
  const present = words.filter((w) => text.includes(w)).length;
  return present >= 2 && present / words.length >= 0.6;
}

/**
 * Plain-language disagreements between what pages say and what the catalog lists. A page that says "contains"
 * when the catalog says "free from", "may contain" or nothing is a disagreement: the catalog is incomplete or wrong.
 */
export function compareWithCatalog(
  statements: VerifiedStatement[],
  product: Pick<Product, 'allergensContain' | 'allergensMayContain' | 'allergensFreeFrom'>
): string[] {
  const out: string[] = [];
  for (const s of statements) {
    if (s.topic !== 'allergen' || !s.allergen || !s.stance) continue;
    const word = allergenWord(s.allergen);
    const inCatalog = product.allergensContain.includes(s.allergen)
      ? 'contains'
      : product.allergensMayContain.includes(s.allergen)
        ? 'may_contain'
        : product.allergensFreeFrom.includes(s.allergen)
          ? 'free_from'
          : 'unlisted';

    const pageSays = { contains: 'contains', may_contain: 'may contain', free_from: 'is free from' }[s.stance];
    const catalogSays = { contains: 'contains', may_contain: 'may contain', free_from: 'is free from', unlisted: 'has no entry for' }[inCatalog];

    const agrees =
      (s.stance === 'contains' && inCatalog === 'contains') ||
      (s.stance === 'may_contain' && (inCatalog === 'may_contain' || inCatalog === 'contains')) ||
      (s.stance === 'free_from' && (inCatalog === 'free_from' || inCatalog === 'unlisted'));
    if (!agrees) out.push(`Source says it ${pageSays} ${word}; the catalog ${catalogSays} ${word} (${s.sourceUrl}).`);
  }
  return [...new Set(out)];
}

// --- recall notices ---

/**
 * The search hits that are individual Ruokavirasto recall notices: a page below a `takaisinvedot` section
 * (not the section's index, the statistics page or the animal-disease page), best-ranked first.
 */
export function recallNoticeUrls(hits: { url: string }[], max: number): string[] {
  const urls = hits
    .filter((h) => {
      try {
        const u = new URL(h.url);
        if (u.hostname !== 'www.ruokavirasto.fi' && u.hostname !== 'ruokavirasto.fi') return false;
        const parts = u.pathname.split('/').filter(Boolean);
        const at = parts.findIndex((p) => p.startsWith('takaisinvedot'));
        return parts[0] === 'elintarvikkeet' && at >= 0 && at < parts.length - 1;
      } catch {
        return false;
      }
    })
    .map((h) => h.url);
  return [...new Set(urls)].slice(0, max);
}

/** Ruokavirasto answers a moved or removed notice with a rendered "404" page that still has text on it. */
export const isNotFoundPage = (page: string) => /\b404\b/.test(page) && /ei valitettavasti löytynyt|page not found|not found/i.test(page.slice(0, 600));

const words = (text: string) => normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * True when a quoted passage names this product: it shows the GTIN, or it names the brand and at least one
 * other distinctive word of the product name, or (no brand known) two of them. Finnish compounds count: the
 * word "mousse" in the quote matches "suklaamousse" in the name, and a word's first five letters match its inflections.
 */
export function namesProduct(quote: string, product: Pick<Product, 'nameEn' | 'nameFi' | 'brand' | 'gtin'>): boolean {
  const text = normalize(quote);
  if (product.gtin && text.includes(product.gtin)) return true;

  const quoted = words(quote);
  const hit = (w: string) => quoted.some((q) => q === w || (q.length >= 5 && w.includes(q)) || (w.length >= 5 && q.includes(w.slice(0, 5))));
  const distinctive = (name: string) => words(name).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  const brand = product.brand ? words(product.brand).filter((w) => w.length >= 3) : [];
  const nameWords = [...new Set([...distinctive(product.nameFi), ...distinctive(product.nameEn ?? '')])].filter((w) => !brand.includes(w));

  const others = nameWords.filter(hit).length;
  return brand.length > 0 ? brand.every((w) => text.includes(w)) && others >= 1 : others >= 2;
}
