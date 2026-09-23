// Transport parity + remote-endpoint tests.
// Run: cd mcp && npm run build && npm run test:transports
//
// WHY THIS EXISTS: the tool layer was split out of the stdio entrypoint so that
// the npm package and the remote (Streamable HTTP) server can never describe
// different products. Nothing but a test enforces that — a well-meaning edit to
// one entrypoint's tool list would otherwise ship a Connectors user a different
// Cituna than an npx user. The parity assertion below is the point of the file;
// the rest checks the remote transport actually speaks MCP and rejects anonymous
// callers.
//
// RUNS OFFLINE, and that is enforced rather than hoped for: the spawned server is
// pointed at a LOCAL STUB backend (see below). It used to be pointed at nothing,
// which means http.ts's default — https://cituna.com, i.e. LIVE PRODUCTION. The
// bogus-key test then depended on a GitHub runner reaching the real site, so it
// failed with "Error: fetch failed" whenever a deploy was in flight — and main
// auto-deploys on every merge, so it broke the required check on three separate
// PRs on 2026-08-08, each time passing on a manual re-run with prod verified
// healthy. A test of OUR error copy must not have an internet dependency.
//
// Set CITUNA_API_KEY to additionally prove a real authenticated tool call against
// the live backend (skipped, loudly, when unset) — that block is the ONLY place
// this file is allowed to touch the network.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "../dist");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

// ─── stdio client ────────────────────────────────────────────────────────────
// Newline-delimited JSON-RPC over the child's stdin/stdout, which is exactly
// what Claude Desktop/Code do.
class StdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<number, (v: any) => void>();
  private nextId = 1;

  constructor(env: Record<string, string> = {}) {
    this.child = spawn("node", [resolve(DIST, "index.js")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolveFn = this.pending.get(msg.id);
        if (resolveFn) { this.pending.delete(msg.id); resolveFn(msg); }
      }
    });
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`stdio ${method} timed out`)), 15000);
      this.pending.set(id, (v) => { clearTimeout(timer); res(v); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  kill() { this.child.kill("SIGKILL"); }
}

// ─── Streamable HTTP client ──────────────────────────────────────────────────
// The server replies with SSE by default (spec-preferred), so a `data:` frame
// carries the JSON-RPC payload. A JSON content-type is handled too, so this
// keeps working if enableJsonResponse is ever flipped on.
async function rpc(
  url: string,
  method: string,
  params: unknown = {},
  opts: { token?: string; id?: number; sessionId?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.sessionId ? { "Mcp-Session-Id": opts.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params }),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  let body: any = null;
  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try { body = JSON.parse(json); } catch { /* keep scanning */ }
    }
  } else {
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers };
}

const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "transport-parity-test", version: "0.0.0" },
};

// ─── Boot the remote server ──────────────────────────────────────────────────
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;
const LIVE_KEY = process.env.CITUNA_API_KEY || "";

// ─── The stub backend ────────────────────────────────────────────────────────
// Stands in for the Cituna API so the offline tests exercise the MCP layer only.
// It answers /api/auth/me the way the real backend answers an unresolvable
// credential — HTTP 200 with user:null — which is precisely the case the
// bogus-key test asserts on (tools.ts turns that into the "invalid or revoked"
// copy). /api/auth/credential is the transport's pre-flight check: 401 for the
// key named "definitely_not_real", 404 for a "legacy_backend" key (an API
// deployed before the endpoint existed), 200 for anything else. Any other path
// 404s: if a future test needs a new endpoint it should fail loudly here rather
// than silently reaching for prod.
const stubPort = await freePort();
const stubHits: string[] = [];
const credentialChecks: string[] = [];
const stub = createServer((req, res) => {
  stubHits.push(String(req.url ?? ""));
  if ((req.url ?? "").startsWith("/api/auth/credential")) {
    const presented = String(req.headers.authorization ?? "");
    credentialChecks.push(presented);
    const status = presented.includes("definitely_not_real") ? 401 : presented.includes("legacy_backend") ? 404 : 200;
    // Like the real endpoint: an OAuth grant carries its scope (read-only when the
    // token is named so), an API key carries null ("not scope-limited").
    const oauth = presented.includes("cituna_at_");
    const scope = oauth ? (presented.includes("readonly") ? "cituna:read" : "cituna:read cituna:write") : null;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { active: true, kind: oauth ? "oauth" : "api_key", scope } : { active: false }));
    return;
  }
  if ((req.url ?? "").startsWith("/api/auth/me")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ user: null, isFounder: false, google: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "stub: unhandled path" }));
});
await new Promise<void>((r) => stub.listen(stubPort, "127.0.0.1", () => r()));

const httpChild = spawn("node", [resolve(DIST, "http.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    CITUNA_API_KEY: "",
    // Without this the server falls back to https://cituna.com — see the header.
    CITUNA_API_URL: `http://127.0.0.1:${stubPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
httpChild.stderr.on("data", (d: Buffer) => console.error("[http server]", d.toString().trim()));

// Wait for the listener rather than sleeping a fixed amount.
await (async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("remote MCP server did not start");
})();

console.log("\nRemote transport");

await test("GET /healthz reports the service is up", async () => {
  const r = await fetch(`${BASE}/healthz`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.transport, "streamable-http");
});

await test("GET / explains itself instead of 404-ing a human", async () => {
  const r = await fetch(`${BASE}/`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.endpoint, "/mcp");
  assert.match(j.message, /MCP endpoint/i);
  // The root doc must point at the config schema so a directory can find the
  // key path without probing the OAuth metadata first.
  assert.match(String(j.mcp_config), /\/\.well-known\/mcp-config$/);
});

await test("GET /.well-known/mcp-config advertises the API-key path (not just OAuth)", async () => {
  // This is what lets an external directory (Smithery et al.) render a
  // "paste your key" form instead of forcing the authorize-your-whole-workspace
  // OAuth grant. A regression here silently pushes every listing back to OAuth.
  const r = await fetch(`${BASE}/.well-known/mcp-config`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(j.required, ["apiKey"]);
  assert.equal(j.properties.apiKey.type, "string");
  // The entered key is forwarded as a header the server actually accepts.
  assert.equal(j.properties.apiKey["x-to"].header, "X-API-Key");
  // Unauthenticated, like the other well-known docs — a client reads it BEFORE
  // it has a credential.
  assert.equal(r.headers.get("www-authenticate"), null);
});

await test("an anonymous POST /mcp is rejected with actionable copy", async () => {
  const { status, body, headers } = await rpc(MCP_URL, "initialize", INIT_PARAMS);
  assert.equal(status, 401);
  assert.match(body.error.message, /Integrations/);
  assert.match(body.error.message, /cituna_sk_/);
  // Must not leak the tool list to an unauthenticated caller.
  assert.equal(body.result, undefined);
  // The challenge is what turns this into a sign-in prompt in the client.
  const challenge = String(headers.get("www-authenticate"));
  assert.match(challenge, /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  assert.doesNotMatch(challenge, /error=/, "an anonymous request is not an invalid token");
  assert.match(challenge, /scope="cituna:read cituna:write"/);
});

await test("a credential that is not a Cituna MCP credential is refused, never forwarded", async () => {
  // A web-app session JWT used to be passed straight to the backend as a bearer.
  const before = stubHits.length;
  const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4Iiwicm9sZSI6ImZvdW5kZXIifQ.c2lnbmF0dXJl";
  const { status, body, headers } = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: jwtLike });
  assert.equal(status, 401);
  assert.match(String(headers.get("www-authenticate")), /error="invalid_token"/);
  assert.equal(body.result, undefined);
  assert.equal(stubHits.length, before, "the foreign credential reached the backend");
});

await test("a revoked or unknown key gets HTTP 401 invalid_token, so the client re-authenticates", async () => {
  // Before the pre-flight check this answered 200 and failed every tool call
  // inside it, and a client never refreshes or re-runs sign-in on a 200.
  const { status, body, headers } = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: "cituna_sk_definitely_not_real" });
  assert.equal(status, 401);
  const challenge = String(headers.get("www-authenticate"));
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /resource_metadata="/);
  assert.match(body.error.message, /expired or was revoked/);
  assert.equal(body.result, undefined);
});

await test("a good credential is checked once, then served from the cache", async () => {
  const probe = "cituna_sk_cache_probe_credential_0001";
  for (let i = 0; i < 3; i++) {
    const { status } = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: probe, id: 10 + i });
    assert.equal(status, 200);
  }
  assert.equal(credentialChecks.filter((c) => c.includes(probe)).length, 1, "every request re-checked the credential");
});

await test("OPTIONS preflight is answered for browser clients", async () => {
  const r = await fetch(MCP_URL, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(String(r.headers.get("access-control-allow-headers")), /Authorization/);
});

await test("a bearer token initializes an MCP session", async () => {
  const { status, body } = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: "cituna_sk_fake_for_handshake" });
  assert.equal(status, 200);
  assert.equal(body.result.serverInfo.name, "cituna");
  assert.ok(body.result.instructions.includes("Cituna tracks how seven AI answer engines"));
  assert.ok(body.result.capabilities.tools);
  assert.ok(body.result.capabilities.prompts);
});

// ─── Step-up ─────────────────────────────────────────────────────────────────
// A grant approved read-only must be told, at the HTTP level, that a write tool
// needs more: 403 + insufficient_scope is what makes claude.ai ask the user to
// approve changes and retry. An error inside a 200 left users with no way to
// ever get the write checkbox back.
console.log("\nStep-up for a read-only grant");

const READ_ONLY_GRANT = "cituna_at_readonly_grant_0000000001";
const WRITE_GRANT = "cituna_at_write_grant_00000000000001";
const WRITE_CALL = { name: "queue_article", arguments: { domain: "example.com", keyword: "study in germany" } };

await test("a read-only grant calling a write tool gets HTTP 403 insufficient_scope naming both scopes", async () => {
  const { status, body, headers } = await rpc(MCP_URL, "tools/call", WRITE_CALL, { token: READ_ONLY_GRANT, id: 21 });
  assert.equal(status, 403);
  const challenge = String(headers.get("www-authenticate"));
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="cituna:read cituna:write"/);
  assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  assert.match(body.error.message, /read-only/);
  assert.equal(body.id, 21, "the refusal should answer the request it refuses");
});

await test("a write tool inside a batch is caught too", async () => {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${READ_ONLY_GRANT}` },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "list_brands", arguments: {} } },
      { jsonrpc: "2.0", id: 32, method: "tools/call", params: WRITE_CALL },
    ]),
  });
  await r.body?.cancel();
  assert.equal(r.status, 403);
  assert.match(String(r.headers.get("www-authenticate")), /error="insufficient_scope"/);
});

await test("a read-only grant still reaches the read tools", async () => {
  const { status } = await rpc(MCP_URL, "tools/call", { name: "list_brands", arguments: {} }, { token: READ_ONLY_GRANT, id: 22 });
  assert.equal(status, 200);
});

await test("a grant that allows changes reaches the write tool", async () => {
  const { status } = await rpc(MCP_URL, "tools/call", WRITE_CALL, { token: WRITE_GRANT, id: 23 });
  assert.equal(status, 200);
});

await test("a personal API key is not scope-limited", async () => {
  const { status } = await rpc(MCP_URL, "tools/call", WRITE_CALL, { token: "cituna_sk_fake_for_handshake", id: 24 });
  assert.equal(status, 200);
});

// ─── Parity ──────────────────────────────────────────────────────────────────
console.log("\nParity");

async function httpToolsAndPrompts() {
  // Stateless mode: each POST stands alone, but the transport still expects the
  // initialize handshake, so re-run it and reuse any session id it hands back.
  const init = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: "cituna_sk_fake_for_handshake" });
  const sessionId = init.headers.get("mcp-session-id") || undefined;
  const tools = await rpc(MCP_URL, "tools/list", {}, { token: "cituna_sk_fake_for_handshake", id: 2, sessionId });
  const prompts = await rpc(MCP_URL, "prompts/list", {}, { token: "cituna_sk_fake_for_handshake", id: 3, sessionId });
  return { tools: tools.body?.result?.tools, prompts: prompts.body?.result?.prompts };
}

async function stdioToolsAndPrompts() {
  const c = new StdioClient({ CITUNA_API_KEY: "cituna_sk_fake_for_handshake" });
  try {
    await c.send("initialize", INIT_PARAMS);
    c.notify("notifications/initialized");
    const tools = await c.send("tools/list");
    const prompts = await c.send("prompts/list");
    return { tools: tools.result?.tools, prompts: prompts.result?.prompts };
  } finally {
    c.kill();
  }
}

const [http, stdio] = await Promise.all([httpToolsAndPrompts(), stdioToolsAndPrompts()]);

await test("stdio and remote expose the SAME tools, byte for byte", async () => {
  assert.ok(Array.isArray(stdio.tools) && stdio.tools.length > 0, "stdio returned no tools");
  assert.ok(Array.isArray(http.tools) && http.tools.length > 0, "remote returned no tools");
  assert.equal(http.tools.length, stdio.tools.length);
  // Names, descriptions AND schemas — a description is product surface, and a
  // drifted schema is a tool that works in one client and fails in the other.
  assert.deepEqual(
    JSON.parse(JSON.stringify(http.tools)),
    JSON.parse(JSON.stringify(stdio.tools)),
  );
  console.log(`    (${http.tools.length} tools identical: ${http.tools.map((t: any) => t.name).join(", ")})`);
});

await test("stdio and remote expose the SAME prompts", async () => {
  assert.ok(Array.isArray(stdio.prompts) && stdio.prompts.length > 0, "stdio returned no prompts");
  assert.deepEqual(
    JSON.parse(JSON.stringify(http.prompts)),
    JSON.parse(JSON.stringify(stdio.prompts)),
  );
  console.log(`    (${http.prompts.length} prompts identical: ${http.prompts.map((p: any) => p.name).join(", ")})`);
});

await test("when the backend cannot check (too old for the endpoint), a bogus key still fails with onboarding copy, not a stack trace", async () => {
  // The pre-flight check fails OPEN on anything but a definite 401, so an API
  // deployed before /api/auth/credential behaves exactly as before: the request
  // runs, and the tool reports the dead credential itself.
  const legacy = "cituna_sk_legacy_backend_not_real";
  const init = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: legacy });
  assert.equal(init.status, 200);
  const sessionId = init.headers.get("mcp-session-id") || undefined;
  const { body } = await rpc(MCP_URL, "tools/call", { name: "whoami", arguments: {} }, { token: legacy, id: 4, sessionId });
  const text = body?.result?.content?.[0]?.text ?? "";
  assert.equal(body?.result?.isError, true, `expected isError, got: ${JSON.stringify(body).slice(0, 300)}`);
  assert.match(text, /invalid|revoked|Authentication failed/i);
});

// ─── Live backend (opt-in) ───────────────────────────────────────────────────
console.log("\nLive backend");

if (!LIVE_KEY) {
  console.log("  ⚠ SKIPPED — set CITUNA_API_KEY to prove a real authenticated call end to end");
} else {
  await test("whoami over the remote transport resolves the real account", async () => {
    const init = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: LIVE_KEY });
    const sessionId = init.headers.get("mcp-session-id") || undefined;
    const { body } = await rpc(MCP_URL, "tools/call", { name: "whoami", arguments: {} }, { token: LIVE_KEY, id: 5, sessionId });
    const text = body?.result?.content?.[0]?.text ?? "";
    assert.notEqual(body?.result?.isError, true, `whoami failed: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text);
    assert.ok(parsed.email, "no email in whoami payload");
    assert.ok(parsed.workspaceId, "no workspaceId in whoami payload");
    console.log(`    (authenticated as ${parsed.email} · plan ${parsed.plan?.plan ?? parsed.plan ?? "?"} · backend ${parsed.backend})`);
  });

  await test("a read tool returns real workspace data over the remote transport", async () => {
    const init = await rpc(MCP_URL, "initialize", INIT_PARAMS, { token: LIVE_KEY });
    const sessionId = init.headers.get("mcp-session-id") || undefined;
    const { body } = await rpc(MCP_URL, "tools/call", { name: "list_brands", arguments: {} }, { token: LIVE_KEY, id: 6, sessionId });
    const text = body?.result?.content?.[0]?.text ?? "";
    assert.notEqual(body?.result?.isError, true, `list_brands failed: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text);
    const brands = parsed.brands ?? parsed.projects ?? parsed;
    console.log(`    (${Array.isArray(brands) ? brands.length : "?"} brands returned)`);
  });
}

httpChild.kill("SIGKILL");
stub.close();
// Proof the offline path really was offline: the stub must have been called. If
// this is ever 0 the server found a different backend — which means production —
// and the whole point of the stub has quietly lapsed.
if (!LIVE_KEY && stubHits.length === 0) {
  console.error("  \u2717 the stub backend was never called \u2014 the MCP server is talking to something else");
  process.exitCode = 1;
} else if (!LIVE_KEY) {
  // Printed, not just asserted: a green run must SHOW that the backend calls
  // landed locally. "The tests passed" is not evidence of offline-ness while
  // production happens to be reachable \u2014 which is exactly how this went
  // unnoticed until CI started failing on deploy windows.
  console.log(`\n  offline: ${stubHits.length} backend call(s) served by the local stub (${[...new Set(stubHits)].join(", ")})`);
}
console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ""}\n`);
