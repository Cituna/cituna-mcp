// queue_article tells the agent why nothing was queued: a duplicate, a page the
// site already has, or a full queue each need a different next step.
// Run: cd mcp && npx tsx src/queueArticle.test.ts
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
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let sent: { path: string; method: string; body: any } | null = null;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  sent = { path: u.pathname, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : null };
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
};
const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "queue-article-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);
async function raw(args: Record<string, unknown> = {}) {
  sent = null;
  return (await mcp.callTool({ name: "queue_article", arguments: { domain: "acme.com", keyword: "peec ai pricing", ...args } })) as any;
}
async function call(args: Record<string, unknown> = {}) {
  const res = await raw(args);
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

try {
  await test("a queued keyword returns its id and sends the evidence", async () => {
    reply = { status: 200, body: { ok: true, id: "t1" } };
    const out = await call({ impressions: 128, position: 8.1 });
    assert.deepEqual(out, { queued: true, id: "t1", domain: "acme.com", keyword: "peec ai pricing" });
    assert.equal(sent?.path, "/api/autoseo/queue");
    assert.equal(sent?.method, "POST");
    assert.equal(sent?.body.source, "keyword");
    assert.deepEqual(sent?.body.keyword, { text: "peec ai pricing", volume: null, competition: null, position: 8.1, impressions: 128 });
  });

  await test("a duplicate says so and points at list_keywords", async () => {
    reply = { status: 409, body: { error: "That topic is already queued or written.", code: "duplicate" } };
    const out = await call();
    assert.equal(out.queued, false);
    assert.equal(out.reason, "duplicate");
    assert.equal(out.duplicate, true);
    assert.match(out.message, /already has a queued topic or a written article\. See list_keywords\./);
  });

  await test("an API that sends no code keeps the duplicate answer", async () => {
    reply = { status: 409, body: { error: "That topic is already queued or written." } };
    const out = await call();
    assert.equal(out.reason, "duplicate");
    assert.equal(out.duplicate, true);
  });

  await test("a page the site already has is named, with the way forward", async () => {
    reply = {
      status: 409,
      body: {
        error: "You already have a page ranking #8 for this: https://acme.com/learn/peec-ai-pricing. A second one would compete with it.",
        code: "already_covered",
        url: "https://acme.com/learn/peec-ai-pricing",
        position: 8,
        canForce: true,
      },
    };
    const out = await call();
    assert.equal(out.queued, false);
    assert.equal(out.reason, "already_covered");
    assert.equal(out.duplicate, false);
    assert.equal(out.url, "https://acme.com/learn/peec-ai-pricing");
    assert.equal(out.position, 8);
    assert.equal("coveringArticle" in out, false);
    assert.match(out.message, /^You already have a page ranking #8 for this: https:\/\/acme\.com\/learn\/peec-ai-pricing\./);
    assert.match(out.message, /Nothing was queued\. Improve that page instead\.$/);
  });

  await test("an AutoSEO article covering it is passed on so it can be refreshed", async () => {
    reply = {
      status: 409,
      body: {
        error: "Your site already covers this: https://acme.com/blog/peec. A second page would compete with it.",
        code: "already_covered",
        url: "https://acme.com/blog/peec",
        position: null,
        canForce: true,
        rewrite: { articleId: "a1", title: "Peec AI pricing", position: 78, clicks: 0, impressions: 40 },
      },
    };
    const out = await call();
    assert.equal(out.position, null);
    assert.deepEqual(out.coveringArticle, { articleId: "a1", title: "Peec AI pricing", position: 78, clicks: 0, impressions: 40 });
    assert.match(out.message, /update_article edits it \(coveringArticle\.articleId\), and enrich_article refreshes/);
  });

  await test("internal error text is replaced and the covering page still named", async () => {
    reply = { status: 409, body: { error: "MongoServerError: E11000 duplicate key error", code: "already_covered", url: "https://acme.com/x" } };
    const out = await call();
    assert.doesNotMatch(out.message, /Mongo|E11000/);
    assert.match(out.message, /^Your site already covers this: https:\/\/acme\.com\/x\. A second page would compete with it\./);
  });

  await test("a full queue is not called a duplicate", async () => {
    reply = { status: 409, body: { error: "The queue is full (50 open topics). Skip some topics first.", code: "queue_full" } };
    const out = await call();
    assert.equal(out.reason, "queue_full");
    assert.equal(out.duplicate, false);
    assert.match(out.message, /^The queue is full \(50 open topics\)\. Skip some topics first\. Nothing was queued\./);
    assert.match(out.message, /list_content_queue/);
    assert.match(out.message, /skip_queued_topics/);
  });

  await test("a refusal code this version does not know is passed on, not called a duplicate", async () => {
    reply = { status: 409, body: { error: "Connect your WordPress site in Integrations first.", code: "destination_not_connected" } };
    const out = await call();
    assert.equal(out.reason, "destination_not_connected");
    assert.equal(out.duplicate, false);
    assert.equal(out.message, "Connect your WordPress site in Integrations first. Nothing was queued.");
  });

  await test("a turned-off format or a banned word says the owner decides, not a duplicate", async () => {
    reply = { status: 409, body: { error: "This topic uses \"Noom\", which your rule \"Never mention Noom\" in What AutoSEO writes bans. Remove that rule there to queue it.", code: "rule_blocked", term: "Noom" } };
    const out = await call();
    assert.equal(out.reason, "rule_blocked");
    assert.equal(out.duplicate, false);
    assert.match(out.message, /Nothing was queued\. The site's owner sets this in What AutoSEO writes/);
    reply = { status: 409, body: { error: "You turned off alternatives roundups in What AutoSEO writes. Turn it back on there to queue this topic.", code: "format_blocked", format: "alternatives" } };
    assert.equal((await call()).reason, "format_blocked");
  });

  await test("other failures are still errors", async () => {
    reply = { status: 500, body: { error: "Could not queue that topic right now." } };
    const res = await raw();
    assert.equal(res.isError, true);
  });

  await test("the description names every refusal reason", () => {
    const tool = TOOLS.find((t) => t.name === "queue_article")!;
    for (const reason of ["duplicate", "already_covered", "queue_full", "format_blocked", "rule_blocked"]) assert.match(tool.description, new RegExp("`" + reason + "`"));
  });
} finally {
  await mcp.close();
  await server.close();
  globalThis.fetch = realFetch;
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
