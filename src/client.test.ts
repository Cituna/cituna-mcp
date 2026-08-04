// Tests for the Cituna API client used by the MCP server.
// Run: cd mcp && npm test   (tsx src/client.test.ts — no network, fetch is stubbed)
//
// WHY THIS EXISTS: the tool name used to ride on a shared mutable `activeTool`
// field set by beginTool() — two tool calls in flight at once could stamp each
// other's backend requests with the wrong X-Cituna-Mcp-Tool, and the backend's
// read/write plan split keys off that header. forTool() binds the tool per call;
// these tests pin that invariant plus the error body passthrough the index.ts
// error mapper relies on (402/429 messages come from the backend's `error`).
import assert from "node:assert/strict";
import { CitunaClient, CitunaApiError } from "./client.js";

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

type Captured = { url: string; tool: string | undefined; client: string | undefined };
const captured: Captured[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
let holdRequests = false;
let releaseQueue: (() => void)[] = [];

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  captured.push({ url: String(url), tool: h["X-Cituna-Mcp-Tool"], client: h["X-Cituna-Client"] });
  if (holdRequests) await new Promise<void>((r) => releaseQueue.push(r));
  return nextResponse();
};

const client = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });

await test("every request carries the MCP client marker and the bound tool name", async () => {
  captured.length = 0;
  await client.forTool("get_visibility").get("/api/visibility", { brand: "acme.com" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].client, "mcp");
  assert.equal(captured[0].tool, "get_visibility");
  assert.ok(captured[0].url.includes("/api/visibility?brand=acme.com"));
});

await test("interleaved calls from two tools each stamp their OWN tool header", async () => {
  captured.length = 0;
  holdRequests = true;
  releaseQueue = [];
  const a = client.forTool("list_gaps");
  const b = client.forTool("run_scan");
  // Start both before either resolves — with shared mutable state the second
  // beginTool() would have clobbered the first call's header.
  const p1 = a.get("/api/gap-status", { domain: "acme.com" });
  const p2 = b.post("/api/gap-status", { domain: "acme.com", gapKey: "k", status: "done" });
  // Let both requests reach the stub, then release them in reverse order.
  await new Promise((r) => setTimeout(r, 10));
  holdRequests = false;
  [...releaseQueue].reverse().forEach((r) => r());
  await Promise.all([p1, p2]);
  assert.equal(captured.length, 2);
  const getReq = captured.find((c) => c.url.includes("?domain=acme.com"));
  const postReq = captured.find((c) => !c.url.includes("?"));
  assert.equal(getReq?.tool, "list_gaps");
  assert.equal(postReq?.tool, "run_scan");
});

await test("a raw (un-bound) client call sends no tool header but keeps the client marker", async () => {
  captured.length = 0;
  await client.get("/api/auth/me");
  assert.equal(captured[0].tool, undefined);
  assert.equal(captured[0].client, "mcp");
});

await test("non-2xx surfaces as CitunaApiError with the backend's error text and body", async () => {
  nextResponse = () =>
    new Response(
      JSON.stringify({ error: "Writing from Claude needs a Pro plan.", reason: "mcp_write_pro", requires: ["agency", "scale"] }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    () => client.forTool("set_gap_status").post("/api/gap-status", {}),
    (e: unknown) => {
      assert.ok(e instanceof CitunaApiError);
      const err = e as CitunaApiError;
      assert.equal(err.status, 402);
      assert.equal(err.message, "Writing from Claude needs a Pro plan.");
      assert.equal((err.body as any)?.reason, "mcp_write_pro");
      return true;
    },
  );
});

await test("429 keeps retryAfterSec available on the body for the error mapper", async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ error: "Scans are starting too fast.", retryAfterSec: 42 }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    () => client.forTool("run_scan").get("/api/history"),
    (e: unknown) => {
      assert.ok(e instanceof CitunaApiError);
      const err = e as CitunaApiError;
      assert.equal(err.status, 429);
      assert.equal((err.body as any)?.retryAfterSec, 42);
      return true;
    },
  );
});

(globalThis as any).fetch = realFetch;
console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ""}`);
