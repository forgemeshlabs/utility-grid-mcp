#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, http } = require("viem");
const { base } = require("viem/chains");

const VERSION = "0.1.4";
const BASE_URL = (process.env.UTILITY_GRID_BASE_URL || "https://x402.forgemesh.io").replace(/\/$/, "");
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Example upstream capabilities, grouped by category, to orient an agent
// before it calls list_capabilities/search_capabilities. This is illustrative
// only — the live catalog (415 routes at build time, and growing) is always
// fetched fresh from /openapi.json, never hardcoded here.
const CATEGORY_EXAMPLES =
  "geo (airports, zip codes, geocoding, weather), lookups (dictionary, bible, country info, holidays), " +
  "math (statistics, matrices, equations, geometry), utilities (QR codes, hashing, UUIDs, phone parsing), " +
  "vision (OCR, image captioning, background removal), audio (TTS, transcription, format conversion), " +
  "time (timezones, cron, sun/moon), space (NASA APOD, asteroids, solar weather), " +
  "web (content extraction, robots.txt/Content-Signal checks), registry (fleet catalog, daily spotlight), " +
  "documents (PDF handling), text (language detection, readability), economy (fx rates, financial calculators), " +
  "science, developer, domains, ai, conversions, and fun (fortunes, chess, trivia)";

// --- discovery (free, no wallet needed) -----------------------------------

// list_tools is free: plain fetch of /menu, no wallet, never touches paidPost.
// The server may attach a labeled `sponsored` data field; pass it through untouched.
async function listTools() {
  const res = await fetch(`${BASE_URL}/menu`);
  if (!res.ok) throw new Error(`Failed to fetch menu: HTTP ${res.status}`);
  return res.json();
}

let discoveryCache = null; // { at: number, spec: object }
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

async function fetchOpenApiSpec() {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.spec;
  const res = await fetch(`${BASE_URL}/openapi.json`);
  if (!res.ok) throw new Error(`Failed to fetch discovery doc: HTTP ${res.status}`);
  const spec = await res.json();
  discoveryCache = { at: Date.now(), spec };
  return spec;
}

function normalizePath(input) {
  let p = String(input || "").trim();
  if (!p) return "";
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/+$/, "") || "/";
}

function routeEntries(spec) {
  const paths = spec.paths || {};
  return Object.entries(paths).map(([path, methods]) => {
    const post = methods.post || {};
    const price = post["x-payment-info"]?.price?.amount;
    return {
      path,
      category: (post.tags || [])[0] || "uncategorized",
      price: price ? `$${price}` : undefined,
      description: post.description || post.summary || "",
      operationId: post.operationId,
    };
  });
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

async function listCapabilities(args) {
  const spec = await fetchOpenApiSpec();
  const entries = routeEntries(spec);
  const category = args.category ? String(args.category).toLowerCase() : null;

  if (!category) {
    const counts = {};
    for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
    return {
      total_routes: entries.length,
      categories: Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ category: name, route_count: count })),
      hint: "Pass a category to list its routes, e.g. { \"category\": \"math\" }. Or use search_capabilities with a keyword.",
      full_catalog: `${BASE_URL}/openapi.json`,
    };
  }

  const matches = entries.filter((e) => e.category.toLowerCase() === category);
  if (matches.length === 0) {
    const available = [...new Set(entries.map((e) => e.category))].sort();
    throw new Error(`No routes found in category "${args.category}". Available categories: ${available.join(", ")}`);
  }
  return {
    category,
    route_count: matches.length,
    routes: matches.map((e) => ({ path: e.path, price: e.price, description: truncate(e.description, 200) })),
  };
}

async function searchCapabilities(args) {
  const spec = await fetchOpenApiSpec();
  const entries = routeEntries(spec);
  const q = String(args.query || "").toLowerCase().trim();
  if (!q) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  const matches = entries
    .filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        (e.operationId || "").toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
    )
    .slice(0, limit);
  return {
    query: args.query,
    match_count: matches.length,
    routes: matches.map((e) => ({
      path: e.path,
      category: e.category,
      price: e.price,
      description: truncate(e.description, 200),
    })),
  };
}

async function getEndpointSpec(args) {
  const spec = await fetchOpenApiSpec();
  const path = normalizePath(args.path);
  const post = spec.paths?.[path]?.post;
  if (!post) {
    // fall back to a loose search so a slightly-off name still resolves
    const entries = routeEntries(spec);
    const norm = path.replace(/^\//, "").toLowerCase();
    const candidates = entries.filter(
      (e) => e.path.toLowerCase().includes(norm) || (e.operationId || "").toLowerCase().includes(norm.replace(/-/g, "_"))
    );
    if (candidates.length === 1) {
      return getEndpointSpec({ path: candidates[0].path });
    }
    throw new Error(
      candidates.length > 1
        ? `"${args.path}" is ambiguous. Candidates: ${candidates.map((c) => c.path).join(", ")}`
        : `No route matching "${args.path}". Use list_capabilities or search_capabilities to find the exact path.`
    );
  }
  const schema = post.requestBody?.content?.["application/json"]?.schema;
  const requestExample = post.requestBody?.content?.["application/json"]?.example;
  const responseExample = post.responses?.["200"]?.content?.["application/json"]?.example;
  return {
    path,
    method: "POST",
    category: (post.tags || [])[0],
    price: post["x-payment-info"]?.price?.amount ? `$${post["x-payment-info"].price.amount}` : undefined,
    description: post.description || post.summary,
    input_schema: schema,
    request_example: requestExample,
    response_example: responseExample,
  };
}

// --- payment client ---------------------------------------------------------

function buildBaseHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not set. Paid utility-grid calls cost $0.001-$0.05 via x402 — set a dedicated low-balance Base wallet private key (never your primary wallet) with a small amount of USDC on Base mainnet. Discovery tools (list_capabilities, search_capabilities, get_endpoint_spec) work without one."
    );
  }
  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account)));
  return { httpClient: new x402HTTPClient(coreClient), account };
}

// x402 derives EIP-3009 validity windows from Date.now; choose a timestamp
// valid for both Base block time and facilitator wall-clock checks (clock-skew fix).
async function createChainTimedPaymentPayload(httpClient, paymentRequired) {
  try {
    const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });
    const block = await publicClient.getBlock();
    const chainNow = Number(block.timestamp);
    const originalNow = Date.now;
    const localNow = Math.floor(originalNow() / 1000);
    const timeout = Number(paymentRequired.accepts?.[0]?.maxTimeoutSeconds || 300);
    const lowerBound = localNow + 30 - timeout;
    const upperBound = chainNow + 600;
    const signingNow = Math.min(Math.max(chainNow, lowerBound), upperBound);
    Date.now = () => signingNow * 1000;
    try {
      return await httpClient.createPaymentPayload(paymentRequired);
    } finally {
      Date.now = originalNow;
    }
  } catch (_) {
    return httpClient.createPaymentPayload(paymentRequired);
  }
}

async function paidPost(ctx, path, body) {
  const { httpClient } = ctx;
  const url = BASE_URL + path;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
  const res = await fetch(url, init);

  if (res.status === 402) {
    let challengeBody;
    try {
      challengeBody = await res.clone().json();
    } catch (_) {}
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), challengeBody);
    const paymentPayload = await createChainTimedPaymentPayload(httpClient, paymentRequired);
    const paidRes = await fetch(url, {
      ...init,
      headers: { ...init.headers, ...httpClient.encodePaymentSignatureHeader(paymentPayload) },
    });
    if (!paidRes.ok) {
      const errBody = await paidRes.text().catch(() => paidRes.statusText);
      throw new Error(`HTTP ${paidRes.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await paidRes.json();
    try {
      const settleResponse = httpClient.getPaymentSettleResponse((name) => paidRes.headers.get(name));
      if (settleResponse && data && typeof data === "object" && !Array.isArray(data)) {
        return { ...data, _payment: settleResponse };
      }
    } catch (_) {}
    return data;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "list_tools",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "FREE — no wallet needed. Lists every Utility Grid route with its live price plus a per-category summary (route_count, price_range), so an agent can pick before paying. Fetches GET /menu with no payment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_capabilities",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      `FREE — no wallet needed. Browse the ForgeMesh Utility Grid catalog (415+ POST routes and growing, covering ${CATEGORY_EXAMPLES}). Call with no arguments for a category overview with route counts, or pass a category to list every route in it with price and description. Always reads the live /openapi.json — never a stale/hardcoded list.`,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category to list routes for, e.g. 'math' or 'vision'" },
      },
    },
  },
  {
    name: "search_capabilities",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "FREE — no wallet needed. Keyword search across every route's path, operation id, and description (e.g. 'chess', 'timezone', 'background removal'). Use this when you don't know the exact route name or category.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for" },
        limit: { type: "integer", description: "Max results (default 20, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_endpoint_spec",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "FREE — no wallet needed. Full call spec for one route: price, input JSON schema, a worked request example, and a worked response example, straight from the live OpenAPI discovery doc. Pass the route path (with or without a leading slash, e.g. 'chess-moves' or '/chess-moves'). Use this before call_endpoint to know exactly what body to send.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path, e.g. 'chess-moves' or '/geocode-city'" },
      },
      required: ["path"],
    },
  },
  {
    name: "call_endpoint",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID (price varies by route, $0.001-$0.05) — the generic way to call ANY route in the Utility Grid. Pass the route path and a JSON body matching its input schema (use get_endpoint_spec first if unsure). Handles the full x402 payment flow automatically: fetches the 402 challenge, signs a USDC payment on Base, retries, and returns the result. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path, e.g. 'chess-moves' or '/geocode-city'" },
        body: { type: "object", description: "JSON body matching the route's input schema (see get_endpoint_spec)" },
      },
      required: ["path"],
    },
  },
  {
    name: "daily_402",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.001) — the Daily 402: one featured x402 endpoint per UTC day, rotated deterministically through every paid route in the 12-service ForgeMesh fleet (500+ routes). Returns what it does, its price, input schema, and a worked example. Optional date override to replay a past day's pick. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional ISO date (YYYY-MM-DD) to replay a past day's featured endpoint" },
      },
    },
  },
  {
    name: "agent_service_directory",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.05) — machine-readable registry of every production x402 service in the ForgeMesh fleet: name, category, live route count, and price range per service. Useful for an agent deciding which paid tool/service to reach for next. Optional category filter (onchain-intel, voice, travel, econ-intel, commerce, infra, media, utility-grid). Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional: onchain-intel, voice, travel, econ-intel, commerce, infra, media, utility-grid" },
      },
    },
  },
];

async function main() {
  let ctxPromise;
  async function getPaymentContext() {
    if (!ctxPromise) ctxPromise = Promise.resolve().then(buildBaseHttpClient);
    return ctxPromise;
  }

  const server = new Server({ name: "utility-grid-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      let data;
      switch (name) {
        case "list_tools":
          data = await listTools();
          break;
        case "list_capabilities":
          data = await listCapabilities(args);
          break;
        case "search_capabilities":
          data = await searchCapabilities(args);
          break;
        case "get_endpoint_spec":
          data = await getEndpointSpec(args);
          break;
        case "call_endpoint":
          data = await paidPost(await getPaymentContext(), normalizePath(args.path), args.body || {});
          break;
        case "daily_402":
          data = await paidPost(await getPaymentContext(), "/daily", { date: args.date });
          break;
        case "agent_service_directory":
          data = await paidPost(await getPaymentContext(), "/agent-service-directory", { category: args.category });
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`utility-grid-mcp v${VERSION} ready — ${BASE_URL}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}

module.exports = {
  TOOLS,
  listTools,
  normalizePath,
  routeEntries,
  listCapabilities,
  searchCapabilities,
  getEndpointSpec,
  buildBaseHttpClient,
  fetchOpenApiSpec,
};
