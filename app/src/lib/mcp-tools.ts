import 'server-only';
import { z } from 'zod';
import { searchProducts } from '@/lib/catalog';
import { exposeOrder, exposeQuote } from '@/lib/exposure';
import { getMandate, createQuote, getOrder, getQuote, placeOrder } from '@/lib/purchasing';
import { enforceRateLimit } from '@/lib/ratelimit';
import { planRequest } from '@/lib/request';
import { verifyProduct } from '@/lib/verify';
import type { McpServerInfo, McpTool } from '@/lib/mcp';

export const MCP_INFO: McpServerInfo = {
  name: 'valio-aimo-trust-gateway',
  version: '0.1.0',
  instructions:
    "Valio Aimo's gateway for buyer purchasing agents. Search the catalog, ask for offers, create a fixed-price quote, " +
    'and place an order. Every order is judged against the buyer\'s mandate: it is confirmed, sent to a human for approval, ' +
    'or rejected. There is deliberately no tool to approve an order or change a mandate: those are human decisions. ' +
    'Quotes are signed by Valio (public key at /.well-known/jwks.json). All data is synthetic.',
};

const mandateId = z.string().describe('The buyer mandate the agent acts under, e.g. "demo-hotel" or "demo-school".');

function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  run: (args: z.output<S>) => Promise<unknown>;
}): McpTool {
  return { ...def, readOnly: def.readOnly ?? false, run: def.run as McpTool['run'] };
}

// No approve, decline or mandate-editing tool exists here, on purpose.
export const MCP_TOOLS: McpTool[] = [
  tool({
    name: 'search_products',
    description:
      'Search the product catalog (static data, no prices). Filters: required claims such as FREE_FROM_LACTOSE, labels such as EU_ORGANIC_FARMING, allergen codes to exclude.',
    inputSchema: z.object({
      query: z.string().min(1),
      claims: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      excludeAllergens: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    readOnly: true,
    run: async ({ query, limit, ...filters }) => {
      const { products, semantic } = await searchProducts(query, filters, limit);
      return { semantic, products };
    },
  }),
  tool({
    name: 'request_offers',
    description:
      'Turn a plain-language need such as "1,000 litres of lactose-free milk by Monday" into ranked offers (cheapest, most reliable, lowest CO2; a split or substitutes when stock is short) and a held, signed quote for the default offer. Takes up to a minute.',
    inputSchema: z.object({ mandateId, text: z.string().min(3).max(500) }),
    run: async ({ mandateId, text }) => {
      await enforceRateLimit('requests', mandateId);
      return planRequest(mandateId, text);
    },
  }),
  tool({
    name: 'create_quote',
    description:
      'Get a fixed-price, signed quote for specific products. Quantities are in sales units. Use substituteFor only when Valio lists the product as a substitute for another.',
    inputSchema: z.object({
      mandateId,
      deliveryDate: z.iso.date(),
      lines: z.array(z.object({ productId: z.string(), quantity: z.number().positive(), substituteFor: z.string().optional() })).min(1).max(20),
    }),
    run: async (args) => {
      await enforceRateLimit('quotes', args.mandateId);
      return exposeQuote(await createQuote(args));
    },
  }),
  tool({
    name: 'place_order',
    description:
      "Commit to a quote at its fixed prices. The buyer's mandate decides: the order comes back confirmed, pending_approval (a human must approve it) or rejected, with the reasons.",
    inputSchema: z.object({ quoteId: z.uuid() }),
    run: async ({ quoteId }) => {
      await enforceRateLimit('orders', (await getQuote(quoteId)).mandateId);
      return exposeOrder(await placeOrder(quoteId));
    },
  }),
  tool({
    name: 'get_order_status',
    description: 'Check an order, for example one waiting for human approval.',
    inputSchema: z.object({ orderId: z.uuid() }),
    readOnly: true,
    run: async ({ orderId }) => exposeOrder(await getOrder(orderId)),
  }),
  tool({
    name: 'verify_product',
    description:
      "Check a product's allergen and label claims against the live web (Oxylabs). Every statement carries a quote from the page and its source URL. Takes up to two minutes; a result is reused for 24 hours.",
    inputSchema: z.object({ productId: z.string() }),
    run: async ({ productId }) => verifyProduct(productId),
  }),
  tool({
    name: 'get_mandate',
    description: 'Read what the agent may decide alone under a mandate: spend limits, blocked allergens, delivery reliability and stock rules.',
    inputSchema: z.object({ mandateId }),
    readOnly: true,
    run: async ({ mandateId }) => getMandate(mandateId),
  }),
];
