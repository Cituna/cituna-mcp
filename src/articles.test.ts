// The article tools: a short list with change dates, one article's text, an edit
// to Cituna's copy, a refresh of a live page, and skipping queued topics.
// Run: cd mcp && npx tsx src/articles.test.ts
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

type Call = { path: string; query: string; method: string; body: any };
type Reply = { status: number; body: unknown };
let calls: Call[] = [];
let answer: (c: Call) => Reply = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  const c: Call = { path: u.pathname, query: u.search, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : null };
  calls.push(c);
  const r = answer(c);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "articles-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);

async function raw(name: string, args: Record<string, unknown>) {
  calls = [];
  return (await mcp.callTool({ name, arguments: args })) as any;
}
async function call(name: string, args: Record<string, unknown>) {
  const res = await raw(name, args);
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}
async function failText(name: string, args: Record<string, unknown>) {
  const res = await raw(name, args);
  assert.equal(res.isError, true, "expected an error, got: " + res.content?.[0]?.text);
  return String(res.content[0].text);
}

// An article as the API's articleView sends it, with the bulk a list must drop.
function view(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    domain: "acme.com",
    title: "How to track brand mentions in ChatGPT",
    slug: "track-brand-mentions-chatgpt",
    status: "published",
    trigger: "auto",
    destination: "github",
    wpLink: "https://acme.com/learn/track-brand-mentions-chatgpt",
    provenance: { source: "keyword", topic: "track brand mentions chatgpt", keyword: { text: "track brand mentions chatgpt", impressions: 120 } },
    gateProblems: [],
    qualityNotes: ["One long paragraph"],
    heldForQuality: false,
    siteEdited: null,
    hasDraft: true,
    internalLinks: { matched: 3, problems: [] },
    image: { filename: "hero.png", url: "https://acme.com/hero.png", alt: "Hero", width: 1200, height: 630, src: "https://acme.com/hero.png" },
    outcome: { impressions: 340, clicks: 2, ctr: 0.006, position: 9.4, windowDays: 28, measuredAt: "2026-10-18T03:00:00.000Z" },
    enrich: { eligible: true, reason: "page one, few clicks", checkedAt: "2026-10-18T03:00:00.000Z" },
    lastEnrichedAt: null,
    lastEnrich: null,
    lastSentAt: "2026-09-10T08:00:00.000Z",
    editedAt: null,
    publishedAt: "2026-09-10T08:00:00.000Z",
    createdAt: "2026-09-10T07:58:00.000Z",
    updatedAt: "2026-10-18T03:00:00.000Z",
    ...over,
  };
}
const DRAFT = {
  title: "How to track brand mentions in ChatGPT",
  metaTitle: "Track brand mentions in ChatGPT",
  metaDescription: "A step by step guide.",
  dek: "Ask the question your buyers ask, every day.",
  sections: [{ h2: "Why it matters", body: "Engines answer before anyone clicks." }],
  faqs: [{ q: "Is it free?", a: "There is a trial." }],
  tags: ["aeo"],
  informationGain: "internal note",
  dataSlot: "What share of your demos mention ChatGPT?",
};

try {
  console.log("\nlist_articles");

  await test("rows are short, keyed for the other tools, and keep the change dates", async () => {
    answer = () => ({ status: 200, body: { articles: [view()], next: "2026-09-10T07:58:00.000Z_a1" } });
    const out = await call("list_articles", { domain: "https://www.Acme.com/blog" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/api/autoseo/articles");
    const q = new URLSearchParams(calls[0].query);
    assert.equal(q.get("domain"), "acme.com");
    assert.equal(q.get("status"), "all");
    assert.equal(q.get("limit"), "50", "a compact row affords the API's largest page");
    assert.equal(out.count, 1);
    assert.equal(out.filteredBy, null);
    assert.equal(out.nextCursor, "2026-09-10T07:58:00.000Z_a1");
    const row = out.articles[0];
    assert.equal(row.id, "a1");
    assert.equal(row.url, "https://acme.com/learn/track-brand-mentions-chatgpt");
    assert.equal(row.keyword, "track brand mentions chatgpt");
    assert.equal(row.source, "keyword");
    assert.equal(row.publishedAt, "2026-09-10T08:00:00.000Z");
    assert.equal(row.lastSentAt, "2026-09-10T08:00:00.000Z");
    assert.equal(row.editsNotSent, false);
    assert.equal(row.hasDraft, true);
    assert.deepEqual(row.enrich, { eligible: true, reason: "page one, few clicks", checkedAt: "2026-10-18T03:00:00.000Z" });
    assert.equal(row.outcome.position, 9.4);
    for (const bulk of ["image", "internalLinks", "qualityNotes", "gateProblems", "lastEnrich", "provenance", "draft"]) {
      assert.equal(bulk in row, false, `${bulk} belongs in get_article, not the list`);
    }
  });

  await test("an edit made after the last send is flagged as not on the site", async () => {
    answer = () => ({ status: 200, body: { articles: [view({ editedAt: "2026-10-01T09:00:00.000Z" })], next: null } });
    const [row] = (await call("list_articles", { domain: "acme.com" })).articles;
    assert.equal(row.editsNotSent, true);
  });

  await test("an edit that was sent afterwards is not flagged", async () => {
    answer = () => ({ status: 200, body: { articles: [view({ editedAt: "2026-10-01T09:00:00.000Z", lastSentAt: "2026-10-01T09:05:00.000Z" })], next: null } });
    const [row] = (await call("list_articles", { domain: "acme.com" })).articles;
    assert.equal(row.editsNotSent, false);
  });

  await test("an API without lastSentAt leaves the flag unknown rather than guessing", async () => {
    const old: Record<string, unknown> = view({ editedAt: "2026-10-01T09:00:00.000Z" });
    delete old.lastSentAt;
    answer = () => ({ status: 200, body: { articles: [old], next: null } });
    const [row] = (await call("list_articles", { domain: "acme.com" })).articles;
    assert.equal(row.lastSentAt, null);
    assert.equal(row.editsNotSent, null);
  });

  await test("a prompt topic and a recorded page still get a keyword", async () => {
    answer = () => ({
      status: 200,
      body: {
        articles: [
          view({ id: "p1", provenance: { source: "prompt", topic: "best aeo tool", prompt: { text: "what is the best aeo tool", citedRate: 0 } } }),
          view({ id: "x1", trigger: "external", hasDraft: false, provenance: { normalized: "peec pricing", topic: "peec pricing" }, publishedAt: null, lastSentAt: null }),
        ],
        next: null,
      },
    });
    const out = await call("list_articles", { domain: "acme.com" });
    assert.equal(out.articles[0].keyword, "what is the best aeo tool");
    assert.equal(out.articles[1].keyword, "peec pricing");
    assert.equal(out.articles[1].hasDraft, false);
  });

  await test("status, cursor and limit reach the API, and a bad status never leaves", async () => {
    answer = () => ({ status: 200, body: { articles: [], next: null } });
    const out = await call("list_articles", { domain: "acme.com", status: "live", before: "c1", limit: 10 });
    const q = new URLSearchParams(calls[0].query);
    assert.equal(q.get("status"), "live");
    assert.equal(q.get("before"), "c1");
    assert.equal(q.get("limit"), "10");
    assert.equal(out.filteredBy, "live");
    const text = await failText("list_articles", { domain: "acme.com", status: "drafts" });
    assert.match(text, /all, live, review, rejected or attention/);
    assert.equal(calls.length, 0);
  });

  console.log("\nget_article");

  await test("returns the editable text and the checks, not internal draft fields", async () => {
    answer = () => ({ status: 200, body: { ok: true, article: { ...view({ lastEnrich: { at: "2026-10-02T00:00:00.000Z", before: { metaTitle: "Old" }, after: { metaTitle: "New" }, addedFaqs: 1, queries: [] } }), draft: DRAFT } } });
    const out = await call("get_article", { id: "a1" });
    assert.equal(calls[0].path, "/api/autoseo/article/a1");
    assert.equal(calls[0].method, "GET");
    assert.deepEqual(out.text, {
      title: DRAFT.title, metaTitle: DRAFT.metaTitle, metaDescription: DRAFT.metaDescription, dek: DRAFT.dek,
      sections: DRAFT.sections, faqs: DRAFT.faqs, tags: DRAFT.tags,
    });
    assert.deepEqual(out.qualityNotes, ["One long paragraph"]);
    assert.equal(out.lastEnrich.after.metaTitle, "New");
    assert.equal(out.domain, "acme.com");
    assert.equal(out.keyword, "track brand mentions chatgpt");
  });

  await test("an unknown id says where ids come from", async () => {
    answer = () => ({ status: 404, body: { error: "article not found" } });
    assert.match(await failText("get_article", { id: "nope" }), /list_articles gives the ids/);
  });

  console.log("\nupdate_article");

  await test("sends only the fields passed, as a PATCH, and says the live page waits", async () => {
    answer = (c) => ({ status: 200, body: { ok: true, article: { ...view({ editedAt: "2026-10-21T10:00:00.000Z" }), draft: { ...DRAFT, metaTitle: c.body.metaTitle } } } });
    const sections = [{ h2: "Why it matters", body: "Engines answer first." }, { h2: "How to start", body: "- Pick prompts\n- Check daily" }];
    const out = await call("update_article", { id: "a1", metaTitle: "Track ChatGPT brand mentions", sections });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].path, "/api/autoseo/article/a1");
    assert.deepEqual(calls[0].body, { metaTitle: "Track ChatGPT brand mentions", sections });
    assert.equal(out.saved, true);
    assert.deepEqual(out.changed, ["metaTitle", "sections"]);
    assert.equal(out.editsNotSent, true);
    assert.match(out.message, /page on the site is unchanged until the article is sent again from the Cituna app/);
  });

  await test("a held draft that still fails says what to fix", async () => {
    answer = () => ({ status: 200, body: { ok: true, article: { ...view({ status: "failed", heldForQuality: true, gateProblems: ["The title is over 60 characters."], lastSentAt: null, publishedAt: null }), draft: DRAFT } } });
    const out = await call("update_article", { id: "a1", title: "A much longer title than the checks allow for this site" });
    assert.equal(out.heldForQuality, true);
    assert.deepEqual(out.gateProblems, ["The title is over 60 characters."]);
    assert.match(out.message, /still hold it/);
  });

  await test("nothing to change is refused before any request", async () => {
    assert.match(await failText("update_article", { id: "a1" }), /Nothing to change/);
    assert.equal(calls.length, 0);
  });

  await test("an article with no text, and an unknown id, are plain errors", async () => {
    answer = () => ({ status: 409, body: { error: "There is no article text to edit here. This run never produced one.", code: "no_draft" } });
    assert.match(await failText("update_article", { id: "a1", dek: "x" }), /no article text to edit here/);
    answer = () => ({ status: 404, body: { error: "article not found" } });
    assert.match(await failText("update_article", { id: "zz", dek: "x" }), /list_articles gives the ids/);
  });

  await test("the API's own validation message comes back", async () => {
    answer = () => ({ status: 400, body: { error: "Every section needs a heading." } });
    assert.match(await failText("update_article", { id: "a1", sections: [{ h2: "", body: "x" }] }), /Every section needs a heading/);
  });

  console.log("\nenrich_article");

  await test("a refresh returns what changed on the live page", async () => {
    const queries = Array.from({ length: 14 }, (_, i) => ({ query: `q${i}`, clicks: 0, impressions: 10 + i, position: 8 }));
    answer = () => ({
      status: 200,
      body: {
        ok: true, code: "enriched",
        article: { ...view({ lastEnrichedAt: "2026-10-21T10:00:00.000Z" }), draft: DRAFT },
        diff: { before: { metaTitle: "Old", metaDescription: "Old desc" }, after: { metaTitle: "New", metaDescription: "New desc" }, addedFaqs: [{ q: "Q", a: "A" }] },
        queries,
      },
    });
    const out = await call("enrich_article", { id: "a1" });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/autoseo/article/a1/enrich");
    assert.equal(out.refreshed, true);
    assert.deepEqual(out.before, { metaTitle: "Old", metaDescription: "Old desc" });
    assert.deepEqual(out.after, { metaTitle: "New", metaDescription: "New desc" });
    assert.equal(out.addedFaqs.length, 1);
    assert.equal(out.queries.length, 10);
    assert.equal(out.url, "https://acme.com/learn/track-brand-mentions-chatgpt");
  });

  await test("a rewrite that changed nothing is not called a refresh", async () => {
    answer = () => ({ status: 200, body: { ok: true, code: "unchanged", article: view(), note: "Nothing was sent: the rewrite matched the copy already live." } });
    const out = await call("enrich_article", { id: "a1" });
    assert.equal(out.refreshed, false);
    assert.equal(out.reason, "unchanged");
    assert.equal(out.message, "Nothing was sent: the rewrite matched the copy already live.");
  });

  await test("a page that is not due, or was edited on the site, is a refusal with its reason", async () => {
    answer = () => ({ status: 409, body: { error: "This article is not due a refresh: refreshed 5 days ago.", code: "not_eligible" } });
    let out = await call("enrich_article", { id: "a1" });
    assert.deepEqual(out, { refreshed: false, id: "a1", reason: "not_eligible", message: "This article is not due a refresh: refreshed 5 days ago." });
    answer = () => ({ status: 409, body: { error: "Not refreshed: the page was edited on your site after Cituna last sent it.", code: "site_edited" } });
    out = await call("enrich_article", { id: "a1" });
    assert.equal(out.reason, "site_edited");
  });

  await test("an allowance used up is a refusal, the Pro gate is an error", async () => {
    answer = () => ({ status: 402, body: { error: "Your monthly generation allowance is used up. Article refreshes resume next month, or sooner on a higher plan.", code: "quota" } });
    const out = await call("enrich_article", { id: "a1" });
    assert.equal(out.refreshed, false);
    assert.equal(out.reason, "quota");
    answer = () => ({ status: 402, body: { error: "Making changes from Claude or with an API key needs a Pro plan.", reason: "mcp_write_pro", requires: ["agency", "scale"] } });
    assert.match(await failText("enrich_article", { id: "a1" }), /needs a Pro plan/);
  });

  await test("a failed delivery is an error, and internal detail never leaks", async () => {
    answer = () => ({ status: 502, body: { error: "The refresh could not be written right now, so the page was left alone: MongoServerError: E11000 duplicate key. It will be tried again in a few days.", code: "failed" } });
    const text = await failText("enrich_article", { id: "a1" });
    assert.doesNotMatch(text, /Mongo|E11000/);
    assert.match(text, /left alone/);
  });

  console.log("\nskip_queued_topics");

  await test("each id is skipped once, and ids that are not open are named", async () => {
    answer = (c) => (c.path.includes("/gone/") ? { status: 404, body: { error: "topic not found" } } : { status: 200, body: { ok: true } });
    const out = await call("skip_queued_topics", { ids: ["t1", "gone", "t2", "t1", " "] });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/autoseo/queue/t1/skip", "POST /api/autoseo/queue/gone/skip", "POST /api/autoseo/queue/t2/skip"]);
    assert.deepEqual(out.skipped, ["t1", "t2"]);
    assert.deepEqual(out.notQueued, ["gone"]);
    assert.match(out.message, /already written, skipped or removed/);
  });

  await test("a refusal part way says what was skipped and what was not", async () => {
    let n = 0;
    answer = () => (++n === 2 ? { status: 429, body: { error: "Too many requests from this workspace's API keys and connected apps." } } : { status: 200, body: { ok: true } });
    const text = await failText("skip_queued_topics", { ids: ["t1", "t2", "t3"] });
    assert.match(text, /^Skipped 1 of 3 topics/);
    assert.match(text, /Not skipped: t2, t3\.$/);
  });

  await test("a refusal on the first id is the usual error", async () => {
    answer = () => ({ status: 402, body: { error: "Making changes from Claude or with an API key needs a Pro plan.", reason: "mcp_write_pro", requires: ["agency", "scale"] } });
    assert.match(await failText("skip_queued_topics", { ids: ["t1", "t2"] }), /needs a Pro plan/);
    assert.equal(calls.length, 1, "it stops at the first refusal");
  });

  await test("no ids, or more than 50, never reach the API", async () => {
    assert.match(await failText("skip_queued_topics", { ids: [] }), /`ids` is required/);
    assert.match(await failText("skip_queued_topics", { ids: Array.from({ length: 51 }, (_, i) => `t${i}`) }), /at most 50/);
    assert.equal(calls.length, 0);
  });

  console.log("\nWhat clients are told");

  await test("the writes are marked so clients confirm the ones that overwrite or spend", () => {
    const hint = (name: string) => TOOLS.find((t) => t.name === name)!.annotations;
    for (const name of ["list_articles", "get_article"]) assert.equal(hint(name).readOnlyHint, true, name);
    for (const name of ["update_article", "enrich_article", "skip_queued_topics"]) assert.equal(hint(name).readOnlyHint, false, name);
    assert.equal(hint("update_article").destructiveHint, true);
    assert.equal(hint("enrich_article").destructiveHint, true);
    assert.equal(hint("enrich_article").idempotentHint, false, "each refresh spends a generation");
    assert.equal(hint("enrich_article").openWorldHint, true, "it writes to the customer's site");
    assert.equal(hint("skip_queued_topics").destructiveHint, false, "a skipped topic can be queued again");
  });

  await test("the descriptions say what reaches the live site and what does not", () => {
    const desc = (name: string) => TOOLS.find((t) => t.name === name)!.description;
    assert.match(desc("update_article"), /A page already on the site does not change/);
    assert.match(desc("enrich_article"), /updates the live page on the site/);
    assert.match(desc("enrich_article"), /`enrich\.eligible: true`/);
    assert.match(desc("skip_queued_topics"), /queue_article brings a topic back/);
    for (const name of ["list_articles", "get_article", "update_article", "enrich_article", "skip_queued_topics"]) {
      assert.doesNotMatch(desc(name), /—/, `${name} uses an em dash`);
    }
  });
} finally {
  await mcp.close();
  await server.close();
  globalThis.fetch = realFetch;
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
