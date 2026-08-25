// Tool-annotation tests.
//
// WHY THIS EXISTS: annotations are a SAFETY CLAIM. `readOnlyHint: true` tells a
// client "this tool cannot change anything", and clients use that to decide what
// to auto-approve without asking. If a write tool ever ships marked read-only,
// we have told Claude it is safe to run `run_scan` unattended — a tool that
// spends the user's money on every call.
//
// The claim has to match the thing that actually enforces it, which is NOT this
// file: it is `MCP_WRITE_TOOLS` in api/src/usage.ts, read by the /api middleware
// that returns the Pro-plan 402. Those are two packages that never import each
// other, so nothing but this test keeps them honest. It reads usage.ts as TEXT
// rather than importing it — api/ has its own dependency tree and importing
// across would drag Mongo and Express into the MCP package's test run.
//
// Also required by the Anthropic Connectors Directory: every tool must carry a
// title and the applicable readOnlyHint/destructiveHint, and the submission
// portal groups tools by annotation and flags any that are missing.
//
// Run: cd mcp && npm run test:annotations
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOOLS, ANNOTATION_WRITE_TOOLS } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE_TS = resolve(HERE, "../../api/src/usage.ts");

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

console.log("\nTool annotations");

test("every tool has a title", () => {
  const missing = TOOLS.filter((t) => !t.annotations?.title?.trim()).map((t) => t.name);
  assert.deepEqual(missing, [], `tools without a title: ${missing.join(", ")}`);
});

test("every tool declares readOnlyHint and destructiveHint", () => {
  const missing = TOOLS.filter(
    (t) => typeof t.annotations?.readOnlyHint !== "boolean" || typeof t.annotations?.destructiveHint !== "boolean",
  ).map((t) => t.name);
  assert.deepEqual(missing, [], `tools missing hints: ${missing.join(", ")}`);
});

test("titles are unique and human-readable, not the tool name", () => {
  const titles = TOOLS.map((t) => t.annotations.title);
  assert.equal(new Set(titles).size, titles.length, "two tools share a title");
  const lazy = TOOLS.filter((t) => t.annotations.title === t.name).map((t) => t.name);
  assert.deepEqual(lazy, [], `titles left as the raw tool name: ${lazy.join(", ")}`);
});

test("no tool is marked destructive (none of them delete or overwrite)", () => {
  // If this ever fails, a genuinely destructive tool was added — that is fine,
  // but the description and the consent copy need to say so too.
  const destructive = TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
  assert.deepEqual(destructive, [], `now destructive, check the user-facing copy: ${destructive.join(", ")}`);
});

console.log("\nAgreement with the backend's write gate");

test("api/src/usage.ts MCP_WRITE_TOOLS is readable", () => {
  const src = readFileSync(USAGE_TS, "utf8");
  assert.match(src, /MCP_WRITE_TOOLS/, "MCP_WRITE_TOOLS not found — did usage.ts move or get renamed?");
});

test("the write set here EXACTLY matches the backend's", () => {
  const src = readFileSync(USAGE_TS, "utf8");
  const m = /MCP_WRITE_TOOLS[^=]*=\s*new Set<string>\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "could not parse MCP_WRITE_TOOLS out of api/src/usage.ts");
  const backend = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  const here = [...ANNOTATION_WRITE_TOOLS].sort();
  assert.deepEqual(
    here,
    backend,
    `annotation write set and backend gate disagree.\n    here:    ${here.join(", ")}\n    backend: ${backend.join(", ")}`,
  );
});

test("every backend write tool is annotated readOnlyHint:false", () => {
  const src = readFileSync(USAGE_TS, "utf8");
  const m = /MCP_WRITE_TOOLS[^=]*=\s*new Set<string>\(\[([^\]]*)\]\)/.exec(src);
  const backend = new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const wrong = TOOLS.filter((t) => backend.has(t.name) && t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(wrong, [], `DANGEROUS: billed as writes but advertised read-only: ${wrong.join(", ")}`);
});

test("every tool the backend does NOT gate is annotated read-only", () => {
  const src = readFileSync(USAGE_TS, "utf8");
  const m = /MCP_WRITE_TOOLS[^=]*=\s*new Set<string>\(\[([^\]]*)\]\)/.exec(src);
  const backend = new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const wrong = TOOLS.filter((t) => !backend.has(t.name) && !t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(wrong, [], `advertised as writes but ungated by the backend: ${wrong.join(", ")}`);
});

console.log("\nSpecific claims worth pinning");

test("run_scan is a non-idempotent, open-world write", () => {
  const t = TOOLS.find((x) => x.name === "run_scan")!;
  assert.equal(t.annotations.readOnlyHint, false);
  assert.equal(t.annotations.idempotentHint, false, "run_scan spends a scan on every call — it is not idempotent");
  assert.equal(t.annotations.openWorldHint, true, "run_scan queries the six answer engines live");
});

test("the gsc_* tools are read-only but open-world", () => {
  for (const name of ["gsc_status", "gsc_overview", "gsc_query"]) {
    const t = TOOLS.find((x) => x.name === name)!;
    assert.equal(t.annotations.readOnlyHint, true, `${name} should be read-only`);
    assert.equal(t.annotations.openWorldHint, true, `${name} reaches Google live`);
  }
});

test("reads of our own stored data are not open-world", () => {
  for (const name of ["list_audits", "get_audit", "get_visibility", "list_gaps", "list_brands"]) {
    const t = TOOLS.find((x) => x.name === name)!;
    assert.equal(t.annotations.openWorldHint, false, `${name} answers from stored data`);
  }
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED: ${failures.join(", ")}` : ""}\n`);
process.exit(failures.length ? 1 : 0);
