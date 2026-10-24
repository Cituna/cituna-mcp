// get_audit counts each check by its verdict across every page the audit read,
// the same count as the app's "N to fix": `siteStatus` when the scan stored it,
// else the API's siteStatusOf rule over the pages an older scan lists.
// Run: cd mcp && npx tsx src/auditChecks.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CitunaClient } from "./client.js";
import { TOOLS, checkVerdict, createCitunaServer } from "./tools.js";
// The rule checkVerdict ports. Type-only imports, so it loads without the API's dependencies.
import { siteStatusOf } from "../../api/src/auditPages.ts";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failures.push(name); console.error("  FAIL " + name + "\n    " + (e as Error).message); }
}
let scan: unknown = null;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any) => {
  const u = new URL(String(url));
  const found = u.pathname === "/api/scan/scan-1" && scan;
  return new Response(JSON.stringify(found ? { result: scan } : { error: "Not found" }), {
    status: found ? 200 : 404, headers: { "content-type": "application/json" },
  });
};
const backend = new CitunaClient({ baseUrl: "http://backend.test", apiKey: "cituna_sk_test" });
const server = createCitunaServer(backend, { apiUrl: "http://backend.test", noCredentialsMessage: "no creds" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "audit-checks-test", version: "0" });
await server.connect(serverTransport);
await mcp.connect(clientTransport);
async function getAudit(audit: Record<string, unknown>) {
  scan = { domain: "acme.com", url: "https://acme.com", score: 41, audit };
  const res = (await mcp.callTool({ name: "get_audit", arguments: { scanId: "scan-1" } })) as any;
  assert.notEqual(res.isError, true, res.content?.[0]?.text);
  return JSON.parse(res.content[0].text);
}

// A scan with the page report: six pages read, checks carry siteStatus. The app
// shows SEO "5 to fix" and GEO "2 to fix" for it; on the homepage alone only the
// sitemap is open.
const check = (id: string, status: string, siteStatus: string, pages?: [number, number]) => ({
  id, label: id.replace(/_/g, " "), status, siteStatus, detail: "Homepage reading.", impact: "Medium", points: 0,
  ...(pages ? { pagesExamined: pages[0], pagesPassing: pages[1] } : {}),
});
const pageReport = () => ({
  seo: {
    score: 70,
    checks: [
      check("https", "pass", "pass"),
      check("title", "pass", "warn", [6, 4]),
      check("meta_desc", "pass", "pass", [6, 6]),
      check("headings", "pass", "warn", [6, 5]),
      check("viewport", "pass", "pass", [6, 6]),
      check("img_alt", "pass", "warn", [6, 4]),
      check("content_depth", "pass", "warn", [6, 4]),
      check("sitemap", "warn", "warn"),
    ],
    advisories: [
      { ...check("duplicate_titles", "warn", "warn", [6, 4]), advisory: true },
      { ...check("hreflang", "pass", "pass", [6, 6]), advisory: true },
    ],
  },
  geo: {
    score: 64,
    checks: [
      check("llms_txt", "pass", "pass"),
      check("entity_grounding", "pass", "pass"),
      check("answer_format", "pass", "fail", [6, 3]),
      check("schema_coverage", "pass", "pass", [6, 6]),
      check("freshness", "pass", "warn", [6, 4]),
      { ...check("ai_training_access", "pass", "pass"), informational: true },
    ],
    advisories: [{ ...check("article_author", "warn", "warn", [6, 5]), advisory: true }],
  },
  coverage: {
    pagesRead: 6, pagesTried: 9, pagesListed: 120, listedSource: "sitemap", sections: 5, budgetHit: true,
    allowance: 30, tier: "solo", nextAllowance: { tier: "agency", pages: 60 },
  },
});

try {
  await test("a check with siteStatus is counted by its verdict across pages, not the homepage's", async () => {
    const out = await getAudit(pageReport());
    const { seo, geo } = out.audit_checks;
    assert.deepEqual({ pass: seo.pass, warn: seo.warn, fail: seo.fail }, { pass: 3, warn: 5, fail: 0 });
    assert.deepEqual({ pass: geo.pass, warn: geo.warn, fail: geo.fail }, { pass: 3, warn: 1, fail: 1 });
    // The app's "N to fix" per pillar is its failing plus warning checks.
    assert.equal(seo.to_fix.length, 5);
    assert.equal(geo.to_fix.length, 2);
  });

  await test("to_fix lists fails before warns, with page counts and the homepage's result when it differs", async () => {
    const { geo, seo } = (await getAudit(pageReport())).audit_checks;
    assert.deepEqual(geo.to_fix, [
      { id: "answer_format", label: "answer format", status: "fail", homepage_status: "pass", pages_examined: 6, pages_passing: 3 },
      { id: "freshness", label: "freshness", status: "warn", homepage_status: "pass", pages_examined: 6, pages_passing: 4 },
    ]);
    // A site-level check answered once has no page counts, and its homepage result is the verdict.
    assert.deepEqual(seo.to_fix.find((c: any) => c.id === "sitemap"), { id: "sitemap", label: "sitemap", status: "warn" });
  });

  await test("advisories are listed with their pages and never counted", async () => {
    const { seo, geo } = (await getAudit(pageReport())).audit_checks;
    assert.deepEqual(seo.advisories, [
      { id: "duplicate_titles", label: "duplicate titles", status: "warn", pages_examined: 6, pages_passing: 4 },
      { id: "hreflang", label: "hreflang", status: "pass", pages_examined: 6, pages_passing: 6 },
    ]);
    assert.deepEqual(geo.advisories.map((a: any) => a.id), ["article_author"]);
    assert.equal(seo.pass + seo.warn + seo.fail, 8, "only the eight checks are counted");
    assert.ok(!seo.to_fix.some((c: any) => c.id === "duplicate_titles"));
  });

  await test("the coverage block gives pages read, pages listed and the plan allowance", async () => {
    const out = await getAudit(pageReport());
    assert.deepEqual(out.audit_coverage, { pages_read: 6, pages_listed: 120, plan_allowance: 30 });
    const unlisted = pageReport();
    unlisted.coverage.pagesListed = 0;
    assert.equal((await getAudit(unlisted)).audit_coverage.pages_listed, null, "0 means the count is unknown");
  });

  await test("an old scan with no siteStatus reads the verdict from the pages it lists, else the homepage's status", async () => {
    const listed = (n: number, status: string) =>
      Array.from({ length: n }, (_, i) => ({ url: `https://acme.com/p${i}`, status, detail: "This page's reading." }));
    const out = await getAudit({
      seo: {
        score: 58,
        checks: [
          { id: "title", label: "Title tag", status: "warn", pagesExamined: 7, pages: listed(1, "warn") },
          { id: "meta_desc", label: "Meta description", status: "fail" },
          { id: "https", label: "HTTPS / TLS", status: "pass" },
          // Four of seven pages fail: at least half, so the check fails although the homepage passes.
          { id: "img_alt", label: "Image alt text", status: "pass", pagesExamined: 7, pages: listed(4, "fail") },
          { id: "content_depth", label: "Content depth", status: "pass", pagesExamined: 7, pages: listed(1, "fail") },
        ],
      },
      geo: {
        score: 50,
        checks: [
          { id: "llms_txt", label: "llms.txt", status: "fail" },
          { id: "freshness", label: "Freshness signals", status: "pass", pagesExamined: 7, pages: listed(5, "fail") },
        ],
      },
    });
    const { seo, geo } = out.audit_checks;
    assert.deepEqual({ pass: seo.pass, warn: seo.warn, fail: seo.fail }, { pass: 1, warn: 2, fail: 2 });
    assert.deepEqual(seo.to_fix, [
      { id: "meta_desc", label: "Meta description", status: "fail" },
      { id: "img_alt", label: "Image alt text", status: "fail", homepage_status: "pass", pages_examined: 7 },
      { id: "title", label: "Title tag", status: "warn", pages_examined: 7 },
      { id: "content_depth", label: "Content depth", status: "warn", homepage_status: "pass", pages_examined: 7 },
    ]);
    // Freshness stops at warn however many pages lack dates.
    assert.deepEqual({ pass: geo.pass, warn: geo.warn, fail: geo.fail }, { pass: 0, warn: 1, fail: 1 });
    assert.ok(!("advisories" in seo), "no advisories on a scan that carries none");
    assert.ok(!("audit_coverage" in out), "no coverage block on a scan that carries none");
  });

  await test("checkVerdict gives the API's siteStatusOf verdict", () => {
    const pg = (status: string, i = 0) => ({ url: `https://acme.com/p${i}`, status, detail: "" });
    const many = (n: number, status: string) => Array.from({ length: n }, (_, i) => pg(status, i));
    const cases: any[] = [
      { id: "title", status: "pass", siteStatus: "fail" },
      { id: "title", status: "fail", siteStatus: "pass" },
      { id: "title", status: "warn", siteStatus: "warn", pages: many(3, "fail"), pagesExamined: 3 },
      { id: "title", status: "pass" },
      { id: "title", status: "warn" },
      { id: "title", status: "fail", pages: [] },
      { id: "title", status: "pass", pages: many(3, "fail"), pagesExamined: 6 },
      { id: "title", status: "pass", pages: many(2, "fail"), pagesExamined: 6 },
      { id: "title", status: "pass", pages: many(4, "warn"), pagesExamined: 6 },
      { id: "title", status: "fail", pages: many(1, "warn"), pagesExamined: 30 },
      { id: "title", status: "pass", pages: many(2, "fail") },
      { id: "title", status: "pass", pages: many(2, "fail"), pagesExamined: 0 },
      { id: "title", status: "pass", pages: [{ status: "fail" }, pg("pass"), pg("warn")], pagesExamined: 6 },
      { id: "title", status: "pass", siteStatus: "unknown", pages: many(5, "fail"), pagesExamined: 6 },
      { id: "freshness", status: "fail", pages: many(6, "fail"), pagesExamined: 6 },
      { id: "freshness", status: "pass", pages: many(1, "fail"), pagesExamined: 6 },
    ];
    for (const c of cases) assert.equal(checkVerdict(c), siteStatusOf(c), JSON.stringify(c));
  });

  await test("on the stored cituna.com scan from before the page report, get_audit counts what the app shows", async () => {
    const stored = JSON.parse(readFileSync(new URL("../../frontend/components/results/__fixtures__/citunaOldAudit.json", import.meta.url), "utf8"));
    const out = await getAudit(stored.audit);
    for (const pillar of ["seo", "geo"]) {
      const checks: any[] = (stored.audit[pillar]?.checks ?? []).filter((c: any) => !c.informational);
      for (const c of checks) assert.equal(checkVerdict(c), siteStatusOf(c), `${pillar} ${c.id}`);
      const open = checks.filter((c) => siteStatusOf(c) !== "pass").length;
      assert.equal(out.audit_checks[pillar].warn + out.audit_checks[pillar].fail, open, `${pillar} to fix`);
      assert.equal(out.audit_checks[pillar].to_fix.length, open);
    }
    // The case this guards: checks that pass on the homepage but fail on the pages listed under them.
    const homeOnly = stored.audit.seo.checks.filter((c: any) => !c.informational && c.status !== "pass").length;
    assert.ok(out.audit_checks.seo.to_fix.length > homeOnly, "the stored scan lists failing pages under passing checks");
  });

  await test("an informational check is never counted or listed", async () => {
    const report = pageReport();
    const { geo } = (await getAudit(report)).audit_checks;
    assert.equal(geo.pass, 3, "ai_training_access reads pass but is not counted");
    report.geo.checks = [{ ...check("ai_training_access", "warn", "warn"), informational: true }, check("llms_txt", "pass", "pass")];
    const only = (await getAudit(report)).audit_checks.geo;
    assert.deepEqual({ pass: only.pass, warn: only.warn, fail: only.fail }, { pass: 1, warn: 0, fail: 0 });
    assert.deepEqual(only.to_fix, []);
  });

  await test("an audit whose checks never ran has no audit_checks block", async () => {
    const out = await getAudit({ seo: { score: null, checks: [] } });
    assert.ok(!("audit_checks" in out), "not checked must not read as 0 passed, 0 failed");
  });

  await test("the tool description says what the counts are", () => {
    const desc = String(TOOLS.find((t) => t.name === "get_audit")!.description);
    assert.match(desc, /across every page the audit read/);
    assert.match(desc, /as the app counts them/);
  });
} finally {
  await mcp.close();
  await server.close();
  globalThis.fetch = realFetch;
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
if (failures.length) process.exit(1);
