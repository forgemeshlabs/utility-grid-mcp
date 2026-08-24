# ForgeMesh Utility Grid MCP

[![M8ven Score](https://m8ven.ai/badge/mcp/forgemeshlabs-utility-grid-mcp-17smfq)](https://m8ven.ai/mcp/forgemeshlabs-utility-grid-mcp-17smfq)

*A [ForgeMesh Labs](https://forgemesh.io) product.*

Search and use more than 400 practical APIs without loading hundreds of tools into your agent. Utility Grid exposes six compact MCP tools for OCR, image and audio processing, web extraction, math, conversions, geodata, and more. Catalog discovery is free; API execution is paid per call in USDC on Base through [x402](https://x402.org). No account or API key is required.

Rather than exposing one MCP tool per route (unmanageable at this scale and growing), this server exposes a handful of **meta-tools**: browse/search the live catalog, fetch a route's exact call spec, then call any route generically. New routes on the upstream service show up automatically — nothing here is hardcoded to today's catalog.

## Quick start (Claude Desktop / Claude Code / any MCP client)

```json
{
  "mcpServers": {
    "utility-grid": {
      "command": "npx",
      "args": ["-y", "@forgemeshlabs/utility-grid-mcp"],
      "env": {
        "WALLET_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

`WALLET_PRIVATE_KEY` is only needed for the 3 paid tools. Discovery works with **no wallet at all** — skip the `env` block entirely to browse and plan calls for free.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `list_capabilities` | **free** | Category overview with route counts, or every route in one category |
| `search_capabilities` | **free** | Keyword search across every route's path, id, and description |
| `get_endpoint_spec` | **free** | A route's exact price, input schema, and worked request/response examples |
| `call_endpoint` | $0.001-$0.05 | Call any route by path + JSON body — handles the x402 payment flow automatically |
| `daily_402` | $0.001 | The Daily 402: one featured endpoint from the whole ForgeMesh fleet, rotated by UTC date |
| `agent_service_directory` | $0.05 | Registry of every ForgeMesh x402 service — category, route count, price range |

## Categories in the catalog (illustrative, not exhaustive)

geo (airports, zip codes, geocoding, weather), lookups (dictionary, Bible, country info, holidays), math (statistics, matrices, equations, geometry), utilities (QR codes, hashing, UUIDs, phone parsing), vision (OCR, image captioning, background removal), audio (TTS, transcription, format conversion), time (timezones, cron, sun/moon), space (NASA APOD, asteroids, solar weather), web (content extraction, robots.txt/Content-Signal checks), registry (fleet catalog, daily spotlight), documents (PDF handling), text (language detection, readability), economy (fx rates, financial calculators), science, developer, domains, ai, and fun (fortunes, chess, trivia).

Call `list_capabilities` with no arguments for the live, current breakdown — the catalog grows over time and this README will drift; the tool won't.

## Typical flow

1. `search_capabilities({ query: "background removal" })` — free, finds `/remove-background`
2. `get_endpoint_spec({ path: "remove-background" })` — free, shows the exact input schema and price
3. `call_endpoint({ path: "remove-background", body: { image_url: "https://..." } })` — paid, does the x402 dance and returns the result

Or skip straight to `call_endpoint` if you already know the route and its input shape.

## How payment works

No signup, no API key, no subscription. `call_endpoint`, `daily_402`, and `agent_service_directory` each trigger the same flow: the first request returns an HTTP 402 challenge, this MCP server signs a USDC payment authorization (EIP-3009) on Base and retries, and the result lands in the same response — including settlement details under `_payment` when available.

## Direct API

Prefer raw HTTP? The full agent-readable surface:

- `https://x402.forgemesh.io/llms.txt` — one-page summary for agents
- `https://x402.forgemesh.io/openapi.json` — OpenAPI 3.1 with x402 payment metadata, full input schemas, and worked examples for every route (this is what `list_capabilities`/`search_capabilities`/`get_endpoint_spec` read from, live, every call)
- `https://x402.forgemesh.io/.well-known/x402.json` — x402 discovery manifest

## FAQ

**Do I need an account or API key?** No. x402 payments are the only credential, and only for the 3 paid tools.

**What chain and token?** USDC on Base mainnet (`eip155:8453`).

**Will this break when the upstream catalog changes?** No — `list_capabilities`, `search_capabilities`, and `get_endpoint_spec` all read `/openapi.json` live (cached in-memory for 5 minutes). `call_endpoint` never needs a hardcoded schema at all; it just forwards your JSON body.

---

Built by [ForgeMesh Labs](https://forgemesh.io) · Powered by the [x402 protocol](https://x402.org) · MIT License
