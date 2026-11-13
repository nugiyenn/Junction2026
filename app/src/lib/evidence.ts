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
