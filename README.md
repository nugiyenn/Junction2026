# Trusted Trade Agents

Junction 2026, Valio Aimo challenge.

A gateway that lets a buyer's AI agent order from Valio Aimo safely: within a mandate the buyer set, at a price Valio signed, seeing only what it should, on a record that shows any edit.

## How it works

1. **Request**: a plain-language need, like "1,000 litres of lactose-free milk by Monday".
2. **Lookup**: search the catalog, then price only a few products live.
3. **Offers**: cheapest, most reliable, lowest CO2. Split across products or substitute if stock is short.
4. **Quote**: a fixed price, signed by Valio.
5. **Order**: the buyer's mandate decides: confirmed, sent to a human, or rejected.
6. **Approval**: a human approves or declines.

A language model reads the request. Code decides everything else: quantities, prices, approval.

## Key ideas

- **Mandate**: what the agent may decide alone (spend limit, blocked allergens, and so on).
- **Signed quote**: the agent can verify it with Valio's public key at `/.well-known/jwks.json`.
- **Exposure policy**: the agent never sees exact stock, list price, discount or supplier.
- **Decision record**: every step is logged in plain language and hash-chained.
- **Live checks**: allergen and label claims can be verified against the web, with quotes and source links.
- **Recipe order**: a kitchen pastes a recipe or shopping list and gets one order instead of ordering product by product.
- **Unusual order flag**: an order that differs from the buyer's own usual orders (for example whole milk instead of the usual skimmed) goes to a person. A fixed rule in code, no model.

## Pages

Eight pages:

- `/`: Buyer agent. Includes a "Recurring orders" block that places the usual weekly milk order and three unusual ones.
- `/recipe`: Recipe order. Paste a recipe or shopping list, match each line to a Valio product with pack quantities, and create one quote. Code reads the text and matches products; a model only splits prose the parser cannot read.
- `/approvals`: a person approves or declines. An order flagged as unusual shows the usual order next to this one.
- `/exposure`: what agents see, next to what Valio holds.
- `/audit`: decision record, hash-chained.
- `/stats`: buyer stats.
- `/models`: the open model evaluation.
- `/verify`: check an order's signed receipt in the browser. `/verify?order=<id>` loads and checks it by itself.
- Order confirmation: every order has a printable PDF (`GET /api/orders/<id>/confirmation`) with the lines, the decision, the signatures and a QR code that opens `/verify`. It is a confirmation, not an invoice.

## Tech

Aiven Postgres, Valkey, Kafka and ClickHouse, Oxylabs, Gemma, Gemini, Nemotron, Featherless, Next.js.

## Interfaces

- REST: `app/public/openapi.json`
- MCP: `POST /api/mcp`. There is no approve tool: approval stays human.
- Set `APPROVER_KEY` and approving and editing a mandate need `Authorization: Bearer <key>`.

## Run it

```bash
cd app
npm install
cp .env.example .env.local        # fill in the keys
node --conditions=react-server --env-file=.env.local scripts/seed.mts --no-embed
npm run dev                       # http://localhost:3000
```

Put `valio_aimo_junction26_product_data.json` in `app/data/` first. Tests: `npm test` (374 tests). An end-to-end script, `app/scripts/e2e-local.mjs`, runs 83 checks against a running dev server.

## Limits

- Orders are stored in our database only. Valio's mock has no order endpoint.
- Semantic search covers only part of the catalog (Gemini free tier).
- No per-agent login. Callers pass a mandate id.
- The unusual-order thresholds are our guesses until Valio gives real numbers, and the order history behind them is synthetic (`app/scripts/seed-standing-orders.mts`).
- Recipe order: some products can never be ordered because Valio's synthetic data has fixed past order cut-offs. They are shown as "Can't order" with the reason.

All Valio data is synthetic.
