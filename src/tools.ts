// ─── Cituna — MCP tool layer (transport-agnostic) ─────────────────────────────
// Every tool definition, prompt, helper and dispatch branch lives here, with NO
// knowledge of how bytes reach the client. Two entrypoints consume it:
//
//   • src/index.ts — stdio, for Claude Desktop / Claude Code / any local client.
//     This is what ships as the `cituna-mcp` npm package.
//   • src/http.ts  — Streamable HTTP, for claude.ai Connectors and any remote
//     client. Deployed as a service; auth arrives per-request, not from env.
//
// The split exists so those two can never drift: a tool description is product
// surface, and maintaining two copies of it is how the local and remote servers
// end up describing different products. Nothing in this file reads process.env
// or touches a transport — callers construct the client and pass it in.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CitunaClient, CitunaApiError, type ToolApi } from "./client.js";

export const VERSION = "1.5.0";

// ─── Tool definitions (JSON Schema — the low-level, version-stable MCP API) ───
const GSC_DIMENSIONS = ["query", "page", "country", "device", "searchAppearance", "date"];
const FILTER_OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"];
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];
const GAP_STATES = ["todo", "doing", "done"];

const TOOL_DEFS = [
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
      "The keyword board for a domain: every tracked keyword with its Google position, monthly search volume, competition, and — the part that makes this actionable — whether an article for it is already queued, drafted or published. This is the join you want before writing anything: it tells you which keywords still have no page behind them. Positions come from two sources and each row says which: the rank checker (a live SERP read, but it only sees the top 20) and Search Console (a 28-day average, no top-20 cliff, ground truth for your own pages). That second source is what stops every keyword past #20 collapsing into one indistinguishable 'not in top 20' — with it, #75 and #95 are told apart, and moving #75 to #40 is visible progress instead of no change at all. The Search Console join costs one metered read; pass includeSearchConsole:false to skip it and keep the call free. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com'." },
        stage: {
          type: "string",
          description: "Optional filter on content state. 'none' is the useful one: keywords with nothing written for them yet.",
          enum: ["none", "queued", "drafted", "published", "failed"],
        },
        includeSearchConsole: {
          type: "boolean",
          description: "Attach the 28-day Search Console position/impressions/clicks per keyword. Default true. Costs one metered GSC read; set false to keep this call free. Degrades silently when Search Console is not connected.",
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
      "Queue an article for a keyword so AutoSEO drafts it on the next run. Pass the keyword exactly as it appears in list_keywords, plus its evidence when you have it — `impressions` (from Search Console, as list_keywords reports) and `position` are what actually rank the queue now; volume/competition are legacy provenance from bought metrics and are usually absent. Queueing a keyword that already has a topic or article returns a duplicate notice rather than a second copy. WRITE ACTION — requires a Pro plan or higher; on Starter/trial the MCP is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain the keyword belongs to, e.g. 'acme.com'." },
        keyword: { type: "string", description: "The keyword to write about, exactly as listed by list_keywords." },
        impressions: { type: "number", description: "Search Console impressions for this query (list_keywords reports them). The primary queue-priority signal." },
        position: { type: "number", description: "Current Google position, if the site ranks at all. Deep positions with real impressions rank the queue highest." },
        volume: { type: "number", description: "Legacy: monthly search volume, if you have a bought figure. Impressions are preferred." },
        competition: { type: "number", description: "Legacy: competition 0-1, paired with volume." },
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
    name: "competitor_discovery",
    description:
      "Rivals showing up in YOUR data that you are not tracking. Cross-references two sources you already have against your tracked competitor list: the brands the six engines named while answering your prompts (from your latest audit) and the vendor-shaped terms people search before landing on you (from Search Console). Anything appearing in either and missing from the list comes back ranked by how much evidence there is, with where it was seen. Worth running monthly: a competitor list goes stale silently, and the first sign a new rival matters is usually that an engine starts naming them in answers to your own buyer questions. Free, reads stored data plus one Search Console read. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com'." },
        days: { type: "integer", description: "Search Console window for query evidence. Default 90.", minimum: 1, maximum: 480 },
        minEvidence: { type: "integer", description: "Ignore candidates below this combined evidence score. Default 2.", minimum: 1 },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "gsc_cannibalisation",
    description:
      "Queries where two or more of your OWN pages compete for the same search. Google picks one URL per query, so when several of your pages qualify it splits the signal between them and often ranks the wrong one: two pages at position 60 instead of one at 30. Returns each affected query with every competing page, its position and impressions, which page Google favours, and the impression split. The usual fix is to pick the canonical target, make the others support it, and internally link accordingly. Cheap to run and one of the few SEO problems where the fix is free, because you already have the content. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'example.com'. Provide this OR siteUrl." },
        siteUrl: { type: "string", description: "Exact GSC property. Optional." },
        days: { type: "integer", description: "Trailing window in days (1-480). Default 28.", minimum: 1, maximum: 480 },
        minImpressions: { type: "integer", description: "Ignore queries below this many total impressions. Default 5.", minimum: 1 },
        limit: { type: "integer", description: "Max queries returned. Default 50.", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_citation_sources",
    description:
      "WHERE AI ANSWERS ABOUT YOUR CATEGORY ACTUALLY COME FROM, and whether you are really on those pages. Walks your recent scans and rolls up every third-party host the six engines cited when answering your tracked prompts: how often it was cited, which rival brands the engines associate with it, which of your prompts it answers, and sample URLs. Then — the field that matters most — `youOnThisSite`, which is not inferred from the answers but comes from OPENING those pages and reading them: 'absent' means we read the page in full and your brand is not on it (that is the citation gap, `isGap: true`), 'mentioned' means you are named with no link back, 'linked' means the page links to you, 'unreachable' means the site refused an automated read, and 'unknown' means it has not been read yet. The last two are NOT evidence of absence and must never be reported as gaps. Rival-owned and engine-owned domains are excluded, because a mention on a competitor's own blog or in a search vendor's docs is not an opportunity. Also returns the pages of yours engines DO cite, so you can see what is already working. This is usually the highest-leverage list in the product and the one that explains a citation score that will not move: improving your own page is a different job from being present in the pages engines already read. Free, reads stored scan and page-check data. Requires a signed-in account.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'acme.com'." },
        gapsOnly: {
          type: "boolean",
          description: "Only VERIFIED gaps — hosts whose cited pages we read in full and your brand was not on them (`youOnThisSite: 'absent'`). Excludes hosts not yet read, so this can under-report early on. Default false, which returns every target ranked gaps-first.",
        },
        limit: { type: "integer", description: "Max targets returned. Default 25.", minimum: 1, maximum: 100 },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "set_outreach_status",
    description:
      "Record where you have got to with one citation-source host: mark it todo, doing or done as you pitch, get listed, or rule it out. Statuses are stored per workspace per domain and come back on every list_citation_sources call, so the outreach list survives across sessions instead of living in someone's head. Use the exact `host` string from list_citation_sources. Needs Pro or higher: on Starter the MCP is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain the target belongs to, e.g. 'acme.com'." },
        host: { type: "string", description: "The target host exactly as list_citation_sources returned it, e.g. 'frase.io'." },
        status: { type: "string", description: "Where this target stands.", enum: GAP_STATES },
      },
      required: ["domain", "host", "status"],
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
    name: "gsc_striking_distance",
    description:
      "The queries worth working on THIS week: everything ranking just off page one, ranked by how much traffic a realistic move would unlock. Returns each query with its position, impressions, the page that ranks for it, and a `priority` score (impressions weighted by how close to page one it already is — a ranking heuristic for ordering the list, NOT a traffic forecast). Position 11-60 by default: above 11 is already page one, below 60 is rarely reachable without new authority. This is the report to open before deciding what to write or rewrite — it is the difference between improving a page that can move and rewriting one that cannot. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'example.com'. Provide this OR siteUrl." },
        siteUrl: { type: "string", description: "Exact GSC property, e.g. 'sc-domain:example.com'. Optional." },
        days: { type: "integer", description: "Trailing window in days (1-480). Default 28.", minimum: 1, maximum: 480 },
        minPosition: { type: "number", description: "Lower bound of the band. Default 11 (just off page one).", minimum: 1 },
        maxPosition: { type: "number", description: "Upper bound. Default 60 — past this, position is an authority problem, not a content one.", minimum: 1 },
        minImpressions: { type: "integer", description: "Ignore queries below this many impressions. Default 1.", minimum: 0 },
        limit: { type: "integer", description: "Max rows returned. Default 50.", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gsc_zero_click_pages",
    description:
      "Pages Google shows and nobody clicks — impressions above a floor with zero (or near-zero) clicks, split by CAUSE, because the two causes need opposite fixes. `ranking` (average position beyond ~15) means the page is too far down to be clicked and needs authority or a rewrite. `snippet` (ranking well but not being clicked) means the page IS reachable and the title/meta description is losing the click — a much cheaper fix. Sorted by wasted impressions. This finds the single most common expensive miss in a content library: the page that earns the most impressions on the whole site and converts none of them. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'example.com'. Provide this OR siteUrl." },
        siteUrl: { type: "string", description: "Exact GSC property. Optional." },
        days: { type: "integer", description: "Trailing window in days (1-480). Default 28.", minimum: 1, maximum: 480 },
        minImpressions: { type: "integer", description: "Impression floor for a page to count. Default 25.", minimum: 1 },
        maxClicks: { type: "integer", description: "Treat a page as zero-click at or below this many clicks. Default 0.", minimum: 0 },
        limit: { type: "integer", description: "Max rows returned. Default 50.", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gsc_query_mix",
    description:
      "What KIND of demand a domain actually earns, bucketed by intent: brand, competitor-alternative, persona-qualified, commercial, tool-intent, how-to, category. Per bucket: query count, impressions, share of total, clicks, and average position. Use it to answer 'what are we actually visible for, and is that the demand we want?' — a domain can look healthy on totals while every impression sits in one bucket at position 90. The persona-qualified bucket (role-prefixed conversational queries like \"i'm a brand manager, X vs Y for a small team\") is worth reading closely: these behave nothing like their head terms and usually rank far better, because the long tail is less contested. Also reports the anonymized-click reconciliation — GSC withholds low-volume queries, so named rows routinely account for well under the site's real click total. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'example.com'. Provide this OR siteUrl." },
        siteUrl: { type: "string", description: "Exact GSC property. Optional." },
        days: { type: "integer", description: "Trailing window in days (1-480). Default 28.", minimum: 1, maximum: 480 },
        competitors: {
          type: "array",
          description: "Competitor names to treat as competitor-intent even without an 'alternative/vs' word. Defaults to the brand's tracked competitors.",
          items: { type: "string" },
        },
        examplesPerBucket: { type: "integer", description: "Sample queries to include per bucket. Default 5, 0 to omit.", minimum: 0, maximum: 25 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gsc_coverage_gap",
    description:
      "Which published pages Google has never shown anyone. Reads the domain's sitemap, compares it against every page that earned at least one impression in the window, and returns the silent ones grouped by URL prefix so a whole dead section is obvious at a glance. This is usually the fastest 'here is what is wrong' a site can get: a library where half the URLs have never surfaced is not a ranking problem, it is pages published against demand that was never verified. Note the two causes it CANNOT separate — never indexed, versus indexed but never competitive. Confirm the difference with URL Inspection in Search Console before acting. Fetches the sitemap over HTTP from the domain itself. Requires a paid plan (Starter+).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Bare domain, e.g. 'example.com'. Its public sitemap is fetched over HTTP." },
        days: { type: "integer", description: "Window for 'earned an impression'. Default 90 — use the widest window the property has.", minimum: 1, maximum: 480 },
        limit: { type: "integer", description: "Max silent URLs listed. Default 100 (counts are always complete).", minimum: 1, maximum: 2000 },
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

// ─── Tool annotations ────────────────────────────────────────────────────────
// Required by the Anthropic Connectors Directory: every tool needs a `title` and
// the applicable readOnlyHint / destructiveHint. They are also just good manners
// — a client that knows which tools are safe can offer to auto-approve reads
// while still confirming a scan that spends the user's money.
//
// ONE table, not sixteen inline blocks, because the property that matters is
// consistency with the backend: `WRITE_TOOLS` below MUST equal
// api/src/usage.ts MCP_WRITE_TOOLS, which is what actually enforces the Pro
// gate. src/annotations.test.ts reads that file and fails if the two drift, so
// a tool cannot end up advertised as read-only while the backend bills it as a
// write (or vice versa, which would be worse: a write silently presented as
// safe to auto-approve).
const WRITE_TOOLS = new Set(["set_gap_status", "run_scan", "queue_article", "mark_article_published", "set_outreach_status"]);

const TITLES: Record<string, string> = {
  whoami: "Check connection and plan",
  list_audits: "List audits",
  get_audit: "Get audit detail",
  get_visibility: "Get daily tracking grid",
  get_engine_answers: "Get engine answers",
  list_gaps: "List the fix queue",
  set_gap_status: "Update a gap's status",
  list_keywords: "List keywords",
  list_content_queue: "List the content queue",
  queue_article: "Queue an article",
  mark_article_published: "Mark an article published",
  run_scan: "Run a visibility scan",
  competitor_discovery: "Find rivals you are not tracking",
  gsc_cannibalisation: "Find pages competing with each other",
  list_citation_sources: "Find where AI answers come from",
  set_outreach_status: "Update an outreach target",
  gsc_status: "Check Search Console connection",
  list_brands: "List tracked brands",
  gsc_overview: "Search Console overview",
  gsc_query: "Search Console query",
  gsc_striking_distance: "Find near-page-one queries",
  gsc_zero_click_pages: "Find pages that earn no clicks",
  gsc_query_mix: "Break demand down by intent",
  gsc_coverage_gap: "Find pages Google never shows",
};

// Reaches a third party live (Google, or the six answer engines) rather than
// reading data Cituna already stored. Everything else answers from our own DB.
// gsc_coverage_gap also fetches the customer's own sitemap over HTTP.
const OPEN_WORLD = new Set([
  "run_scan",
  "gsc_status",
  "gsc_overview",
  "gsc_query",
  "gsc_striking_distance",
  "gsc_zero_click_pages",
  "gsc_query_mix",
  "gsc_coverage_gap",
  "gsc_cannibalisation",
  "competitor_discovery",
]);

// run_scan is the one write that is NOT idempotent: every call spends another
// scan from the monthly quota and produces a new audit. The other three
// converge — re-queueing a keyword returns a duplicate notice, and setting a
// status or a published URL twice lands in the same state.
const NON_IDEMPOTENT = new Set(["run_scan"]);

export const TOOLS = TOOL_DEFS.map((t) => {
  const isWrite = WRITE_TOOLS.has(t.name);
  return {
    ...t,
    annotations: {
      title: TITLES[t.name] ?? t.name,
      readOnlyHint: !isWrite,
      // No tool here deletes or overwrites user data: the writes add a queue
      // entry, move a status, or record a URL. Claiming otherwise would train
      // clients to warn about the wrong things.
      destructiveHint: false,
      idempotentHint: isWrite ? !NON_IDEMPOTENT.has(t.name) : true,
      openWorldHint: OPEN_WORLD.has(t.name),
    },
  };
});

/** Exported for the drift test in src/annotations.test.ts. */
export const ANNOTATION_WRITE_TOOLS: ReadonlySet<string> = WRITE_TOOLS;

// ─── Server instructions ─────────────────────────────────────────────────────
// Surfaced to the client model at initialize. This is the server-level "how to
// use me well": what is cheap, what spends money, and the one analysis shape
// (GSC × engine answers) that generic SEO tooling cannot do because it does not
// hold both datasets. Keep it tight: every token here is loaded into EVERY
// conversation that connects this server.
export const INSTRUCTIONS = `Cituna tracks how six AI answer engines (ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews) mention and cite brands, and joins that with Google Search Console (GSC).

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
- Read tools (list_brands, get_visibility, get_engine_answers, list_audits, get_audit, list_gaps, list_keywords, list_content_queue, list_citation_sources, gsc_status, gsc_overview, gsc_query, gsc_striking_distance, gsc_zero_click_pages, gsc_query_mix, gsc_coverage_gap, gsc_cannibalisation, competitor_discovery) are cheap: prefer answering from existing data. GSC reads are metered but cheap; reads of stored scan data are free.
- Prefer the ANALYSIS tools over hand-rolling the same fold from gsc_query: gsc_striking_distance (what is close enough to move), gsc_zero_click_pages (what is seen and not clicked, split by cause), gsc_query_mix (what kind of demand this is), gsc_coverage_gap (what was published and never shown). Each answers in one call a question that otherwise takes several gsc_query calls plus arithmetic.
- ALWAYS read the 'history' block these tools return before quoting an average position. A 90-day window over a two-week-old property is not a 90-day measurement, and windowTruncated:true is the flag that says so. Young properties sit deep in the results because Google barely knows them — that is not a content defect and must not be reported as one.
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
export const PROMPTS = [
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

// Stable per-gap key — MUST match the frontend (frontend/lib/gapStatus.js) and
// api/src/nextMoves.ts so a status set here shows up in the app and vice-versa:
// `category-title` slug with the audit status verb ("Fix:"/"Improve:") stripped
// first — a check moving fail↔warn is the same task, and the verb in the key
// orphaned its status on every transition (2026-08-04).
function gapKey(gap: any, idx: number): string {
  const title = String(gap?.title ?? "").replace(/^\s*(?:fix|improve):\s*/i, "");
  const base = `${gap?.category || "other"}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `gap-${idx}`;
}

// ─── Search Console analysis helpers ─────────────────────────────────────────
// The four gsc_* analysis tools below are composed entirely from the existing
// /api/integrations/gsc/query endpoint — no new backend surface. Each is a join
// or a fold that a human otherwise does by hand in a spreadsheet, which is
// exactly the work a tool should absorb.

export type GscRow = { query?: string; page?: string; date?: string; clicks: number; impressions: number; ctr: number; position: number | null };

/** One /api/integrations/gsc/query POST, normalised. Throws on a not-configured reply. */
async function gscRows(
  api: ToolApi,
  opts: { domain?: string; siteUrl?: string; dimensions: string[]; days?: number; rowLimit?: number },
): Promise<{ rows: GscRow[]; range: { startDate: string; endDate: string }; siteUrl: string }> {
  const res = await api.post("/api/integrations/gsc/query", {
    domain: opts.domain || undefined,
    siteUrl: opts.siteUrl || undefined,
    dimensions: opts.dimensions,
    days: opts.days,
    rowLimit: opts.rowLimit ?? 5000,
  });
  if (!res || res.configured === false) {
    throw new Error(String(res?.message || "Search Console is not connected for this domain."));
  }
  return { rows: Array.isArray(res.rows) ? res.rows : [], range: res.range ?? { startDate: "", endDate: "" }, siteUrl: res.siteUrl ?? "" };
}

/**
 * How much of the requested window actually has data behind it.
 *
 * This exists because of a real misreading: a 90-day audit of a two-week-old
 * property reported "average position 72" with no hint that 76 of those 90 days
 * were empty. A `days:90` and a `days:14` query returned byte-identical rows and
 * nothing said why. Position 72 means one thing on an established site and
 * something completely different on a property Google has known for a fortnight.
 *
 * Derived from a ['date'] query over the SAME window — one extra metered read,
 * and only worth it on windows long enough for the distinction to matter.
 */
async function gscHistory(
  api: ToolApi,
  opts: { domain?: string; siteUrl?: string; days: number },
): Promise<Record<string, unknown> | undefined> {
  try {
    const { rows, range } = await gscRows(api, { ...opts, dimensions: ["date"], rowLimit: 500 });
    const withData = rows.filter((r) => (r.impressions ?? 0) > 0).map((r) => String(r.date)).sort();
    if (!withData.length) {
      return { requestedDays: opts.days, daysWithData: 0, windowTruncated: true, note: `No Search Console data in the requested ${opts.days}-day window.` };
    }
    const firstDataDate = withData[0];
    const start = range.startDate;
    // Truncated = the window reaches back past the first day Google has anything
    // for. One day of slack absorbs the reporting-lag boundary.
    const truncated = !!start && Date.parse(firstDataDate) - Date.parse(start) > 86400000;
    const spanDays = Math.round((Date.parse(withData[withData.length - 1]) - Date.parse(firstDataDate)) / 86400000) + 1;
    return {
      firstDataDate,
      lastDataDate: withData[withData.length - 1],
      daysWithData: withData.length,
      requestedDays: opts.days,
      windowTruncated: truncated,
      ...(truncated
        ? {
            note: `This property has data from ${firstDataDate} only — ${spanDays} day(s), not the ${opts.days} requested. Averages here describe a young property; read positions accordingly and do not compare them to an established site.`,
          }
        : {}),
    };
  } catch {
    return undefined; // history is a nicety; never fail the caller's real question over it
  }
}

export const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
export const avgPos = (rows: GscRow[]) => {
  const imp = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  if (!imp) return null;
  return round(rows.reduce((a, r) => a + (r.impressions || 0) * (r.position ?? 0), 0) / imp, 1);
};

/**
 * Intent buckets for a query set. Order matters — the first match wins, so brand
 * and persona are tested before the generic vendor/category patterns that would
 * otherwise swallow them.
 *
 * The persona bucket is the one nobody else reports and the reason this tool
 * exists: role-prefixed conversational queries ("i'm a brand manager. X vs Y for
 * a two-person team") behave nothing like their head terms. On cituna.com they
 * averaged position 61 against 86 for the same vendors' head terms — the SERP is
 * simply less contested that far down the tail.
 */
export function classifyQuery(q: string, brandTokens: string[], competitorTokens: string[]): string {
  const s = q.toLowerCase();
  if (brandTokens.some((b) => b && s.includes(b))) return "brand";
  if (/^(i'm |i am |i lead |i advise |i run |as a |we're |we are |our )/.test(s)) return "persona-qualified";
  // Commercial outranks a vendor mention on purpose: the price word is what
  // decides the PAGE TYPE, and the vendor name only decides the topic.
  // "ahrefs brand radar pricing" and "ahrefs brand radar alternative" are two
  // different pages — filing both under competitor-alternative hides the fact
  // that you have written one of them and not the other. (On cituna.com the
  // pricing variants were the second-best-positioned non-brand queries on the
  // site, and there was no pricing page behind them.)
  if (/\b(price|pricing|cost|costs|cheap|cheapest|affordable|free|trial|discount|how much)\b/.test(s)) return "commercial";
  if (/\b(alternative|alternatives|competitor|competitors|replacement|vs\.?|versus|compare[d]? (to|with))\b/.test(s)) return "competitor-alternative";
  if (competitorTokens.some((c) => c && s.includes(c))) return "competitor-alternative";
  if (/\b(tool|tools|software|platform|tracker|app|dashboard)\b/.test(s)) return "tool-intent";
  if (/^(how|why|what|when|where|which|can|does|do|is|are)\b/.test(s) || s.includes("?")) return "how-to";
  return "category";
}

/** Fetch a domain's sitemap (following one level of sitemap index) and return its URLs. */
async function fetchSitemapUrls(domain: string, cap = 5000): Promise<{ urls: string[]; sources: string[]; error?: string }> {
  const base = `https://${normDomain(domain)}`;
  const seen = new Set<string>();
  const sources: string[] = [];
  const get = async (url: string): Promise<string> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Cituna-MCP/1.3 (+https://cituna.com/mcp)" } });
      return r.ok ? await r.text() : "";
    } catch { return ""; } finally { clearTimeout(t); }
  };
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

  let root = await get(`${base}/sitemap.xml`);
  if (!root) {
    // robots.txt is the spec-blessed pointer when /sitemap.xml is not the entry point.
    const robots = await get(`${base}/robots.txt`);
    const declared = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    if (declared.length) { sources.push(declared[0]); root = await get(declared[0]); }
    if (!root) return { urls: [], sources, error: `No readable sitemap at ${base}/sitemap.xml or declared in robots.txt.` };
  } else {
    sources.push(`${base}/sitemap.xml`);
  }

  if (/<sitemapindex/i.test(root)) {
    for (const child of locs(root).slice(0, 25)) {
      sources.push(child);
      for (const u of locs(await get(child))) { if (seen.size < cap) seen.add(u); }
    }
  } else {
    for (const u of locs(root)) { if (seen.size < cap) seen.add(u); }
  }
  return { urls: [...seen], sources };
}

/** Compare on path + host, ignoring trailing slashes — GSC and sitemaps disagree on both. */
export const canonPath = (u: string) => {
  try { const p = new URL(u); return (p.host.replace(/^www\./, "") + p.pathname.replace(/\/+$/, "")) || p.host; }
  catch { return String(u).replace(/\/+$/, ""); }
};

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

export type ServerOptions = {
  /** The Cituna backend this server talks to — reported by whoami. */
  apiUrl: string;
  /** Transport-appropriate copy for "you have not authenticated". */
  noCredentialsMessage: string;
};

/**
 * Build a fully-wired MCP Server over one CitunaClient.
 *
 * One server per credential: the client is captured in the request handlers, so
 * the remote transport MUST construct a fresh server per authenticated request
 * rather than sharing one across users. The stdio entrypoint builds exactly one
 * because a stdio process serves exactly one user.
 */
export function createCitunaServer(client: CitunaClient, opts: ServerOptions): Server {
  const { apiUrl, noCredentialsMessage } = opts;

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
    // works but calls tell the user exactly what to do. The copy is
    // transport-specific: an env var means nothing to a Connectors user.
    if (!client.hasCredentials()) return fail(noCredentialsMessage);

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
            backend: apiUrl,
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

          // Join Search Console positions onto the board.
          //
          // The rank checker only looks at the top 20, so EVERY keyword below it
          // came back `position: null` and rendered as the same flat string. On
          // cituna.com that meant the board said "not in top 20" for `cituna`,
          // which Google actually ranks at 1.2, and gave the identical answer for
          // a term at 75 and a term at 95. Position 75 → 40 → 18 is three
          // quarters of an SEO campaign and none of it was visible.
          //
          // GSC is ground truth for OUR pages and it has no top-20 cliff. One
          // read, degrading silently when Search Console is not connected.
          const wantGsc = args.includeSearchConsole !== false;
          let gscJoined = 0;
          let gscNote: string | undefined;
          if (wantGsc) {
            try {
              const { rows: gsc } = await gscRows(api, { domain, dimensions: ["query"], days: 28, rowLimit: 25000 });
              const byQuery = new Map(gsc.map((r) => [String(r.query ?? "").toLowerCase().trim(), r]));
              for (const k of keywords) {
                const hit = byQuery.get(String(k.keyword).toLowerCase().trim());
                if (!hit) continue;
                gscJoined++;
                k.searchConsole = {
                  position: hit.position == null ? null : round(hit.position, 1),
                  impressions: hit.impressions ?? 0,
                  clicks: hit.clicks ?? 0,
                };
              }
              if (!gscJoined) gscNote = "Search Console is connected but none of these keywords earned an impression in the last 28 days.";
            } catch (e) {
              gscNote = `Search Console positions unavailable (${(e as Error).message}). Rank-checker positions only, which means anything past #20 reads as 'not in top 20'.`;
            }
          }

          const stateRes = await api.post("/api/seo/keyword-state", { domain, keywords: keywords.map((k) => k.keyword) });
          const states = stateRes?.states ?? {};
          const wantStage = String(args.stage ?? "").trim();
          const merged = keywords
            .map((k) => ({
              ...k,
              position: k.position ?? null,
              // Prefer a measured number from EITHER source over the flat string.
              // The rank check wins when it has one (it is a live top-20 SERP
              // read); GSC fills the long tail the checker cannot see, labelled
              // so nobody mistakes a 28-day average for a live position.
              ranking:
                k.position != null
                  ? `#${k.position}`
                  : k.searchConsole?.position != null
                  ? `#${k.searchConsole.position} (Search Console, 28-day average)`
                  : k.positionChecked
                  ? "not in top 20, and no Search Console impressions in 28 days"
                  : "not checked",
              content: states[k.keyword] ?? { stage: "none" },
            }))
            .filter((k) => !wantStage || k.content.stage === wantStage);
          return ok({
            domain,
            count: merged.length,
            filteredBy: wantStage || null,
            searchConsoleJoined: wantGsc ? gscJoined : null,
            keywords: merged,
            ...(gscNote ? { searchConsoleNote: gscNote } : {}),
            note: "`content.stage` is none | queued | drafted | published | failed. Keywords at 'none' with real volume and no ranking are the ones missing a page. `searchConsole` carries the 28-day average position from Google for keywords the rank checker cannot see (it only reads the top 20), so a keyword at #75 is distinguishable from one at #95 instead of both reading 'not in top 20'.",
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
            // impressions rides along: since the Keywords tab stopped buying
            // volume/competition (2026-08-04), the queue route ranks GSC-evidence
            // topics by evidenceScore(impressions, position) — without it every
            // MCP-queued topic scored 0 and sat at the back of the queue while
            // this tool's description promised prioritisation.
            const r = await api.post("/api/autoseo/queue", {
              domain,
              source: "keyword",
              keyword: {
                text: keyword,
                volume: num(args.volume),
                competition: num(args.competition),
                position: num(args.position),
                impressions: num(args.impressions),
              },
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
          // The backend's merged queue (GET /api/gaps/:domain) — the SAME plan the
          // app's Recommendations screen renders: Stage-3 competitor gaps + driver
          // gaps + on-page audit fixes, each with its stable gapKey and current
          // status. This tool used to map result.stage3.gaps only (usually the
          // minority of the queue), so statuses set on audit/driver gaps in the
          // app were invisible here and "Fix with Claude" could never find an
          // audit-derived gap's key for set_gap_status.
          let domain = normDomain(domainArg);
          if (!domain && scanId) {
            const resolved = await resolveScan(api, scanId, "");
            if (!resolved) return ok({ domain: "", count: 0, gaps: [], message: "No saved audit found — run_scan first, or pass a scanId from list_audits." });
            domain = resolved.domain;
          }
          const r = await api.get(`/api/gaps/${encodeURIComponent(domain)}`, scanId ? { scanId } : undefined);
          if (!r || !Array.isArray(r.gaps)) {
            return ok({ domain, count: 0, gaps: [], message: "No saved audit found — run_scan first, or pass a scanId from list_audits." });
          }
          return ok({ domain: r.domain ?? domain, scanId: r.scanId ?? null, count: r.count ?? r.gaps.length, gaps: r.gaps });
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

        case "competitor_discovery": {
          const domain = normDomain(String(args.domain ?? "").trim());
          if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
          const days = args.days != null ? Number(args.days) : 90;
          const minEvidence = args.minEvidence != null ? Math.max(1, Number(args.minEvidence)) : 2;

          // The tracked list is the thing we are diffing AGAINST, so it has to be
          // read first and matched loosely: "Peec AI" in the brand record and
          // "peec" in an engine answer are the same company.
          const projects = await api.get("/api/projects");
          const brand = (projects?.brands ?? []).find((b: any) => normDomain(b?.domain ?? "") === domain);
          if (!brand) return fail(`No tracked brand matches ${domain}. Run list_brands to see what this workspace tracks.`);
          const known = new Set<string>();
          const addKnown = (v: unknown) => {
            const s = String(v ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
            if (!s) return;
            known.add(s);
            for (const w of s.split(/\s+/)) if (w.length > 2) known.add(w);
          };
          addKnown(brand.name);
          addKnown(domain.split(".")[0]);
          for (const c of brand.competitors ?? []) {
            if (typeof c === "string") addKnown(c);
            else { addKnown(c?.name); if (c?.domain) addKnown(String(c.domain).split(".")[0]); }
          }
          const isKnown = (name: string) => {
            const s = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
            if (known.has(s)) return true;
            return s.split(/\s+/).some((w) => w.length > 2 && known.has(w));
          };

          const found = new Map<string, { name: string; citedInAnswers: number; searchImpressions: number; seenIn: Set<string>; examples: string[] }>();
          const bump = (name: string, patch: Partial<{ cited: number; impressions: number; where: string; example: string }>) => {
            const key = name.toLowerCase().trim();
            const row = found.get(key) ?? { name, citedInAnswers: 0, searchImpressions: 0, seenIn: new Set<string>(), examples: [] };
            row.citedInAnswers += patch.cited ?? 0;
            row.searchImpressions += patch.impressions ?? 0;
            if (patch.where) row.seenIn.add(patch.where);
            if (patch.example && row.examples.length < 3 && !row.examples.includes(patch.example)) row.examples.push(patch.example);
            found.set(key, row);
          };

          // Source 1: brands the engines actually named answering this brand's prompts.
          // The strongest signal there is — an engine put them in front of your buyer.
          // Same two calls list_audits and get_audit make: /api/history for the
          // scan list, then GET /api/scan/<id> for the result. Not POST /api/audit
          // — that is the public "run an audit on this URL" endpoint and calling it
          // here would have started a scan rather than reading one.
          let engineSourceRead = false;
          try {
            const history = await api.get("/api/history");
            const scans = Array.isArray(history?.scans) ? history.scans : [];
            const latest = scans.filter((s: any) => normDomain(String(s?.domain ?? "")) === domain)[0];
            const scanId = latest?._id ? String(latest._id) : "";
            if (scanId) {
              const data = await api.get(`/api/scan/${encodeURIComponent(scanId)}`);
              const cited = data?.result?.stage1?.competitors_cited ?? [];
              if (Array.isArray(cited)) {
                engineSourceRead = true;
                for (const c of cited) {
                  const name = String(c?.brand ?? c?.name ?? "").trim();
                  if (!name || isKnown(name)) continue;
                  bump(name, { cited: Number(c?.count) || 1, where: "engine answers" });
                }
              }
            }
          } catch { /* the GSC half still works on its own; reported below */ }

          // Source 2: vendor-shaped search queries. A comparison query naming a
          // company you do not track is a buyer telling you who your rival is.
          let searchSourceRead = false;
          try {
            const { rows } = await gscRows(api, { domain, dimensions: ["query"], days, rowLimit: 25000 });
            searchSourceRead = true;
            const COMPARE = /\b(alternative|alternatives|competitor|competitors|vs\.?|versus|compared? to)\b/;
            for (const r of rows) {
              const q = String(r.query ?? "").toLowerCase();
              if (!COMPARE.test(q)) continue;
              // Strip the comparison scaffolding; whatever is left names companies.
              const words = q
                .replace(COMPARE, " ")
                .replace(/\b(best|top|good|cheap|cheapest|free|the|a|an|to|for|of|and|or|is|are|what|which|who|how|ai|tool|tools|software|platform|app|apps|pricing|price|review|reviews|2026|2025)\b/g, " ")
                .split(/[^a-z0-9.]+/)
                .map((w) => w.replace(/\.(com|ai|io|co)$/, ""))
                .filter((w) => w.length > 3);
              for (const w of words) {
                if (isKnown(w)) continue;
                bump(w, { impressions: r.impressions ?? 0, where: "search queries", example: String(r.query) });
              }
            }
          } catch { /* the engine-answer half still works on its own */ }

          const candidates = [...found.values()]
            .map((r) => ({
              name: r.name,
              // Engine citations are worth more than a stray query token: an engine
              // naming them put them in front of a buyer, a query only shows someone
              // typed the word.
              evidence: r.citedInAnswers * 2 + Math.min(r.searchImpressions, 50),
              citedInAnswers: r.citedInAnswers,
              searchImpressions: r.searchImpressions,
              seenIn: [...r.seenIn],
              exampleQueries: r.examples,
            }))
            .filter((r) => r.evidence >= minEvidence)
            .sort((a, b) => b.evidence - a.evidence)
            .slice(0, 25);

          // Say WHICH sources answered. A half-read that silently returns fewer
          // candidates is indistinguishable from "there are fewer candidates",
          // and that ambiguity is the thing this whole audit kept finding.
          const sourcesRead = [
            engineSourceRead ? "engine answers" : null,
            searchSourceRead ? "search queries" : null,
          ].filter(Boolean);
          return ok({
            domain,
            trackedCompetitors: (brand.competitors ?? []).length,
            sourcesRead,
            ...(sourcesRead.length < 2
              ? {
                  partial: true,
                  partialNote: `Only read ${sourcesRead.length ? sourcesRead.join(" and ") : "nothing"}. ${
                    !engineSourceRead ? "No readable audit for this domain, so engine-named brands were not checked (run a scan first). " : ""
                  }${!searchSourceRead ? "Search Console did not answer, so comparison-query evidence is missing. " : ""}Treat this list as incomplete rather than as a clean result.`,
                }
              : {}),
            candidates,
            howToRead:
              "Each candidate appeared in your engine answers or your comparison searches and is NOT on your tracked competitor list. `evidence` weights an engine citation above a search token because a citation means an engine put them in front of your buyer. Names are extracted mechanically, so expect some noise: confirm before adding, then add via the app.",
            ...(candidates.length ? {} : { note: "Nothing untracked found. Your competitor list matches what the engines and your searchers are naming." }),
          });
        }

        case "gsc_cannibalisation": {
          const domain = String(args.domain ?? "").trim();
          const siteUrl = String(args.siteUrl ?? "").trim();
          if (!domain && !siteUrl) return fail("Provide `domain` (e.g. 'example.com') or `siteUrl`.");
          const days = args.days != null ? Number(args.days) : 28;
          const minImpressions = args.minImpressions != null ? Number(args.minImpressions) : 5;
          const limit = args.limit != null ? Math.min(500, Math.max(1, Number(args.limit))) : 50;

          const { rows, range } = await gscRows(api, { domain, siteUrl, dimensions: ["query", "page"], days, rowLimit: 25000 });
          // Multi-dimension rows only became usable once shapeGscRows stopped
          // naming keys[0] and throwing the page away. Without that fix this tool
          // could not exist: every row looked like a plain query row.
          const byQuery = new Map<string, GscRow[]>();
          for (const r of rows) {
            if (!r.page) continue;
            const q = String(r.query ?? "");
            if (!q) continue;
            (byQuery.get(q) ?? byQuery.set(q, []).get(q)!).push(r);
          }

          const clashes = [...byQuery.entries()]
            .filter(([, rs]) => rs.length > 1)
            .map(([query, rs]) => {
              const impressions = rs.reduce((a, r) => a + (r.impressions ?? 0), 0);
              const sorted = rs.slice().sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
              const best = sorted[0];
              return {
                query,
                pagesCompeting: rs.length,
                impressions,
                clicks: rs.reduce((a, r) => a + (r.clicks ?? 0), 0),
                bestPosition: best.position == null ? null : round(best.position, 1),
                googleFavours: best.page,
                // A near-even split is the expensive case: neither page is winning
                // and the signal is genuinely divided.
                topPageImpressionShare: impressions ? round((100 * (best.impressions ?? 0)) / impressions, 1) : null,
                pages: sorted.map((r) => ({
                  page: r.page,
                  position: r.position == null ? null : round(r.position, 1),
                  impressions: r.impressions,
                  clicks: r.clicks,
                })),
              };
            })
            .filter((c) => c.impressions >= minImpressions)
            .sort((a, b) => b.impressions - a.impressions);

          return ok({
            domain: domain || siteUrl,
            range,
            queriesExamined: byQuery.size,
            cannibalisedQueries: clashes.length,
            history: await gscHistory(api, { domain, siteUrl, days }),
            rows: clashes.slice(0, limit),
            ...(clashes.length > limit ? { note: `${clashes.length} queries affected; showing the top ${limit} by impressions.` } : {}),
            howToRead:
              "Google picks ONE url per query. When several of yours qualify the signal splits and it often ranks the wrong one. Pick the canonical target per query, make the others support it, and link internally to the winner. A near-50% topPageImpressionShare is the costliest case: nothing is winning.",
          });
        }

        case "list_citation_sources": {
          const domain = normDomain(String(args.domain ?? "").trim());
          if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
          const limit = args.limit != null ? Math.min(100, Math.max(1, Number(args.limit))) : 25;
          const res = await api.get("/api/sources", { domain });
          const outreach = res?.outreach ?? {};
          const all = Array.isArray(res?.targets) ? res.targets : [];
          const gapsOnly = args.gapsOnly === true;
          // A GAP IS A PAGE WE READ, not an absence inferred from answer counts.
          // `you` counts answers that cited the host and named the brand in the
          // same breath; it credits every page an answer cited, so it said "gap"
          // for hosts that carry the customer and "covered" for hosts that never
          // mention them. `presence` comes from opening the pages.
          const isGap = (t: any) => t?.presence === "absent";
          const chosen = (gapsOnly ? all.filter(isGap) : all).slice(0, limit);
          const targets = chosen.map((t: any) => ({
            host: t.host,
            kind: t.kind,
            citedInAnswers: t.count,
            // What reading the pages found: "absent" | "mentioned" | "linked" |
            // "unreachable" | "unknown" (not read yet — never treat as absent).
            youOnThisSite: t.presence ?? "unknown",
            pagesChecked: t.pagesChecked ?? 0,
            pagesLinkingToYou: t.pagesLinked ?? 0,
            pagesMentioningYou: t.pagesMentioned ?? 0,
            isGap: isGap(t),
            // Kept for continuity, named for what it is: engine behaviour, not
            // a fact about the site. Do not read this as "the site cites you".
            appearedWithYouInAnswers: t.you ?? 0,
            rivalsNamedHere: t.rivals ?? [],
            engines: t.engines ?? [],
            yourPromptsItAnswers: t.queries ?? [],
            sampleUrls: t.urls ?? [],
            lastSeen: t.lastSeen,
            outreachStatus: outreach?.[t.host] ?? "todo",
          }));
          const gapCount = all.filter(isGap).length;
          const uncheckedCount = all.filter((t: any) => !t?.presence || t.presence === "unknown").length;
          return ok({
            domain,
            scansWalked: res?.scans ?? null,
            generatedAt: res?.generatedAt ?? null,
            totalTargets: all.length,
            gapTargets: gapCount,
            uncheckedTargets: uncheckedCount,
            filteredBy: gapsOnly ? "gapsOnly" : null,
            targets,
            yourPagesEnginesCite: Array.isArray(res?.own) ? res.own.slice(0, 20) : [],
            ...(chosen.length < (gapsOnly ? gapCount : all.length)
              ? { note: `Showing ${chosen.length} of ${gapsOnly ? gapCount : all.length}. Raise \`limit\` for more.` }
              : {}),
            howToRead:
              "`youOnThisSite` is what we found by OPENING the host's cited pages and reading them: 'absent' (engines read it, you are not on it — the real gap, `isGap: true`), 'mentioned' (named without a link: the cheapest win, just ask), 'linked' (already won), 'unreachable' (the site blocked the read — NOT evidence of absence), 'unknown' (not read yet — also not evidence of absence; the background pass gets to it, or the app's Sources page can check it on demand). Rival-owned and platform domains are already excluded. `appearedWithYouInAnswers` is engine behaviour only — how often an answer cited this host AND named you — and must never be reported as the site citing you. Mark progress with set_outreach_status.",
          });
        }

        case "set_outreach_status": {
          const domain = normDomain(String(args.domain ?? "").trim());
          const host = String(args.host ?? "").trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
          const status = String(args.status ?? "").trim().toLowerCase();
          if (!domain) return fail("`domain` is required, e.g. 'acme.com'.");
          if (!host) return fail("`host` is required — use the exact host from list_citation_sources, e.g. 'frase.io'.");
          if (!GAP_STATES.includes(status)) return fail(`\`status\` must be one of: ${GAP_STATES.join(", ")}.`);
          await api.post("/api/sources/outreach", { domain, host, status });
          return ok({ domain, host, status, saved: true });
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
          const res = await api.get("/api/integrations/gsc/data", { domain, days });

          // How much of the window actually has data behind it. Free here — the
          // overview already returns a day-by-day series, so this needs no extra
          // Google read. It matters because a 28- or 90-day average computed over
          // a fortnight of history reads like an established site's numbers and
          // is nothing of the kind: a young property sits at position ~70 because
          // Google barely knows it, not because the pages are bad.
          const series: any[] = Array.isArray(res?.series) ? res.series : [];
          const withData = series.filter((d) => Number(d?.impressions) > 0).map((d) => String(d.date)).sort();
          if (res && typeof res === "object" && withData.length) {
            const first = withData[0];
            const start = res?.range?.startDate;
            const truncated = !!start && Date.parse(first) - Date.parse(start) > 86400000;
            (res as any).history = {
              firstDataDate: first,
              lastDataDate: withData[withData.length - 1],
              daysWithData: withData.length,
              daysRequested: series.length,
              windowTruncated: truncated,
              ...(truncated
                ? { note: `Data starts ${first}; the earlier part of this window is empty. Averages describe a young property — read positions accordingly.` }
                : {}),
            };
          }
          return ok(res);
        }
        case "gsc_striking_distance": {
          const domain = String(args.domain ?? "").trim();
          const siteUrl = String(args.siteUrl ?? "").trim();
          if (!domain && !siteUrl) return fail("Provide `domain` (e.g. 'example.com') or `siteUrl`.");
          const days = args.days != null ? Number(args.days) : 28;
          const minPosition = args.minPosition != null ? Number(args.minPosition) : 11;
          const maxPosition = args.maxPosition != null ? Number(args.maxPosition) : 60;
          const minImpressions = args.minImpressions != null ? Number(args.minImpressions) : 1;
          const limit = args.limit != null ? Math.min(500, Math.max(1, Number(args.limit))) : 50;

          const { rows, range } = await gscRows(api, { domain, siteUrl, dimensions: ["query", "page"], days, rowLimit: 25000 });
          const band = rows.filter((r) => {
            const p = r.position;
            return p != null && p >= minPosition && p <= maxPosition && (r.impressions ?? 0) >= minImpressions;
          });
          // Same impressions, closer to page one ⇒ higher priority. A ranking
          // heuristic for ordering the list, deliberately NOT dressed up as a
          // click forecast — we have no CTR curve for this site.
          const span = Math.max(1, maxPosition - minPosition);
          const scored = band
            .map((r) => ({
              query: r.query,
              ...(r.page ? { page: r.page } : {}),
              position: round(r.position ?? 0, 1),
              impressions: r.impressions,
              clicks: r.clicks,
              priority: round((r.impressions ?? 0) * ((maxPosition - (r.position ?? maxPosition)) / span + 0.1), 1),
            }))
            .sort((a, b) => b.priority - a.priority);

          return ok({
            domain: domain || siteUrl,
            range,
            band: { minPosition, maxPosition, minImpressions },
            scanned: rows.length,
            inBand: scored.length,
            history: await gscHistory(api, { domain, siteUrl, days }),
            rows: scored.slice(0, limit),
            ...(scored.length > limit ? { note: `${scored.length} queries are in the band; showing the top ${limit} by priority.` } : {}),
            priorityNote: "priority = impressions weighted by closeness to page one. It orders the list; it does not predict clicks.",
          });
        }

        case "gsc_zero_click_pages": {
          const domain = String(args.domain ?? "").trim();
          const siteUrl = String(args.siteUrl ?? "").trim();
          if (!domain && !siteUrl) return fail("Provide `domain` (e.g. 'example.com') or `siteUrl`.");
          const days = args.days != null ? Number(args.days) : 28;
          const minImpressions = args.minImpressions != null ? Number(args.minImpressions) : 25;
          const maxClicks = args.maxClicks != null ? Number(args.maxClicks) : 0;
          const limit = args.limit != null ? Math.min(500, Math.max(1, Number(args.limit))) : 50;

          const { rows, range } = await gscRows(api, { domain, siteUrl, dimensions: ["page"], days, rowLimit: 25000 });
          const dead = rows
            .filter((r) => (r.impressions ?? 0) >= minImpressions && (r.clicks ?? 0) <= maxClicks)
            .map((r) => ({
              page: r.page,
              impressions: r.impressions,
              clicks: r.clicks,
              position: r.position == null ? null : round(r.position, 1),
              // Beyond ~15 the page is not reachable enough to be clicked, so the
              // title is not the problem. Inside it, the listing is being seen and
              // passed over — that is a snippet fix and it is far cheaper.
              cause: r.position != null && r.position <= 15 ? "snippet" : "ranking",
              fix:
                r.position != null && r.position <= 15
                  ? "Ranks on page one but loses the click — rewrite the title and meta description against the query that earns these impressions."
                  : "Too far down to be clicked. Needs a genuine content or authority move, not a snippet tweak.",
            }))
            .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));

          const wasted = dead.reduce((a, r) => a + (r.impressions ?? 0), 0);
          return ok({
            domain: domain || siteUrl,
            range,
            thresholds: { minImpressions, maxClicks },
            pagesExamined: rows.length,
            zeroClickPages: dead.length,
            wastedImpressions: wasted,
            bySnippet: dead.filter((d) => d.cause === "snippet").length,
            byRanking: dead.filter((d) => d.cause === "ranking").length,
            history: await gscHistory(api, { domain, siteUrl, days }),
            rows: dead.slice(0, limit),
            ...(dead.length > limit ? { note: `${dead.length} pages qualify; showing the top ${limit} by impressions.` } : {}),
          });
        }

        case "gsc_query_mix": {
          const domain = String(args.domain ?? "").trim();
          const siteUrl = String(args.siteUrl ?? "").trim();
          if (!domain && !siteUrl) return fail("Provide `domain` (e.g. 'example.com') or `siteUrl`.");
          const days = args.days != null ? Number(args.days) : 28;
          const perBucket = args.examplesPerBucket != null ? Math.max(0, Math.min(25, Number(args.examplesPerBucket))) : 5;

          // Brand + competitor tokens sharpen the buckets. Pull them from the
          // tracked brand when the caller has not supplied their own.
          let competitors: string[] = Array.isArray(args.competitors) ? args.competitors.map((c: any) => String(c).toLowerCase().trim()) : [];
          const brandTokens: string[] = [];
          if (domain) {
            const bare = normDomain(domain);
            brandTokens.push(bare.split(".")[0]);
            if (!competitors.length) {
              try {
                const projects = await api.get("/api/projects");
                const brand = (projects?.brands ?? []).find((b: any) => normDomain(b?.domain ?? "") === bare);
                if (brand?.name) brandTokens.push(String(brand.name).toLowerCase());
                competitors = (brand?.competitors ?? [])
                  .map((c: any) => String(typeof c === "string" ? c : c?.name ?? "").toLowerCase().trim())
                  .filter(Boolean);
              } catch { /* buckets still work without them */ }
            }
          }

          const { rows, range } = await gscRows(api, { domain, siteUrl, dimensions: ["query"], days, rowLimit: 25000 });
          const buckets = new Map<string, GscRow[]>();
          for (const r of rows) {
            const b = classifyQuery(String(r.query ?? ""), brandTokens, competitors);
            (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r);
          }
          const totalImpr = rows.reduce((a, r) => a + (r.impressions ?? 0), 0);
          const namedClicks = rows.reduce((a, r) => a + (r.clicks ?? 0), 0);

          const mix = [...buckets.entries()]
            .map(([bucket, rs]) => ({
              bucket,
              queries: rs.length,
              impressions: rs.reduce((a, r) => a + (r.impressions ?? 0), 0),
              sharePct: totalImpr ? round((100 * rs.reduce((a, r) => a + (r.impressions ?? 0), 0)) / totalImpr, 1) : 0,
              clicks: rs.reduce((a, r) => a + (r.clicks ?? 0), 0),
              avgPosition: avgPos(rs),
              ...(perBucket
                ? { examples: rs.slice().sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0)).slice(0, perBucket).map((r) => ({ query: r.query, impressions: r.impressions, position: r.position == null ? null : round(r.position, 1) })) }
                : {}),
            }))
            .sort((a, b) => b.impressions - a.impressions);

          // GSC withholds queries below a privacy threshold, so the named rows
          // under-report real performance. Reporting the shortfall stops anyone
          // treating the top-queries table as the whole picture.
          let anonymized: Record<string, unknown> | undefined;
          try {
            const totals = await api.get("/api/integrations/gsc/data", { domain: domain || undefined, days });
            const siteClicks = Number(totals?.totals?.clicks);
            if (Number.isFinite(siteClicks) && siteClicks >= namedClicks) {
              anonymized = {
                siteClicks,
                attributedToNamedQueries: namedClicks,
                anonymizedClicks: siteClicks - namedClicks,
                anonymizedPct: siteClicks ? round((100 * (siteClicks - namedClicks)) / siteClicks, 1) : 0,
                note: "Clicks Google will not attribute to a named query (low-volume privacy threshold). Long-tail performance the query table cannot show you.",
              };
            }
          } catch { /* optional */ }

          // Rich results: an EMPTY searchAppearance while the site earns impressions
          // means Google is attributing no enhancement to any page. That is a real
          // finding and it is invisible unless someone thinks to ask for a dimension
          // nobody queries by hand.
          let richResults: Record<string, unknown> | undefined;
          try {
            const { rows: appear } = await gscRows(api, { domain, siteUrl, dimensions: ["searchAppearance"], days, rowLimit: 100 });
            richResults = appear.length
              ? { types: appear.map((a: any) => ({ type: a.searchAppearance, impressions: a.impressions, clicks: a.clicks })) }
              : {
                  types: [],
                  note: totalImpr
                    ? "Google is attributing NO rich-result appearance to any page on this site. If the pages carry FAQ, HowTo, Article or Product structured data, it is not producing enhancements: validate it in the Rich Results Test before writing more."
                    : "No impressions in this window, so there is nothing for a rich result to attach to yet.",
                };
          } catch { /* optional */ }

          return ok({
            domain: domain || siteUrl,
            range,
            totalQueries: rows.length,
            totalImpressions: totalImpr,
            history: await gscHistory(api, { domain, siteUrl, days }),
            mix,
            ...(richResults ? { richResults } : {}),
            ...(anonymized ? { anonymizedClicks: anonymized } : {}),
          });
        }

        case "gsc_coverage_gap": {
          const domain = String(args.domain ?? "").trim();
          if (!domain) return fail("`domain` is required, e.g. 'example.com'.");
          const days = args.days != null ? Number(args.days) : 90;
          const limit = args.limit != null ? Math.min(2000, Math.max(1, Number(args.limit))) : 100;

          const [{ rows, range }, sitemap] = await Promise.all([
            gscRows(api, { domain, dimensions: ["page"], days, rowLimit: 25000 }),
            fetchSitemapUrls(domain),
          ]);
          if (!sitemap.urls.length) {
            return fail(sitemap.error || `Could not read a sitemap for ${domain}. Coverage needs one to know what was published.`);
          }

          const impressed = new Set(rows.filter((r) => (r.impressions ?? 0) > 0).map((r) => canonPath(String(r.page ?? ""))));
          const silent = sitemap.urls.filter((u) => !impressed.has(canonPath(u)));

          // Group by first path segment: one dead section is a strategy problem,
          // twenty scattered dead pages are a different one, and the shape of the
          // list is what tells them apart.
          const bySection = new Map<string, number>();
          for (const u of silent) {
            let seg = "/";
            try { seg = "/" + (new URL(u).pathname.split("/").filter(Boolean)[0] ?? ""); } catch { /* keep default */ }
            bySection.set(seg, (bySection.get(seg) ?? 0) + 1);
          }

          return ok({
            domain,
            range,
            sitemapSources: sitemap.sources,
            inSitemap: sitemap.urls.length,
            earnedImpressions: impressed.size,
            silent: silent.length,
            silentPct: sitemap.urls.length ? round((100 * silent.length) / sitemap.urls.length, 1) : 0,
            silentBySection: [...bySection.entries()].map(([section, count]) => ({ section, count })).sort((a, b) => b.count - a.count),
            history: await gscHistory(api, { domain, days }),
            silentUrls: silent.slice(0, limit),
            ...(silent.length > limit ? { note: `${silent.length} silent URLs; listing the first ${limit}. Counts above are complete.` } : {}),
            caveat:
              "Silent means 'no impression in this window'. It does NOT distinguish 'never indexed' from 'indexed but never competitive' — use URL Inspection in Search Console to tell those apart before acting.",
          });
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

  return server;
}
