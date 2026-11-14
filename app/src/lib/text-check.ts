import { MAX_REQUEST_CHARS, quantityLineCount } from './interpret.ts';
import { MAX_RECIPE_CHARS, MAX_RECIPE_LINES, parseRecipe } from './recipe.ts';

// Checks on the text a person types, before anything is sent. Pure and free of server imports, so the pages can run it on
// every keystroke and tests can run it as is. The rules mirror what the server refuses (`/api/requests`, `/api/recipe`):
// a text that would be refused is stopped here, instead of after a wait of 30 seconds.
//   ok:    nothing to say.
//   info:  something useful, not a problem (how many lines were read).
//   hint:  something that probably needs a fix, but sending is allowed.
//   block: the server would refuse it, so sending is stopped.

export interface TextCheck {
  level: 'ok' | 'info' | 'hint' | 'block';
  message: string | null;
  /** A page that fits the text better, shown as a link next to the message. */
  link?: { href: string; label: string };
}

const OK: TextCheck = { level: 'ok', message: null };

/** The one-product request box on the Buyer agent page. */
export function checkRequestText(text: string): TextCheck {
  const trimmed = text.trim();
  if (trimmed.length === 0) return OK;
  if (trimmed.length < 3) return { level: 'block', message: 'Write a little more: what you need, how much and by when.' };
  if (text.length > MAX_REQUEST_CHARS) {
    return { level: 'block', message: `Too long: ${text.length.toLocaleString('en-GB')} of ${MAX_REQUEST_CHARS.toLocaleString('en-GB')} characters. Shorten it.` };
  }
  const products = quantityLineCount(text);
  if (products >= 3) {
    return {
      level: 'block',
      message: `This looks like a recipe or a list with ${products} products. A request covers one product at a time.`,
      link: { href: '/recipe', label: 'Use Recipe order for lists' },
    };
  }
  if (!/\d/.test(text)) return { level: 'hint', message: 'No amount found. Say how much you need, for example "100 litres".' };
  return OK;
}

/** The recipe or shopping list box on the Recipe order page. */
export function checkRecipeText(text: string): TextCheck {
  if (text.trim().length === 0) return OK;
  if (text.length > MAX_RECIPE_CHARS) {
    return { level: 'block', message: `Too long: ${text.length.toLocaleString('en-GB')} of ${MAX_RECIPE_CHARS.toLocaleString('en-GB')} characters. Split it into two orders.` };
  }
  const { lines, skipped } = parseRecipe(text);
  if (lines.length > MAX_RECIPE_LINES) {
    return { level: 'block', message: `${lines.length} lines. An order covers at most ${MAX_RECIPE_LINES}: split it into two.` };
  }
  if (lines.length === 0) {
    return {
      level: 'hint',
      message: 'No line with an amount found. Write one product per line, like "20 kg mozzarella". A plain sentence is read by a model, which takes longer.',
    };
  }
  const read = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} found.`;
  if (skipped.length === 0) return { level: 'info', message: read };
  const shown = skipped.slice(0, 2).map((s) => `"${s.length > 28 ? `${s.slice(0, 27)}…` : s}"`).join(', ');
  return { level: 'info', message: `${read} Not read: ${shown}${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ''}.` };
}
