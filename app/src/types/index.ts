// Shared contract: generic agent-log shapes first, then the Valio Aimo challenge types.

export type ToolStatus = 'success' | 'warning' | 'error';

export interface AgentStepLog {
  step: number;
  tool: 'aiven_pgvector' | 'oxylabs_live' | 'groq_planner' | 'featherless_scorer' | 'gemini_fallback';
  action: string;
  durationMs: number;
  status: ToolStatus;
}

// ---------------------------------------------------------------------------
// Valio Aimo mock API (raw shapes, see data/openapi.json)
// ---------------------------------------------------------------------------

export interface ValioPrice {
  value: number;
  valueWithTax?: number;
  validFrom: string;
  validTo: string;
  currency: string;
}

export interface ValioProductPrice {
  productId: string;
  quantity: number;
  /** Price per sales unit. `value` is without tax. */
  catalogPrice?: ValioPrice | null;
  priceWithTax?: ValioPrice | null;
  /** Price per `comparisonUnit`, so products of different sizes can be compared. */
  comparisonPrice?: ValioPrice | null;
  comparisonUnit?: 'KG' | 'L' | null;
  tax?: { taxRate: number; taxValue: number } | null;
  listPrice?: ValioPrice | null;
  netPriceFound: boolean;
  /** True when no price could be found for the product. */
  error: boolean;
}

export interface ValioPriceResponse {
  customerId: string;
  currency: string;
  pricingDate: string;
  products: ValioProductPrice[];
}

export interface ValioScheduleLine {
  salesBlock: boolean;
  /** In sales units. Terminal products report 999999 because the real amount is unknown. */
  availableAmount: number;
  availableDate?: string | null;
  salesUnit: string;
}

export interface ValioProductAvailability {
  productId: string;
  /** Order cut-off for delivery on the available date. */
  closingTime?: string | null;
  salesBlock: boolean;
  logisticModel?: 'Stock' | 'Terminal' | null;
  /** Empty means the product cannot be delivered on any date. Otherwise exactly one entry. */
  scheduleLines: ValioScheduleLine[];
}

export interface ValioAvailabilityResponse {
  timeNow: string;
  requestedDate: string;
  products: ValioProductAvailability[];
}

// ---------------------------------------------------------------------------
// Catalog (static product data, seeded into the `products` table)
// ---------------------------------------------------------------------------

export interface ProductUnit {
  unitId: string;
  gtin?: string;
  sizeInBaseUnits: number;
}

export interface Product {
  id: string;
  nameFi: string;
  nameEn: string | null;
  brand: string | null;
  vendorName: string | null;
  category: string | null;
  /** Technical unit code the product is priced and ordered in, e.g. KI (case) or ST (piece). */
  salesUnit: string;
  baseUnit: string;
  /** Order quantity must be a multiple of this. */
  allowedLotSize: number;
  /** Lowercase ISO 3166-1 alpha-2. */
  countryOfOrigin: string | null;
  temperatureCondition: number | null;
  gtin: string | null;
  /** Allergen codes, e.g. AM (milk), AW (gluten cereals), AE (egg). */
  allergensContain: string[];
  allergensMayContain: string[];
  allergensFreeFrom: string[];
  /** Nutritional and diet claims, e.g. FREE_FROM_LACTOSE, VEGAN. */
  claims: string[];
  /** Certificates and labels, e.g. EU_ORGANIC_FARMING, MARINE_STEWARDSHIP_COUNCIL_LABEL. */
  labels: string[];
  units: ProductUnit[];
  /** Product codes Valio Aimo lists as replacements when this one is unavailable. */
  substitutes: string[];
  ingredients: string | null;
  /** Nutrient code -> amount per 100 g/ml, e.g. { "ENER-E14": { value: 39, unit: "E14" } }. */
  nutrition: Record<string, { value: number; unit: string }>;
  /** 0-1 share of ordered quantity historically delivered. Null when unknown. */
  deliveryReliability: number | null;
  /** Product-group average kg CO2-eq per kg, not a measurement of this product. Null when unknown. */
  co2PerKg: number | null;
}

export type ProductSearchResult = Product & { similarity: number };

// ---------------------------------------------------------------------------
// Mandate: what a buyer has authorised its purchasing agent to do
// ---------------------------------------------------------------------------

/** Which offer the buyer wants held as a quote by default. */
export type OfferPreference = 'cheapest' | 'most_reliable' | 'lowest_co2';

export interface Mandate {
  id: string;
  buyerName: string;
  agentName: string;
  /** Orders up to this total (EUR, ex VAT) are confirmed without a human. */
  autoApproveLimitEur: number;
  /** Orders above this total are rejected outright. Between the two limits a human must approve. */
  maxOrderEur: number;
  /** Allergen codes the buyer must avoid. "Contains" rejects the order, "may contain" needs approval. */
  blockedAllergens: string[];
  /** Orders with a product whose historical delivery reliability (0-1) is below this need a human. Null = no rule. */
  minDeliveryReliability: number | null;
  /** When true, a Terminal-stock line (supplier stock, unconfirmed) needs a human. */
  requireConfirmedStock: boolean;
  /** Orders with a product whose carbon footprint (kg CO2-eq per kg, group average) is above this need a human. Null = no rule. */
  maxCo2PerKg: number | null;
  /** The offer held as a quote by default when the request has more than one. The buyer can still pick another. */
  preferredOffer: OfferPreference;
}

export type PolicyOutcome = 'auto_approve' | 'needs_approval' | 'reject';

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Human-readable, one per rule that fired. Empty when auto-approved with nothing to note. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Quote -> order
// ---------------------------------------------------------------------------

/** Valio's own view of a line: commercial and operational detail that stays inside Valio. */
export interface QuoteLineInternal {
  listPrice: number | null;
  /** How far the buyer's price is below the list price, in percent. Reveals the customer-specific discount. */
  discountPct: number | null;
  /** True when a customer-specific net price was found, false when the catalog price was used. */
  netPriceFound: boolean | null;
  /** Exact stock in sales units. Null for Terminal products, whose real stock Valio does not know either. */
  availableAmount: number | null;
  vendorName: string | null;
  category: string | null;
}

export interface QuoteLine {
  productId: string;
  name: string;
  /** In sales units. */
  quantity: number;
  salesUnit: string;
  /** Per sales unit, ex VAT. Null when Valio has no price for the product. */
  unitPrice: number | null;
  unitPriceWithTax: number | null;
  comparisonPrice: number | null;
  comparisonUnit: 'KG' | 'L' | null;
  lineTotal: number | null;
  lineTotalWithTax: number | null;
  /** In sales units. Null for Terminal products, whose real stock is unknown. */
  availableAmount: number | null;
  availableDate: string | null;
  closingTime: string | null;
  logisticModel: 'Stock' | 'Terminal' | null;
  /** True when the full quantity can be delivered on the requested date at a known price. */
  fulfillable: boolean;
  /** Why the line is not fulfillable. Empty when it is. */
  issues: string[];
  substitutes: string[];
  /** What Valio knows and the agent does not see. Stripped from every agent-facing response (see exposure.ts). */
  internal?: QuoteLineInternal;
  /** True when this line replaces what the buyer asked for. The mandate sends such orders to a human. */
  isSubstitute?: boolean;
  /** The product this line replaces. Only accepted when Valio lists this product as a substitute for it. */
  substituteFor?: string;
}

export interface Quote {
  id: string;
  mandateId: string;
  /** Requested delivery date, YYYY-MM-DD. */
  deliveryDate: string;
  currency: string;
  lines: QuoteLine[];
  /** Sum of priced lines, ex VAT. */
  total: number;
  totalWithTax: number;
  /** True when every line is fulfillable. Only such quotes can be ordered. */
  fulfillable: boolean;
  createdAt: string;
  /** Prices are held until this time. Ordering after it needs a new quote. */
  expiresAt: string;
  /** Valio's signature over the offer (see offer-signature.ts). Any agent can check it with the public key. */
  signature: { alg: 'EdDSA'; keyId: string; value: string } | null;
}

// ---------------------------------------------------------------------------
// Exposure: what an agent sees of Valio's data
// ---------------------------------------------------------------------------

/** Stock as an agent sees it: whether the request can be filled and how sure Valio is, never the quantity. */
export interface StockView {
  canFill: boolean;
  /** confirmed: Valio holds the stock. supplier_unconfirmed: the supplier ships it and the quantity is unknown. */
  confidence: 'confirmed' | 'supplier_unconfirmed' | 'unknown';
  level: 'ample' | 'limited' | 'unknown';
}

export type ExposedQuoteLine = Omit<QuoteLine, 'availableAmount' | 'internal'> & { stock: StockView };
export type ExposedQuote = Omit<Quote, 'lines'> & { lines: ExposedQuoteLine[] };
export type ExposedOrder = Omit<Order, 'lines'> & { lines: ExposedQuoteLine[] };

export type OrderStatus = 'confirmed' | 'pending_approval' | 'rejected';

export interface Order {
  id: string;
  quoteId: string;
  mandateId: string;
  status: OrderStatus;
  /** Why the policy sent the order to a human or rejected it. */
  policyReasons: string[];
  deliveryDate: string;
  currency: string;
  lines: QuoteLine[];
  total: number;
  totalWithTax: number;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

// ---------------------------------------------------------------------------
// Request: plain-language need -> structured need -> ranked candidates -> quote
// ---------------------------------------------------------------------------

/** What the language model extracted from the buyer's sentence. Code validates and acts on it. */
export interface PurchaseRequest {
  /** Short product description to search for, in English, e.g. "lactose-free milk". */
  product: string;
  amount: number;
  /** L and KG are converted to sales units by code; "unit" means sales units as-is. */
  amountUnit: 'L' | 'KG' | 'unit';
  /** YYYY-MM-DD */
  deliveryDate: string;
  /** Claim codes every product must carry, e.g. FREE_FROM_LACTOSE. */
  requiredClaims: string[];
}

export interface Candidate {
  productId: string;
  name: string;
  /** Sales units needed to cover the requested amount. Null when it cannot be computed. */
  quantity: number | null;
  salesUnit: string;
  /** L or KG per sales unit, derived from catalogPrice / comparisonPrice. */
  amountPerUnit: number | null;
  unitPrice: number | null;
  /** Price per L or KG, ex VAT. */
  comparisonPrice: number | null;
  comparisonUnit: 'KG' | 'L' | null;
  /** Price for the whole requested amount, ex VAT. */
  total: number | null;
  logisticModel: 'Stock' | 'Terminal' | null;
  deliveryReliability: number | null;
  co2PerKg: number | null;
  labels: string[];
  /** 1 = chosen. Unfulfillable candidates come last. */
  rank: number;
  fulfillable: boolean;
  /** In sales units, for Stock products. Always null in what an agent receives: exact stock stays inside Valio. */
  availableAmount: number | null;
  /** The pack multiple the product must be ordered in. */
  allowedLotSize: number;
  /** True when the only problem is that stock is lower than needed, so it can contribute to a split. */
  onlyShort: boolean;
  /** Set when this candidate is one of Valio's listed substitutes for a product from the search. */
  substituteFor: string | null;
  /** Why it was chosen, or why not. */
  reasons: string[];
}

/** Why an offer is shown. A product can earn several. */
export type OfferKind = 'cheapest' | 'most_reliable' | 'lowest_co2' | 'split' | 'substitute';

export interface OfferLine {
  productId: string;
  name: string;
  /** In sales units. */
  quantity: number;
  salesUnit: string;
  unitPrice: number | null;
  lineTotal: number | null;
  /** How much of the request this line covers, in L or KG. */
  amountCovered: number | null;
  /** Set on substitute lines: the product from the search it replaces. */
  substituteFor?: string;
}

/** A complete way to fill the request, ready to be turned into a quote. */
export interface Offer {
  id: string;
  kinds: OfferKind[];
  label: string;
  lines: OfferLine[];
  total: number;
  /** Lowest delivery reliability (0-1) among the lines. Null if any line has none on record. */
  reliability: number | null;
  /** Amount-weighted kg CO2-eq per kg (product-group average). Null if any line has none on record. */
  co2PerKg: number | null;
  labels: string[];
  /** Stock means a confirmed quantity; Terminal means the supplier ships it and the quantity is unknown. */
  logisticModels: ('Stock' | 'Terminal')[];
  isSplit: boolean;
  isSubstitute: boolean;
  /** One plain sentence on what this offer is and what it trades off. */
  summary: string;
}

export interface RequestResult {
  text: string;
  /** Which open-weights model read the request and picked the matching products. */
  models: { interpreted: string; picked: string };
  /** Keyword matches the mandate's blocked allergens removed before pricing. */
  excludedByMandate: number;
  interpreted: PurchaseRequest;
  candidates: Candidate[];
  /** Ways to fill the request, the default first. Empty when nothing can cover it. */
  offers: Offer[];
  /** Held quote for the default offer (offers[0]), as an agent sees it. Null when there are no offers. */
  quote: ExposedQuote | null;
  /** What the mandate would decide about that quote if it were ordered now. Null when there is no quote. */
  policy: PolicyDecision | null;
  /** Plain-language notes on exceptions: a split, a substitution, a shortfall. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Verification: catalog claims checked against the live web (Oxylabs)
// ---------------------------------------------------------------------------

export interface VerifiedStatement {
  topic: 'allergen' | 'label' | 'ingredient' | 'origin';
  /** For allergen statements: what the page says about it. */
  stance: 'contains' | 'may_contain' | 'free_from' | null;
  /** GS1 allergen code (AM milk, AN tree nuts, ...). Null for other topics. */
  allergen: string | null;
  /** The model's one-line paraphrase. */
  text: string;
  /** A passage copied from the page. Code checked that it appears in the page text, so the statement is not invented. */
  evidence: string;
  sourceUrl: string;
}

export interface VerificationSource {
  url: string;
  title: string;
  /** Oxylabs request id of the scrape, for reporting a failure. */
  requestId: string | null;
  readable: boolean;
  /** Why the page was not used: unreadable, or not about this product. */
  note: string | null;
}

export interface Verification {
  productId: string;
  checkedAt: string;
  /**
   * confirmed: web evidence found and nothing contradicts the catalog.
   * contradiction: a page disagrees with the catalog's allergen data.
   * no_evidence: pages were read but no verifiable statement was found.
   * unreadable: no page could be read.
   */
  status: 'confirmed' | 'contradiction' | 'no_evidence' | 'unreadable';
  statements: VerifiedStatement[];
  /** Plain-language disagreements between a page and the catalog, each with its source. */
  contradictions: string[];
  sources: VerificationSource[];
  searchRequestId: string | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export type AuditActor = 'agent' | 'human' | 'system';

export type AuditAction =
  | 'product_verified'
  | 'mandate_changed'
  | 'request_interpreted'
  | 'catalog_searched'
  | 'quote_issued'
  | 'order_confirmed'
  | 'order_sent_for_approval'
  | 'order_rejected_by_policy'
  | 'order_approved'
  | 'order_declined';

export interface AuditEvent {
  id: string;
  at: string;
  actor: AuditActor;
  action: AuditAction;
  mandateId: string | null;
  quoteId: string | null;
  orderId: string | null;
  /** One plain-language sentence: what happened and why. */
  summary: string;
  data: Record<string, unknown>;
  /** SHA-256 over the previous event's hash and this event's content. Null only before the chain was introduced. */
  hash: string | null;
  prevHash: string | null;
}

/** Body of every non-2xx API response. */
export interface ApiError {
  error: string;
}

// --- valkey ---

/** One backing service as GET /api/health sees it. */
export interface ServiceHealth {
  name: 'postgres' | 'valkey';
  configured: boolean;
  ok: boolean;
  latencyMs: number | null;
  /** What is happening, in a sentence: the error, or what is off because the service is missing. */
  detail: string;
}

export interface HealthReport {
  services: ServiceHealth[];
  /** Valio API calls saved (hits) and made (misses) by the Valkey cache. Null when Valkey is off or failing. */
  cache: { hits: number; misses: number } | null;
}
