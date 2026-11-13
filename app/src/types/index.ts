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
}

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
// Audit trail
// ---------------------------------------------------------------------------

export type AuditActor = 'agent' | 'human' | 'system';

export type AuditAction =
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
}

/** Body of every non-2xx API response. */
export interface ApiError {
  error: string;
}
