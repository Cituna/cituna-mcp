// set_outreach_status ↔ backend vocabulary drift test.
//
// WHY THIS EXISTS: on 2026-09-10 every call to `set_outreach_status` failed in
// production. The tool validated `status` against GAP_STATES (todo / doing /
// done) — the vocabulary of the OTHER status tool — while the endpoint it posts
// to, `POST /api/sources/outreach`, accepts only planned / pitched / placed /
// declined (plus "none" to clear) and answers anything else with a 400. The
// schema enum, the description, and the handler's own pre-check all agreed with
// each other and all disagreed with the backend, so nothing local caught it: the
// tool looked healthy right up to the HTTP call.
//
// The two packages never import each other, so this test reads the API's list
// as TEXT (the same posture as annotations.test.ts) and pins three things to it:
// the JSON-schema enum clients see, the words in the description, and what the
// handler actually accepts and rejects when driven over an in-memory MCP
// transport with the backend stubbed.
//
// Run: cd mcp && npx tsx src/outreach.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CitunaClient } from "./client.js";
import { TOOLS, createCitunaServer } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTREACH_TS = resolve(HERE, "../../api/src/outreachStatus.ts");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

// ─── The backend's list, read from source ────────────────────────────────────
// `export const OUTREACH_STATUSES = ["planned", "pitched", "placed", "declined"] as const;`
function apiOutreachStatuses(): string[] {
  const src = readFileSync(OUTREACH_TS, "utf8");
  const m = src.match(/export const OUTREACH_STATUSES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, `could not find OUTREACH_STATUSES in ${OUTREACH_TS}`);
  const list = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(list.length >= 2, `OUTREACH_STATUSES parsed to ${JSON.stringify(list)}`);
  return list;
}
const API_STATUSES = apiOutreachStatuses();
// "none" is not stored — the backend deletes the row — but it IS an accepted
// value on the wire, so the tool must offer it too.
const API_ACCEPTS = [...API_STATUSES, "none"];

const outreachTool = TOOLS.find((t) => t.name === "set_outreach_status");
const gapTool = TOOLS.find((t) => t.name === "set_gap_status");
assert.ok(outreachTool, "set_outreach_status tool is missing");
assert.ok(gapTool, "set_gap_status tool is missing");
const schemaEnum: string[] = (outreachTool!.inputSchema as any).properties.status.enum;
const gapEnum: string[] = (gapTool!.inputSchema as any).properties.status.enum;

console.log(`\nset_outreach_status vocabulary (backend accepts: ${API_ACCEPTS.join(", ")})`);

test("schema enum equals the API's OUTREACH_STATUSES plus none", () => {
  assert.deepEqual([...schemaEnum].sort(), [...API_ACCEPTS].sort());
});

test("schema enum shares no value with set_gap_status (the 2026-09-10 regression)", () => {
  const overlap = schemaEnum.filter((s) => gapEnum.includes(s));
  assert.deepEqual(overlap, [], `outreach enum leaks gap vocabulary: ${overlap.join(", ")}`);
});

test("description names every accepted status and no gap status", () => {
  const text = `${outreachTool!.description} ${(outreachTool!.inputSchema as any).properties.status.description}`.toLowerCase();
  for (const s of API_ACCEPTS) assert.ok(text.includes(s), `description never mentions "${s}"`);
  for (const s of gapEnum) {
    assert.ok(!new RegExp(`\\b${s}\\b`).test(text), `description still teaches gap vocabulary "${s}"`);
  }
});

// ─── Drive the real handler over an in-memory transport ──────────────────────
// A real CitunaClient with fetch stubbed, so the assertion covers the exact
// request the backend would receive — path, method and body — not a mock's idea
// of it.
type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let sourcesResponse: any = { targets: [], outreach: {} };
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  const method = String(init?.method ?? "GET");
  hits.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const payload = u.includes("/api/sources?") || u.endsWith("/api/sources") ? sourcesResponse : { ok: true };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};

const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "outreach-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);

async function call(name: string, args: Record<string, unknown>) {
  hits.length = 0;
  const res: any = await mcp.callTool({ name, arguments: args });
  const text = String(res?.content?.[0]?.text ?? "");
  return { isError: res?.isError === true, text, posts: hits.filter((h) => h.method === "POST") };
}

for (const status of API_ACCEPTS) {
  await test(`handler accepts "${status}" and posts it unchanged to /api/sources/outreach`, async () => {
    const r = await call("set_outreach_status", { domain: "acme.com", host: "frase.io", status });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.posts.length, 1, `expected one POST, saw ${JSON.stringify(hits)}`);
    assert.equal(r.posts[0].url, "http://backend.test/api/sources/outreach");
    assert.deepEqual(r.posts[0].body, { domain: "acme.com", host: "frase.io", status });
  });
}

for (const status of gapEnum) {
  await test(`handler rejects gap status "${status}" before it reaches the backend`, async () => {
    const r = await call("set_outreach_status", { domain: "acme.com", host: "frase.io", status });
    assert.equal(r.isError, true, "a gap status must be an error");
    for (const s of API_ACCEPTS) assert.ok(r.text.includes(s), `error copy should list "${s}": ${r.text}`);
    assert.equal(r.posts.length, 0, "must not spend a backend call on a value the backend will 400");
  });
}

await test("handler rejects an unknown status with the accepted list", async () => {
  const r = await call("set_outreach_status", { domain: "acme.com", host: "frase.io", status: "won" });
  assert.equal(r.isError, true);
  assert.equal(r.posts.length, 0);
});

await test("list_citation_sources reports a host with no row as none, never todo", async () => {
  sourcesResponse = {
    targets: [
      { host: "frase.io", kind: "blog", count: 3, presence: "absent" },
      { host: "g2.com", kind: "review", count: 5, presence: "mentioned" },
    ],
    outreach: { "g2.com": API_STATUSES[0] },
  };
  const r = await call("list_citation_sources", { domain: "acme.com" });
  assert.equal(r.isError, false, r.text);
  const parsed = JSON.parse(r.text);
  const byHost = Object.fromEntries(parsed.targets.map((t: any) => [t.host, t.outreachStatus]));
  assert.equal(byHost["frase.io"], "none");
  assert.equal(byHost["g2.com"], API_STATUSES[0]);
  for (const t of parsed.targets) {
    assert.ok(!gapEnum.includes(t.outreachStatus), `list hands the caller gap vocabulary: ${t.outreachStatus}`);
  }
});

await test("list_citation_sources forwards `engine` and reports what each engine reads", async () => {
  sourcesResponse = {
    engineFilter: "perplexity",
    targets: [{ host: "g2.com", kind: "review", count: 2, presence: "absent", engines: ["chatgpt", "perplexity"], byEngine: { chatgpt: 1, perplexity: 2 } }],
    engineSummary: [
      { engine: "chatgpt", answers: 18, citedYou: 3, citations: 40, ownCitations: 2, sites: [{ host: "reddit.com", count: 9 }] },
      { engine: "perplexity", answers: 18, citedYou: 5, citations: 90, ownCitations: 4, sites: [{ host: "g2.com", count: 12 }] },
    ],
    outreach: {},
  };
  const r = await call("list_citation_sources", { domain: "acme.com", engine: "perplexity" });
  assert.equal(r.isError, false, r.text);
  const get = hits.find((h) => h.method === "GET" && h.url.includes("/api/sources"));
  assert.ok(get, `no GET to /api/sources in ${JSON.stringify(hits)}`);
  assert.equal(new URL(get!.url).searchParams.get("engine"), "perplexity");
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.engine, "perplexity");
  assert.deepEqual(parsed.targets[0].citationsByEngine, { chatgpt: 1, perplexity: 2 });
  assert.deepEqual(parsed.whatEachEngineReads.map((e: any) => [e.engine, e.answersCitingYou, e.topSites[0].host]), [
    ["chatgpt", 3, "reddit.com"],
    ["perplexity", 5, "g2.com"],
  ]);
});

await test("list_citation_sources without `engine` sends no engine param", async () => {
  sourcesResponse = { targets: [], outreach: {} };
  const r = await call("list_citation_sources", { domain: "acme.com" });
  assert.equal(r.isError, false, r.text);
  const get = hits.find((h) => h.method === "GET" && h.url.includes("/api/sources"));
  assert.equal(new URL(get!.url).searchParams.has("engine"), false);
  assert.deepEqual(JSON.parse(r.text).whatEachEngineReads, []);
});

// ─── `limit` and `totalTargets` ──────────────────────────────────────────────
// 2026-09-22: limit 100 returned exactly 25 targets and totalTargets: 25, with
// and without an engine. The API sent a fixed 25 and this tool counted what it
// was sent. Now the tool asks the API for the page it wants, and the totals are
// the API's count of every candidate host, taken before the page was cut.
const target = (i: number, presence = "unknown") => ({ host: `site${i}.com`, kind: "article", count: 1, presence });
const sourcesQuery = () => new URL(hits.find((h) => h.method === "GET" && h.url.includes("/api/sources"))!.url).searchParams;

await test("list_citation_sources forwards `limit` and reports every candidate in totalTargets", async () => {
  sourcesResponse = {
    targets: Array.from({ length: 100 }, (_, i) => target(i)),
    targetCounts: { total: 180, absent: 0, unknown: 180, unreachable: 0, mentioned: 0, linked: 0 },
    outreach: {},
  };
  const r = await call("list_citation_sources", { domain: "acme.com", limit: 100 });
  assert.equal(r.isError, false, r.text);
  assert.equal(sourcesQuery().get("limit"), "100");
  assert.equal(sourcesQuery().has("gapsOnly"), false);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.targets.length, 100);
  assert.equal(parsed.totalTargets, 180, "the candidates before the cut, not the size of the page");
  assert.equal(parsed.uncheckedTargets, 180);
  assert.equal(parsed.nextOffset, 100);
  assert.equal(parsed.note, "Showing 1-100 of 180. Pass offset: 100 for the next page.", "a truncated list says so, and how to go on");
});

await test("list_citation_sources asks for 25 by default and never more than 100", async () => {
  sourcesResponse = { targets: [], outreach: {} };
  await call("list_citation_sources", { domain: "acme.com" });
  assert.equal(sourcesQuery().get("limit"), "25");
  await call("list_citation_sources", { domain: "acme.com", limit: 500 });
  assert.equal(sourcesQuery().get("limit"), "100");
});

await test("list_citation_sources gapsOnly asks the API for gaps and counts them over every candidate", async () => {
  sourcesResponse = {
    targets: [target(7, "absent")],
    targetCounts: { total: 180, absent: 3, unknown: 170, unreachable: 2, mentioned: 3, linked: 2 },
    outreach: {},
  };
  const r = await call("list_citation_sources", { domain: "acme.com", gapsOnly: true, limit: 1 });
  assert.equal(r.isError, false, r.text);
  assert.equal(sourcesQuery().get("gapsOnly"), "1");
  assert.equal(sourcesQuery().get("limit"), "1");
  const parsed = JSON.parse(r.text);
  assert.deepEqual(parsed.targets.map((t: any) => t.host), ["site7.com"]);
  assert.equal(parsed.gapTargets, 3);
  assert.equal(parsed.totalTargets, 180);
  assert.equal(parsed.note, "Showing 1 of 3. Pass offset: 1 for the next page, or raise `limit` (up to 100).");
});

await test("list_citation_sources against an API with no targetCounts counts what came back", async () => {
  sourcesResponse = { targets: [target(1, "absent"), target(2)], outreach: {} };
  const r = await call("list_citation_sources", { domain: "acme.com" });
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.totalTargets, 2);
  assert.equal(parsed.gapTargets, 1);
  assert.equal(parsed.uncheckedTargets, 1);
  assert.equal(parsed.note, undefined, "nothing was cut");
  assert.equal(parsed.nextOffset, null);
});

// ─── `offset`: reaching every host, 100 at a time ───────────────────────────
// cituna.com had 564 candidates on 2026-09-22 against a ceiling of 100 a call.
const pageOf = (from: number, n: number, total: number, offset: number) => ({
  targets: Array.from({ length: n }, (_, i) => target(from + i)),
  targetCounts: { total, absent: 0, unknown: total, unreachable: 0, mentioned: 0, linked: 0 },
  targetPage: { limit: 100, offset, gapsOnly: false },
  outreach: {},
});

await test("list_citation_sources forwards `offset` and says where the next page starts", async () => {
  sourcesResponse = pageOf(100, 100, 250, 100);
  const r = await call("list_citation_sources", { domain: "acme.com", limit: 100, offset: 100 });
  assert.equal(r.isError, false, r.text);
  assert.equal(sourcesQuery().get("offset"), "100");
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.offset, 100);
  assert.equal(parsed.nextOffset, 200);
  assert.equal(parsed.note, "Showing 101-200 of 250. Pass offset: 200 for the next page.");
});

await test("list_citation_sources says so on the last page, and nextOffset is null", async () => {
  sourcesResponse = pageOf(200, 50, 250, 200);
  const parsed = JSON.parse((await call("list_citation_sources", { domain: "acme.com", limit: 100, offset: 200 })).text);
  assert.equal(parsed.nextOffset, null);
  assert.equal(parsed.note, "Showing 201-250 of 250. That is the last page.");
});

await test("list_citation_sources sends no offset for the first page", async () => {
  sourcesResponse = pageOf(0, 25, 250, 0);
  const parsed = JSON.parse((await call("list_citation_sources", { domain: "acme.com" })).text);
  assert.equal(sourcesQuery().has("offset"), false);
  assert.equal(parsed.nextOffset, 25);
});

await test("list_citation_sources refuses a page an older API did not serve, instead of repeating page one", async () => {
  // An API that predates paging ignores ?offset= and sends no targetPage.
  sourcesResponse = { targets: Array.from({ length: 100 }, (_, i) => target(i)), targetCounts: { total: 250, unknown: 250 }, outreach: {} };
  const r = await call("list_citation_sources", { domain: "acme.com", limit: 100, offset: 100 });
  assert.equal(r.isError, true, "page one relabelled as page two would repeat rows and never end a paging loop");
  assert.match(r.text, /not available on this backend yet/);
});

await mcp.close();
await server.close();
(globalThis as any).fetch = realFetch;

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED: ${failures.join("; ")}` : ""}\n`);
if (failures.length) process.exit(1);
