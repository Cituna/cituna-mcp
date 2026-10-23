// gsc_zero_click_pages: which cause each zero-click page gets, and why.
//
// On 2026-09-25 the tool told cituna.com to rewrite the titles of /enterprise,
// /privacy, /terms and /mcp. Nearly all of their named impressions came from the
// brand search "cituna", where they sit under the home page, which takes the
// click. It also called position 13.4 "page one". The fixtures are the real rows
// from that read (sc-domain:cituna.com, 2026-08-27 to 2026-09-23).
// Run: cd mcp && npx tsx src/zeroClick.test.ts
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CitunaClient } from "./client.js";
import { TOOLS, brandTerms, createCitunaServer, isBrandQuery, zeroClickPages, type GscRow } from "./tools.js";

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

const SITE = "https://cituna.com";
const p = (page: string, clicks: number, impressions: number, position: number | null): GscRow =>
  ({ page: SITE + page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const q = (page: string, query: string, clicks: number, impressions: number, position: number): GscRow =>
  ({ ...p(page, clicks, impressions, position), query });

const AHREFS = "/learn/ahrefs-nowy-what-it-can-and-cannot-show-about-ai";
// Page totals, which include the queries Google withholds.
const PAGES: GscRow[] = [
  p("/", 14, 102, 5.372549019607843),
  p("/pricing", 1, 49, 5.428571428571429),
  p("/developers", 0, 29, 5.793103448275862),
  p("/enterprise", 0, 65, 4.046153846153846),
  p("/learn/aeo-vs-seo", 0, 234, 74.38888888888889),
  p(AHREFS, 0, 541, 13.434380776340111),
  p("/mcp", 0, 43, 10.651162790697674),
  p("/privacy", 0, 45, 4.044444444444444),
  p("/terms", 0, 36, 8.277777777777779),
];
// Every named query of the pages under test, and every page's "cituna" row. The
// aeo-vs-seo page is left without its queries: position alone decides it.
const QUERIES: GscRow[] = [
  q("/", "cituna", 13, 52, 1.3269230769230769),
  q("/pricing", "cituna", 0, 25, 2.7199999999999998),
  q("/developers", "\"ai visibility tool\"", 0, 5, 5),
  q("/developers", "\"otterly.ai\"", 0, 1, 9),
  q("/developers", "cituna", 0, 5, 1.6),
  q("/enterprise", "cituna", 0, 36, 3.0833333333333335),
  q(AHREFS, "ahrefs neu", 0, 2, 23),
  q(AHREFS, "ahrefs nieuw", 0, 1, 85),
  q(AHREFS, "ahrefs nowy", 0, 308, 12.866883116883116),
  q(AHREFS, "neu ahrefs", 0, 4, 34),
  q(AHREFS, "not nowy ahrefs", 0, 4, 12),
  q(AHREFS, "nowy ahrefs", 0, 178, 11.07865168539326),
  q(AHREFS, "test ahrefs neu", 0, 6, 23.5),
  q(AHREFS, "test ahrefs new", 0, 10, 23.1),
  q(AHREFS, "test ahrefs nowy", 0, 17, 22.647058823529413),
  q(AHREFS, "test new ahrefs", 0, 9, 23.88888888888889),
  q(AHREFS, "test nowy ahrefs", 0, 2, 23),
  q("/mcp", "ai visibility mcp", 0, 1, 44),
  q("/mcp", "cituna", 0, 16, 3.0625),
  q("/mcp", "mcp server for invoice lookup", 0, 1, 91),
  q("/privacy", "cituna", 0, 15, 3.8666666666666667),
  q("/terms", "cituna", 0, 11, 2.6363636363636367),
];
const CITUNA = brandTerms({ name: "Cituna", aliases: [], domain: "cituna.com" });
const DEFAULTS = { minImpressions: 25, maxClicks: 0 };
const rowFor = (rows: ReturnType<typeof zeroClickPages>, path: string) => {
  const r = rows.find((x) => x.page === SITE + path);
  assert.ok(r, `${path} is missing from ${JSON.stringify(rows.map((x) => x.page))}`);
  return r!;
};

console.log("\nBrand spellings");

await test("each brand in the workspace yields the spellings people type", () => {
  assert.deepEqual(CITUNA, [["cituna"]]);
  assert.deepEqual(brandTerms({ name: "GarageFinderUAE", domain: "garagefinderuae.com" }), [["garage", "finder", "uae"]]);
  assert.deepEqual(brandTerms({ name: "Automate Basics", domain: "automatebasics.com" }), [["automate", "basics"]]);
  assert.deepEqual(brandTerms({ name: "PostWharf", aliases: ["Post-Wharf"], domain: "postwharf.com" }), [["post", "wharf"]]);
  // A name saved as a domain loses its TLD, and the same letters are not repeated.
  assert.deepEqual(brandTerms({ name: "universityswitch.com", domain: "universityswitch.com" }), [["universityswitch"]]);
  assert.deepEqual(brandTerms({ domain: "shop.brand.co.uk" }), [["brand"]]);
});

await test("a brand search matches on word boundaries, spaced or run together", () => {
  for (const s of ["cituna", "Cituna", "cituna.com", "www.cituna.com", "what is cituna", "cituna's pricing", "cituna vs profound"]) {
    assert.ok(isBrandQuery(s, CITUNA), s);
  }
  // Real near-collision on cituna.com: it earned impressions on name similarity alone.
  assert.equal(isBrandQuery("vicuna benchmark", CITUNA), false);
  assert.equal(isBrandQuery("citunax", CITUNA), false);
  const garage = brandTerms({ name: "GarageFinderUAE", domain: "garagefinderuae.com" });
  for (const s of ["garage finder uae", "garagefinderuae", "garagefinder uae reviews", "Garage-Finder UAE"]) {
    assert.ok(isBrandQuery(s, garage), s);
  }
  for (const s of ["best garage finder in uae", "garage uae", "garage finder"]) {
    assert.equal(isBrandQuery(s, garage), false, s);
  }
});

await test("a run-together domain label only matches as written, until an alias spaces it", () => {
  // "university switch" is also a generic search about changing universities.
  const bare = brandTerms({ name: "universityswitch.com", domain: "universityswitch.com" });
  assert.ok(isBrandQuery("universityswitch reviews", bare));
  assert.equal(isBrandQuery("university switch", bare), false);
  const aliased = brandTerms({ name: "universityswitch.com", aliases: ["University Switch"], domain: "universityswitch.com" });
  assert.ok(isBrandQuery("university switch", aliased));
});

await test("spellings under three characters are dropped rather than matching every query", () => {
  assert.deepEqual(brandTerms({ name: "AI", domain: "ai.com" }), []);
  assert.equal(isBrandQuery("ai visibility", []), false);
});

console.log("\nCauses on the real cituna.com rows");

await test("pages under the brand search are branded, and the home page takes their click", () => {
  const rows = zeroClickPages(PAGES, QUERIES, CITUNA, DEFAULTS);
  const expected: Record<string, [number, number]> = {
    "/enterprise": [36, 100],
    "/privacy": [15, 100],
    "/terms": [11, 100],
    "/mcp": [18, 88.9],
  };
  for (const [path, [named, pct]] of Object.entries(expected)) {
    const r = rowFor(rows, path);
    assert.equal(r.cause, "branded", `${path}: ${r.cause}`);
    assert.equal(r.namedImpressions, named, path);
    assert.equal(r.brandedPct, pct, path);
    assert.equal(r.clickGoesTo, SITE + "/", path);
    assert.match(r.fix, /brand search: the home page takes this click\. No title work\./);
  }
});

await test("position 13.4 is page two, not page one", () => {
  const r = rowFor(zeroClickPages(PAGES, QUERIES, CITUNA, DEFAULTS), AHREFS);
  assert.equal(r.cause, "page-two");
  assert.equal(r.brandedPct, 0);
  assert.equal(r.namedImpressions, 541, "every impression of this page has a named query");
  assert.doesNotMatch(r.fix, /Ranks on page one/);
  assert.match(r.fix, /“ahrefs nowy”, its top non-brand query/);
  assert.deepEqual(r.topQueries?.map((t) => t.query), ["ahrefs nowy", "nowy ahrefs", "test ahrefs nowy"]);
});

await test("a mixed page on page one stays a snippet fix, aimed at its top non-brand query", () => {
  // /developers: 5 of 11 named impressions are "cituna", which is under half.
  const r = rowFor(zeroClickPages(PAGES, QUERIES, CITUNA, DEFAULTS), "/developers");
  assert.equal(r.cause, "snippet");
  assert.equal(r.brandedPct, 45.5);
  assert.equal(r.clickGoesTo, undefined);
  assert.match(r.fix, /^Ranks on page one but loses the click: rewrite the title and meta description for “"ai visibility tool"”, its top non-brand query\.$/);
  assert.deepEqual(r.topQueries?.find((t) => t.query === "cituna"), { query: "cituna", impressions: 5, position: 1.6, branded: true });
});

await test("the whole split: counts, order and the pages that earned clicks", () => {
  const rows = zeroClickPages(PAGES, QUERIES, CITUNA, DEFAULTS);
  assert.deepEqual(
    rows.map((r) => [r.page.replace(SITE, ""), r.cause]),
    [
      [AHREFS, "page-two"],
      ["/learn/aeo-vs-seo", "ranking"],
      ["/enterprise", "branded"],
      ["/privacy", "branded"],
      ["/mcp", "branded"],
      ["/terms", "branded"],
      ["/developers", "snippet"],
    ],
  );
  const deep = rowFor(rows, "/learn/aeo-vs-seo");
  assert.equal(deep.brandedPct, null, "no named queries means no share, not 0%");
  assert.equal(deep.topQueries, undefined);
});

await test("without the page x query read, causes fall back to position and page two still splits out", () => {
  const rows = zeroClickPages(PAGES, null, CITUNA, DEFAULTS);
  assert.equal(rowFor(rows, "/enterprise").cause, "snippet");
  assert.equal(rowFor(rows, "/terms").cause, "snippet");
  assert.equal(rowFor(rows, "/mcp").cause, "page-two");
  assert.equal(rowFor(rows, AHREFS).cause, "page-two");
  assert.match(rowFor(rows, "/enterprise").fix, /for the query that earns these impressions\.$/);
  for (const r of rows) {
    assert.equal("brandedPct" in r, false, "a share that was never measured is left out");
    assert.equal("namedImpressions" in r, false);
  }
});

await test("with no brand spelling, no page is called branded and no share is reported", () => {
  const rows = zeroClickPages(PAGES, QUERIES, [], DEFAULTS);
  assert.equal(rowFor(rows, "/enterprise").cause, "snippet");
  assert.equal("brandedPct" in rowFor(rows, "/enterprise"), false);
  assert.equal(rowFor(rows, "/enterprise").namedImpressions, 36);
  assert.match(rowFor(rows, "/developers").fix, /“"ai visibility tool"”, its top query\./);
});

console.log("\nEdges");

await test("the bands follow the position as shown: 10 is page one, 10.1 to 15 page two, beyond that ranking", () => {
  const at = (position: number | null) =>
    zeroClickPages([{ page: "https://x.com/a", clicks: 0, impressions: 30, ctr: 0, position }], [], [], DEFAULTS)[0];
  assert.equal(at(10).cause, "snippet");
  assert.equal(at(10.04).cause, "snippet");
  assert.equal(at(10.04).position, 10);
  assert.equal(at(10.06).cause, "page-two");
  assert.equal(at(15).cause, "page-two");
  assert.equal(at(15.1).cause, "ranking");
  assert.equal(at(73.9).cause, "ranking");
  assert.equal(at(null).cause, "ranking");
});

await test("a brand listing deep in the results is still a brand listing, not a ranking problem", () => {
  const rows = zeroClickPages(
    [p("/blog/launch", 0, 40, 31)],
    [q("/blog/launch", "cituna launch", 0, 30, 31), q("/blog/launch", "ai launch checklist", 0, 5, 60), q("/", "cituna launch", 4, 20, 1)],
    CITUNA,
    DEFAULTS,
  );
  assert.equal(rows[0].cause, "branded");
  assert.equal(rows[0].clickGoesTo, SITE + "/");
});

await test("the click goes to the page with the most clicks on those brand searches, never the page itself", () => {
  const rows = zeroClickPages(
    [p("/terms", 1, 40, 6)],
    [
      q("/terms", "cituna", 1, 20, 6),
      q("/terms", "cituna pricing", 0, 10, 7),
      q("/", "cituna", 3, 50, 1),
      q("/pricing", "cituna pricing", 5, 30, 1),
    ],
    CITUNA,
    { minImpressions: 25, maxClicks: 1 },
  );
  assert.equal(rows[0].clickGoesTo, SITE + "/pricing");
  assert.match(rows[0].fix, /brand search: \/pricing takes this click/);
});

await test("when no page earns the brand click, the fix says so instead of naming one", () => {
  const rows = zeroClickPages([p("/", 0, 30, 1.2)], [q("/", "cituna", 0, 30, 1.2)], CITUNA, DEFAULTS);
  assert.equal(rows[0].cause, "branded");
  assert.equal(rows[0].clickGoesTo, undefined);
  assert.match(rows[0].fix, /no page on the site earned a click from them/);
});

console.log("\nThe tool over MCP, backend stubbed");

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
const stub = { projectsFail: false, queryReadFail: false };
const RANGE = { startDate: "2026-08-27", endDate: "2026-09-23" };
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  const method = String(init?.method ?? "GET");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  hits.push({ method, url: u, body });
  if (u.endsWith("/api/projects")) {
    if (stub.projectsFail) return json({ error: "Couldn't load your brands." }, 500);
    return json({ configured: true, ok: true, brands: [{ domain: "cituna.com", name: "Cituna", aliases: [] }] });
  }
  if (u.endsWith("/api/integrations/gsc/query")) {
    const dims = (body?.dimensions ?? []).join(",");
    if (dims === "page") return json({ configured: true, siteUrl: "sc-domain:cituna.com", range: RANGE, rows: PAGES });
    if (dims === "page,query") {
      if (stub.queryReadFail) return json({ error: "Search Console quota exceeded" }, 500);
      return json({ configured: true, siteUrl: "sc-domain:cituna.com", range: RANGE, rows: QUERIES });
    }
    if (dims === "date") {
      return json({ configured: true, range: RANGE, rows: [{ date: "2026-08-27", clicks: 1, impressions: 90, ctr: 0, position: 40 }, { date: "2026-09-22", clicks: 0, impressions: 80, ctr: 0, position: 41 }] });
    }
  }
  return json({ error: `unexpected ${method} ${u}` }, 404);
};

const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "zero-click-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);

async function call(args: Record<string, unknown>) {
  hits.length = 0;
  const res: any = await mcp.callTool({ name: "gsc_zero_click_pages", arguments: args });
  const text = String(res?.content?.[0]?.text ?? "");
  assert.equal(res?.isError === true, false, text);
  return JSON.parse(text);
}
const gscPosts = () => hits.filter((h) => h.url.endsWith("/api/integrations/gsc/query")).map((h) => h.body);

await test("reads page x query rows over the same window and labels the brand listings", async () => {
  const out = await call({ domain: "cituna.com" });
  assert.deepEqual(
    { snippet: out.bySnippet, ranking: out.byRanking, branded: out.byBranded, pageTwo: out.byPageTwo },
    { snippet: 1, ranking: 1, branded: 4, pageTwo: 1 },
  );
  assert.deepEqual(out.brandTerms, ["cituna"]);
  assert.match(out.brandNote, /50% or more makes the cause branded/);
  const pq = gscPosts().find((b) => b.dimensions.join(",") === "page,query");
  assert.ok(pq, "the page x query read was never made");
  assert.equal(pq.days, 28);
  assert.equal(pq.rowLimit, 25000);
});

await test("the output keeps every field it had before, with the same meaning", async () => {
  const out = await call({ domain: "cituna.com" });
  for (const k of ["domain", "range", "thresholds", "pagesExamined", "zeroClickPages", "wastedImpressions", "bySnippet", "byRanking", "history", "rows"]) {
    assert.ok(k in out, `top-level ${k} is gone`);
  }
  assert.equal(out.pagesExamined, 9);
  assert.equal(out.zeroClickPages, 7);
  assert.equal(out.wastedImpressions, 541 + 234 + 65 + 45 + 43 + 36 + 29);
  for (const r of out.rows) {
    for (const k of ["page", "impressions", "clicks", "position", "cause", "fix"]) assert.ok(k in r, `row ${r.page} lost ${k}`);
  }
});

await test("the brand comes from the workspace when the call names a siteUrl instead of a domain", async () => {
  const out = await call({ siteUrl: "sc-domain:cituna.com" });
  assert.equal(out.byBranded, 4);
  assert.ok(hits.some((h) => h.url.endsWith("/api/projects")));
});

await test("if the brand list fails, the domain label still names the brand", async () => {
  stub.projectsFail = true;
  try {
    const out = await call({ domain: "cituna.com" });
    assert.deepEqual(out.brandTerms, ["cituna"]);
    assert.equal(out.byBranded, 4);
  } finally {
    stub.projectsFail = false;
  }
});

await test("if the page x query read fails, the tool still answers on position alone and says why", async () => {
  stub.queryReadFail = true;
  try {
    const out = await call({ domain: "cituna.com" });
    assert.equal(out.byBranded, 0);
    assert.equal(out.bySnippet, 4);
    assert.equal(out.byPageTwo, 2);
    assert.match(out.brandNote, /read failed/);
  } finally {
    stub.queryReadFail = false;
  }
});

await test("when no page qualifies, neither extra read is spent", async () => {
  const out = await call({ domain: "cituna.com", minImpressions: 5000 });
  assert.equal(out.zeroClickPages, 0);
  assert.equal("brandNote" in out, false);
  assert.deepEqual(gscPosts().map((b) => b.dimensions.join(",")).sort(), ["date", "page"]);
  assert.equal(hits.some((h) => h.url.endsWith("/api/projects")), false);
});

await test("the description names all four causes and keeps page two off page one", () => {
  const d = TOOLS.find((t) => t.name === "gsc_zero_click_pages")!.description;
  for (const c of ["`branded`", "`snippet`", "`page-two`", "`ranking`", "clickGoesTo", "brandedPct"]) assert.ok(d.includes(c), c);
  assert.match(d, /`snippet`: position 10 or better/);
  assert.doesNotMatch(d, /—/, "house style: no em dashes");
});

await mcp.close();
await server.close();
(globalThis as any).fetch = realFetch;

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED: ${failures.join("; ")}` : ""}\n`);
if (failures.length) process.exit(1);
