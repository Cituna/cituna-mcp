// Both READMEs keep a row for every tool and state the current read and write
// counts. Nothing checked them, and both tables fell ten tools behind.
// Run: cd mcp && npx tsx src/docs.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS } from "./tools.js";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const reads = TOOLS.filter((t) => t.annotations.readOnlyHint).length;
const writes = TOOLS.length - reads;

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

console.log("\nREADME tool tables");

for (const [name, rel] of [["mcp/README.md", "../README.md"], ["PUBLIC-README.md", "../../PUBLIC-README.md"]]) {
  const text = readFileSync(new URL(rel, import.meta.url), "utf8");
  const listed = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    for (const m of line.split("|")[1].matchAll(/`([a-z_]+)`/g)) listed.add(m[1]);
  }

  test(`${name} has a row for every tool`, () => {
    const missing = TOOLS.map((t) => t.name).filter((n) => !listed.has(n));
    assert.deepEqual(missing, [], `no row for: ${missing.join(", ")}`);
  });

  test(`${name} states the read and write counts`, () => {
    const plain = text.replace(/\*\*/g, "");
    assert.match(plain, new RegExp(`\\b${reads} read tools`), `expected "${reads} read tools"`);
    assert.match(plain, new RegExp(`\\b(${writes}|${WORDS[writes]}) write tools`, "i"), `expected "${WORDS[writes]} write tools"`);
  });
}

console.log(`\n${passed} passed`);
