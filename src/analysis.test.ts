// The pure folds behind the four gsc_* analysis tools.
//
// Fixtures are REAL rows from cituna.com's Search Console (2026-07-24 → 08-07),
// the dataset that motivated these tools: 164 queries where the head competitor
// terms sat at position ~95 and the persona-prefixed tail sat at ~61, and where
// half the sitemap had never earned an impression. Pinning behaviour against
// real rows rather than invented ones is the point — the classifier's hard cases
// (a query that is both persona-shaped AND vendor-shaped, a brand near-collision
// like "vicuna" vs "cituna") only exist in real data.
// Run: cd mcp && npx tsx src/analysis.test.ts
import assert from "node:assert/strict";
import { classifyQuery, canonPath, round, avgPos, type GscRow } from "./tools.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const BRAND = ["cituna"];
const RIVALS = ["profound", "otterly", "athenahq", "peec", "scrunch", "semrush", "ahrefs"];
const cls = (q: string) => classifyQuery(q, BRAND, RIVALS);

console.log("\nQuery intent classification");

test("brand wins over every other pattern", () => {
  assert.equal(cls("cituna"), "brand");
  // Brand + a competitor word is still brand — it is someone looking for US.
  assert.equal(cls("cituna vs profound"), "brand");
});

test("persona prefix beats the competitor pattern it contains", () => {
  // The whole reason this bucket is checked before competitor-alternative: every
  // one of these also matches /vs|alternative/ and would otherwise vanish into a
  // bucket averaging 30 positions worse.
  assert.equal(cls("i'm a brand manager. for a two-person brand team, suede web systems or athenahq: which is easier to run day-to-day?"), "persona-qualified");
  assert.equal(cls("i'm an agency consultant. for our college clients, should the agency standardize on suede, profound, or athenahq?"), "persona-qualified");
  assert.equal(cls("as a coo, is there a meaningful difference between the $10k-a-year and $70k-a-year tiers"), "persona-qualified");
  assert.equal(cls("i advise coalitions on digital strategy. which ai narrative platform handles multi-stakeholder issue fights best"), "persona-qualified");
  assert.equal(cls("i lead external affairs at a large corporation"), "persona-qualified");
});

test("competitor intent catches both the word and the bare vendor name", () => {
  assert.equal(cls("profound alternative"), "competitor-alternative");
  assert.equal(cls("best otterly ai competitors"), "competitor-alternative");
  assert.equal(cls("otterly vs peec"), "competitor-alternative");
  // No "alternative"/"vs" anywhere — matched purely on the tracked rival name.
  assert.equal(cls("athenahq ai visibility share of voice"), "competitor-alternative");
});

test("commercial intent outranks a vendor mention, because it picks the page type", () => {
  // "<vendor> pricing" and "<vendor> alternative" are two different pages. Filing
  // both under competitor-alternative hides that you built one and not the other
  // — the exact miss found on cituna.com, where the pricing variants were the
  // second-best-positioned non-brand queries and had no page behind them.
  assert.equal(cls("ahrefs brand radar pricing"), "commercial");
  assert.equal(cls("how much does profound cost"), "commercial");
  assert.equal(cls("lower-cost alternatives to athena hq ai search mentions tracking"), "commercial");
  // Without a price word, the same vendor stays competitor intent.
  assert.equal(cls("ahrefs brand radar alternative"), "competitor-alternative");
});

test("tool and how-to intent separate cleanly", () => {
  assert.equal(cls("perplexity rank tracker"), "tool-intent");
  assert.equal(cls("how to get cited by chatgpt"), "how-to");
  assert.equal(cls("where does my brand rank in perplexity?"), "how-to");
});

test("plain category terms land in category, not a guess", () => {
  assert.equal(cls("aeo vs seo"), "competitor-alternative"); // "vs" — honest about the limitation
  assert.equal(cls("visibility in ai"), "category");
  assert.equal(cls("ai share of voice"), "category");
});

test("a brand near-collision is not silently treated as brand", () => {
  // "vicuna" earned real impressions on cituna.com purely by name similarity.
  // Substring matching must not absorb it into the brand bucket.
  assert.notEqual(cls("vicuna benchmark"), "brand");
});

console.log("\nWeighted position");

test("average position is impression-weighted, not a mean of means", () => {
  // The naive mean of 95 and 20 is 57.5. Weighted by 150 vs 1 impressions it is
  // ~94.5 — the head term dominates, which is the truth about where the traffic is.
  const rows: GscRow[] = [
    { query: "profound alternative", clicks: 14, impressions: 150, ctr: 0.09, position: 94.76 },
    { query: "otterly.ai alternatives", clicks: 0, impressions: 1, ctr: 0, position: 20 },
  ];
  const w = avgPos(rows)!;
  assert.ok(w > 94 && w < 95, `expected ~94.3, got ${w}`);
});

test("no impressions means no position, not a divide-by-zero", () => {
  assert.equal(avgPos([{ impressions: 0, clicks: 0, ctr: 0, position: 50 }]), null);
  assert.equal(avgPos([]), null);
});

test("a null position does not poison the weighted average", () => {
  const rows: GscRow[] = [
    { impressions: 10, clicks: 0, ctr: 0, position: 10 },
    { impressions: 0, clicks: 0, ctr: 0, position: null },
  ];
  assert.equal(avgPos(rows), 10);
});

console.log("\nURL canonicalisation (sitemap ↔ GSC)");

test("trailing slashes and www never split one page into two", () => {
  // The coverage diff is worthless if these read as different URLs — the sitemap
  // and GSC disagree on both, routinely, on the same site.
  assert.equal(canonPath("https://cituna.com/learn/"), canonPath("https://cituna.com/learn"));
  assert.equal(canonPath("https://www.cituna.com/learn"), canonPath("https://cituna.com/learn"));
  assert.equal(canonPath("http://cituna.com/learn"), canonPath("https://cituna.com/learn"));
});

test("distinct pages stay distinct", () => {
  assert.notEqual(canonPath("https://cituna.com/learn"), canonPath("https://cituna.com/compare"));
  assert.notEqual(canonPath("https://cituna.com/"), canonPath("https://cituna.com/pricing"));
});

test("the bare root survives canonicalisation as something non-empty", () => {
  assert.ok(canonPath("https://cituna.com/").length > 0);
  assert.equal(canonPath("https://cituna.com/"), canonPath("https://www.cituna.com"));
});

test("a malformed URL degrades instead of throwing", () => {
  assert.equal(canonPath("not a url/"), "not a url");
});

console.log("\nCoverage diff");

test("the silent set is exactly sitemap minus impressed", () => {
  const sitemap = [
    "https://cituna.com/compare/profound-alternatives",
    "https://cituna.com/compare/knowatoa-alternative",
    "https://cituna.com/compare/goodie-alternatives",
    "https://cituna.com/learn/aeo-vs-seo/",
  ];
  const impressedRows: GscRow[] = [
    { page: "https://cituna.com/compare/profound-alternatives", impressions: 331, clicks: 15, ctr: 0.045, position: 92 },
    { page: "https://cituna.com/learn/aeo-vs-seo", impressions: 260, clicks: 0, ctr: 0, position: 73.9 },
    { page: "https://cituna.com/compare/knowatoa-alternative", impressions: 0, clicks: 0, ctr: 0, position: null },
  ];
  const impressed = new Set(impressedRows.filter((r) => r.impressions > 0).map((r) => canonPath(String(r.page))));
  const silent = sitemap.filter((u) => !impressed.has(canonPath(u)));

  // knowatoa is IN the GSC rows but at zero impressions — still silent. The
  // trailing slash on aeo-vs-seo must not make it look silent.
  assert.deepEqual(silent, [
    "https://cituna.com/compare/knowatoa-alternative",
    "https://cituna.com/compare/goodie-alternatives",
  ]);
});

console.log("\nZero-click cause split");

test("cause is decided by position, because the two fixes are different", () => {
  const cause = (position: number | null) => (position != null && position <= 15 ? "snippet" : "ranking");
  // Real row: /learn/aeo-vs-seo, 260 impressions, 0 clicks, position 73.9.
  // Nothing about the title will fix that — it is not reachable.
  assert.equal(cause(73.9), "ranking");
  // Real row: /pricing, position 4.8, 59 impressions, 1 click. That IS a snippet problem.
  assert.equal(cause(4.83), "snippet");
  assert.equal(cause(15), "snippet");
  assert.equal(cause(15.1), "ranking");
  assert.equal(cause(null), "ranking");
});

console.log("\nRounding");

test("round keeps the precision it promises", () => {
  assert.equal(round(94.7612345, 1), 94.8);
  assert.equal(round(0.047524752, 2), 0.05);
  assert.equal(round(100, 1), 100);
});

console.log(`\n${passed} passed\n`);
