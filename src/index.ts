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
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CitunaClient, CitunaApiError, type ToolApi } from "./client.js";

// Defaults to the public Cituna backend so distributed users can omit it.
// For local backend dev, set CITUNA_API_URL=http://localhost:3001.
const API_URL = process.env.CITUNA_API_URL || "https://cituna.com";
const VERSION = "1.0.0";

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
      "Return the authenticated Cituna account (email, workspaceId, role), the backend URL, your plan (Starter/Pro/Max), and — when available — the full usage meters: per-tool used/limit (scans, MCP calls, GSC reads, …) plus brand and prompt-pool counts. Use this first to confirm the connection works. Does NOT report Search Console state — call gsc_status for that. Fails with an actionable message if the API key is missing, invalid, or revoked.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_audits",
    description:
      "List recent AI-visibility audits (scans) for your workspace, newest first: scanId, domain, date, AI-citation score, on-page SEO / GEO / authority scores, open-gap count, and each audit's scoring_epoch (the score-formula version that produced it). Only compare scores between audits with the SAME scoring_epoch — across epochs the scores are re-based, so compare citation counts instead. Pass a scanId to get_audit for the full breakdown. Requires a signed-in account.",
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
      "Get one AI-visibility audit in detail by scanId (from list_audits): overall AI-citation score + SEO/GEO/authority scores, per-engine citation summary (ChatGPT/Perplexity/Gemini/Claude/Grok/Google AI Overviews), the query×engine citation matrix, competitors cited, the top prioritised gaps (title, category, impact, effort), and pass/warn/fail audit check counts. In the citation matrix every engine appears explicitly per query with one of three states: \"cited\" (the engine's answer cited the brand), \"not_cited\" (the engine answered but did not cite the brand), or \"not_run\" (the engine produced no measured answer for that query — it sat the query out or errored; NOT a miss). Bulky raw fields (page HTML, full engine answers) are omitted. Requires a signed-in account.",
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
      "Your brand's LATEST DAILY TRACKING GRID — the core Cituna deliverable. For a brand (a brand id from list_brands, OR its bare domain), returns the most recent day's per-prompt × per-engine grid: for every tracked prompt and each of the six engines (ChatGPT/Perplexity/Gemini/Claude/Grok/Google AI Overviews) whether your brand was cited, its position when cited, the engine mode that ran (live/value/lite/off), plus per-cell status (cited / answered / empty / error / notrun). Also the brand's current visibility score, its label, and the UTC day it was measured. Compact JSON, designed to be read directly. Use get_engine_answers to see what an engine actually said for a prompt. Requires a signed-in account; works on Starter and up (the free trial has no MCP access).",
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
      "The RECEIPTS behind the tracking grid. For a brand (id or domain) and one tracked prompt — optionally a single engine — returns the actual stored answer text each engine gave on the most recent day, the brands it cited, the source URLs, and whether your brand was cited and at what position. Answer text is capped (~4000 chars per engine) with a `truncated` flag. Copy the exact prompt text from get_visibility's prompts[].prompt; a prompt that isn't found returns availablePrompts to pick from. Requires a signed-in account; works on Starter and up (the free trial has no MCP access).",
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
    name: "list_keywords",
    description:
      "The keyword board for a domain: every tracked keyword with its Google position (or 'not ranking'), monthly search volume, competition, the verdict on what to do about it, and — the part that makes this actionable — whether an article for it is already queued, drafted or published. This is the join you want before writing anything: it tells you which keywords still have no page behind them. Free, reads stored data, spends no quota. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com'." },
        stage: {
          type: "string",
          description: "Optional filter on content state. 'none' is the useful one: keywords with nothing written for them yet.",
          enum: ["none", "queued", "drafted", "published", "failed"],
        },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "list_content_queue",
    description:
      "The AutoSEO content pipeline for a domain: topics waiting to be written, and the articles already generated or published, with the keyword or prompt that produced each one. Use it to see what is in flight before queueing more. Free, reads stored data. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com'." },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "queue_article",
    description:
      "Queue an article for a keyword so AutoSEO drafts it on the next run. Pass the keyword exactly as it appears in list_keywords, plus its numbers when you have them (they are kept as provenance and used to prioritise the queue). Queueing a keyword that already has a topic or article returns a duplicate notice rather than a second copy. WRITE ACTION — requires a Pro plan or higher; on Starter/trial the MCP is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain the keyword belongs to, e.g. 'acme.com'." },
        keyword: { type: "string", description: "The keyword to write about, exactly as listed by list_keywords." },
        volume: { type: "number", description: "Optional monthly search volume, for queue priority." },
        competition: { type: "number", description: "Optional competition, 0-1." },
        position: { type: "number", description: "Optional current Google position, if the site ranks at all." },
      },
      required: ["domain", "keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_article_published",
    description:
      "Tell Cituna a page for this keyword is LIVE on the site — one you wrote yourself, published from your own CMS, or produced by driving this MCP. Cituna then stops suggesting the topic, shows the keyword as published on the Keywords board, and stops offering to write a competing page for it. Use it right after you publish; pass the keyword exactly as list_keywords shows it and the page's full https URL. WRITE ACTION — requires a Pro plan or higher.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain the page belongs to, e.g. 'acme.com'." },
        keyword: { type: "string", description: "The keyword this page targets, as listed by list_keywords." },
        url: { type: "string", description: "Full https URL of the published page." },
        title: { type: "string", description: "Optional page title. Defaults to the keyword." },
      },
      required: ["domain", "keyword", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "run_scan",
    description:
      "Run an AI-visibility audit for a website and return the completed result (scores, citation matrix, competitors, top gaps). A fresh scan takes about a minute and CONSUMES ONE SCAN from your monthly quota. Two honest caveats: (1) for a domain the workspace does not already track (and with no competitors passed), the backend may answer from a recent shared measurement up to 7 days old — that replay consumes no quota and adds NO entry to list_audits; (2) a successful scan of a new domain also adds it as a tracked brand, which counts against the plan's brand cap. Optionally pass competitors to steer the comparison (this forces a fresh run). Prefer list_audits/get_audit to read an existing audit for free; use run_scan only when fresh data is needed. WRITE ACTION — requires a Pro plan or higher; on Starter/trial the MCP is read-only (run scans in the app instead).",
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
      "The authoritative Google Search Console connection check for this workspace: whether GSC OAuth is configured server-side, whether THIS workspace has connected (`connected`), the connected Google account email, and the list of verified GSC properties (site URLs / sc-domain: properties) available to query. whoami does not report GSC state — this tool is the truthful signal.",
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

// ─── Server instructions ─────────────────────────────────────────────────────
// Surfaced to the client model at initialize. This is the server-level "how to
// use me well": what is cheap, what spends money, and the one analysis shape
// (GSC × engine answers) that generic SEO tooling cannot do because it does not
// hold both datasets. Keep it tight: every token here is loaded into EVERY
// conversation that connects this server.
const INSTRUCTIONS = `Cituna tracks how six AI answer engines (ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews) mention and cite brands, and joins that with Google Search Console (GSC).

START HERE — run this once, before the first substantive answer of a conversation:
1. whoami — proves the key works and reports the plan. Starter is READ-ONLY here; the trial has no MCP access at all.
2. list_brands — what this workspace actually tracks. If it returns nothing, the workspace is empty: say so and point the user at the app to add their brand. Do NOT call run_scan to conjure one — a scan of an untracked domain silently adds a brand against their plan cap.
3. gsc_status — whoami does not cover this, and whether Google data is joined decides which of the workflows below can run.
Hold that state for the rest of the conversation instead of re-establishing it before every answer. If step 1 fails, stop and report the auth problem — every later call will fail the same way, and "API key invalid or expired" is usually a stale local dist/ or a redirect stripping the Authorization header, not a bad key.

Then route the user's ask to the matching workflow. These are registered as prompts, but do not wait to be asked: recognise the intent and run the numbered recipe yourself.
- "why don't AI engines mention/cite us", "we're invisible in ChatGPT" -> why-am-i-not-cited
- "where should we start", "what's the opportunity", "we rank on Google but not in AI" -> gsc-to-ai-gap
- "who comes up instead of us", "how do we compare to <rival>" -> competitor-teardown
- "how did this week go", "any change", a recurring check-in -> weekly-review
- "what should I fix first", "is this list in the right order" -> prioritize-fixes
- "write/fix the content for this" -> list_keywords stage "none", then queue_article; if you write and publish the page yourself, mark_article_published immediately after.
When the ask is vague ("look at our AI visibility"), run gsc-to-ai-gap when GSC is connected and why-am-i-not-cited when it is not, and say which you chose and why.

Ground rules:
- If connection state is unknown, call whoami first. whoami does NOT report Search Console state — gsc_status is the truthful signal for that.
- Read tools (list_brands, get_visibility, get_engine_answers, list_audits, get_audit, list_gaps, list_keywords, list_content_queue, gsc_status, gsc_overview, gsc_query) are cheap: prefer answering from existing data. GSC reads (gsc_overview, gsc_query) are metered but cheap; reads of stored scan data are free.
- run_scan SPENDS REAL MONEY and one scan of the monthly quota, and takes about a minute. Call it only when the user explicitly wants a fresh measurement AND list_audits has nothing recent. Never re-scan just to double-check.
- Only compare scores between audits with the same scoring_epoch (list_audits reports it); across epochs the scores are re-based, so compare citation counts instead.
- run_scan, set_gap_status, queue_article and mark_article_published need Pro or higher; on Starter this server is read-only, and the free trial has no MCP access at all.
- To fix a site's content: list_keywords with stage "none" gives the keywords that have real demand and no page behind them. queue_article puts one in AutoSEO's queue; list_content_queue shows what is already in flight. Check list_keywords before queueing so you never ask for a page that is already drafted or live.
- If you WRITE and publish a page yourself rather than queueing it, call mark_article_published straight after. Otherwise Cituna keeps the keyword as unwritten, keeps suggesting the topic, and will offer to write a second page that would compete with the one you just shipped.
- Never invent numbers. Empty rows and zero scores are real measurements (common for new domains): report them plainly.
- The highest-value analysis joins what Google sees (gsc_overview, gsc_query) with what AI engines say (get_visibility, get_engine_answers). "We rank on Google but AI never cites us" and "we are invisible to both" need different fixes.
- AI engines mostly cite third-party roundups, review sites and lists, not vendor homepages. Recommendations should include earning third-party coverage, not only on-site fixes.`;

// ─── Prompts (reusable workflows, surfaced in the client's prompt picker) ─────
// Each prompt is a worked analysis recipe over the tools above. They encode the
// joins that make the data valuable, so a user does not have to know which four
// tool calls, in which order, answer "why am I not cited". Text is interpolated
// with the user's arguments and returned as a single user message.
const PROMPTS = [
  {
    name: "why-am-i-not-cited",
    description:
      "Diagnose why AI engines do not cite a brand: joins the engine answers (who got cited instead) with GSC (does Google even rank you for that intent) and classifies each miss into a fixable bucket.",
    arguments: [
      { name: "brand", description: "Brand id (from list_brands) or bare domain, e.g. acme.com", required: true },
      { name: "prompt", description: "One tracked prompt to focus on. Omit to cover every uncited prompt.", required: false },
    ],
    text: (a: Record<string, string>) => `Diagnose why AI engines are not citing ${a.brand}${a.prompt ? ` for the prompt "${a.prompt}"` : ""}.

Work through this, calling tools as you go, and do not run a new scan:
1. get_visibility for ${a.brand}. List the prompt × engine cells that are "answered" but not cited${a.prompt ? `, focusing on "${a.prompt}"` : ""}.
2. For each uncited prompt (up to 5), call get_engine_answers and extract: which brands ARE cited, and what kind of page each citation points at (vendor site, roundup/listicle, review site, forum, docs).
3. gsc_status; if GSC is connected, gsc_query with dimensions ["query"] filtered to terms related to each uncited prompt. Note impressions and average position.
4. Classify every uncited prompt into exactly one bucket, with the evidence:
   a. INVISIBLE EVERYWHERE: no meaningful GSC impressions and no AI citations. Fix starts with content + indexation, not AEO.
   b. GOOGLE-VISIBLE, AI-INVISIBLE: real impressions/position but engines cite others. Look at WHAT they cite: if it is roundups and review sites, the fix is getting into those third-party sources; if it is competitor sites, compare page structure and citability.
   c. PARTIALLY CITED: cited by some engines, missed by others. Name the missing engines and what their answers relied on.
5. Finish with the 3 highest-leverage actions, each tied to a bucket and its evidence. Quote the engine answers where they name who was cited instead. If every cell is empty or the brand is days old, say plainly that the constraint is indexation and third-party presence, and do not dress that up.`,
  },
  {
    name: "gsc-to-ai-gap",
    description:
      "Find the queries where Google already sends impressions but AI engines never cite the brand: the ranked, evidence-based target list for AEO work.",
    arguments: [
      { name: "domain", description: "Bare domain, e.g. acme.com", required: true },
      { name: "days", description: "GSC window in days (default 28)", required: false },
    ],
    text: (a: Record<string, string>) => `Build the GSC-to-AI gap list for ${a.domain} over the last ${a.days || "28"} days.

1. gsc_status first; if GSC is not connected for ${a.domain}, stop and say so.
2. gsc_overview for ${a.domain} (days: ${a.days || "28"}). Keep the top queries by impressions.
3. get_visibility for ${a.domain}: which tracked prompts are cited, which are not.
4. Join them: for each high-impression GSC query, find the tracked prompt(s) covering the same buyer intent. Flag the queries with real impressions where the matching prompt has zero citations. Where a high-impression query has NO tracked prompt at all, list it separately as untracked intent worth adding in the app.
5. Output a ranked table: GSC query, impressions, avg position, matching tracked prompt (or "untracked"), engines citing / total. Rank by impressions.
6. Close with the top 3 intents to attack first and why, and for each, whether the evidence says the fix is on-site (structure, citability) or off-site (get into the roundups engines cite). GSC data lags about 2 days and windows are UTC; if totals are zero (new domain), report that as the finding rather than inventing targets.`,
  },
  {
    name: "competitor-teardown",
    description:
      "Who do AI engines cite instead, across every tracked prompt: tallies the actually-cited brands from the answer text and checks the configured competitor list against reality.",
    arguments: [
      { name: "brand", description: "Brand id or bare domain", required: true },
      { name: "competitor", description: "One competitor to focus on. Omit for the full field.", required: false },
    ],
    text: (a: Record<string, string>) => `Tear down the competitive field AI engines see for ${a.brand}${a.competitor ? `, focusing on ${a.competitor}` : ""}.

1. list_brands: note the CONFIGURED competitor list for ${a.brand}.
2. get_visibility for ${a.brand}, then get_engine_answers for AT MOST 3 prompts (all engines). Answer pulls are bulky, so choose the 3 highest-signal prompts from the grid: prefer category prompts (those that do not name ${a.brand}) where the most engines answered. Do not pull more than 3 even if the brand tracks many prompts — say which prompts you sampled instead.
3. From the answer text, tally every brand actually cited or recommended${a.competitor ? `, tracking ${a.competitor} explicitly` : ""}. Count per engine and overall. Quote one representative line per top rival.
4. Compare the tally against the configured competitor list:
   - Brands the engines cite that are MISSING from the configured list (these are the real rivals).
   - Configured competitors the engines never mention (benchmarking against them measures the wrong race).
5. Note WHERE the citations point (roundups, review sites, vendor pages): that is the distribution channel to attack.
6. Finish with: the top 3 actually-cited rivals with counts, the configured-list corrections to make in the app, and the single highest-leverage move the evidence supports. Use only what the tools returned; if answers are sparse, say so.`,
  },
  {
    name: "weekly-review",
    description:
      "The Monday-morning readout: visibility deltas, GSC trend, gap-queue movement, and the 3 actions for the week. Reads only, never scans.",
    arguments: [
      { name: "brand", description: "Brand id or bare domain", required: true },
    ],
    text: (a: Record<string, string>) => `Give me the weekly AI-visibility review for ${a.brand}. Reads only: do not call run_scan.

1. get_visibility for ${a.brand}: current score and the prompt × engine grid.
2. list_audits: compare the two most recent audits for ${a.brand}. Check scoring_epoch FIRST: only report score deltas between audits with the SAME scoring_epoch. When the epochs differ, say the scores were re-based (formula change, not performance) and compare citation counts (engines citing / total) instead. Same-epoch: deltas in overall, SEO and GEO scores; either way note any engine that flipped between cited and uncited.
3. gsc_status; if connected, gsc_overview (days: 7) and compare clicks/impressions against the prior week if the series allows.
4. list_gaps for ${a.brand}: what moved to done, what is stuck in todo.
5. Format as: WINS (with numbers), REGRESSIONS (with numbers), NO-CHANGE (one line), then THIS WEEK: the 3 most valuable actions, each grounded in something above. If nothing changed, say the week was flat rather than manufacturing movement. Close by listing any engine cells in "error" state so the user knows measurement coverage, not just performance.`,
  },
  {
    name: "prioritize-fixes",
    description:
      "Re-rank the gap/fix queue by evidence instead of static severity: weight each gap by the GSC impressions and uncited prompts it touches.",
    arguments: [
      { name: "domain", description: "Bare domain whose newest audit's gaps to prioritise", required: true },
    ],
    text: (a: Record<string, string>) => `Prioritise the fix queue for ${a.domain} by expected impact, not by the default severity order.

1. list_gaps for ${a.domain} (skip gaps already done).
2. get_visibility for ${a.domain}: the uncited prompts.
3. gsc_status; if connected, gsc_query (dimensions ["query"], rowLimit 50) for ${a.domain}. Rows come back ranked by clicks; read the impressions column per row rather than assuming any impression ordering.
4. For each open gap, estimate impact: how many uncited prompts does it plausibly move, and how many GSC impressions ride on the intents it touches? Be explicit about which mapping is evidence and which is judgement.
5. Output the re-ranked queue: gap, current status, effort (from the gap data), impact rationale in one line each. Where the evidence says a gap is low-impact busywork, say so.
6. End with the single next action. If the user confirms they want statuses updated to reflect this plan, use set_gap_status (needs Pro; leave statuses untouched otherwise).`,
  },
];

// ─── Server wiring ───────────────────────────────────────────────────────────
const server = new Server(
  { name: "cituna", version: VERSION },
  { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS.find((x) => x.name === req.params.name);
  if (!p) throw new Error(`Unknown prompt: ${req.params.name}. Available: ${PROMPTS.map((x) => x.name).join(", ")}`);
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.params.arguments ?? {})) args[k] = String(v ?? "").trim();
  for (const spec of p.arguments) {
    if (spec.required && !args[spec.name]) {
      throw new Error(`Prompt "${p.name}" needs the "${spec.name}" argument: ${spec.description}`);
    }
  }
  return {
    description: p.description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args) } }],
  };
});

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

// null = no checks ran at all (audit section absent/empty) — the caller omits the
// block entirely, so "we did not check" can never read as "0 passed, 0 failed".
function summarizeChecks(checks: any): { pass: number; warn: number; fail: number } | null {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const out = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (c?.status === "pass") out.pass++;
    else if (c?.status === "warn") out.warn++;
    else if (c?.status === "fail") out.fail++;
  }
  return out;
}

// query × engine citation matrix from stage1.citations[] (engine, query,
// customer_cited, error). EVERY engine key is emitted explicitly per row with a
// three-state string, so an LLM reader can never conflate a missing key with a
// miss (the old sparse shape made "engine never ran" look like "not cited"):
//   "cited"     — the engine's answer cited the brand for this query
//   "not_cited" — the engine answered but did not cite the brand
//   "not_run"   — no measured answer exists for this engine+query: either stage1
//                 emitted no citation row (the engine sat the query out — the same
//                 absence visibility.ts cellStatus reads as "notrun") or the row
//                 carries an error (the run failed, so nothing was measured)
type MatrixCell = "cited" | "not_cited" | "not_run";
function citationMatrix(stage1: any) {
  const citations = Array.isArray(stage1?.citations) ? stage1.citations : [];
  const engines: string[] = Array.isArray(stage1?.per_engine) ? stage1.per_engine.map((e: any) => String(e.engine)) : [];
  const blankRow = (): Record<string, MatrixCell> => {
    const row: Record<string, MatrixCell> = {};
    for (const e of engines) row[e] = "not_run";
    return row;
  };
  const rowByQuery = new Map<string, Record<string, MatrixCell>>();
  for (const q of Array.isArray(stage1?.queries) ? stage1.queries : []) rowByQuery.set(String(q), blankRow());
  for (const c of citations) {
    if (!c || !c.query) continue;
    const q = String(c.query);
    if (!rowByQuery.has(q)) rowByQuery.set(q, blankRow());
    if (!c.error) rowByQuery.get(q)![String(c.engine)] = c.customer_cited ? "cited" : "not_cited";
  }
  return {
    engines,
    cell_states: ["cited", "not_cited", "not_run"],
    rows: [...rowByQuery.entries()].map(([query, cells]) => ({ query, cells })),
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
  // Prefer the explicit scanId (get_audit knows it); otherwise surface one the
  // payload itself carries (a fresh run_scan result), so get_audit chaining works.
  const sid = scanId ?? (r.scanId ? String(r.scanId) : r._id ? String(r._id) : undefined);
  const auditChecks: Record<string, { pass: number; warn: number; fail: number }> = {};
  const seoChecks = summarizeChecks(audit.seo?.checks);
  if (seoChecks) auditChecks.seo = seoChecks;
  const geoChecks = summarizeChecks(audit.geo?.checks);
  if (geoChecks) auditChecks.geo = geoChecks;
  return {
    ...(sid ? { scanId: sid } : {}),
    domain: r.domain ?? null,
    url: r.url ?? null,
    overall: {
      ai_citation_score: r.score ?? null,
      score_label: r.score_label ?? null,
      seo_score: audit.seo?.score ?? null,
      geo_score: audit.geo?.score ?? null,
      authority_score: audit.authority?.measured ? audit.authority.score : null, // null unless actually measured — matches db + list_audits
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
    // Only sections whose checks actually ran; absent ⇒ not checked, not "all zero".
    ...(Object.keys(auditChecks).length ? { audit_checks: auditChecks } : {}),
    patterns_observed: Array.isArray(stage1.patterns_observed) ? stage1.patterns_observed.slice(0, 10) : [],
  };
}

// Resolve a full scan result from either an explicit scanId or a domain's newest
// audit. Returns { result, domain } or null when nothing is found. `api` is the
// per-tool client view so the calls are attributed to the calling tool.
async function resolveScan(api: ToolApi, scanId: string, domain: string): Promise<{ result: any; domain: string } | null> {
  if (scanId) {
    const data = await api.get(`/api/scan/${encodeURIComponent(scanId)}`);
    const result = data?.result;
    if (!result) return null;
    return { result, domain: normDomain(domain || result.domain || "") };
  }
  const dom = normDomain(domain);
  if (!dom) return null;
  const hist = await api.get(`/api/history/${encodeURIComponent(dom)}`);
  const scans = Array.isArray(hist?.scans) ? hist.scans : [];
  const newest = scans[scans.length - 1]; // domainHistory returns oldest→newest
  if (!newest?._id) return null;
  const data = await api.get(`/api/scan/${encodeURIComponent(String(newest._id))}`);
  const result = data?.result;
  if (!result) return null;
  return { result, domain: dom };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  // A per-call client view: every backend call this handler makes carries
  // X-Cituna-Mcp-Tool so the backend can apply the read/write plan split (write
  // tools are Pro+). Bound per call — never shared mutable state — so concurrent
  // tool calls cannot stamp each other's requests.
  const api = client.forTool(name);

  // Every tool needs a credential. Short-circuit with a clean, actionable error
  // (rather than a stack trace) when none is configured — so `tools/list` still
  // works but calls tell the user exactly what to do.
  if (!client.hasCredentials()) {
    // For npm-first users this error IS the onboarding: it must route people
    // with no account at all (sign up), not only people who lost their key.
    return fail(
      "No API key configured. Existing account: in the app, Integrations → \"Claude / MCP access\" → Generate token, then set CITUNA_API_KEY (cituna_sk_…). No account yet: start at https://cituna.com/signup (the MCP needs a paid plan; the trial is app-only).",
    );
  }

  try {
    switch (name) {
      case "whoami": {
        const me = await api.get("/api/auth/me");
        const user = me?.user ?? null;
        // The backend returns HTTP 200 {user:null} when the credential doesn't
        // resolve — treat that as a FAILURE so Claude doesn't report a phantom
        // "connected" state. API keys never expire, so an unresolved key means it
        // was revoked / mistyped, or the account was suspended or removed.
        if (!user) {
          return fail(
            "API key invalid, revoked, or the account no longer has access — mint a new key in the app: Integrations → Claude / MCP access, then set CITUNA_API_KEY.",
          );
        }
        // Usage comes from /api/me/usage, the add-on-aware meters endpoint: per-tool
        // used/limit (including the mcp and gsc meters) plus brand + prompt-pool
        // counts. auth/me's own usage block lacks those meters. Non-fatal: whoami
        // must still confirm the connection if the meters read hiccups.
        let usage: unknown;
        try { usage = await api.get("/api/me/usage"); } catch { usage = undefined; }
        const plan = me.plan ?? user.plan ?? undefined;
        // NOTE: no gsc_connected field here, deliberately. auth/me's `google` flag
        // is the server-wide OAuth env check, NOT this workspace's Search Console
        // connection — reporting it here shipped a fabricated value. gsc_status is
        // the truthful, workspace-scoped signal.
        return ok({
          backend: API_URL,
          auth: client.describeAuth(),
          email: user.email ?? null,
          workspaceId: user.workspaceId ?? null,
          role: user.role ?? null,
          isFounder: !!me.isFounder,
          ...(plan ? { plan } : {}),
          ...(usage ? { usage } : {}),
          note: "Search Console connection state is not reported here — call gsc_status for that.",
        });
      }

      case "list_audits": {
        const data = await api.get("/api/history");
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
            // Which score-formula version produced `ai_citation_score`. null = a
            // scan from before epochs existed. Scores are only comparable between
            // audits with the SAME epoch; across epochs compare citation counts.
            scoring_epoch: s.scoringEpoch ?? null,
          }));
        return ok({ configured: !!data?.configured, count: audits.length, audits });
      }

      case "get_audit": {
        const scanId = String(args.scanId ?? "").trim();
        if (!scanId) return fail("`scanId` is required — get one from list_audits.");
        const data = await api.get(`/api/scan/${encodeURIComponent(scanId)}`);
        if (!data?.result) return fail(`No audit found for scanId ${scanId} (or it belongs to another workspace).`);
        return ok(trimAudit(data.result, scanId));
      }

      case "get_visibility": {
        const brand = String(args.brand ?? "").trim();
        if (!brand) return fail("`brand` is required — a brand id (from list_brands) or a domain like 'acme.com'.");
        return ok(await api.get("/api/visibility", { brand }));
      }

      case "get_engine_answers": {
        const brand = String(args.brand ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!brand) return fail("`brand` is required — a brand id (from list_brands) or a domain like 'acme.com'.");
        if (!prompt) return fail("`prompt` is required — the exact tracked prompt text (see get_visibility).");
        const engine = String(args.engine ?? "").trim();
        return ok(await api.get("/api/engine-answers", { brand, prompt, engine: engine || undefined }));
      }

      case "list_keywords": {
        const domain = normDomain(String(args.domain ?? "").trim());
        if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
        const snap = await api.get("/api/seo/snapshots", { domain });
        // The keyword board is assembled from two stored sources: the volume
        // pull and the position checks. Neither alone is the whole set.
        const rows = new Map<string, any>();
        const put = (kw: unknown, patch: Record<string, unknown>) => {
          const k = String(kw ?? "").trim();
          if (!k) return;
          rows.set(k.toLowerCase(), { keyword: k, ...(rows.get(k.toLowerCase()) ?? {}), ...patch });
        };
        for (const it of snap?.keywords?.data?.items ?? []) {
          put(it?.keyword, {
            searchVolume: it?.searchVolume ?? null,
            competition: it?.competition ?? null,
            cpc: it?.cpc ?? null,
          });
        }
        for (const r of Array.isArray(snap?.rank) ? snap.rank : []) {
          // position null after a check means measured-and-absent, which is a
          // real answer, not a missing one.
          put(r?.keyword, { position: r?.position ?? null, positionChecked: true, url: r?.url ?? null });
        }
        const keywords = [...rows.values()];
        if (!keywords.length) {
          return ok({ domain, count: 0, keywords: [], message: "No keywords tracked for this domain yet. Add them on the Keywords screen." });
        }
        const stateRes = await api.post("/api/seo/keyword-state", { domain, keywords: keywords.map((k) => k.keyword) });
        const states = stateRes?.states ?? {};
        const wantStage = String(args.stage ?? "").trim();
        const merged = keywords
          .map((k) => ({
            ...k,
            position: k.position ?? null,
            ranking: k.positionChecked ? (k.position == null ? "not in top 20" : `#${k.position}`) : "not checked",
            content: states[k.keyword] ?? { stage: "none" },
          }))
          .filter((k) => !wantStage || k.content.stage === wantStage);
        return ok({
          domain,
          count: merged.length,
          filteredBy: wantStage || null,
          keywords: merged,
          note: "`content.stage` is none | queued | drafted | published | failed. Keywords at 'none' with real volume and no ranking are the ones missing a page.",
        });
      }

      case "list_content_queue": {
        const domain = normDomain(String(args.domain ?? "").trim());
        if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
        const d = await api.get("/api/autoseo", { domain });
        return ok({
          domain,
          enabled: d?.settings?.enabled ?? false,
          destination: d?.settings?.destination ?? null,
          destinationConnected: d?.destinationConnected ?? null,
          nextAutoRun: d?.nextAutoRun ?? null,
          queued: d?.queue ?? [],
          articles: d?.history ?? [],
        });
      }

      case "queue_article": {
        const domain = normDomain(String(args.domain ?? "").trim());
        const keyword = String(args.keyword ?? "").trim();
        if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
        if (!keyword) return fail("`keyword` is required — the keyword to write about, as listed by list_keywords.");
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        try {
          const r = await api.post("/api/autoseo/queue", {
            domain,
            source: "keyword",
            keyword: { text: keyword, volume: num(args.volume), competition: num(args.competition), position: num(args.position) },
          });
          return ok({ queued: true, id: r?.id ?? null, domain, keyword });
        } catch (e: any) {
          // A duplicate is the user's intent already satisfied, not a failure.
          if (e?.status === 409) {
            return ok({ queued: false, duplicate: true, domain, keyword, message: "That keyword already has a queued topic or a written article. See list_keywords." });
          }
          throw e;
        }
      }

      case "mark_article_published": {
        const domain = normDomain(String(args.domain ?? "").trim());
        const keyword = String(args.keyword ?? "").trim();
        const url = String(args.url ?? "").trim();
        if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
        if (!keyword) return fail("`keyword` is required — the keyword this page targets, as listed by list_keywords.");
        if (!/^https?:\/\//i.test(url)) return fail("`url` must be the published page's full https address.");
        const r = await api.post("/api/autoseo/published", { domain, keyword, url, title: String(args.title ?? "").trim() || undefined });
        return ok({ recorded: true, domain, keyword, url, id: r?.id ?? null });
      }

      case "list_gaps": {
        const scanId = String(args.scanId ?? "").trim();
        const domainArg = String(args.domain ?? "").trim();
        if (!scanId && !domainArg) return fail("Provide `scanId` (from list_audits) or `domain`.");
        const resolved = await resolveScan(api, scanId, domainArg);
        if (!resolved) {
          return ok({
            domain: normDomain(domainArg),
            count: 0,
            gaps: [],
            message: "No saved audit found — run_scan first, or pass a scanId from list_audits.",
          });
        }
        const { result, domain } = resolved;
        const statusRes = await api.get("/api/gap-status", { domain });
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
        // The backend now validates the write (the domain must be a brand this
        // workspace tracks; the status must be a known value) — a rejection throws
        // CitunaApiError and is surfaced by the error mapper below, so success here
        // really means the status was stored.
        const saved = await api.post("/api/gap-status", { domain, gapKey: key, status });
        if (saved && typeof saved === "object" && (saved as any).ok === false) {
          return fail(String((saved as any).error || "The backend rejected this gap-status update."));
        }
        return ok({ ok: true, domain, gapKey: key, status });
      }

      case "run_scan": {
        const url = String(args.url ?? "").trim();
        if (!url) return fail("`url` is required, e.g. 'acme.com'.");
        const competitors = Array.isArray(args.competitors)
          ? args.competitors.map((s: any) => String(s).trim()).filter(Boolean).slice(0, 8)
          : undefined;
        const { result, progress } = await api.runScanStream(
          { url, ...(competitors && competitors.length ? { competitors } : {}) },
          { timeoutMs: 300000 },
        );
        return ok({ ...trimAudit(result), progress_stages: progress });
      }

      case "gsc_status": {
        return ok(await api.get("/api/integrations/gsc/status"));
      }
      case "list_brands": {
        return ok(await api.get("/api/projects"));
      }
      case "gsc_overview": {
        const domain = String(args.domain ?? "").trim();
        if (!domain) return fail("`domain` is required, e.g. 'example.com'.");
        const days = args.days != null ? Number(args.days) : undefined;
        return ok(await api.get("/api/integrations/gsc/data", { domain, days }));
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
        const res = await api.post("/api/integrations/gsc/query", payload);
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
        // API keys never expire — a 401 on a key means revoked/mistyped, or the
        // account was suspended or removed. Session JWTs (CITUNA_TOKEN) DO expire.
        return fail(
          "Authentication failed (HTTP 401) — the API key is invalid or was revoked, the session token expired, or the account no longer has access. Mint a new key in the app: Integrations → Claude / MCP access, then set CITUNA_API_KEY.",
        );
      }
      if (e.status === 402) {
        const body = (e.body ?? {}) as any;
        const requires = Array.isArray(body?.requires) ? body.requires : [];
        // The backend's 402 bodies carry a customer-safe `error` naming the REAL
        // condition (monthly cap vs trial wall vs the Pro write gate). Prefer that
        // text; the generic copy below is only the fallback for a bare body.
        const backendMsg = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "";
        if (body?.reason === "mcp_write_pro") {
          return fail(
            backendMsg
              ? `${backendMsg} Upgrade at https://cituna.com/pricing`
              : `${name} is a write action — it needs the ${displayPlans(requires)} plan. On Starter/trial the MCP is read-only (you can still read audits, gaps and Search Console data, and run scans in the app). Upgrade at https://cituna.com/pricing`,
          );
        }
        if (backendMsg) {
          return fail(backendMsg.includes("/pricing") ? backendMsg : `${backendMsg} Upgrade at https://cituna.com/pricing`);
        }
        return fail(
          `This requires a paid plan (${displayPlans(requires)}) — upgrade at https://cituna.com/pricing`,
        );
      }
      if (e.status === 429) {
        // 429 is the burst/abuse ceiling (requests starting too fast, or a daily
        // hard cap) — NOT the monthly plan quota, which arrives as a 402 with the
        // plan-limit message. Waiting fixes a 429; upgrading fixes a 402.
        const body = (e.body ?? {}) as any;
        const retry = Number(body?.retryAfterSec);
        return fail(
          `Rate limited (HTTP 429): ${e.message}${Number.isFinite(retry) && retry > 0 ? ` Retry in about ${Math.ceil(retry)}s.` : ""}`,
        );
      }
      if (e.status === 404) {
        return fail(`Not found (HTTP 404): ${e.message}. Check the scanId/domain against list_audits.`);
      }
      if (e.status === 400) {
        return fail(`Invalid request (HTTP 400): ${e.message}`);
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
