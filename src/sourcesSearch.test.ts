// 2026-09-22: pitch targets alone could not answer which page Marqeable was.
// Drive the real handler with fetch stubbed: q must reach the API, excluded
// pages must survive, and a backend that ignores q must not return everything.
// Run: cd mcp && npx.cmd tsx src/sourcesSearch.test.ts
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CitunaClient } from "./client.js";
import { TOOLS, createCitunaServer } from "./tools.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failures.push(name); console.error("  FAIL " + name + "\n    " + (e as Error).message); }
}
const hits: { url: string; method: string }[] = [];
let response: any = {};
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  hits.push({ url: String(url), method: String(init?.method ?? "GET") });
  return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
};
const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "sources-search-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);
async function call(args: Record<string, unknown> = {}) {
  hits.length = 0;
  const res: any = await mcp.callTool({ name: "list_citation_sources", arguments: { domain: "acme.com", ...args } });
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}
const query = () => new URL(hits[0].url).searchParams;
const page = (host: string, count = 3, extra: any = {}) => ({
  url: "https://" + host + "/blog/best-tools", host, count,
  byEngine: { chatgpt: count }, engines: ["chatgpt"], brands: ["A rival"],
  firstSeen: "2026-09-01", lastSeen: "2026-09-22", isNew: false, role: "publisher", ...extra,
});

try {
  await test("schema exposes optional bounded search and the Sources ranges", () => {
    const schema: any = TOOLS.find((t) => t.name === "list_citation_sources")!.inputSchema;
    assert.deepEqual(schema.required, ["domain"]);
    assert.equal(schema.properties.search.type, "string");
    assert.equal(schema.properties.search.minLength, 1);
    assert.equal(schema.properties.search.maxLength, 100);
    assert.deepEqual(schema.properties.range.enum, ["today", "7d", "30d", "all"]);
  });
  await test("search goes as q and every range goes unchanged", async () => {
    response = { query: { q: "marqeable.com/blog" }, sources: [], targets: [] };
    for (const range of ["today", "7d", "30d", "all"]) {
      await call({ search: "marqeable.com/blog", range, engine: "perplexity" });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].method, "GET");
      assert.equal(query().get("q"), "marqeable.com/blog");
      assert.equal(query().get("range"), range);
      assert.equal(query().get("engine"), "perplexity");
    }
  });
  await test("no search or range preserves the exact default request and result", async () => {
    response = { sources: [page("marqeable.com")], targets: [], outreach: {} };
    const result = await call();
    assert.equal(hits[0].url, "http://backend.test/api/sources?domain=acme.com&limit=25");
    const { howToRead, ...rest } = result;
    assert.equal(typeof howToRead, "string");
    assert.deepEqual(rest, {
      domain: "acme.com", scansWalked: null, generatedAt: null,
      totalTargets: 0, gapTargets: 0, uncheckedTargets: 0, filteredBy: null,
      engine: null, offset: 0, nextOffset: null, targets: [],
      yourPagesEnginesCite: [], whatEachEngineReads: [],
    });
    await call({ range: "7d" });
    assert.equal(query().has("q"), false);
    assert.equal(query().get("range"), "7d");
  });
  await test("new API pages map counts and actual checks, including every exclusion reason", async () => {
    const reasons = [null, "tracked_competitor", "competitor", "institution", "platform", "not_an_organisation", "named_rival"];
    response = {
      query: { q: "marqeable", pages: 7, hosts: 7 },
      // A query echo is authoritative: do not re-filter the API's matches.
      sources: reasons.map((excludedAs, i) => page("site" + i + ".com", 10 - i, { excludedAs, check: i === 0 ? { presence: "linked" } : undefined, you: 99 })),
      targets: [{ host: "site0.com", count: 10, presence: "linked" }],
    };
    const result = await call({ search: "marqeable" });
    assert.deepEqual(result.pages[0], {
      url: "https://site0.com/blog/best-tools", host: "site0.com", citations: 10,
      citationsByEngine: { chatgpt: 10 }, engines: ["chatgpt"],
      firstSeen: "2026-09-01", lastSeen: "2026-09-22", isNew: false,
      rivalsNamedHere: ["A rival"], role: "publisher", pitchTarget: true,
      excludedAs: null, youOnThisPage: "linked",
    });
    assert.deepEqual(result.pages.map((p: any) => p.excludedAs), reasons);
    assert.deepEqual(result.pages.map((p: any) => p.pitchTarget), [true, false, false, false, false, false, false]);
    assert.ok(result.pages.slice(1).every((p: any) => p.youOnThisPage === "unknown"));
    assert.equal(result.targets[0].host, "site0.com");
    assert.equal(result.note, undefined);
    assert.equal(query().has("range"), false);
  });
  await test("legacy filtering matches URL, host, names and identity roots and counts only matches", async () => {
    response = {
      sources: [
        page("www.mar-qeable.co.uk", 8), // root equality, not a substring
        page("editor.com", 7, { brands: ["MARQEABLE"] }),
        page("links.com", 6, { url: "https://links.com/Marqeable-review" }),
        page("marqeable-news.com", 5),
        page("unrelated.com", 99),
      ],
      targets: [
        { host: "www.mar-qeable.co.uk", count: 8 },
        { host: "editor.com", count: 7, rivals: ["Marqeable"] },
        { host: "unrelated.com", count: 99 },
      ],
      targetCounts: { total: 100, unknown: 100 },
    };
    const result = await call({ search: "Marqeable" });
    assert.deepEqual(result.pages.map((p: any) => p.host), ["www.mar-qeable.co.uk", "editor.com", "links.com", "marqeable-news.com"]);
    assert.deepEqual(result.pages.map((p: any) => p.pitchTarget), [true, true, false, false]);
    assert.deepEqual(result.targets.map((t: any) => t.host), ["www.mar-qeable.co.uk", "editor.com"]);
    assert.equal(result.totalTargets, 2);
    assert.equal(result.uncheckedTargets, 2);
    assert.equal(result.nextOffset, null);
    assert.match(result.note, /only covered the API's top 200 pages for the range/);
    const missing = await call({ search: "nonexistent" });
    assert.deepEqual(missing.pages, []);
    assert.deepEqual(missing.targets, []);
  });
  await test("pages sort most-cited first before limit, independently of target gaps", async () => {
    response = { query: { q: "marqeable" }, sources: [page("a.com", 1), page("b.com", 10, { excludedAs: "competitor" }), page("c.com", 5, { excludedAs: null })], targets: [] };
    const result = await call({ search: "marqeable", limit: 2, gapsOnly: true });
    assert.deepEqual(result.pages.map((p: any) => p.citations), [10, 5]);
    assert.equal(result.pages[1].pitchTarget, true, "explicit null wins even if a host is not in the targets page");
    assert.equal(query().get("limit"), "2");
  });
  await test("legacy warning is appended to existing paging guidance", async () => {
    response = { sources: [], targets: [{ host: "marqeable.com" }, { host: "marqeable.org" }] };
    const result = await call({ search: "marqeable", limit: 1 });
    assert.match(result.note, /^Showing 1 of 2/);
    assert.match(result.note, /top 200 pages for the range/);
  });
} finally {
  await mcp.close();
  await server.close();
  globalThis.fetch = realFetch;
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
