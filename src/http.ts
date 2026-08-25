#!/usr/bin/env node
// ─── Cituna — MCP server, remote (Streamable HTTP) entrypoint ─────────────────
// The transport claude.ai Connectors speaks. A user adds ONE URL and signs in;
// no Node, no npx, no JSON config file — and it works on claude.ai web and
// mobile, which a stdio server can never reach.
//
// Same tools, same descriptions, same dispatch as the npm package: both
// entrypoints build their server from ./tools.ts. The only difference is where
// the credential comes from — env for stdio, per-request for this one.
//
// Deliberately built on node:http rather than express: `cituna-mcp` is a
// published package, and stdio users should not download a web framework they
// will never execute. Two routes and a body reader do not justify the dependency.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
// This is an OAuth 2.1 protected resource. Two credentials are accepted, and the
// difference is only how the user obtained them:
//   • cituna_at_…  an OAuth access token, minted after the user clicked "Allow
//                  access" in the browser. This is the Connectors path, and the
//                  one nobody has to copy and paste.
//   • cituna_sk_…  a personal API key from the app, for scripts and CI.
// Either arrives as `Authorization: Bearer …` (or `X-API-Key:` for clients that
// reserve the Authorization header) and is used to build a per-request client.
// Nothing is stored.
//
// An anonymous request gets 401 plus a `WWW-Authenticate` header naming this
// resource's metadata document. That header is the whole trick: it is what makes
// a client stop and run the browser sign-in instead of surfacing an error. The
// discovery chain a client walks is
//   /.well-known/oauth-protected-resource   (here — names the auth server)
//     → <issuer>/.well-known/oauth-authorization-server  (on the Cituna API)
//       → register → authorize → token
//
// Config via env:
//   PORT                       listen port (default 8080)
//   CITUNA_API_URL             backend base URL (default https://cituna.com)
//   CITUNA_MCP_PUBLIC_URL      this server's public origin, used to build the
//                              metadata URLs (default https://mcp.cituna.com).
//                              MUST match how clients actually reach it: a
//                              mismatch makes discovery fail validation.
//   CITUNA_OAUTH_ISSUER        the authorization server (default https://api.cituna.com)
//   CITUNA_MCP_ALLOWED_HOSTS   comma-separated Host allowlist (DNS-rebinding
//                              protection). Unset = off, which is correct behind
//                              a proxy that already pins the host.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CitunaClient } from "./client.js";
import { createCitunaServer, VERSION } from "./tools.js";

const PORT = Number(process.env.PORT || 8080);
const API_URL = process.env.CITUNA_API_URL || "https://cituna.com";
const PUBLIC_URL = (process.env.CITUNA_MCP_PUBLIC_URL || "https://mcp.cituna.com").replace(/\/+$/, "");
const ISSUER = (process.env.CITUNA_OAUTH_ISSUER || "https://api.cituna.com").replace(/\/+$/, "");
const ALLOWED_HOSTS = (process.env.CITUNA_MCP_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const MCP_PATH = "/mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";
// Bodies here are JSON-RPC envelopes, not uploads. A cap keeps a hostile client
// from parking memory on an unauthenticated route.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Shown when a client ignores the WWW-Authenticate header (or a human curls the
// endpoint). A client that honours it never renders this — it opens the browser.
const NO_CREDENTIALS_MESSAGE =
  "Not signed in to Cituna. Reconnect this server in your MCP client and approve access in the browser, or send a personal API key as `Authorization: Bearer cituna_sk_…` (app → Integrations → \"Claude / MCP access\"). No account yet: start at https://cituna.com/signup (the MCP needs a paid plan; the trial is app-only).";

// ─── Small helpers ───────────────────────────────────────────────────────────

// Permissive CORS: the MCP endpoint is credential-authenticated per request and
// holds no cookies or ambient session, so there is no cross-origin state for a
// browser to be tricked into spending. Mcp-Session-Id must be exposed or a
// browser-based client cannot read it.
function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

// A JSON-RPC-shaped error, so a client that reached us with a valid envelope
// gets something it can parse rather than a bare HTTP body. `id: null` is the
// correct id for an error raised before the request could be read.
function rpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Bearer first, then X-API-Key. Returns "" when the request is anonymous.
function extractCredential(req: IncomingMessage): string {
  const authz = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (m && m[1]) return m[1].trim();
  const key = req.headers["x-api-key"];
  return String(Array.isArray(key) ? key[0] : key || "").trim();
}

// The backend accepts a personal API key or a session JWT on the same bearer
// slot; CitunaClient wants them in different fields (only the key path is
// long-lived). Route by the documented prefix.
function clientFor(credential: string): CitunaClient {
  const isApiKey = credential.startsWith("cituna_sk_");
  return new CitunaClient({
    baseUrl: API_URL,
    apiKey: isApiKey ? credential : undefined,
    token: isApiKey ? undefined : credential,
  });
}

// ─── Request handling ────────────────────────────────────────────────────────

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const credential = extractCredential(req);
  if (!credential) {
    // RFC 9728 §5.1: point the client at this resource's metadata, which names
    // the authorization server. This header is what converts a dead end into a
    // sign-in prompt — without it a client just reports "unauthorized".
    rpcError(res, 401, -32001, NO_CREDENTIALS_MESSAGE, {
      "WWW-Authenticate": `Bearer resource_metadata="${PUBLIC_URL}${PRM_PATH}"`,
    });
    return;
  }

  // Stateless: one Server + one Transport per request, both closed when the
  // response finishes. Sharing a Server across requests would leak one user's
  // credential into another user's calls — the client is captured in the tool
  // handlers, so the server instance IS the identity.
  const client = clientFor(credential);
  const server = createCitunaServer(client, { apiUrl: API_URL, noCredentialsMessage: NO_CREDENTIALS_MESSAGE });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session to resume, auth rides every request
    ...(ALLOWED_HOSTS.length ? { enableDnsRebindingProtection: true, allowedHosts: ALLOWED_HOSTS } : {}),
  });

  // Close both when the response ends, however it ends (normal finish, client
  // disconnect mid-scan, or a socket error). Without this each request leaks a
  // Server and its transport.
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };
  res.on("close", cleanup);

  try {
    let parsed: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req);
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        rpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
        cleanup();
        return;
      }
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    console.error("[cituna-mcp-http] request failed:", (e as Error).message);
    if (!res.headersSent) rpcError(res, 500, -32603, `Internal server error: ${(e as Error).message}`);
    cleanup();
  }
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── Protected-resource metadata (RFC 9728) ──────────────────────────────
  // Always public and unauthenticated — a client reads this precisely BECAUSE
  // it does not have a credential yet. Served at the bare well-known path and
  // at the path-suffixed form (…/oauth-protected-resource/mcp), because clients
  // differ on which they probe for a resource that lives under a path.
  if (url.pathname === PRM_PATH || url.pathname === `${PRM_PATH}${MCP_PATH}`) {
    sendJson(res, 200, {
      resource: `${PUBLIC_URL}${MCP_PATH}`,
      authorization_servers: [ISSUER],
      scopes_supported: ["cituna:read", "cituna:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Cituna",
      resource_documentation: "https://cituna.com/mcp",
    });
    return;
  }

  // Liveness for the platform health check. Deliberately unauthenticated and
  // free of backend calls: it answers "is this process up", not "is Cituna up".
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "cituna-mcp", transport: "streamable-http", version: VERSION, backend: API_URL });
    return;
  }

  // A human who pastes the connector URL into a browser lands here. Tell them
  // what this is rather than showing a 404 that reads as "the URL is wrong".
  if (url.pathname === "/" && req.method === "GET") {
    sendJson(res, 200, {
      service: "cituna-mcp",
      version: VERSION,
      transport: "streamable-http",
      endpoint: MCP_PATH,
      authorization_servers: [ISSUER],
      protected_resource_metadata: `${PUBLIC_URL}${PRM_PATH}`,
      docs: "https://cituna.com/mcp",
      message: `This is an MCP endpoint, not a website. Add ${PUBLIC_URL}${MCP_PATH} as a connector in your MCP client and approve access in the browser.`,
    });
    return;
  }

  if (url.pathname === MCP_PATH) {
    void handleMcp(req, res);
    return;
  }

  rpcError(res, 404, -32601, `Not found. The MCP endpoint is ${MCP_PATH}.`);
});

httpServer.listen(PORT, () => {
  console.log(`[cituna-mcp-http] v${VERSION} listening on :${PORT}${MCP_PATH} · backend ${API_URL}`);
  if (!ALLOWED_HOSTS.length) console.log("[cituna-mcp-http] DNS-rebinding protection off (CITUNA_MCP_ALLOWED_HOSTS unset)");
});

// Coolify/Docker stop the container with SIGTERM; drain in-flight requests
// rather than cutting a scan off mid-stream.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[cituna-mcp-http] ${sig} — draining`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
