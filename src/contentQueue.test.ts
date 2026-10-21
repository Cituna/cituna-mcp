// list_content_queue pages the article history, so an agent can reach past the
// newest 30 and read one cut (live, review, rejected, attention) alone.
// Run: cd mcp && npx tsx src/contentQueue.test.ts
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CitunaClient } from "./client.js";
import { TOOLS, createCitunaServer } from "./tools.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failures.push(name); console.error("  FAIL " + name + "\n    " + (e as Error).message); }
}
const hits: URL[] = [];
let routes: Record<string, { status?: number; body: unknown }> = {};
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any) => {
  const u = new URL(String(url));
  hits.push(u);
  const r = routes[u.pathname] ?? { status: 404, body: { error: "Cannot GET " + u.pathname } };
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
};
const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "content-queue-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);
async function raw(args: Record<string, unknown> = {}) {
  hits.length = 0;
  return (await mcp.callTool({ name: "list_content_queue", arguments: { domain: "acme.com", ...args } })) as any;
}
async function call(args: Record<string, unknown> = {}) {
  const res = await raw(args);
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}
const article = (id: string, status: string) => ({ id, title: "Article " + id, status });
const pipeline = {
  settings: { enabled: true, destination: "wordpress" },
  destinationConnected: true,
  nextAutoRun: "2026-10-02T06:00:00.000Z",
  queue: [{ id: "t1", topic: "Queued topic" }],
  history: [article("a30", "published")],
  historyNext: "2026-09-01T00:00:00.000Z_aaaaaaaaaaaaaaaaaaaaaaaa",
  rejectedCount: 4,
};

try {
  await test("schema keeps domain the only required input and offers the five cuts", () => {
    const schema: any = TOOLS.find((t) => t.name === "list_content_queue")!.inputSchema;
    assert.deepEqual(schema.required, ["domain"]);
    assert.deepEqual(schema.properties.status.enum, ["all", "live", "review", "rejected", "attention"]);
    assert.equal(schema.properties.before.type, "string");
    assert.equal(schema.properties.limit.minimum, 1);
    assert.equal(schema.properties.limit.maximum, 50);
  });

  await test("a domain alone makes the call it always made, plus the cursor to older pages", async () => {
    routes = { "/api/autoseo": { body: pipeline } };
    const result = await call();
    assert.deepEqual(hits.map((h) => h.href), ["http://backend.test/api/autoseo?domain=acme.com"]);
    assert.deepEqual(result, {
      domain: "acme.com", enabled: true, destination: "wordpress", destinationConnected: true,
      nextAutoRun: pipeline.nextAutoRun, queued: pipeline.queue, articles: pipeline.history,
      nextCursor: pipeline.historyNext, rejectedCount: 4,
    });
  });

  await test("a status reads that cut of the paged list, with the pipeline beside it", async () => {
    routes = {
      "/api/autoseo": { body: pipeline },
      "/api/autoseo/articles": { body: { articles: [article("r1", "rejected")], next: null } },
    };
    const result = await call({ status: "rejected" });
    const paged = hits.find((h) => h.pathname === "/api/autoseo/articles")!;
    assert.equal(paged.searchParams.get("status"), "rejected");
    assert.equal(paged.searchParams.has("before"), false);
    assert.equal(result.filteredBy, "rejected");
    assert.deepEqual(result.articles, [article("r1", "rejected")]);
    assert.equal(result.nextCursor, null);
    assert.deepEqual(result.queued, pipeline.queue);
    assert.equal(result.rejectedCount, 4);
  });

  await test("a cursor fetches only the older page", async () => {
    routes = { "/api/autoseo/articles": { body: { articles: [article("a31", "published")], next: "2026-08-01T00:00:00.000Z_bbbbbbbbbbbbbbbbbbbbbbbb" } } };
    const result = await call({ before: pipeline.historyNext, limit: 500 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].pathname, "/api/autoseo/articles");
    assert.equal(hits[0].searchParams.get("before"), pipeline.historyNext);
    assert.equal(hits[0].searchParams.get("status"), "all");
    assert.equal(hits[0].searchParams.get("limit"), "50");
    assert.deepEqual(result, {
      domain: "acme.com", filteredBy: null, articles: [article("a31", "published")],
      nextCursor: "2026-08-01T00:00:00.000Z_bbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  await test("an unknown status is refused before any request", async () => {
    const res = await raw({ status: "drafts" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /all, live, review, rejected or attention/);
    assert.equal(hits.length, 0);
  });

  await test("an API from before paging says so instead of passing off the newest 30 as all", async () => {
    routes = { "/api/autoseo": { body: pipeline } };
    const res = await raw({ status: "live" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /only the newest 30 articles/);
  });
} finally {
  await mcp.close();
  await server.close();
  globalThis.fetch = realFetch;
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
