# Trusted Trade Agents: pitch deck

Junction 2026, Valio Aimo challenge. Seven slides, each with a 20-second speaker note. All Valio data is synthetic. The slide version is `docs/pitch-slides.html`.

---

## Slide 1. Problem

**Agents will order. Wholesalers have no safe door for them.**

- Ordering is shifting from people clicking a webshop to agents deciding.
- Today's webshop is built for people, not for agents.
- An open door can leak contract prices, exact stock and supplier data.
- It can also mean unchecked spend, allergen mistakes and a flooded back end.
- Whoever defines the interface first owns the customer relationship.

*Speaker note (20 s):* Ordering is moving from people clicking a webshop to agents making the call. A wholesaler has no safe door for them. Open it carelessly and you leak contract prices and stock, risk allergen mistakes, and flood a rate-limited back end. Whoever defines this interface first owns the customer.

---

## Slide 2. Solution

**A gateway where the model reads and code decides.**

- A buyer's agent sends a plain request: "1,000 litres of lactose-free milk by Monday".
- The gateway returns offers, then one fixed price signed by Valio.
- The buyer's mandate decides: confirmed, sent to a person, or rejected.
- Substitutes come only from Valio's own list and always need sign-off.
- Every step goes into a plain-language, hash-chained record.

*Speaker note (20 s):* The buyer's agent asks in plain language. Our gateway finds products, prices only a short list, and offers the cheapest, the most reliable and the lowest-carbon option. Valio signs one fixed price. The buyer's mandate then decides: confirm, ask a person, or reject. A model reads the request. Code decides everything else.

---

## Slide 3. Live Demo Flow

**Four requests, four outcomes.** Flow: request, offers, signed quote, order, approval, record.

- Hotel, 1,000 L lactose-free milk: goes to a person.
- Hotel, 100 L: confirmed automatically.
- School, 20 kg granola: nut-risk products are hidden before pricing.
- School, 100 kg granola: stock is short, so a split or a substitute needs sign-off.

*Speaker note (20 s):* Four requests, two buyers. The hotel's big milk order goes to a person; its small top-up confirms by itself. The school's mandate blocks nuts, so risky granola is hidden before we even price it. When school stock runs short, we split the order or offer a Valio-listed substitute, and a person signs off.

---

## Slide 4. Data Firewall and Governance

**What the agent sees is decided in code.**

- Quotes and orders never carry list price, discount, supplier or exact stock (`exposure.ts`).
- The mandate is code: spend limits, blocked allergens, reliability, CO2, confirmed stock (`policy.ts`).
- Missing allergen data counts as unknown, never as safe.
- Quotes are Ed25519-signed. The record is hash-chained and tamper-evident.
- Agents have no approve tool. Approval stays human.

*Speaker note (20 s):* Every response to an agent passes through an exposure filter, so list price, discount, supplier and exact stock stay inside Valio. The mandate is plain code with a reason for every rule. No allergen data means unknown, so a person looks. Quotes are signed, the record is hash-chained, and agents cannot approve anything.

---

## Slide 5. Open Standards and MCP

**Open interfaces, not a platform's black box.**

- MCP server at `/api/mcp`: seven tools, no approve, no mandate editing.
- REST with an OpenAPI file. A test fails if routes and spec drift apart.
- Any agent can verify a quote with Valio's public key at `/.well-known/jwks.json`.
- `Idempotency-Key` on orders. Rate-limit headers on REST.
- Honest limit: no per-agent login yet. Callers pass a mandate id.

*Speaker note (20 s):* The same functions are open two ways: an MCP server any agent can plug into, and a REST API with an OpenAPI spec. Quotes verify against a public JWKS key, with no call back to Valio. Retried orders are safe. The honest gap: agents are not authenticated yet; that is the next step.

---

## Slide 6. Tech Stack and Sponsor Deep-Dives

**Each partner does a real job.**

- Aiven: Postgres with pgvector, Valkey, Kafka, ClickHouse snapshot.
- Oxylabs: live allergen, label and recall checks, with quotes and source URLs.
- Gemma and Gemini read the request twice. Code compares.
- Nemotron reads long pages and picks products. Featherless Qwen is the fallback.
- Models interpret. Code decides.

Evaluation line (from `app/eval/results.json`, 12 labelled requests, exact match on all fields): Gemma 12, Gemini 3.8 Flash 12, Nemotron 11, Qwen 0 (every weekday date a day late; code now sets weekdays).

*Speaker note (20 s):* Aiven holds the catalog, quotes, orders and the audit chain in Postgres, protects Valio's API with Valkey, streams decision events to Kafka and answers stats from ClickHouse. Oxylabs checks allergens and recalls on the live web, with quotes. Gemma and Gemini read each request; Nemotron reads long pages. None of them decides.

---

## Slide 7. Commercial Value for Valio Aimo

**Why Valio should own this door.**

- List price, discount and supplier stay inside Valio. Agents get one fixed, signed price.
- Valio sets the rules agents work under: limits, approvals, substitutes.
- The back end is protected: shortlist-only pricing, caching, per-buyer rate limits.
- Buyer and Valio share one readable decision record.
- One standard door for any buyer's agent, instead of third-party aggregators.

*Speaker note (20 s):* If agents order through someone else's platform, that platform sees the prices and owns the relationship. Here Valio sets what agents see, what they may decide and what needs a person, and both sides get the record. This is a prototype on synthetic data. Orders are not yet sent to Valio's order system.

---

## Sponsor claim status (internal, not for slides)

- **Context.dev: not integrated.** No calls and no key anywhere in the repo. Do not list it as used.
- **CRACI: not integrated.** No GitHub Actions workflow, nothing runs on `runs-on: craci`. There is no `.github` folder. Do not list it as used.
- Slides and `pitch-slides.html` name only real integrations: Aiven, Oxylabs, Gemma, Gemini, Nemotron, Featherless.
- Aiven wording: Kafka receives decision events (topic `trade-events`, `events.ts`). The Kafka-to-ClickHouse integration is **not enabled** (Aiven's Free Kafka plan does not support it). ClickHouse answers the stats page from a loaded snapshot (`scripts/clickhouse-backfill.mts`). Say "snapshot", never "live pipeline".
- Semantic search covers only part of the catalog (17,546 products in the data file; Gemini free embedding cap). The embedded count is not stored in the repo, so no number is quoted.
- Gemma reads requests; it is not a policy or guardrail evaluator. Policy is `policy.ts`.
- Nemotron: used for page extraction in `verify.ts` (allergen, label, ingredient, origin statements) and for picking matching products from the shortlist in `request.ts`. The recall check (`recall.ts`) uses the Gemma-first chain, not Nemotron. Do not say Nemotron reads recall notices.
- Say out loud if asked: orders are stored in our database only; no per-agent authentication; audit is tamper-evident, not tamper-proof.

---

## Demo script

Open `/` (buyer flow). Use the four scenario buttons. Check each outcome on screen before the pitch: live prices and stock decide the exact numbers, and `policy.ts` prints the reason for every decision.

1. **Hotel, 1,000 litres lactose-free milk (mandate `demo-hotel`: auto-approve up to 500 EUR, reject above 5,000 EUR).**
   Say: "Two models read the request, they agree, and code resolves 'Monday'." Show the offers (cheapest, most reliable, lowest CO2), then the signed quote. Place the order. It goes to a person because the mandate does not let the agent decide alone; read the reason on screen. Open `/approvals`, approve, and open `/audit`.
2. **Hotel, 100 litres top-up.**
   Say: "Same buyer, smaller order." The order is confirmed automatically within the mandate. Point at the record entry.
3. **School, 20 kg granola (mandate `demo-school`: blocks tree nuts and peanuts, needs 90% delivery reliability, confirmed stock, auto-approve up to 300 EUR).**
   Say: "The request never mentions nuts. The mandate does." Point at the line that says how many matching products the mandate hid. Show the live check results with quotes and source links if they ran. A product with no allergen data goes to a person, not through.
4. **School, 100 kg granola (short stock).**
   Say: "No single product covers it." The gateway splits across confirmed stock, or offers Valio-listed substitutes. A substitute always goes to a person. A split goes to a person when any other rule fires (limit, unverified allergen data).

Close with three clicks:
- `/exposure`: the same quote as Valio holds it and as the agent gets it, side by side.
- `/audit`: verify the hash chain, then use the tamper button and verify again to show detection. (Demo actions are refused in production unless `ALLOW_DEMO_RESET=true`.)
- `/models`: the 12-request evaluation, including Qwen's wrong dates.
