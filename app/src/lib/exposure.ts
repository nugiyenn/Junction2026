import type { ExposedOrder, ExposedQuote, ExposedQuoteLine, Order, Quote, QuoteLine, StockView } from '../types/index.ts';

// Pure. The exposure policy: what an external agent may see of Valio's data. The agent gets its own fixed price,
// whether the request can be filled, and how sure Valio is of the stock. It never gets the stock quantity, the list
// price or the discount, the supplier, or Valio's internal category.

/** "Limited" when stock is under this many times the quantity asked for. */
const AMPLE_FACTOR = 3;

export function stockView(line: QuoteLine): StockView {
  const confidence =
    line.logisticModel === 'Stock' ? 'confirmed' : line.logisticModel === 'Terminal' ? 'supplier_unconfirmed' : 'unknown';
  const available = line.internal?.availableAmount ?? line.availableAmount;
  if (available === null || available === undefined) {
    // Terminal stock is unknown to Valio too. A Stock line with no number means no limit was reported.
    return { canFill: line.fulfillable, confidence, level: line.logisticModel === 'Stock' ? 'ample' : 'unknown' };
  }
  return {
    canFill: available >= line.quantity,
    confidence,
    level: available >= line.quantity * AMPLE_FACTOR ? 'ample' : 'limited',
  };
}

/** "Only 51 ST available." names the quantity, so it is replaced by a sentence that does not. */
const sanitizeIssue = (issue: string) => (/^Only [\d.]+ .* available\.$/.test(issue) ? 'Not enough stock for the full quantity.' : issue);

export function exposeLine(line: QuoteLine): ExposedQuoteLine {
  const { availableAmount: _stock, internal: _internal, issues, ...visible } = line;
  void _stock;
  void _internal;
  return { ...visible, issues: issues.map(sanitizeIssue), stock: stockView(line) };
}

export function exposeQuote(quote: Quote): ExposedQuote {
  return { ...quote, lines: quote.lines.map(exposeLine) };
}

export function exposeOrder(order: Order): ExposedOrder {
  return { ...order, lines: order.lines.map(exposeLine) };
}
