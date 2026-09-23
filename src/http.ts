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
// Nothing is stored. Anything else in that slot, a web-app session JWT included,
// is refused rather than forwarded: this endpoint must not become a way to spend
// a credential that was issued for something other than the MCP server.
//
// An anonymous request gets 401 plus a `WWW-Authenticate` header naming this
// resource's metadata document. That header is the whole trick: it is what makes
// a client stop and run the browser sign-in instead of surfacing an error. A
// token the backend no longer accepts gets the same 401 with
// `error="invalid_token"`, which is what makes a client use its refresh token
// (see checkCredential). The discovery chain a client walks is
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

import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CitunaClient } from "./client.js";
import { ANNOTATION_WRITE_TOOLS, createCitunaServer, VERSION } from "./tools.js";

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
const MCP_CONFIG_PATH = "/.well-known/mcp-config";
// Bodies here are JSON-RPC envelopes, not uploads. A cap keeps a hostile client
// from parking memory on an unauthenticated route.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Shown when a client ignores the WWW-Authenticate header (or a human curls the
// endpoint). A client that honours it never renders this — it opens the browser.
const NO_CREDENTIALS_MESSAGE =
  "Not signed in to Cituna. Reconnect this server in your MCP client and approve access in the browser, or send a personal API key as `Authorization: Bearer cituna_sk_…` (app → Integrations → \"Claude / MCP access\"). No account yet: start at https://cituna.com/signup (the MCP needs a paid plan; the trial is app-only).";
const INVALID_CREDENTIALS_MESSAGE =
  "Your Cituna access has expired or was revoked. Reconnect this server in your MCP client and approve access in the browser, or create a new personal API key (app → Integrations → \"Claude / MCP access\").";
const READ_ONLY_MESSAGE =
  "This connection to Cituna was approved read-only. Approve access again in the browser and keep \"Also allow changes\" ticked to run scans, move your fix queue or queue articles.";
const WRONG_CREDENTIAL_MESSAGE =
  "That is not a Cituna MCP credential. Connect this server and approve access in the browser, or send a personal API key as `Authorization: Bearer cituna_sk_…` (app → Integrations → \"Claude / MCP access\").";

const SCOPES = ["cituna:read", "cituna:write"];

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
function rpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>, id: string | number | null = null) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id }, headers);
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

// The two credentials this endpoint accepts, by their documented prefixes. A
// session JWT used to pass straight through to the backend, where it resolves
// with the full web-session role (founder included, which a key or token never
// carries). The MCP spec forbids exactly that: a server must not accept a token
// that was not issued for it.
function isCitunaCredential(credential: string): boolean {
  return /^cituna_(at|sk)_[A-Za-z0-9_-]{16,}$/.test(credential);
}

// RFC 6750 §3 challenge, with RFC 9728's resource_metadata so a client can
// discover where to sign in, and the scopes it should ask for.
function challenge(error?: { code: "invalid_token" | "insufficient_scope"; description: string }): string {
  const params = [`resource_metadata="${PUBLIC_URL}${PRM_PATH}"`, `scope="${SCOPES.join(" ")}"`];
  if (error) params.push(`error="${error.code}"`, `error_description="${error.description}"`);
  return `Bearer ${params.join(", ")}`;
}

// ─── Step-up for a read-only grant ───────────────────────────────────────────
// A user who left "Also allow changes" unticked holds a cituna:read token. When
// that token called a write tool, the backend refused it with a 403 and tools.ts
// reported the refusal INSIDE a 200, as a tool error. A client cannot act on
// that. The MCP authorization spec's answer, and what claude.ai implements, is
// step-up: HTTP 403 with `error="insufficient_scope"` and the scopes needed.
// The client then asks the user to approve again, requesting those scopes, so
// the consent screen offers the write checkbox, and it retries the call with the
// new token. Without this, reconnecting could not help: nothing ever asked for
// write again, so the consent screen had no box to tick.
//
// Only OAuth grants carry a scope; a personal API key's is null ("not
// scope-limited") and passes. The backend still enforces the scope on every
// call, so this is the signal, not the access control.
function scopeAllowsWrite(scope: string): boolean {
  return scope.split(/\s+/).includes("cituna:write");
}

// The write tool a JSON-RPC message (or batch) asks for, or "".
function writeToolRequested(message: unknown): string {
  const list = Array.isArray(message) ? message : [message];
  for (const m of list) {
    const call = m as { method?: unknown; params?: { name?: unknown } } | null;
    if (call && call.method === "tools/call" && typeof call.params?.name === "string" && ANNOTATION_WRITE_TOOLS.has(call.params.name)) {
      return call.params.name;
    }
  }
  return "";
}

function requestId(message: unknown): string | number | null {
  const id = !Array.isArray(message) && message ? (message as { id?: unknown }).id : null;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

// ─── Is this credential still good? ──────────────────────────────────────────
// This server cannot read the token store, so without asking it accepted an
// expired or revoked token, answered 200, and let every tool call fail inside
// that 200. The MCP spec says an invalid token gets HTTP 401, and many clients
// only refresh or re-run sign-in when they see one. Without it, a client that
// does not refresh ahead of expiry kept failing once its 24-hour access token
// lapsed, until the user reconnected by hand.
//
// Only a definite 401 refuses. A backend that is down, slow, redirecting, or too
// old to have the endpoint lets the request through, and each tool call then
// reports the real problem, which is exactly how this server behaved before. That
// is safe because the check is not the access control: the backend verifies the
// credential again on every call a tool makes. Good answers are cached for a
// minute, keyed by a hash so no credential is held in memory as a map key.
//
// The same answer carries the grant's scope ({ active, kind, scope }: a string for
// an OAuth grant, null for an API key), kept so a read-only grant asking for a
// write tool can be sent through step-up (see writeToolRequested).
const VALID_TTL_MS = 60_000;
const VALID_CACHE_MAX = 5_000;
const validUntil = new Map<string, { until: number; scope: string | null }>();

type CredentialCheck = { refused: boolean; scope: string | null };

async function checkCredential(credential: string): Promise<CredentialCheck> {
  const key = createHash("sha256").update(credential).digest("hex");
  const cached = validUntil.get(key);
  if (cached && cached.until > Date.now()) return { refused: false, scope: cached.scope };
  let status = 0;
  let scope: string | null = null;
  try {
    const r = await fetch(`${API_URL.replace(/\/+$/, "")}/api/auth/credential`, {
      headers: { Authorization: `Bearer ${credential}` },
      // Never follow: a redirect drops the Authorization header on the way, and
      // the 401 that comes back would wrongly condemn a good credential.
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    status = r.status;
    if (status === 200) {
      const body = (await r.json().catch(() => null)) as { scope?: unknown } | null;
      scope = typeof body?.scope === "string" ? body.scope : null;
    } else {
      await r.body?.cancel().catch(() => {});
    }
  } catch {
    return { refused: false, scope: null };
  }
  if (status === 401) {
    validUntil.delete(key);
    return { refused: true, scope: null };
  }
  if (status === 200) {
    if (validUntil.size >= VALID_CACHE_MAX) {
      const oldest = validUntil.keys().next().value;
      if (oldest !== undefined) validUntil.delete(oldest);
    }
    validUntil.set(key, { until: Date.now() + VALID_TTL_MS, scope });
  }
  return { refused: false, scope };
}

// Only the two prefixes above reach this: an API key, or an OAuth access token
// that CitunaClient carries in its token slot.
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
    rpcError(res, 401, -32001, NO_CREDENTIALS_MESSAGE, { "WWW-Authenticate": challenge() });
    return;
  }
  if (!isCitunaCredential(credential)) {
    rpcError(res, 401, -32001, WRONG_CREDENTIAL_MESSAGE, {
      "WWW-Authenticate": challenge({ code: "invalid_token", description: "Not a Cituna access token or API key" }),
    });
    return;
  }
  const check = await checkCredential(credential);
  if (check.refused) {
    rpcError(res, 401, -32001, INVALID_CREDENTIALS_MESSAGE, {
      "WWW-Authenticate": challenge({ code: "invalid_token", description: "The credential is expired, revoked or unknown" }),
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
    if (check.scope !== null && !scopeAllowsWrite(check.scope) && writeToolRequested(parsed)) {
      rpcError(res, 403, -32001, READ_ONLY_MESSAGE, {
        "WWW-Authenticate": challenge({ code: "insufficient_scope", description: "This grant is read-only. Approve changes to use this tool." }),
      }, requestId(parsed));
      cleanup();
      return;
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    // The raw message is ours: it carries backend hostnames, upstream provider
    // detail and Mongo internals, and an MCP client renders it verbatim in the
    // user's chat. Log it, return the code only (2026-09-06 audit).
    console.error("[cituna-mcp-http] request failed:", (e as Error).message);
    if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error.");
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

  // ─── MCP config schema (key-based connect, for directories/gateways) ─────
  // WHY THIS EXISTS: an external directory (Smithery et al.) that discovers only
  // the OAuth protected-resource metadata above shows the user a single
  // "authorize your whole Cituna workspace" button — the wrong default for a
  // listing, and the thing that makes people hesitate to connect. This endpoint
  // advertises the OTHER accepted credential: a personal API key. A config-aware
  // client reads this and renders a "paste your key" form, then connects
  // straight to this endpoint with the key — no OAuth grant, and the directory
  // itself receives nothing. The key is the user's own workspace-scoped,
  // revocable credential (the same one the npm/stdio path uses).
  //
  // This is a config-discovery convention, not yet ratified MCP spec; the
  // standardized equivalent is the `remotes[].headers` block in server.json,
  // which points registry-driven clients at the same key path. Public and
  // unauthenticated, exactly like the metadata above — a client reads it BECAUSE
  // it does not have a credential yet.
  if (url.pathname === MCP_CONFIG_PATH) {
    sendJson(res, 200, {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-mcp-config-version": "1",
      type: "object",
      required: ["apiKey"],
      additionalProperties: false,
      properties: {
        apiKey: {
          type: "string",
          title: "Cituna API key",
          description:
            "Your personal Cituna API key (cituna_sk_…). Create it in the app under Integrations → \"Claude / MCP access\" → Generate token. It authenticates as you, is scoped to your workspace only, and is revocable in the app — connecting this way needs no OAuth grant.",
          minLength: 8,
          // Forward the entered value as the X-API-Key header on every request to
          // /mcp. (The server also accepts it as `Authorization: Bearer <key>`;
          // X-API-Key is used here because it carries the raw key with no "Bearer "
          // prefix for a proxy to have to synthesise.)
          "x-to": { header: "X-API-Key" },
        },
      },
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
      mcp_config: `${PUBLIC_URL}${MCP_CONFIG_PATH}`,
      docs: "https://cituna.com/mcp",
      message: `This is an MCP endpoint, not a website. Add ${PUBLIC_URL}${MCP_PATH} as a connector in your MCP client — sign in with OAuth, or connect with a personal API key (Authorization: Bearer cituna_sk_… or X-API-Key).`,
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
