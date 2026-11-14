# Trusted Trade Agents: pitch deck

Junction 2026, Valio Aimo challenge. Seven slides, each with a 20-second speaker note. All Valio data is synthetic. The slide version is `docs/pitch-slides.html`.

The thesis in one line: **trust you can verify, autonomy you can earn.** A mandate the buyer sets. Autonomy that grows only when people keep approving. Receipts anyone can check. Proof under attack. An input kitchen staff can use.

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

**Trust you can verify, autonomy you can earn.**

- A buyer's agent sends a plain request: "1,000 litres of lactose-free milk by Monday".
- The gateway returns offers, then one fixed price signed by Valio.
- The buyer's mandate decides: confirmed, sent to a person, or rejected.
- Autonomy is earned: code proposes a higher limit after people keep approving, and a person accepts.
- Every order gets a receipt anyone can verify, and a hash-chained record behind it.

*Speaker note (20 s):* The buyer's agent asks in plain language. Our gateway offers products and Valio signs one fixed price. The buyer's mandate decides: confirm, ask a person, or reject. A model reads the request; code decides everything else. The limit only rises when people have approved enough orders, and every order leaves a receipt you can check yourself.

---

## Slide 3. Live Demo Flow

**Four requests, four outcomes, then four extras.** Flow: request, offers, signed quote, order, approval, record.

- Hotel, 1,000 L lactose-free milk: goes to a person.
- Hotel, 100 L: confirmed automatically.
- School, 20 kg granola: nut-risk products are hidden before pricing.
- School, 100 kg granola: stock is short, so a split or a substitute needs sign-off.
- Extras: a receipt checked in the browser, the red team page, an order from a photo, earned autonomy.

*Speaker note (20 s):* Four requests, two buyers. The hotel's big milk order goes to a person; its small top-up confirms by itself. The school's mandate blocks nuts, so risky granola is hidden before we price it, and short stock means a split or a substitute with sign-off. Then four extras: verify a receipt, attack the system, order from a photo, and earn a higher limit.

---

## Slide 4. Data Firewall and Governance

**What the agent sees is decided in code, and we attack it ourselves.**

- Quotes and orders never carry list price, discount, supplier or exact stock. Catalog search hides supplier and internal category (`exposure.ts`).
- The mandate is code (`policy.ts`). A rolling 24-hour rule sends many small orders to a person.
- Missing allergen data counts as unknown. Any page can make an order stricter; only the maker or a known grocery or wholesale site can loosen it.
- Approving and editing a mandate need an approver key when one is set (`auth.ts`). MCP has no approve tool.
- `/red-team` runs ten attacks against the real checks and reports blocked, allowed or not protected.

*Speaker note (20 s):* Every response passes an exposure filter, so list price, discount, supplier and exact stock stay inside Valio. The mandate is plain code, including a rolling 24-hour rule. Unknown allergen data goes to a person, and only trusted sources can clear it. Approval needs a key. And a red team page attacks all of this and shows the gaps too.

---

## Slide 5. Open Standards and MCP

**Open interfaces, and proof you can check yourself.**

- MCP server at `/api/mcp`: seven tools, no approve, no mandate editing. REST with an OpenAPI file; a test fails if routes and spec drift apart.
- Any agent can verify a quote with Valio's public key at `/.well-known/jwks.json`.
- Each order has a signed receipt. `/verify` runs six checks in the browser with WebCrypto.
- `Idempotency-Key` on orders. Rate-limit headers on REST.
- Honest limit: the approver key exists, per-agent login does not. Callers pass a mandate id.

*Speaker note (20 s):* The same functions are open two ways: an MCP server any agent can plug into, and a REST API with an OpenAPI spec. Quotes verify against a public key. Each order has a receipt, and the verify page checks it in your browser: quote, mandate, record, human signature. The honest gap: agents are not individually authenticated yet.

---

## Slide 6. Tech Stack and Sponsor Deep-Dives

**Each partner does a real job.**

- Aiven: Postgres with pgvector, Valkey, Kafka, ClickHouse snapshot.
- Oxylabs: live allergen, label and recall checks, with quotes and source URLs.
- Gemma reads the request, Gemini reads it again, code compares.
- Nemotron picks products, reads long pages and reads photos of lists. Featherless Qwen is the fallback.
- Models interpret. Code decides.

Evaluation line (from `app/eval/results.json`, 12 labelled requests, exact match on all fields): Gemma 12 of 12 (median 12.4 s), Gemini 3.8 Flash 12 of 12 (3.4 s), Nemotron 11 of 12 (0.7 s), Qwen 0 of 12 (raw delivery date wrong on all 12; code now sets weekdays). Gemini 3.1 Flash-Lite gave 3 valid answers of 12 and is not used.

*Speaker note (20 s):* Aiven holds the catalog, quotes, orders and the audit chain in Postgres, protects Valio's API with Valkey, streams decision events to Kafka and answers stats from ClickHouse. Oxylabs checks allergens and recalls on the live web, with quotes. Gemma and Gemini read each request; Nemotron picks products and reads pages and photos. None of them decides.

---

## Slide 7. Commercial Value for Valio Aimo

**Why Valio should own this door.**

- List price, discount and supplier stay inside Valio. Agents get one fixed, signed price.
- Valio sets the rules agents work under, and autonomy grows only when a person accepts it.
- The back end is protected: shortlist-only pricing, caching, per-buyer rate limits, time limits on every call.
- Buyer and Valio share one decision record and receipts either side can verify.
- One standard door for any buyer's agent, and an order can start from a photo or a spoken line.

*Speaker note (20 s):* If agents order through someone else's platform, that platform sees the prices and owns the relationship. Here Valio sets what agents see, what they may decide and what needs a person, and both sides hold a receipt. Kitchen staff can start an order from a photo. This is a prototype on synthetic data; orders are not yet sent to Valio's order system.

---

## Sponsor claim status (internal, not for slides)

- **Context.dev: not integrated.** No calls and no key anywhere in the repo. Do not list it as used.
- **CRACI: not integrated.** No GitHub Actions workflow, nothing runs on `runs-on: craci`. There is no `.github` folder. Do not list it as used.
- Slides and `pitch-slides.html` name only real integrations: Aiven, Oxylabs, Gemma, Gemini, Nemotron, Featherless.
- Aiven wording: Kafka receives decision events (topic `trade-events`, `events.ts`). The Kafka-to-ClickHouse integration is **not enabled** (Aiven's Free Kafka plan does not support it). ClickHouse answers the stats page from a loaded snapshot (`scripts/clickhouse-backfill.mts`). Say "snapshot", never "live pipeline".
- Semantic search covers only part of the catalog (17,546 products in the data file; Gemini free embedding cap). The embedded count is not stored in the repo, so no number is quoted.
- Gemma reads requests; it is not a policy or guardrail evaluator. Policy is `policy.ts`.
- Gemma and Gemini share the Google API and key, so the second reader is not fully independent. Say so if asked.
- Nemotron: page extraction in `verify.ts` (allergen, label, ingredient, origin statements), picking matching products in `request.ts`, and reading photos in `vision.ts` (order intake). The recall check (`recall.ts`) uses the Gemma-first chain, not Nemotron. Do not say Nemotron reads recall notices.
- Look: Valio Aimo's own colours (petrol, lime, ink, grey) read from valioaimo.fi. The app does not use Valio's logo.
- Say out loud if asked:
  - Orders are stored in our database only.
  - There is an approver key (when `APPROVER_KEY` is set) but no per-agent authentication; bearer tokens per mandate are not built.
  - The audit record and receipts are tamper-evident, not tamper-proof. A device key is not an identity, and there is no key registry.
  - The red team found one gap we did not fix: a planted sentence on a trusted site would still clear an unknown allergen. Fixing it would need two independent sources.
  - Two orders placed at the same moment are not locked against each other for the rolling 24-hour rule.
  - Stock can still be probed by trying quantities; rate limits slow that, they do not stop it.
  - The history behind earned autonomy is synthetic and labelled so on the page.
  - Photo reading results are from single runs. Dictation uses the browser's speech API and was not tested.

---

## Demo script

Open `/` (buyer flow). Use the four scenario buttons. Check each outcome on screen before the pitch: live prices, stock and model answers vary from run to run, so rehearse the whole script, including the extras. `policy.ts` prints the reason for every decision.

Before the pitch: check `/api/health` says `approverKeyRequired: true` (otherwise the approve-without-key attack reports "not protected"), have the approver key ready (the browser asks once per tab), and confirm the seeded mandates `demo-redteam` and `demo-autonomy` exist.

1. **Hotel, 1,000 litres lactose-free milk (mandate `demo-hotel`: auto-approve up to 500 EUR, reject above 5,000 EUR).**
   Say: "Two models read the request, they agree, and code resolves 'Monday'." Show the offers (cheapest, most reliable, lowest CO2), then the signed quote. Place the order. It goes to a person because the mandate does not let the agent decide alone; read the reason on screen. Open `/approvals`, approve (enter the approver key if asked), and open `/audit`.
2. **Hotel, 100 litres top-up.**
   Say: "Same buyer, smaller order." The order is confirmed automatically within the mandate. Point at the record entry.
3. **School, 20 kg granola (mandate `demo-school`: blocks tree nuts and peanuts, needs 90% delivery reliability, confirmed stock, auto-approve up to 300 EUR).**
   Say: "The request never mentions nuts. The mandate does." Point at the line that says how many matching products the mandate hid. Show the live check results with quotes and source links if they ran. A product with no allergen data goes to a person, not through, unless a trusted source says it is free from the allergen.
4. **School, 100 kg granola (short stock).**
   Say: "No single product covers it." The gateway splits across confirmed stock, or offers Valio-listed substitutes. A substitute always goes to a person. A split goes to a person when any other rule fires (limit, unverified allergen data).

Extras (about a minute each, pick what time allows):

5. **Receipt and `/verify`.** On the approved order, download the receipt and open `/verify`. Paste it and press Verify: six checks pass. Press "Edit a value" (it adds 1 to the order total), verify again and watch the receipt signature and the match check fail. Say what a pass does not prove: the key comes from our server unless you paste one, and the approver signature is a device key, not an identity.
6. **Red team.** Open `/red-team` and run all. Read out one blocked result (replay or forged quote), the structuring result (blocked by the rolling 24-hour rule), and the honest ones: stock probing is slowed, not stopped, and a planted sentence on a trusted site would still clear an unknown allergen. The run takes a while and is rate limited, so run it once, ahead of the pitch if need be.
7. **Order from a photo.** On `/`, press Photo and pick a handwritten list. Tap a line: it fills the request box, nothing is ordered. Say: "The model reads the photo; it never orders. The mandate still decides." Dictation appears only in browsers with a speech API and was not tested.
8. **Earned autonomy.** Open `/autonomy` (buyer `demo-autonomy`). Show the proposal and its evidence, and the label saying the history is synthetic. Accept it (approver key) and open `/audit` to see the mandate change recorded.

Close with three clicks:
- `/exposure`: the same quote as Valio holds it and as the agent gets it, side by side.
- `/audit`: verify the hash chain, then use the tamper button and verify again to show detection. (Demo actions need the approver key when it is set and are refused in production unless `ALLOW_DEMO_RESET=true`.)
- `/models`: the 12-request evaluation, including Qwen's wrong dates.
