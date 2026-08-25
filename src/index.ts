#!/usr/bin/env node
// ─── Cituna — MCP server, stdio entrypoint ────────────────────────────────────
// Exposes the Cituna product to Claude Desktop / Claude Code / any local MCP
// client. This is what the `cituna-mcp` npm package runs.
//
// Everything this server can DO lives in ./tools.ts, which knows nothing about
// transports. This file's whole job is: read credentials from the environment,
// build a client, and pump the protocol over stdio. The remote (Streamable HTTP)
// entrypoint in ./http.ts does the same job with per-request credentials.
//
// IMPORTANT: stdout is reserved for the JSON-RPC protocol — all logging goes to
// stderr (console.error), never console.log.
//
// Config via env (see README):
//   CITUNA_API_URL   backend base URL (default https://cituna.com)
//   CITUNA_API_KEY   a personal API key (cituna_sk_…) from the app — RECOMMENDED
//   CITUNA_TOKEN     a session JWT (the app's cituna_token) — alternative
//   CITUNA_EMAIL + CITUNA_PASSWORD   email/password login — alternative

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CitunaClient } from "./client.js";
import { createCitunaServer, VERSION } from "./tools.js";

// Defaults to the public Cituna backend so distributed users can omit it.
// For local backend dev, set CITUNA_API_URL=http://localhost:3001.
const API_URL = process.env.CITUNA_API_URL || "https://cituna.com";

const client = new CitunaClient({
  baseUrl: API_URL,
  apiKey: process.env.CITUNA_API_KEY,
  token: process.env.CITUNA_TOKEN,
  email: process.env.CITUNA_EMAIL,
  password: process.env.CITUNA_PASSWORD,
});

const server = createCitunaServer(client, {
  apiUrl: API_URL,
  // For npm-first users this error IS the onboarding: it must route people
  // with no account at all (sign up), not only people who lost their key.
  noCredentialsMessage:
    "No API key configured. Existing account: in the app, Integrations → \"Claude / MCP access\" → Generate token, then set CITUNA_API_KEY (cituna_sk_…). No account yet: start at https://cituna.com/signup (the MCP needs a paid plan; the trial is app-only).",
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cituna] MCP server v${VERSION} ready · backend ${API_URL} · auth: ${client.describeAuth()}`);
}

main().catch((e) => {
  console.error("[cituna] fatal:", e);
  process.exit(1);
});
