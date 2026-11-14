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
  /** A second model's independent reading of the request, compared with the first on amount, unit and delivery date. */
  interpretationCheck: InterpretationCheck | null;
  /** What the mandate would decide about that quote if it were ordered now. Null when there is no quote. */
  policy: PolicyDecision | null;
  /** Plain-language notes on exceptions: a split, a substitution, a shortfall. */
  notes: string[];
  /** Automatic live-web checks run before the policy preview. Null when the request had no claims or blocked allergens. */
  liveChecks: LiveChecks | null;
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
  /** The model that read the pages, as it was labelled when the check ran. */
  model?: string | null;
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
  | 'recall_checked'
  | 'mandate_changed'
  | 'request_interpreted'
  | 'catalog_searched'
  | 'quote_issued'
  | 'order_confirmed'
  | 'order_sent_for_approval'
  | 'order_rejected_by_policy'
  | 'order_approved'
  | 'order_declined'
  /** Approver-only: the full unusual-order report for one order. Never served by /api/audit or put in a receipt. */
  | 'deviation_report'
  /** A person approved a flagged order and said it is the buyer's new normal, so it counts in future baselines. */
  | 'order_accepted_as_normal';

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
  /** Whether approving an order or editing a mandate needs the approver key (APPROVER_KEY is set). */
  approverKeyRequired: boolean;
}

// --- live-web guardrail ---

export interface RecallMatch {
  sourceUrl: string;
  /** A passage copied from the notice. Code checked it is on the page and names the product or brand. */
  quote: string;
  /** The model's one-line reason for the recall. */
  text: string;
}

export interface RecallCheck {
  productId: string;
  checkedAt: string;
  /**
   * none_found: Ruokavirasto's recall notices were searched and none concerning this product was found
   * (`query`, `searchRequestId` and `sources` are the proof). match: a notice names the product or brand.
   * unreadable: notices were found but none could be read.
   */
  status: 'none_found' | 'match' | 'unreadable';
  /** The model that read the notices, as it was labelled when the check ran. */
  model?: string | null;
  matches: RecallMatch[];
  /** Every result of the search: read notices carry a request id, the rest say why they were not read. */
  sources: VerificationSource[];
  query: string;
  searchRequestId: string | null;
  summary: string;
}

export interface LiveCheckedProduct {
  productId: string;
  name: string;
  /** Null when the allergen and label check did not run or failed; see `skipped`. */
  verification: Verification | null;
  /** Null when the recall check did not run or failed; see `skipped`. */
  recall: RecallCheck | null;
  /** Why a check is missing, one entry per check: "Live check skipped for X: reason". */
  skipped: string[];
}

export interface LiveChecks {
  products: LiveCheckedProduct[];
  /** The time budget the checks ran in, in seconds. */
  budgetSeconds: number;
}

// --- stats ---

/** pending = still waiting for a person. rejected = stopped by the mandate. declined = a person said no. */
export type OrderOutcome = 'auto_approved' | 'approved' | 'declined' | 'rejected' | 'pending';

/** One past order, from the real `orders` table or the synthetic `order_history` table. */
export interface StatsOrder {
  id: string;
  /** ISO 8601. */
  at: string;
  mandateId: string;
  outcome: OrderOutcome;
  /** True for generated demo history, false for orders placed through the gateway. */
  synthetic: boolean;
  /** EUR ex VAT. */
  total: number;
  /** Seconds from the order waiting for a person to their decision. Null when no person decided. */
  decisionSeconds: number | null;
  /** Mean kg CO2-eq per kg over the lines that have a footprint. */
  avgCo2: number | null;
  /** Mean historical delivery reliability (0-1) over the lines that have one. */
  avgReliability: number | null;
  lines: { productId: string; name: string; total: number }[];
}

export interface StatsWeek {
  /** Monday of the week (UTC), YYYY-MM-DD. */
  week: string;
  /** Confirmed spend (auto-approved and approved orders), EUR ex VAT. */
  spend: number;
  /** The part of `spend` that comes from synthetic demo history. */
  syntheticSpend: number;
  orders: number;
}

export interface StatsTopProduct {
  productId: string;
  name: string;
  spend: number;
  orders: number;
}

/** What both stores compute: the same numbers from Postgres or from ClickHouse. */
export interface BuyerStatsCore {
  totals: { orders: number; realOrders: number; syntheticOrders: number; confirmedSpend: number };
  weeks: StatsWeek[];
  outcomes: Record<OrderOutcome, number>;
  avgDecisionSeconds: number | null;
  avgCo2PerKg: number | null;
  avgReliability: number | null;
  topProducts: StatsTopProduct[];
  /** Over all orders, whatever their outcome. */
  orderSize: { median: number; p90: number } | null;
}

export interface InfraStatus {
  name: 'kafka' | 'clickhouse';
  configured: boolean;
  /** Null when nothing has been checked: not configured, or no attempt yet. */
  ok: boolean | null;
  detail: string;
}

/** Decision events that arrived in ClickHouse through Aiven Kafka. */
export interface StatsStream {
  events: number;
  latestAt: string | null;
  byAction: Record<string, number>;
}

export interface BuyerStats extends BuyerStatsCore {
  mandateId: string;
  buyerName: string;
  generatedAt: string;
  source: 'postgres' | 'clickhouse';
  /** Null unless ClickHouse answered and its event table could be read. */
  stream: StatsStream | null;
  infra: InfraStatus[];
}

// --- models ---
// Evaluation of the models that read purchase requests (eval/results.json, served by GET /api/models).

/** One hand-labelled request in eval/requests.json. */
export interface EvalCase {
  id: string;
  text: string;
  /** Why the case is in the set. */
  note: string;
  expected: {
    /** Lower-case keywords; the product matches if the model's description contains any of them. */
    productAny: string[];
    amount: number;
    amountUnit: 'L' | 'KG' | 'unit';
    deliveryDate: string;
    requiredClaims: string[];
  };
}

export type EvalField ='product' | 'amount' | 'amountUnit' | 'deliveryDate' | 'requiredClaims';

/** timeout and error: the call failed. invalid_output: the model answered, but not with JSON that passes the schema. */
export type EvalErrorKind = 'timeout' | 'invalid_output' | 'error';

export interface EvalRun {
  caseId: string;
  ok: boolean;
  latencyMs: number;
  output: PurchaseRequest | null;
  error: string | null;
  errorKind: EvalErrorKind | null;
  /** Per field: matches the hand label. Null when the run failed. */
  correct: Record<EvalField, boolean> | null;
}

export interface EvalModelSummary {
  attempts: number;
  /** Runs whose output was JSON that passes the schema. */
  valid: number;
  validRate: number;
  /** Per field: share of all attempts (a failed run counts as wrong) that matched the label. */
  fieldAccuracy: Record<EvalField, number>;
  /** Share of all attempts with every field correct. */
  exactRate: number;
  /** Latency over the valid runs only. Null when there were none. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  errors: Record<EvalErrorKind, number>;
}

export interface EvalModelResult {
  id: string;
  label: string;
  /** The exact model id sent to the provider, when known. */
  modelId: string | null;
  /** ran: every case was attempted. not_run: no key or model id, so nothing was called. */
  status: 'ran' | 'not_run';
  /** Why a model was not run, e.g. "NVIDIA_API_KEY missing". */
  reason: string | null;
  /** When this model's runs happened (a partial rerun keeps the other models' times). */
  ranAt: string;
  summary: EvalModelSummary | null;
  runs: EvalRun[];
}

/** Do the models that answered agree on the two fields that drive deterministic quantities: amount and unit? */
export interface EvalAgreement {
  caseId: string;
  /** The request as the buyer wrote it. */
  text: string;
  /** Model id to [amount, amountUnit]; null when that model's run failed. */
  answers: Record<string, [number, string] | null>;
  /** All models that answered gave the same amount and unit. Null with fewer than two answers. */
  agree: boolean | null;
  /** Amount and unit the hand label expects. */
  expected: [number, string];
  /** Models whose amount or unit differs from the label. */
  wrong: string[];
}

export interface EvalResults {
  generatedAt: string;
  /** The date the prompt told the models it was, so "by Monday" has one right answer. */
  today: string;
  caseCount: number;
  models: EvalModelResult[];
  agreement: EvalAgreement[];
  agreementSummary: {
    /** Cases where at least two models answered. */
    comparable: number;
    agreed: number;
    /** Cases where every model that answered got amount and unit right. */
    allCorrect: number;
  };
}

// --- second opinion ---

/**
 * The first model reads the request; a second model reads it independently. Code multiplies the amount, so a disagreement
 * on amount, unit or delivery date is shown to the person before anything is ordered. It is a warning, not a mandate rule.
 */
export interface InterpretationCheck {
  /** agree, disagree, or unavailable when the second model did not answer in time. */
  status: 'agree' | 'disagree' | 'unavailable';
  secondModel: string;
  /** What each model read, one line per differing field, for example "amount: 100 vs 1000". Empty when they agree. */
  differences: string[];
  /** The second model's reading in a line, or why it was unavailable. */
  detail: string;
}
// --- receipts ---

/** A public key as WebCrypto and JWKS exchange it. Only the fields the checks use. */
export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y?: string;
  kid?: string;
}

/** What a person's device signed when it approved or declined an order. A device key is not an identity. */
export interface ApproverSignature {
  alg: 'ES256';
  payload: {
    orderId: string;
    decision: 'approve' | 'decline';
    decidedBy: string;
    note: string | null;
    /** The device's clock, not Valio's. */
    signedAt: string;
  };
  /** Base64url, 64 bytes (r then s), as WebCrypto produces it. */
  value: string;
  publicKey: PublicJwk;
}

/** An audit event as exported: every field its hash covers. */
export interface ReceiptAuditEvent {
  id: string;
  at: string;
  actor: AuditActor;
  action: AuditAction;
  mandateId: string | null;
  quoteId: string | null;
  orderId: string | null;
  summary: string;
  data: Record<string, unknown>;
  prevHash: string | null;
  hash: string | null;
}

/** An event of someone else's that sits between two events of this order in the chain: hash links only, no content. */
export interface ReceiptAuditStub {
  id: string;
  prevHash: string | null;
  hash: string | null;
  omitted: true;
}

export interface ReceiptBundle {
  version: 1;
  exportedAt: string;
  order: ExposedOrder;
  quote: ExposedQuote;
  mandate: {
    /** The fields that decide what the agent may do, as they are at `capturedAt`: mandates keep no history. */
    snapshot: Pick<
      Mandate,
      'id' | 'buyerName' | 'agentName' | 'autoApproveLimitEur' | 'maxOrderEur' | 'blockedAllergens' | 'minDeliveryReliability' | 'requireConfirmedStock' | 'maxCo2PerKg' | 'preferredOffer'
    >;
    /** SHA-256 (hex) of the canonical JSON of `snapshot`. */
    hash: string;
    capturedAt: string;
  };
  policy: { outcome: PolicyOutcome | null; reasons: string[] };
  /** The human decision, if there was one. `approverSignature` is null when the client did not sign it. */
  decision: { status: 'approved' | 'declined'; decidedBy: string; decidedAt: string; note: string | null; approverSignature: ApproverSignature | null } | null;
  audit: {
    /** Events of this quote and order, oldest first, with hash-only stubs for events in between when `linked` is true. */
    events: (ReceiptAuditEvent | ReceiptAuditStub)[];
    /** True when no event between the first and last of this order is missing from `events`, even as a stub. */
    linked: boolean;
    /** Newest event in the whole chain when the receipt was made. */
    head: { id: string; hash: string | null } | null;
  };
  /** Valio's Ed25519 signature over the canonical JSON of this bundle without `signature`. */
  signature: { alg: 'EdDSA'; keyId: string; value: string };
}

export interface ReceiptCheck {
  id: 'bundle' | 'quote' | 'match' | 'mandate' | 'audit' | 'approver';
  /** Two to four words. */
  label: string;
  /** `skip` is neither a pass nor a failure: there was nothing to check (no human decision, or it was not signed). */
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

// --- policy context ---

/** What the policy knows about the buyer's recent activity, beyond the order itself. */
export interface PolicyContext {
  /** Confirmed and pending orders of this mandate in the last 24 hours, ex VAT, not counting the order being judged. */
  spentLast24hEur?: number;
  /** How this order compares with the buyer's usual orders (see lib/deviation.ts). Any `review` finding sends it to a person. */
  deviations?: DeviationReport;
}

// --- unusual order check ---

/** `review` differs and needs a person, `info` differs but is not a reason by itself, `usual` matches the buyer's habit. */
export type DeviationResult = 'usual' | 'review' | 'info';

export interface DeviationCheck {
  id: string;
  /** "Product", "Fat per 100 g", "Quantity", "Delivery weekday" ... */
  label: string;
  /** What the buyer usually orders, with its evidence: "1,000 L (800 to 1,200)", "Monday, 12 of 12". */
  usual: string;
  thisOrder: string;
  result: DeviationResult;
  /** The Result cell: "+4.2 g", "+14%", "Different product". */
  detail?: string;
  /** Checks with the same group count as one finding (a product swap and its attribute rows). */
  group?: string;
  /** Product name, to tell the lines of an order apart. */
  line?: string;
}

export interface DeviationReport {
  /** Past orders the baseline is built from. */
  basedOn: number;
  /** False when the buyer has no standing order yet: nothing is flagged. */
  hasBaseline: boolean;
  checks: DeviationCheck[];
  /** Findings (groups) with a `review` check, and all findings. */
  differing: number;
  total: number;
  /** One plain sentence per differing finding, for the approver's summary line. */
  findings: string[];
}

/** One line of a past order. `amount` is litres or kilos (pack size times packs); `unit` is 'unit' when the size is unknown. */
export interface DeviationHistoryLine {
  productId: string;
  name: string;
  amount: number;
  unit: 'L' | 'KG' | 'unit';
  total?: number | null;
}

/** A past order of the same mandate, as the unusual-order check reads it. */
export interface DeviationHistoryOrder {
  id: string;
  /** When it was placed, ISO 8601. */
  at: string;
  /** YYYY-MM-DD. Falls back to `at` when missing. */
  deliveryDate?: string | null;
  total: number;
  lines: DeviationHistoryLine[];
  /** The check flagged it. It counts as a normal order only if a person accepted it as the new normal. */
  flagged?: boolean;
  acceptedAsNormal?: boolean;
}


// ---------------------------------------------------------------------------
// Recipe order: pasted recipe or shopping list -> lines -> matched products -> one quote
// ---------------------------------------------------------------------------

/** KG covers kg and g, L covers l, dl, cl and ml, unit covers pieces (kpl, pcs, pc, st). */
export type RecipeUnit = 'KG' | 'L' | 'unit';

/** One line of a recipe as read from the text. The amount is as written (the portions factor is applied later). */
export interface RecipeLine {
  /** The text the line was read from. */
  raw: string;
  name: string;
  /** In `unit`: grams are converted to kilograms, decilitres and millilitres to litres. */
  amount: number;
  unit: RecipeUnit;
  /** A valioaimo.fi product link given in the text. Its address names the product, so it is a strong matching hint. */
  link?: string;
  /** Who split the text into this line: the parser (code) or, as a fallback for prose, a model. Set by the reading step. */
  readBy?: RecipeReader;
}

/** code: the parser read the line. model: a model read prose the parser could not, so every such line needs a look. */
export type RecipeReader = 'code' | 'model';

export interface ParsedRecipe {
  lines: RecipeLine[];
  /** Text that could not be read as an amount with a name. Never silently dropped. */
  skipped: string[];
}

/**
 * matched: a product that fits the name. weak: the best product found fits only partly, check it.
 * not_found: nothing in Valio's range fits (water, salt and the like). unpriced: Valio gave no price in time or at all.
 */
export type RecipeMatchStatus = 'matched' | 'weak' | 'not_found' | 'unpriced';

/** A product proposed for a recipe line, with only what a buyer may see in a quote (no list price, discount, supplier, category or stock amount). */
export interface RecipeProduct {
  productId: string;
  name: string;
  brand: string | null;
  gtin: string | null;
  salesUnit: string;
  /** Kilograms or litres in one sales unit, or 1 when the line is counted in pieces. Null when it cannot be worked out. */
  packSize: number | null;
  packUnit: RecipeUnit | null;
  /** Sales units that cover the line, rounded up to the lot size. Null when there is no pack size. */
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  fulfillable: boolean;
  /** Plain reasons the line cannot be filled as asked. Exact stock is never named. */
  issues: string[];
  stock: StockView;
}

export interface RecipeLineMatch {
  /** Position of the line in the recipe, from 0. */
  index: number;
  raw: string;
  name: string;
  link?: string;
  /** Who read the line out of the text. Lines read by a model are to be checked one by one. */
  readBy: RecipeReader;
  /** As read from the text. */
  baseAmount: number;
  /** After the portions factor. This is the amount the packs were sized for. */
  amount: number;
  unit: RecipeUnit;
  status: RecipeMatchStatus;
  /** True for water and ice: not a miss, just not something to order. The status stays `not_found`. */
  notOrdered?: boolean;
  /** One plain sentence on what to check, or why nothing was found. Null when there is nothing to add. */
  note: string | null;
  proposal: RecipeProduct | null;
  /** Up to two other products, best first. */
  alternatives: RecipeProduct[];
}

export interface RecipeResult {
  lines: RecipeLineMatch[];
  /** True when a model, not the parser, read at least one line. */
  readByModel: boolean;
  skipped: string[];
  deliveryDate: string;
  multiplier: number;
  notes: string[];
}
