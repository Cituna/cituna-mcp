#!/usr/bin/env node
// ─── Cituna — MCP server ──────────────────────────────────────────────
// Exposes the Cituna product to Claude (Desktop / Code / any MCP client):
//   • AI-visibility audits — per-engine citation scores, the query×engine citation
//     matrix, competitors cited, and the prioritised gap/action queue.
//   • Live Google Search Console data — clicks / impressions / CTR / position,
//     top queries & pages, arbitrary Search Analytics queries.
// Everything goes through the Cituna backend, which owns the Google OAuth
// refresh token and the database — this server only authenticates AS you.
//
// Transport: stdio (for Claude Desktop / Claude Code / any local MCP client).
// IMPORTANT: stdout is reserved for the JSON-RPC protocol — all logging goes to
// stderr (console.error), never console.log.
//
// Config via env (see .env.example / README):
//   CITUNA_API_URL   backend base URL (default https://cituna.com)
//   CITUNA_API_KEY   a personal API key (cituna_sk_…) from the app — RECOMMENDED
//   CITUNA_TOKEN     a session JWT (the app's cituna_token) — alternative
//   CITUNA_EMAIL + CITUNA_PASSWORD   email/password login — alternative

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CitunaClient, CitunaApiError } from "./client.js";

// Defaults to the public Cituna backend so distributed users can omit it.
// For local backend dev, set CITUNA_API_URL=http://localhost:3001.
const API_URL = process.env.CITUNA_API_URL || "https://cituna.com";
const VERSION = "1.4.0";

const client = new CitunaClient({
  baseUrl: API_URL,
  apiKey: process.env.CITUNA_API_KEY,
  token: process.env.CITUNA_TOKEN,
  email: process.env.CITUNA_EMAIL,
  password: process.env.CITUNA_PASSWORD,
});

// ─── Tool definitions (JSON Schema — the low-level, version-stable MCP API) ───
const GSC_DIMENSIONS = ["query", "page", "country", "device", "searchAppearance", "date"];
const FILTER_OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"];
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];
const GAP_STATES = ["todo", "doing", "done"];

const TOOLS = [
  {
    name: "whoami",
    description:
      "Return the authenticated Cituna account (email, workspaceId, role), the backend URL, and — when available — your plan (Starter/Pro/Max) and current usage. Use this first to confirm the connection works. Fails with an actionable message if the API key is missing, invalid, or expired.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_audits",
    description:
      "List recent AI-visibility audits (scans) for your workspace, newest first: scanId, domain, date, AI-citation score, plus on-page SEO / GEO / authority scores and open-gap count. Pass a scanId to get_audit for the full breakdown. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Optional client-side filter — only return audits for this bare domain, e.g. 'acme.com'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_audit",
    description:
      "Get one AI-visibility audit in detail by scanId (from list_audits): overall AI-citation score + SEO/GEO/authority scores, per-engine citation summary (ChatGPT/Perplexity/Gemini/Claude/Grok/Google AI Overviews), the query×engine citation matrix (was your brand cited for each question, per engine), competitors cited, the top prioritised gaps (title, category, impact, effort), and pass/warn/fail audit check counts. Bulky raw fields (page HTML, full engine answers) are omitted. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string", description: "The audit/scan id from list_audits." },
      },
      required: ["scanId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_visibility",
    description:
      "Your brand's LATEST DAILY TRACKING GRID — the core Cituna deliverable. For a brand (a brand id from list_brands, OR its bare domain), returns the most recent day's per-prompt × per-engine grid: for every tracked prompt and each of the six engines (ChatGPT/Perplexity/Gemini/Claude/Grok/Google AI Overviews) whether your brand was cited, its position when cited, the engine mode that ran (live/value/lite/off), plus per-cell status (cited / answered / empty / error / notrun). Also the brand's current visibility score, its label, and the UTC day it was measured. Compact JSON, designed to be read directly. Use get_engine_answers to see what an engine actually said for a prompt. Requires a signed-in account; works on Starter and the trial.",
    inputSchema: {
      type: "object",
      properties: {
        brand: {
          type: "string",
          description: "The brand to report on — a brand id (from list_brands) OR its bare domain, e.g. 'acme.com'.",
        },
      },
      required: ["brand"],
      additionalProperties: false,
    },
  },
  {
    name: "get_engine_answers",
    description:
      "The RECEIPTS behind the tracking grid. For a brand (id or domain) and one tracked prompt — optionally a single engine — returns the actual stored answer text each engine gave on the most recent day, the brands it cited, the source URLs, and whether your brand was cited and at what position. Answer text is capped (~4000 chars per engine) with a `truncated` flag. Copy the exact prompt text from get_visibility's prompts[].prompt; a prompt that isn't found returns availablePrompts to pick from. Requires a signed-in account; works on Starter and the trial.",
    inputSchema: {
      type: "object",
      properties: {
        brand: {
          type: "string",
          description: "The brand — a brand id (from list_brands) OR its bare domain, e.g. 'acme.com'.",
        },
        prompt: {
          type: "string",
          description: "The exact tracked prompt text to pull answers for — copy it from get_visibility (prompts[].prompt).",
        },
        engine: {
          type: "string",
          description:
            "Optional — limit to a single engine. One of: ChatGPT, Perplexity, Gemini, Claude, Grok, or Google AI Overviews (pass the key `aioverviews` for that last one; the others are their lowercase name, e.g. `chatgpt`).",
        },
      },
      required: ["brand", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "list_gaps",
    description:
      "The fix/action queue for a domain: each AI-visibility gap with its stable gapKey, current status (todo / doing / done), title, category, impact, effort, and the concrete fix. Pass a scanId (exact audit) OR a domain (uses that domain's newest audit). Use set_gap_status to update a gap. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        scanId: { type: "string", description: "Audit id (from list_audits) to read gaps from. Optional if `domain` is given." },
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com' — uses its most recent audit. Optional if `scanId` is given." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_gap_status",
    description:
      "Update one gap's status in the action queue (todo / doing / done). Use the gapKey and domain from list_gaps. e.g. mark the schema gap for acme.com done. WRITE ACTION — requires a Pro plan or higher; on Starter/trial the MCP is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain the gap belongs to, e.g. 'acme.com'." },
        gapKey: { type: "string", description: "The stable gapKey from list_gaps." },
        status: { type: "string", description: "New status.", enum: GAP_STATES },
      },
      required: ["domain", "gapKey", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "run_scan",
    description:
      "Run a NEW AI-visibility audit for a website and return the completed result (scores, citation matrix, competitors, top gaps). Takes ~1 minute and CONSUMES ONE SCAN from your monthly quota. Optionally pass competitors to steer the comparison. Prefer list_audits/get_audit to read an existing audit for free; use run_scan only when fresh data is needed. WRITE ACTION — requires a Pro plan or higher; on Starter/trial the MCP is read-only (run scans in the app instead).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Site to scan — bare domain 'acme.com' or full URL 'https://acme.com'." },
        competitors: {
          type: "array",
          description: "Optional competitor domains to compare against (up to 8). Steers the comparison instead of relying only on auto-detection.",
          items: { type: "string" },
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "gsc_status",
    description:
      "Get Google Search Console connection status for this workspace: whether GSC OAuth is configured, whether this workspace has connected, the connected Google account email, and the list of verified GSC properties (site URLs / sc-domain: properties) available to query.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_brands",
    description:
      "List the brands/domains tracked in this Cituna workspace. Handy for discovering which domains you can pass to the audit and gsc_* tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gsc_overview",
    description:
      "Live Google Search Console SUMMARY for a domain over the last N days: headline totals (clicks, impressions, CTR, average position) plus top queries, top pages, country and device splits, and a day-by-day time series. Windows are UTC and end ~2 days ago (GSC reporting lag). Best default for 'how is my search traffic doing?'. Requires a paid plan (Starter+). Returns {configured:false, message} if GSC isn't connected or no property matches the domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Bare domain to report on, e.g. 'example.com' (no scheme/path). Must match a connected GSC property.",
        },
        days: {
          type: "integer",
          description: "Trailing window in days (1–90). Default 28. Data lags ~2–3 days, so the window ends ~2 days ago.",
          minimum: 1,
          maximum: 90,
        },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "gsc_query",
    description:
      "Run an arbitrary Google Search Console Search Analytics query — the raw, flexible tool. Choose any dimensions (query, page, country, device, searchAppearance, date), an explicit date range OR a trailing `days` window, a row limit, and optional filters. Use dimensions:['date'] for day-by-day trends; ['country'] or ['device'] for splits; add filters to focus on a specific query or page. Windows are UTC and end ~2 days ago (GSC lag). Returns rows with keys[] plus clicks/impressions/ctr/position. Default rowLimit 100 — page with startRow when capped. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Bare domain, e.g. 'example.com'. Resolved to a connected GSC property. Provide this OR siteUrl.",
        },
        siteUrl: {
          type: "string",
          description: "Exact GSC property instead of a domain, e.g. 'sc-domain:example.com' or 'https://example.com/'. Optional.",
        },
        dimensions: {
          type: "array",
          description: "Dimensions to group by. Default ['query'].",
          items: { type: "string", enum: GSC_DIMENSIONS },
        },
        days: {
          type: "integer",
          description: "Trailing window in days (1–480) when startDate/endDate are omitted. Default 28. Window ends ~2 days ago (GSC lag).",
          minimum: 1,
          maximum: 480,
        },
        startDate: { type: "string", description: "YYYY-MM-DD. Overrides `days`. Must be paired with endDate." },
        endDate: { type: "string", description: "YYYY-MM-DD. Overrides `days`. Must be paired with startDate." },
        rowLimit: {
          type: "integer",
          description: "Max rows to return (1–25000). Default 100.",
          minimum: 1,
          maximum: 25000,
        },
        startRow: { type: "integer", description: "Zero-based offset for pagination. Default 0.", minimum: 0 },
        type: {
          type: "string",
          description: "Search type. Default 'web'.",
          enum: SEARCH_TYPES,
        },
        dataState: {
          type: "string",
          description: "'final' (default, stable) or 'all' (includes the freshest partial data for the last ~2 days).",
          enum: ["final", "all"],
        },
        filters: {
          type: "array",
          description:
            "Optional filters, combined with AND. Each: {dimension, operator, expression}. e.g. {dimension:'query', operator:'contains', expression:'pricing'} or {dimension:'country', operator:'equals', expression:'usa'} (3-letter ISO) or {dimension:'device', operator:'equals', expression:'MOBILE'}.",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string", enum: GSC_DIMENSIONS },
              operator: { type: "string", enum: FILTER_OPERATORS },
              expression: { type: "string" },
            },
            required: ["dimension", "expression"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
];

// ─── Server wiring ───────────────────────────────────────────────────────────
const server = new Server(
  { name: "cituna", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Wrap a handler's result as MCP text content (compact JSON — no pretty-printing,
// so we don't burn tokens on whitespace).
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Bare-domain normaliser — MUST match the backend (api/src/gapstatus.ts) so
// gap-status writes and history lookups hit the same key the app uses.
function normDomain(d: string): string {
  return String(d).replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
}

// Stable per-gap key — MUST match the frontend (frontend/lib/gapStatus.js) so a
// status set here shows up in the app and vice-versa: `category-title` slug.
function gapKey(gap: any, idx: number): string {
  const base = `${gap?.category || "other"}-${gap?.title || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `gap-${idx}`;
}

// Internal plan id → customer-facing display name (Starter/Pro/Max).
const PLAN_DISPLAY: Record<string, string> = { solo: "Starter", agency: "Pro", scale: "Max" };
function displayPlans(ids: string[]): string {
  const names = ids.map((id) => PLAN_DISPLAY[id] || id);
  return [...new Set(names)].join("/") || "Starter/Pro/Max";
}

function summarizeChecks(checks: any): { pass: number; warn: number; fail: number } {
  const out = { pass: 0, warn: 0, fail: 0 };
  for (const c of Array.isArray(checks) ? checks : []) {
    if (c?.status === "pass") out.pass++;
    else if (c?.status === "warn") out.warn++;
    else if (c?.status === "fail") out.fail++;
  }
  return out;
}

// query × engine citation matrix from stage1.citations[] (engine, query,
// customer_cited, error). Cell: true = cited, false = not cited, null = engine
// errored / not run for that query.
function citationMatrix(stage1: any) {
  const citations = Array.isArray(stage1?.citations) ? stage1.citations : [];
  const engines = Array.isArray(stage1?.per_engine) ? stage1.per_engine.map((e: any) => e.engine) : [];
  const rowByQuery = new Map<string, Record<string, boolean | null>>();
  for (const q of Array.isArray(stage1?.queries) ? stage1.queries : []) rowByQuery.set(String(q), {});
  for (const c of citations) {
    if (!c || !c.query) continue;
    const q = String(c.query);
    if (!rowByQuery.has(q)) rowByQuery.set(q, {});
    rowByQuery.get(q)![String(c.engine)] = c.error ? null : !!c.customer_cited;
  }
  return {
    engines,
    rows: [...rowByQuery.entries()].map(([query, cited]) => ({ query, cited })),
  };
}

function mapGap(g: any, idx: number) {
  return {
    gapKey: gapKey(g, idx),
    title: g?.title || g?.gap_title || "Recommendation",
    category: g?.category || "other",
    impact: g?.impact_bracket ?? null,
    effort: g?.effort_estimate ?? null,
    confidence: g?.confidence ?? null,
  };
}

// Trim a full ScanResult to a compact audit summary (a few thousand tokens max).
// Drops stage2 (page HTML), raw engine answers, cited-URL dumps, gap evidence.
function trimAudit(result: any, scanId?: string) {
  const r = result || {};
  const audit = r.audit || {};
  const stage1 = r.stage1 || {};
  return {
    ...(scanId ? { scanId } : {}),
    domain: r.domain ?? null,
    url: r.url ?? null,
    overall: {
      ai_citation_score: r.score ?? null,
      score_label: r.score_label ?? null,
      seo_score: audit.seo?.score ?? null,
      geo_score: audit.geo?.score ?? null,
      authority_score: audit.authority?.measured ? audit.authority.score : null, // null unless REAL (DataForSEO) — matches db + list_audits
    },
    engines: Array.isArray(stage1.per_engine)
      ? stage1.per_engine.map((e: any) => ({
          engine: e.engine, configured: e.configured, cited: e.cited, total: e.total, avg_position: e.avg_position ?? null,
        }))
      : [],
    citation_matrix: citationMatrix(stage1),
    competitors_cited: Array.isArray(stage1.competitors_cited)
      ? stage1.competitors_cited.slice(0, 10).map((c: any) => ({ brand: c.brand, count: c.count }))
      : [],
    top_gaps: (Array.isArray(r.stage3?.gaps) ? r.stage3.gaps : []).slice(0, 12).map(mapGap),
    gap_summary: r.stage3?.gap_summary_one_line ?? null,
    audit_checks: {
      seo: summarizeChecks(audit.seo?.checks),
      geo: summarizeChecks(audit.geo?.checks),
    },
    patterns_observed: Array.isArray(stage1.patterns_observed) ? stage1.patterns_observed.slice(0, 10) : [],
  };
}

// Resolve a full scan result from either an explicit scanId or a domain's newest
// audit. Returns { result, domain } or null when nothing is found.
async function resolveScan(scanId: string, domain: string): Promise<{ result: any; domain: string } | null> {
  if (scanId) {
    const data = await client.get(`/api/scan/${encodeURIComponent(scanId)}`);
    const result = data?.result;
    if (!result) return null;
    return { result, domain: normDomain(domain || result.domain || "") };
  }
  const dom = normDomain(domain);
  if (!dom) return null;
  const hist = await client.get(`/api/history/${encodeURIComponent(dom)}`);
  const scans = Array.isArray(hist?.scans) ? hist.scans : [];
  const newest = scans[scans.length - 1]; // domainHistory returns oldest→newest
  if (!newest?._id) return null;
  const data = await client.get(`/api/scan/${encodeURIComponent(String(newest._id))}`);
  const result = data?.result;
  if (!result) return null;
  return { result, domain: dom };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  // Tell the client which tool this is, so backend calls carry X-Cituna-Mcp-Tool and
  // the backend can apply the read/write plan split (write tools are Pro+).
  client.beginTool(name);

  // Every tool needs a credential. Short-circuit with a clean, actionable error
  // (rather than a stack trace) when none is configured — so `tools/list` still
  // works but calls tell the user exactly what to do.
  if (!client.hasCredentials()) {
    return fail(
      "No API key configured. In the app: Integrations → \"Claude / MCP access\" → Generate token, then set CITUNA_API_KEY (cituna_sk_…).",
    );
  }

  try {
    switch (name) {
      case "whoami": {
        const me = await client.get("/api/auth/me");
        const user = me?.user ?? null;
        // The backend returns HTTP 200 {user:null} for a bad/expired key — treat
        // that as a FAILURE so Claude doesn't report a phantom "connected" state.
        if (!user) {
          return fail(
            "API key invalid or expired — mint one in the app: Integrations → Claude / MCP access, then set CITUNA_API_KEY.",
          );
        }
        const plan = me.plan ?? user.plan ?? undefined;
        const usage = me.usage ?? user.usage ?? undefined;
        return ok({
          backend: API_URL,
          auth: client.describeAuth(),
          email: user.email ?? null,
          workspaceId: user.workspaceId ?? null,
          role: user.role ?? null,
          isFounder: !!me.isFounder,
          gsc_connected: !!me.google,
          ...(plan ? { plan } : {}),
          ...(usage ? { usage } : {}),
        });
      }

      case "list_audits": {
        const data = await client.get("/api/history");
        const scans = Array.isArray(data?.scans) ? data.scans : [];
        const filter = args.domain ? normDomain(String(args.domain)) : null;
        const audits = scans
          .filter((s: any) => !filter || normDomain(String(s.domain || "")) === filter)
          .map((s: any) => ({
            scanId: String(s._id),
            domain: s.domain ?? null,
            date: s.createdAt ?? null,
            ai_citation_score: s.score ?? null,
            seo_score: s.seo_score ?? null,
            geo_score: s.geo_score ?? null,
            authority_score: s.authority_score ?? null,
            gaps: s.gaps_count ?? null,
          }));
        return ok({ configured: !!data?.configured, count: audits.length, audits });
      }

      case "get_audit": {
        const scanId = String(args.scanId ?? "").trim();
        if (!scanId) return fail("`scanId` is required — get one from list_audits.");
        const data = await client.get(`/api/scan/${encodeURIComponent(scanId)}`);
        if (!data?.result) return fail(`No audit found for scanId ${scanId} (or it belongs to another workspace).`);
        return ok(trimAudit(data.result, scanId));
      }

      case "get_visibility": {
        const brand = String(args.brand ?? "").trim();
        if (!brand) return fail("`brand` is required — a brand id (from list_brands) or a domain like 'acme.com'.");
        return ok(await client.get("/api/visibility", { brand }));
      }

      case "get_engine_answers": {
        const brand = String(args.brand ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!brand) return fail("`brand` is required — a brand id (from list_brands) or a domain like 'acme.com'.");
        if (!prompt) return fail("`prompt` is required — the exact tracked prompt text (see get_visibility).");
        const engine = String(args.engine ?? "").trim();
        return ok(await client.get("/api/engine-answers", { brand, prompt, engine: engine || undefined }));
      }

      case "list_gaps": {
        const scanId = String(args.scanId ?? "").trim();
        const domainArg = String(args.domain ?? "").trim();
        if (!scanId && !domainArg) return fail("Provide `scanId` (from list_audits) or `domain`.");
        const resolved = await resolveScan(scanId, domainArg);
        if (!resolved) {
          return ok({
            domain: normDomain(domainArg),
            count: 0,
            gaps: [],
            message: "No saved audit found — run_scan first, or pass a scanId from list_audits.",
          });
        }
        const { result, domain } = resolved;
        const statusRes = await client.get("/api/gap-status", { domain });
        const statusMap = statusRes && typeof statusRes.statuses === "object" ? statusRes.statuses : {};
        const rawGaps = Array.isArray(result?.stage3?.gaps) ? result.stage3.gaps : [];
        const gaps = rawGaps.map((g: any, i: number) => {
          const key = gapKey(g, i);
          return {
            gapKey: key,
            status: statusMap[key] || "todo",
            title: g?.title || g?.gap_title || "Recommendation",
            category: g?.category || "other",
            impact: g?.impact_bracket ?? null,
            effort: g?.effort_estimate ?? null,
            confidence: g?.confidence ?? null,
            fix: g?.specific_fix?.what ?? g?.fix ?? g?.recommendation ?? null,
            where: g?.specific_fix?.where ?? null,
          };
        });
        return ok({ domain, count: gaps.length, gaps });
      }

      case "set_gap_status": {
        const domain = normDomain(String(args.domain ?? "").trim());
        const key = String(args.gapKey ?? "").trim();
        const status = String(args.status ?? "").trim();
        if (!domain || !key) return fail("`domain` and `gapKey` are required (gapKey comes from list_gaps).");
        if (!GAP_STATES.includes(status)) return fail(`\`status\` must be one of: ${GAP_STATES.join(", ")}.`);
        await client.post("/api/gap-status", { domain, gapKey: key, status });
        return ok({ ok: true, domain, gapKey: key, status });
      }

      case "run_scan": {
        const url = String(args.url ?? "").trim();
        if (!url) return fail("`url` is required, e.g. 'acme.com'.");
        const competitors = Array.isArray(args.competitors)
          ? args.competitors.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 8)
          : undefined;
        const { result, progress } = await client.runScanStream(
          { url, ...(competitors && competitors.length ? { competitors } : {}) },
          { timeoutMs: 300000 },
        );
        return ok({ ...trimAudit(result), progress_stages: progress });
      }

      case "gsc_status": {
        return ok(await client.get("/api/integrations/gsc/status"));
      }
      case "list_brands": {
        return ok(await client.get("/api/projects"));
      }
      case "gsc_overview": {
        const domain = String(args.domain ?? "").trim();
        if (!domain) return fail("`domain` is required, e.g. 'example.com'.");
        const days = args.days != null ? Number(args.days) : undefined;
        return ok(await client.get("/api/integrations/gsc/data", { domain, days }));
      }
      case "gsc_query": {
        const domain = String(args.domain ?? "").trim();
        const siteUrl = String(args.siteUrl ?? "").trim();
        if (!domain && !siteUrl) return fail("Provide `domain` (e.g. 'example.com') or `siteUrl`.");
        // Turn the convenience `filters` array into GSC's dimensionFilterGroups
        // (a single AND group). Default operator is 'contains'.
        const filters = Array.isArray(args.filters) ? args.filters : [];
        const dimensionFilterGroups =
          filters.length > 0
            ? [
                {
                  groupType: "and",
                  filters: filters.map((f: any) => ({
                    dimension: String(f.dimension),
                    operator: String(f.operator ?? "contains"),
                    expression: String(f.expression),
                  })),
                },
              ]
            : undefined;
        // Enforce a default row cap here so paging behaviour is predictable and we
        // can tell the caller when the result is capped.
        const rowLimit = args.rowLimit != null ? Math.max(1, Math.min(25000, Number(args.rowLimit))) : 100;
        const startRow = args.startRow != null ? Math.max(0, Number(args.startRow)) : 0;
        const payload: Record<string, unknown> = {
          domain: domain || undefined,
          siteUrl: siteUrl || undefined,
          dimensions: Array.isArray(args.dimensions) && args.dimensions.length ? args.dimensions : undefined,
          days: args.days != null ? Number(args.days) : undefined,
          startDate: args.startDate || undefined,
          endDate: args.endDate || undefined,
          rowLimit,
          startRow: startRow || undefined,
          type: args.type || undefined,
          dataState: args.dataState || undefined,
          dimensionFilterGroups,
        };
        const res = await client.post("/api/integrations/gsc/query", payload);
        // When the result fills the requested cap, more rows likely exist — tell
        // the caller how to page (GSC returns no grand total to show N of M).
        if (res && typeof res === "object" && Array.isArray(res.rows) && res.rows.length >= rowLimit) {
          return ok({
            ...res,
            note: `showing ${res.rows.length} rows (capped at rowLimit=${rowLimit}) — more may exist; pass startRow=${startRow + rowLimit} to page the rest.`,
          });
        }
        return ok(res);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof CitunaApiError) {
      if (e.status === 401) {
        return fail(
          "API key invalid or expired (HTTP 401) — mint a new one in the app: Integrations → Claude / MCP access, then set CITUNA_API_KEY.",
        );
      }
      if (e.status === 402) {
        const body = (e.body ?? {}) as any;
        const requires = Array.isArray(body?.requires) ? body.requires : [];
        // Write tool on a read-only (Starter/trial) plan → a specific, actionable
        // upsell rather than the generic paid-plan message.
        if (body?.reason === "mcp_write_pro") {
          return fail(
            `${name} is a write action — it needs the ${displayPlans(requires)} plan. On Starter/trial the MCP is read-only (you can still read audits, gaps and Search Console data, and run scans in the app). Upgrade at https://cituna.com/pricing`,
          );
        }
        return fail(
          `This requires a paid plan (${displayPlans(requires)}) — upgrade at https://cituna.com/pricing`,
        );
      }
      if (e.status === 429) {
        return fail(`Scan quota reached (HTTP 429): ${e.message}`);
      }
      if (e.status === 404) {
        return fail(`Not found (HTTP 404): ${e.message}. Check the scanId/domain against list_audits.`);
      }
      return fail(`Backend error (HTTP ${e.status}): ${e.message}`);
    }
    return fail(`Error: ${(e as Error).message}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cituna] MCP server v${VERSION} ready · backend ${API_URL} · auth: ${client.describeAuth()}`);
}

main().catch((e) => {
  console.error("[cituna] fatal:", e);
  process.exit(1);
});
