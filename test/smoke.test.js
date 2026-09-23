#!/usr/bin/env node
"use strict";

// Smoke tests: schema-shape assertions on every tool definition, plus live
// discovery + a 402-challenge parse check against the real service. NO
// PAYMENTS are made or attempted here — the paid-path test only fetches the
// 402 challenge and verifies a client can construct a payment payload from
// it; it never signs+sends a real payment.

const test = require("node:test");
const assert = require("node:assert/strict");
const { generatePrivateKey } = require("viem/accounts");
const {
  TOOLS,
  listTools,
  normalizePath,
  routeEntries,
  listCapabilities,
  searchCapabilities,
  getEndpointSpec,
  buildBaseHttpClient,
  fetchOpenApiSpec,
} = require("../index.js");

const BASE_URL = process.env.UTILITY_GRID_BASE_URL || "https://x402.forgemesh.io";
const EXPECTED_TOOL_NAMES = [
  "list_tools",
  "list_capabilities",
  "search_capabilities",
  "get_endpoint_spec",
  "call_endpoint",
  "daily_402",
  "agent_service_directory",
];

test("exposes exactly the 7 expected tools", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOL_NAMES].sort());
});

test("every tool has a name, description, and object inputSchema", () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 20, `${tool.name} description too short`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.inputSchema.properties, "object");
  }
});

test("free tools are labeled FREE and paid tools are labeled PAID in their descriptions", () => {
  const free = ["list_tools", "list_capabilities", "search_capabilities", "get_endpoint_spec"];
  const paid = ["call_endpoint", "daily_402", "agent_service_directory"];
  for (const tool of TOOLS) {
    if (free.includes(tool.name)) assert.match(tool.description, /FREE/);
    if (paid.includes(tool.name)) assert.match(tool.description, /PAID/);
  }
});

test("normalizePath adds a leading slash and strips trailing slashes", () => {
  assert.equal(normalizePath("chess-moves"), "/chess-moves");
  assert.equal(normalizePath("/chess-moves"), "/chess-moves");
  assert.equal(normalizePath("/chess-moves/"), "/chess-moves");
  assert.equal(normalizePath("  geocode-city  "), "/geocode-city");
});

// --- Live checks against the real service (network required, no payments) ---

test("live: openapi.json discovery doc is reachable and has 400+ paths", async () => {
  const spec = await fetchOpenApiSpec();
  const entries = routeEntries(spec);
  assert.ok(entries.length >= 400, `expected 400+ routes, got ${entries.length}`);
  assert.ok(entries.every((e) => e.path.startsWith("/")));
});

test("live: list_tools returns every route with a price and a category summary", async () => {
  const menu = await listTools();
  assert.ok(Array.isArray(menu.tools) && menu.tools.length > 100, "menu should list the full grid");
  assert.ok(menu.tools.every((t) => typeof t.price_usd === "number"), "every tool carries a price");
  assert.ok(Array.isArray(menu.categories) && menu.categories.length > 0, "menu carries a category summary");
});

test("live: list_capabilities with no args returns a category overview", async () => {
  const result = await listCapabilities({});
  assert.ok(result.total_routes > 0);
  assert.ok(Array.isArray(result.categories) && result.categories.length > 5);
  assert.ok(result.categories.every((c) => typeof c.category === "string" && c.route_count > 0));
});

test("live: list_capabilities with a category filters to that category", async () => {
  const result = await listCapabilities({ category: "math" });
  assert.ok(result.route_count > 0);
  assert.ok(result.routes.every((r) => r.path.startsWith("/")));
});

test("live: list_capabilities rejects an unknown category with a helpful error", async () => {
  await assert.rejects(() => listCapabilities({ category: "not-a-real-category-xyz" }), /No routes found/);
});

test("live: search_capabilities finds chess routes for 'chess'", async () => {
  const result = await searchCapabilities({ query: "chess" });
  assert.ok(result.match_count > 0);
  assert.ok(result.routes.some((r) => r.path.includes("chess")));
});

test("live: get_endpoint_spec returns a full spec for a known route", async () => {
  const spec = await getEndpointSpec({ path: "chess-moves" });
  assert.equal(spec.path, "/chess-moves");
  assert.equal(spec.method, "POST");
  assert.ok(spec.price);
  assert.ok(spec.input_schema);
  assert.ok(spec.input_schema.properties.fen);
});

test("live: get_endpoint_spec errors clearly for an unknown route", async () => {
  await assert.rejects(() => getEndpointSpec({ path: "this-route-does-not-exist-xyz" }), /No route matching/);
});

test("live: a paid route returns a 402 challenge, and a throwaway test wallet can construct (never send) a signed payment payload from it", async () => {
  const res = await fetch(`${BASE_URL}/daily`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 402, "expected a 402 Payment Required challenge (no payment sent)");
  assert.ok(res.headers.get("payment-required"), "expected a payment-required header carrying the x402 challenge");

  const challengeBody = await res.json().catch(() => undefined);

  // Ephemeral, randomly generated, zero-balance test key — used only to prove
  // the payment payload construction step works. Never funded, never logged,
  // and the resulting payload is never sent back to the server (no settlement).
  const originalKey = process.env.WALLET_PRIVATE_KEY;
  process.env.WALLET_PRIVATE_KEY = generatePrivateKey();
  try {
    const { httpClient } = buildBaseHttpClient();
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), challengeBody);
    assert.equal(paymentRequired.x402Version, 2);
    assert.ok(Array.isArray(paymentRequired.accepts) && paymentRequired.accepts.length > 0);
    const accept = paymentRequired.accepts[0];
    assert.equal(accept.network, "eip155:8453");
    assert.ok(accept.payTo);

    // Signs an EIP-3009 authorization locally (no network call) and stops
    // there. It is never sent as an X-PAYMENT header to the server.
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    assert.ok(paymentPayload);
    const encoded = httpClient.encodePaymentSignatureHeader(paymentPayload);
    assert.ok(Object.keys(encoded).length > 0, "should encode at least one payment header");
  } finally {
    if (originalKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
    else process.env.WALLET_PRIVATE_KEY = originalKey;
  }
});
