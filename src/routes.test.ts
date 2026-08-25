// Every endpoint the MCP calls must exist on the backend, with the same verb.
//
// This test exists because it caught a real one. `competitor_discovery` shipped
// calling `api.get("/api/audit", { scanId })`. `/api/audit` IS a route, so a
// path-only check would have passed it — but it is a POST, and it is the public
// "run an audit on this URL" endpoint, not "read audit by id". The correct call
// was `GET /api/scan/<id>`, which is what get_audit had been using all along.
//
// The failure mode is what makes this worth a test: the call sat inside a
// try/catch, so the tool did not error. It silently returned half its answer,
// and "fewer candidates" is indistinguishable from "fewer candidates exist".
//
// Verb matters as much as path. A GET against a POST route does not 404 in a way
// anyone notices; it 404s inside a catch block six months later.
// Run: cd mcp && npx tsx src/routes.test.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const tools = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

// Scan the WHOLE api source tree, not a hand-listed subset. Routes are spread
// across server.ts and a dozen register*Routes modules, and a hardcoded list
// goes stale the first time someone adds a file — which would make this test
// fail on correct code, the fastest way to get a test deleted.
const apiDir = fileURLToPath(new URL("../../api/src/", import.meta.url));
const backend = [
  readFileSync(new URL("../../api/server.ts", import.meta.url), "utf8"),
  ...readdirSync(apiDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(apiDir, f), "utf8")),
].join("\n");

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

/** Every `app.get("/x")` / `app.post("/x")` the backend registers. */
function backendRoutes(verb: string): string[] {
  return [...backend.matchAll(new RegExp(`app\\.${verb}\\(\\s*["\`]([^"\`]+)["\`]`, "g"))].map((m) => m[1]);
}
const GET_ROUTES = backendRoutes("get");
const POST_ROUTES = backendRoutes("post");

/** Express path → matcher, so `/api/scan/:id` matches a templated MCP call. */
function matches(routes: string[], called: string): boolean {
  return routes.some((r) => {
    if (r === called) return true;
    if (!r.includes(":")) return false;
    const re = new RegExp("^" + r.replace(/:[^/]+/g, "[^/]+") + "$");
    return re.test(called);
  });
}

/** Calls the MCP makes. Template literals become a `*` segment. */
function mcpCalls(verb: "get" | "post"): string[] {
  const out: string[] = [];
  // Plain string paths: api.get("/api/x")
  for (const m of tools.matchAll(new RegExp(`api\\.${verb}\\(\\s*"([^"]+)"`, "g"))) out.push(m[1]);
  // Template paths: api.get(`/api/scan/${...}`) → /api/scan/X
  for (const m of tools.matchAll(new RegExp("api\\\\." + verb + "\\(\\s*`([^`]+)`", "g"))) {
    out.push(m[1].replace(/\$\{[^}]*\}/g, "X"));
  }
  return [...new Set(out)];
}

console.log("\nMCP → backend route contract");

test("the backend actually registers routes we can read", () => {
  assert.ok(GET_ROUTES.length > 20, `only found ${GET_ROUTES.length} GET routes — the scan is broken, not the code`);
  assert.ok(POST_ROUTES.length > 10, `only found ${POST_ROUTES.length} POST routes`);
});

test("every path the MCP GETs is a real GET route", () => {
  const missing = mcpCalls("get").filter((p) => !matches(GET_ROUTES, p));
  assert.deepEqual(missing, [], `MCP GETs paths the backend does not serve as GET: ${missing.join(", ")}`);
});

test("every path the MCP POSTs is a real POST route", () => {
  const missing = mcpCalls("post").filter((p) => !matches(POST_ROUTES, p));
  assert.deepEqual(missing, [], `MCP POSTs paths the backend does not serve as POST: ${missing.join(", ")}`);
});

test("the MCP never GETs something that is only a POST", () => {
  // The exact bug: /api/audit exists, but only as POST, and it STARTS a scan.
  // A GET against it is both wrong and expensive to get wrong.
  const wrongVerb = mcpCalls("get").filter((p) => !matches(GET_ROUTES, p) && matches(POST_ROUTES, p));
  assert.deepEqual(wrongVerb, [], `these are POST-only routes being called with GET: ${wrongVerb.join(", ")}`);
});

test("/api/audit is not GET-called from the MCP", () => {
  // Pinned by name, because getting this one wrong triggers a real scan and
  // spends the customer's quota rather than just failing.
  assert.ok(!mcpCalls("get").includes("/api/audit"), "/api/audit is the public run-a-scan POST; read audits with GET /api/scan/<id>");
});

console.log(`\n${passed} passed\n`);
