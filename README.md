# Trusted Trade Agents

Junction 2026 for the Valio Aimo challenge.

**The challenge:** How can a food-service wholesaler let AI purchasing agents place orders, finding products, comparing offers and getting the right approval, without exposing real systems or confidential data?

**Our answer:** A gateway between a buyer's AI agent and Valio Aimo. The agent looks up products, gets a fixed price signed by Valio, and orders inside rules the buyer set. Large or unusual orders go to a person. Every step is recorded, and every order has a receipt anyone can verify.

Live demo: https://valio-platform.vercel.app

## What's in it

- Product search, signed quotes and orders through REST and MCP (no approve tool: approval stays human)
- Rules per buyer: spend limits, allergens, delivery reliability, carbon cap
- A flag for orders that differ from the buyer's usual ones
- A recipe order: paste a recipe, get one order
- A hash-chained audit trail, signed receipts and a PDF order confirmation

All Valio data is synthetic. A language model only reads text. Code decides prices, quantities and approval.

## Run it

```bash
cd app
npm install
cp .env.example .env.local
node --conditions=react-server --env-file=.env.local scripts/seed.mts --no-embed
npm run dev
```

Put `valio_aimo_junction26_product_data.json` in `app/data/` first. Tests: `npm test`.

## Tech

Next.js, Aiven (Postgres, Valkey, Kafka, ClickHouse), Oxylabs, Gemma, Gemini, Nemotron, Featherless.