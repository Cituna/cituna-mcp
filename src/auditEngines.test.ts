// get_audit's per-engine line: the rate is over ANSWERED runs, and a run with no
// answer is "unavailable", never a measured zero (audit engines-reliability-4).
// Run: cd mcp && npx tsx src/auditEngines.test.ts
import assert from "node:assert/strict";
import { engineSummary, TOOLS } from "./tools.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

console.log("\nget_audit per-engine summary");

test("a rate-limited engine is judged on what it answered, not on what was attempted", () => {
  // The prod shape: Perplexity attempted 15, 12 gave no answer, 3 answered.
  const s = engineSummary({ engine: "perplexity", configured: true, mode: "live", cited: 3, total: 15, errors: 12, avg_position: 2 });
  assert.equal(s.total, 15, "existing field kept");
  assert.equal(s.cited, 3, "existing field kept");
  assert.equal(s.answered, 3);
  assert.equal(s.unavailable, 12);
  assert.equal(s.pending, 0);
  assert.equal(s.citation_rate, 1);
  assert.equal(s.status, "measured");
  assert.equal(s.avg_position, 2);
});

test("parked answers come off the denominator too", () => {
  const s = engineSummary({ engine: "gemini", configured: true, mode: "value", cited: 2, total: 22, errors: 0, pending: 10 });
  assert.equal(s.answered, 12);
  assert.equal(s.pending, 10);
  assert.equal(s.citation_rate, 0.167);
});

test("nothing answered has no rate, and says why", () => {
  const dead = engineSummary({ engine: "grok", configured: true, mode: "live", cited: 0, total: 9, errors: 9 });
  assert.equal(dead.citation_rate, null, "0% would be a measurement we never made");
  assert.equal(dead.status, "unavailable");
  const parked = engineSummary({ engine: "aimode", configured: true, mode: "live", cited: 0, total: 5, errors: 0, pending: 5 });
  assert.equal(parked.status, "collecting");
});

test("an off or unconfigured engine is not run, never 0/0", () => {
  assert.equal(engineSummary({ engine: "grok", configured: true, mode: "off", cited: 0, total: 0 }).status, "not_run");
  assert.equal(engineSummary({ engine: "claude", configured: false, cited: 0, total: 0 }).status, "not_run");
  assert.equal(engineSummary({ engine: "claude", configured: false, cited: 0, total: 0 }).citation_rate, null);
});

test("an unconfigured engine's not_configured rows are not answers", () => {
  // The real stage1 shape: one not_configured row per prompt, so total = 9 while
  // errors leaves those rows out.
  const s = engineSummary({ engine: "grok", configured: false, mode: "live", cited: 0, total: 9, errors: 0 });
  assert.equal(s.answered, 0);
  assert.equal(s.citation_rate, null, "a measured 0% next to not_run would be a reading we never took");
  assert.equal(s.status, "not_run");
  assert.equal(s.total, 9, "the existing field keeps its value");
  const off = engineSummary({ engine: "grok", configured: true, mode: "off", cited: 0, total: 4, errors: 0 });
  assert.equal(off.answered, 0);
  assert.equal(off.citation_rate, null);
});

test("no field or tool description tells the reader an engine errored", () => {
  const s = engineSummary({ engine: "perplexity", configured: true, mode: "live", cited: 0, total: 4, errors: 4 });
  assert.ok(!("errors" in s), "the count is `unavailable`, not `errors`");
  for (const name of ["get_audit", "get_visibility"]) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} is registered`);
    assert.doesNotMatch(String(t!.description), /errored|\/ error \/|"error" state/i, `${name} description still names an error state`);
  }
});

console.log(`\n${passed} passed\n`);
