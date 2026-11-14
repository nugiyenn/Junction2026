# Judge Q&A prep sheet

Trusted Trade Agents, Junction 2026, Valio Aimo challenge. Short answers, true to the code. File paths are under `app/src/lib/` unless stated. All Valio data is synthetic.

One rule for every answer: the model interprets, code decides. If a judge asks "what stops the model from approving something?", the answer is that no model output reaches `policy.ts`. Models produce a structured reading of a request or a page; quantities, prices, policy and approval are code.

---

## 1. Valio commercial and online sales judges

**Contract pricing: does the agent get the customer's net price or the list price?**
The agent gets one fixed unit price per line, taken from the `catalogPrice` that Valio's price API returns (`purchasing.ts`, `buildQuoteLine`). List price, the discount percentage and whether a customer-specific price was found are stored in `QuoteLine.internal` and never sent to agents. Honest limit: price lookups use one fixed customer number (`valio.ts`, `DEFAULT_CUSTOMER`), and Valio's mock ignores it, so the demo cannot show two customers paying different prices. Mapping each mandate to a real customer number is the first thing we would add. The cache key already includes the customer, so prices would not mix.

**Margin protection: what does the agent never see?**
In quote and order responses it never sees list price, discount, whether a net price was found, exact stock quantity, supplier name or Valio's internal category. `exposure.ts` removes them, and `tests/exposure.test.mts` covers it. The `/exposure` page shows both views side by side. Honest gaps: (1) the stock view says whether the requested quantity can be filled, so an agent could probe with different quantities and narrow down stock; per-mandate rate limits slow that, they do not stop it. (2) The static catalog search (`/api/products/search`, MCP `search_products`) used to return `vendorName` and `category`; it now passes products through `exposeProduct` in `exposure.ts`, which removes both, and `tests/exposure.test.mts` covers it. (3) `candidates[].reasons` in `/api/requests` used to be able to contain "Only N units available"; `request.ts` now runs those reasons through the same `sanitizeIssue` that quotes and orders use.

**Why should we trust an agent's substitution? Will customers accept it?**
We never invent substitutes. A line can only be marked as a substitute if Valio's own catalog lists that product as a replacement for the original (`purchasing.ts`, `createQuote` rejects anything else). Candidates must carry every required claim and must not contain or possibly contain a blocked allergen (`request.ts`, `findSubstitutes`). Substitutes are offered only when no single product and no split can fill the request, at most two are shown, and the mandate always sends an order with a substitute to a person (`policy.ts`). We do not do recipe-aware substitution; ranking is by price.

**Customer lock-in: does this lock buyers in?**
Not through the interface. It is open on purpose: MCP, REST with an OpenAPI file, and signed quotes any agent can verify. A buyer can point a different agent at it, and Valio can serve any agent. Stickiness would come from the things Valio already has: contract prices, delivery reliability data, and a mandate and decision record that live with the relationship. We have not built mandate export, so do not promise portability.

**Why should Valio own the gateway instead of a third-party aggregator?**
An aggregator sits between Valio and the buyer. It would see net prices across customers, could route orders to competitors, and Valio could not enforce what the agent may decide. With Valio's own gateway, Valio decides what an agent sees (`exposure.ts`), signs the price it will honour (`signing.ts`), protects its back end (shortlist-only pricing, cache, rate limits), and keeps the record. An aggregator could still become a client of the gateway; that is a commercial and authentication question we have not solved (see section 4).

**Is the price guaranteed? What if stock changes?**
A quote is signed with Ed25519 and held for 15 minutes, or until the earliest order cut-off among its lines, whichever comes first (`purchasing.ts`, `QUOTE_TTL_MS`). At order time the signature is verified again and a changed quote is refused. Stock can be up to 15 seconds old because availability is cached (`valio.ts`). Valio's real order system would still have the last word on delivery.

**Does an order reach Valio's ERP?**
No. Valio's mock API has no order endpoint, so orders exist only in our database. The prototype shows the decision logic and the record, not the fulfilment.

---

## 2. Valio IT and data governance judges

**How do you protect Valio's rate-limited price and availability APIs?**
Four layers. (1) Only a shortlist is priced: search runs in Aiven first, a model picks matches from 40 catalog lines, and at most 5 products go to Valio (`request.ts`, `SHORTLIST_SIZE`). Valio is never queried across the catalog. (2) Responses are cached in Valkey for 30 s (price) and 15 s (availability), keyed by customer, date and the set of product ids (`cache.ts`, `valio.ts`). (3) Each mandate has fixed-window limits, by default 20 requests, 60 quotes and 30 orders per minute, configurable by env (`ratelimit.ts`). (4) Valio calls time out after 20 s and a 429 from Valio is passed on with `Retry-After`. Honest limit: if Valkey is down, caching and limits switch off and requests go straight through (fail-open, `cache.ts`, `withKV`).

**How is confidential data redacted?**
`exposure.ts` is pure code with no database access. `exposeQuote` and `exposeOrder` strip `internal` (list price, discount, supplier, category) and the exact stock number, replace it with `canFill`, a confidence value and an "ample or limited" level, and rewrite "Only N available" messages. Every REST route and MCP tool that returns a quote or order calls them. The side-by-side view endpoint (`/api/quotes/:id/views`) is refused in production. Known gaps are listed in section 1.

**What happens when allergen data is missing (null)?**
It counts as unknown, not safe. `policy.ts`, `hasNoAllergenData`: if the mandate blocks allergens and a product has no contains, may-contain or free-from entry at all, the order goes to a person. The only way to clear that automatically is a stored live-web check that has a verified "free from" statement for every blocked allergen. A source that says "contains" rejects the order; "may contain" or any disagreement with the catalog sends it to a person. Order judging reads stored checks only and makes no live call (`purchasing.ts`, `judgeQuote`).

**How do the live checks work, and what stops a model from making things up?**
Oxylabs finds and reads pages (`verify.ts`, `oxylabs.ts`). A model extracts statements, and each one must carry a passage copied from the page. Code keeps a statement only if that passage appears on the page (`evidence.ts`, `evidenceAppears`) and the page is about the product (GTIN or enough distinctive name words). Each result stores the source URL and the Oxylabs request id, and is reused for 24 hours.

**Is the audit log immutable?**
No. It is tamper-evident. Each event stores a SHA-256 hash over the previous hash and its own canonical content (`chain.ts`); writes run under a Postgres advisory lock so the chain cannot fork (`audit.ts`). `GET /api/audit/verify` recomputes the whole chain and names the first event that was changed, removed or reordered. Limits: someone with write access to the database could rewrite every event and recompute every hash. Publishing the `head` hash elsewhere is what would expose that, and removal of the newest events, and we do not automate it yet. Kafka events carry each event's hash, which gives a second copy, but that is on Aiven too. The demo has a tamper button (`/api/demo/tamper`), disabled in production unless `ALLOW_DEMO_RESET=true`.

**MCP security: what can an agent do, and what can it not?**
`/api/mcp` is a stateless JSON-RPC endpoint (`mcp.ts`, `mcp-tools.ts`). Seven tools: `search_products`, `request_offers`, `create_quote`, `place_order`, `get_order_status`, `verify_product`, `get_mandate`. There is deliberately no approve, decline or mandate-editing tool; a test checks an `approve_order` call fails. Inputs are validated with zod, cross-origin browser requests are refused, and `request_offers`, `create_quote` and `place_order` are rate limited per mandate. What is missing: agent authentication. The caller passes a mandate id and that is its identity. Also, `search_products` has no rate limit (`verify_product` and the REST verify route share a 12 per minute limit in `ratelimit.ts`), and the REST routes for approval (`POST /api/orders/:id/decision`) and mandate changes (`PATCH /api/mandates/:id`) are unauthenticated; "agents cannot approve" is true of the MCP surface, not yet enforced by credentials on REST.

**How are quotes signed, and can an agent verify them?**
Ed25519 over a canonical serialisation of the terms: quote id, mandate, delivery date, currency, each line's product, quantity, unit, price and total, the totals, and the created and expiry times (`offer-signature.ts`, `offerPayload`). Public keys are published as JWK at `/.well-known/jwks.json`, and `signature.keyId` names the key (`signing.ts`). An agent can verify offline. Limits: the private key is stored in a database table (a real deployment needs a KMS or HSM, as the code comment says), there is no rotation process, and the signature covers commercial terms, not the stock confidence or policy outcome.

**How do you stop duplicate orders?**
A unique constraint on the quote id means a quote can be ordered once (409 otherwise). On REST, an `Idempotency-Key` header makes a retry return the first order with `Idempotent-Replayed: true` (`idempotency.ts`, stored in Valkey for 24 h); that part needs Valkey. The MCP `place_order` tool has no idempotency key, only the unique constraint.

**What does the Kafka stream carry?**
Only whitelisted fields: id, time, actor, action, mandate id, quote id, order id and hash (`events.ts`, `toTradeEvent`). No summary text, no prices. Publishing is best effort with a 4 s timeout and never blocks or fails an order, so events can be lost.

---

## 3. Sponsor judges

### Aiven

- **Where it runs:** Postgres with pgvector (`db.ts`, `catalog.ts`, `purchasing.ts`, `audit.ts`, `signing.ts`, `verify.ts`, `recall.ts`, schema in `scripts/seed.mts`); Valkey (`cache.ts`, `ratelimit.ts`, `idempotency.ts`; `GET /api/health`); Kafka (`events.ts`, topic `trade-events`); ClickHouse (`clickhouse.ts`, `stats.ts`, `scripts/clickhouse-backfill.mts`; `GET /api/stats`, `/stats`).
- **Why more than a thin wrapper:** Postgres holds the system of record: 17,546 catalog products, mandates, signed quotes, orders, stored web checks, the signing key and the hash-chained audit record written under an advisory lock. Search is hybrid (keyword full-text and pgvector, merged by reciprocal rank fusion, with SQL filters for claims and allergens). Valkey protects Valio's API and makes orders idempotent. Kafka carries decision events. ClickHouse answers the stats page. Each has its own failure behaviour and is shown honestly on `/stats` and `/api/health`.
- **Hard follow-ups:**
  - *Is the Kafka to ClickHouse pipeline live?* No. Aiven's Free Kafka plan does not support the integration, so it is not enabled. Events are published to Kafka and can be read in the Aiven console. ClickHouse holds an orders snapshot loaded by script, so we call it a snapshot. The stats page says which store answered and falls back to Postgres.
  - *Is every product searchable semantically?* No. Only part of the catalog has embeddings because Gemini's free embedding tier caps how many texts we can embed per day (`scripts/seed.mts`). Keyword search covers the rest, and search falls back to keyword-only if embedding fails. We do not quote a count because it is not stored in the repo.
  - *Why not only Postgres?* It could do the cache and counters, but we wanted the protective layer off the transactional database and failing open without taking orders down. That is a design choice, not a hard need at this scale.
  - *TLS?* Connections are encrypted but the Aiven CA is not verified (`rejectUnauthorized: false` in `db.ts` and `cache.ts`). Fix: pin the CA.
  - *Free-tier limits?* Small connection pool (3 per instance), Valkey and Kafka on free plans, and each Kafka publish opens a short-lived producer.

### Oxylabs

- **Where it runs:** `oxylabs.ts` (client), `verify.ts` (allergen and label claims), `recall.ts` and `recall-core.ts` (Ruokavirasto recall notices), `live-checks.ts` (budget and concurrency), `evidence.ts` (checks on what models say). Endpoints: `POST /api/products/{id}/verify`, MCP `verify_product`, and automatically inside `POST /api/requests` when the request has claims or the mandate blocks allergens.
- **Why more than a thin wrapper:** `/search` finds sources and `/scrape` reads them. Empty or skeletal pages follow a retry ladder: plain scrape, then `run_js`, then `run_js` with the country taken from the site's TLD. Calls retry with backoff and jitter, errors are typed, the key is redacted from every error, and each statement keeps its source URL and request id. Results change the decision: a "contains" source rejects, a contradiction or a recall match sends the order to a person, a verified "free from" clears unverified data. Stored results are reused for 24 hours. Recall search is restricted to `site:ruokavirasto.fi`, filtered to individual notice pages, detects Ruokavirasto's soft 404 pages, and requires the quote to name the brand and product.
- **Hard follow-ups:**
  - *What if the top pages are wrong?* We read the top two search results per product. If they are not about the product (no GTIN, too few name words), they are skipped and the check says "no evidence", which does not clear anything.
  - *Latency?* A request with live checks waits for up to a 90 s budget, two products at a time, for at most three products. Anything skipped is named in the result's notes and never fails the request.
  - *Recall coverage?* Finnish Food Authority notices only, in Finnish. It is a check, not a guarantee.
  - *At order time?* No live call. Orders read the stored check. A product never checked is judged on catalog data alone.
  - *Quota?* A 429 after three attempts surfaces as a 502 with a plain message.

### Gemma (`gemma-4-26b-a4b-it`)

- **Where it runs:** `llm.ts` (`runGemmaStructured`, `runOpenModelStructured`), `request.ts` (`interpretRequest`, first reader of the request). It is also first in the fallback chain for product picking and page reading, and `recall.ts` reads notices through the same chain.
- **Why more than a thin wrapper:** strict zod schema on the output, Gemma's reasoning block stripped, a 45 s deadline, then it is skipped for two minutes (tracked per scope) and Featherless answers; the audit summary names the model that actually answered. It is evaluated in the open: 12 of 12 requests exact, in `app/eval/results.json` and `/models`.
- **Hard follow-ups:**
  - *Is Gemma your guardrail?* No. Gemma only reads the request. Policy is deterministic code in `policy.ts`, by design.
  - *Latency?* Slow on the free tier: median 12,384 ms, slowest 17,105 ms over the 12 requests. That is why page reading and product picking go to Nemotron first, and why the Gemini second reader runs in parallel with Gemma instead of after it.
  - *What if Gemma is busy?* Featherless Qwen answers and the label says so. Qwen's weakness is dates (see Featherless), which code now settles.

### Gemini 3.8 Flash (second reader)

- **Where it runs:** `request.ts` (`interpretRequest`, `SECOND_READER`), `interpret.ts` (`compareInterpretations`). The result appears as `interpretationCheck` in `POST /api/requests`, in the audit summary, and as a note when the two disagree.
- **Why more than a thin wrapper:** it is a second, independent reading of the same request with the same prompt and schema. Code compares the three fields it multiplies or schedules with (amount, unit, delivery date) and warns on disagreement. Weekday dates are settled by code for both readings so the comparison is fair. Evaluation: 12 of 12 exact, median 3,443 ms, slowest 5,798 ms.
- **Hard follow-ups:**
  - *Does disagreement block the order?* No. It is advisory: a "check before ordering" note and an audit entry. Policy does not use it. A hard gate would be a small change.
  - *How independent is it?* It is a different model, but it is served through the same Google API and key as Gemma, so an outage or quota problem can hit both. Both could also make the same mistake.
  - *Does it always answer?* It has a 15 s timeout. If it fails, the request continues and the check says "unavailable".
  - *Also used for:* Gemini embeddings for semantic search. Gemini 3.1 Flash-Lite was evaluated only: 3 of 12 valid answers, not in the request path.

### Nemotron (`nvidia/nemotron-3.5-super-vl-120b-a12b`)

- **Where it runs:** `llm.ts` (`runNemotronStructured`, `runExtractionModelStructured`), used in `verify.ts` (extracting allergen, label, ingredient and origin statements from long pages) and `request.ts` (`pickMatches`, choosing matching products from the search results). Text only; we do not send images or video. Note: the recall check (`recall.ts`) uses the Gemma-first chain, not Nemotron.
- **Why more than a thin wrapper:** JSON mode with reasoning switched off, retry with backoff on 429 and 5xx (honouring `Retry-After`), one extra attempt when the output is not usable JSON, then fall back to Gemma and Qwen. Its output is never trusted by itself: each extracted statement needs a quote that code finds on the page. Tests with a mocked transport are in `tests/nemotron.test.mts`.
- **Hard follow-ups:**
  - *How good is it?* On our 12-request evaluation: all 12 valid, 11 exact, median 661 ms, slowest 1,702 ms. The miss added a VEGAN claim to "ten cases of oat milk". That set is small and tests request reading, not page extraction. Page extraction quality is protected by the quote check, not measured separately.
  - *Why is it first for pages?* Speed: Gemma did not answer the long product-picking prompt within 45 s in live runs, Nemotron answers in about a second.
  - *Free tier?* About 40 requests per minute on NVIDIA's free endpoint, which the retry logic respects. It is an early-access model; that is a risk for anything beyond a demo.

### Featherless (Qwen 2.5 72B, then 32B)

- **Where it runs:** `llm.ts` (`runFeatherlessValidation`, the fallback inside `runOpenModelStructured`). Setting `LLM_PRIMARY=featherless` puts it first.
- **Why more than a thin wrapper:** two sizes in a chain at temperature 0, labelled in the audit record when used, switchable as primary, and part of the evaluation. It is what keeps requests working when Gemma is slow.
- **Hard follow-ups:**
  - *Qwen's dates?* In our evaluation Qwen got the delivery date wrong on all 12 requests (0 of 12), always a day late on weekday phrases, and read "2 tonnia" as 2 kg (amount correct on 11 of 12). Those scores are the raw model output, kept as measured. In the product, `weekdayDate` in `interpret.ts` now settles weekday names in code. The tonnes mistake is not fixed by code; the Gemini second reader would flag it as a disagreement.
  - *Is it just a checkbox sponsor?* It is a fallback and in normal operation it is rarely the answering model. We would say so.
  - *Output length?* Calls are capped at 512 tokens (Featherless requires a cap), which is enough for a request reading but could cut a long page extraction short.

### Context.dev and CRACI

- **Context.dev:** not integrated. There are no calls and no key in the repo. If we used it, it would plug in next to Oxylabs in `verify.ts`: fetching clean product or brand pages for a known domain, feeding the same extract-then-verify-quote step. We would not claim it.
- **CRACI:** not integrated. There is no GitHub Actions workflow and nothing runs on a `craci` runner. If we used it, it would run `npm test` and the OpenAPI drift test on every push, and a scheduled job could run the model evaluation (`scripts/eval-models.mts`). We would not claim it.

---

## 4. Questions we should expect about limits

**Do orders go to Valio?** No. The mock API has no order endpoint, so orders live in our database with a status and a reason. That is enough to show the decision, approval and record. Forwarding is the integration Valio's team would write.

**Who is the agent? Where is authentication?** There is none yet. The caller passes a mandate id. Next step: a bearer token per mandate (or per agent), checked on every route and tool, with scopes so an agent token cannot call the approval or mandate-edit endpoints, and an approver identity instead of a free-text `decidedBy`. Until then, "agents cannot approve" holds for the MCP surface only.

**Is semantic search complete?** No. Only part of the catalog is embedded because of the Gemini free-tier cap. Keyword search covers all 17,546 products, and the answer says whether semantic search ran.

**Is the data real?** No. The catalog, prices, availability and the buyers' order history (`order_history`, labelled "Demo history" on `/stats`) are synthetic. The mandates `demo-hotel` and `demo-school` are demo buyers.

**Is the audit log tamper-proof?** No, tamper-evident. See section 2.

**Can an agent work out Valio's stock or supplier?** Not from quotes, orders, catalog search or candidate reasons: all of them pass through the exposure functions, and the tests check it. What remains is probing: because the stock view says whether a requested quantity can be filled, an agent could try different quantities and narrow stock down. Per-mandate rate limits slow that; they do not stop it.

**Does a split need approval?** Not by itself. A split goes to a person only if another rule fires (above the auto-approve limit, unverified allergen data, low reliability, unconfirmed stock). A substitute always goes to a person.

**How do you size quantities?** Per sales unit, from the price per litre or kilo and the unit price, rounded to two significant figures (`request.ts`, `roundPackSize`), and rounded up to the allowed lot size. Odd pack sizes could be slightly off; Valio's real data would let us use exact pack sizes.

**How long does a request take?** Reading takes a few seconds to about 17 s on Gemma. A request with live checks can take up to about 90 s more. The route allows 300 s. Slow external calls have timeouts and fail with plain messages.

**What if Valkey or Kafka is down?** Valkey: caching, limits and idempotency switch off and everything else keeps working. Kafka: events are dropped and the order is unaffected. Both are shown as such on `/api/health` and `/stats`, never as healthy.

**Are the evaluation numbers solid?** They are real measurements from `app/eval/results.json`, but the set is 12 hand-labelled requests, one run per model. Good enough to choose a reading chain, not a benchmark.
