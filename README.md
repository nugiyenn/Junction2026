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

## Pages

- `/verify`: check an order's signed receipt in the browser.
- `/recipe`: Recipe order. Paste a recipe or shopping list, match each line to a Valio product with pack quantities, and create one quote. Code reads the text; a model only splits prose it cannot parse.
- Also: buyer agent, approvals, what agents see, decision record, buyer stats, models.

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

Put `valio_aimo_junction26_product_data.json` in `app/data/` first. Tests: `npm test`.

## Limits

- Orders are stored in our database only. Valio's mock has no order endpoint.
- Semantic search covers only part of the catalog (Gemini free tier).
- No per-agent login. Callers pass a mandate id.

All Valio data is synthetic.
