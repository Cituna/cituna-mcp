<!-- The README of the public mirror (github.com/cituna/cituna-mcp); publish-mcp.yml copies it there.
     Everything between the shared markers is repeated in mcp/README.md, the npm README.
     mcp/src/docs.test.ts fails when the two copies differ. -->
<!-- shared:start -->
# Cituna MCP: the AI visibility MCP server

[![npm](https://img.shields.io/npm/v/cituna-mcp)](https://www.npmjs.com/package/cituna-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-com.cituna%2Fcituna--mcp-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=cituna)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/cituna/cituna-mcp/blob/main/LICENSE)

**Cituna MCP is the official MCP server for [Cituna](https://cituna.com), the AI visibility tool: your AI agent reads how seven AI engines answer, mention and cite your brand every day, next to your Google Search Console data, and acts on it with 31 tools.**

The seven engines are ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews and Google AI Mode, and every tracked prompt is asked on all of them daily. Connect the server to Claude, ChatGPT, Cursor, VS Code or any other MCP client and you can ask which buyer questions you are losing, what each engine actually answered, which pages it read, and what to fix first, then have the agent fix it.

It is hosted, speaks Streamable HTTP, and signs you in with OAuth in your browser. One URL, nothing to install:

```
https://mcp.cituna.com/mcp
```

Running it yourself instead, for scripts, CI or a client without OAuth? The same server is on npm. It takes a personal API key and needs Node 20 or later:

```bash
npx -y cituna-mcp
```

Product page and full docs: **[cituna.com/mcp](https://cituna.com/mcp)**.

| At a glance | |
|---|---|
| Hosted URL | `https://mcp.cituna.com/mcp` (Streamable HTTP, OAuth 2.1 or API key) |
| Local package | `npx -y cituna-mcp` on npm (stdio, API key, Node 20+) |
| Engines | ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews and Google AI Mode, checked daily |
| Also joins | Google Search Console (read-only), AutoSEO articles, your fix queue |
| Tools | 31 in all: 22 read tools and 9 write tools |
| Built-in workflows | 5 MCP prompts (diagnosis, AEO gap, competitor teardown, weekly review, fix ranking) |
| Plans | Read tools from Starter ($49/mo); write tools and `list_keywords` on Pro ($119/mo) and Max ($399/mo). No MCP on the free trial |
| Registry name | `com.cituna/cituna-mcp` on the official MCP Registry |
| Works in | claude.ai, Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code, Windsurf, Codex CLI and any MCP client |
| License | MIT for this server; Cituna itself is a paid service |

## Contents

- [What your agent can do](#what-your-agent-can-do)
- [Try asking](#try-asking)
- [Quick start](#quick-start): [claude.ai](#claudeai-web-and-mobile), [Claude Desktop](#claude-desktop), [Claude Code](#claude-code), [ChatGPT](#chatgpt), [Cursor](#cursor), [VS Code](#vs-code-github-copilot), [Windsurf](#windsurf), [Codex CLI](#codex-cli), [Gemini CLI](#gemini-cli), [any other client](#any-other-mcp-client)
- [Tools](#tools)
- [Plans and access](#plans-and-access)
- [Built-in workflows](#built-in-workflows)
- [What a session looks like](#what-a-session-looks-like)
- [Connecting Google Search Console](#connecting-google-search-console)
- [Authentication and security](#authentication-and-security)
- [Self-hosting the remote server](#self-hosting-the-remote-server)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Links](#links)

## What your agent can do

Most AI visibility tools hand you a dashboard and leave the thinking to you. Cituna puts the measurements where you already reason: ask your agent why an engine never mentions you, and it pulls the answer receipts, checks them against what Google already sends you, and queues the page that fixes it, without you opening a tab.

- **Read the daily tracking grid.** Which of your tracked prompts each engine cited you for today, at what position, and your current visibility score (`get_visibility`).
- **Pull the receipts.** What an engine actually answered for one prompt, the brands it named and the URLs it cited (`get_engine_answers`).
- **Find where the answers come from.** The third-party pages the engines cite for your prompts, how often, which rivals each one names, and whether you are on the page, read from the page itself rather than guessed (`list_citation_sources`).
- **Spot new rivals.** Brands the engines name in answers to your own buyer questions, and vendor names people search before reaching you, that you are not tracking yet (`competitor_discovery`).
- **Join AI answers with Google.** Search Console totals, any Search Analytics query, and six ready-made analyses: queries just off page one, pages seen and not clicked, demand by intent, pages never shown, your own pages competing, and searches worded like AI prompts (`gsc_*`).
- **Work the fix queue.** Every gap from your latest audit with its impact, effort and the concrete fix, and its status as you go (`list_gaps`, `set_gap_status`).
- **Plan and ship content.** Keywords with real demand and nothing written for them, the AutoSEO queue and every article it wrote, then queue, edit, refresh or skip from the chat (`list_keywords`, `queue_article`, `update_article`, `enrich_article`).
- **Change what is measured.** Add, disable or rewrite the buyer questions the seven engines are asked every day, with a before-and-after diff (`set_prompts`).
- **Run a fresh scan** when you have shipped a fix and want to look now (`run_scan`).
- **Keep an outreach list.** Mark a cited source as planned, pitched, placed or declined, so the list survives between sessions (`set_outreach_status`).

## Try asking

Once connected, ask in plain English. The server tells your agent which tools and workflow answer which kind of question, so you do not have to name them.

**Visibility and receipts**

> - "How is acme.com doing in AI search today? Which prompts and engines cite us?"
> - "What did Perplexity answer for *best CRM for dentists*, and who did it cite instead of us?"
> - "What changed in my AI visibility this week, and which engines dropped us?"
> - "Why don't AI engines mention us? Use the not-cited diagnosis."

**Sources and competitors**

> - "Which sites does each engine read for our prompts that don't mention us yet? Rank them as a pitch list."
> - "Which of our own pages do the engines already cite?"
> - "Who comes up instead of us, and which rivals aren't we tracking?"
> - "Mark the G2 category page as pitched." *(Pro)*

**Search Console, joined up**

> - "Which queries are just off page one, and which page ranks for each?"
> - "Which pages get impressions and no clicks, and why?"
> - "Where do Google impressions exist but AI never cites us? That is my AEO target list."
> - "Do two of our pages compete for the same query?"
> - "How many of our searches look like AI prompts?"

**Fixes and content**

> - "List the open gaps for acme.com, ranked by the Search Console impressions each one touches."
> - "Which keywords have demand and no page behind them? Queue the top three." *(Pro)*
> - "Which AutoSEO articles are due a refresh? Refresh them." *(Pro)*
> - "Add the three questions we lost this week to our tracked prompts, and disable the ones nobody searches." *(Pro)*
> - "Run a fresh scan for acme.com and summarise the top 3 gaps." *(Pro, uses one scan)*

## Quick start

**You need** a Cituna account on Starter or a higher plan, with at least one tracked brand. The 3-day free trial is app-only: MCP access starts when your plan does. A brand-new workspace has nothing to read yet, so add your brand in the app first ([cituna.com](https://cituna.com)).

There are two ways to connect, and both expose exactly the same tools:

| | Hosted connector (recommended) | Local npm package |
|---|---|---|
| Address | `https://mcp.cituna.com/mcp` | `npx -y cituna-mcp` |
| Transport | Streamable HTTP | stdio |
| Sign-in | OAuth in your browser, or an API key header | `CITUNA_API_KEY` environment variable |
| Needs locally | Nothing | Node 20 or later |
| Works in | Every client below, including claude.ai on the web and mobile | Desktop and terminal clients |

### claude.ai (web and mobile)

1. In Claude, open **Customize → Connectors**, click **Add**, then **Add custom connector**.
2. Name it Cituna and paste the URL:

   ```
   https://mcp.cituna.com/mcp
   ```

3. Claude sends you to Cituna to sign in, then shows a consent screen. Leave **Also allow changes** ticked to let Claude run scans and work your queue (Pro and Max), or untick it for a read-only connection.
4. In a chat, turn Cituna on from the **+** menu and ask your first question.

On Team and Enterprise plans an owner adds the connector once under **Organization settings → Connectors**, then each member connects it from **Customize → Connectors** and signs in with their own Cituna account. A connector added on claude.ai is also available in Claude Desktop and the mobile apps signed in to the same account.

### Claude Desktop

The connector above is the quickest route: **Customize → Connectors → Add → Add custom connector**, paste `https://mcp.cituna.com/mcp`, and approve in the browser.

To run the npm package locally instead, generate an API key ([below](#getting-an-api-key)) and edit `claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "cituna": {
      "command": "npx",
      "args": ["-y", "cituna-mcp"],
      "env": {
        "CITUNA_API_KEY": "cituna_sk_your_generated_key"
      }
    }
  }
}
```

On Windows, if the server does not start, run `npx` through `cmd`: `"command": "cmd"` and `"args": ["/c", "npx", "-y", "cituna-mcp"]`. Restart Claude Desktop. The tools appear under the **+** button in the chat box.

### Claude Code

Hosted, with browser sign-in:

```bash
claude mcp add --transport http cituna https://mcp.cituna.com/mcp
```

Then run `/mcp` inside Claude Code, pick **cituna** and choose **Authenticate**. To use an API key instead of OAuth:

```bash
claude mcp add --transport http cituna https://mcp.cituna.com/mcp \
  --header "Authorization: Bearer cituna_sk_your_generated_key"
```

Or run the npm package locally, available in every project:

```bash
claude mcp add cituna --scope user \
  --env CITUNA_API_KEY=cituna_sk_your_generated_key \
  -- npx -y cituna-mcp
```

Run `/mcp` to confirm it is connected, then ask *"what changed in my AI visibility this week?"*

### ChatGPT

ChatGPT connects to the same hosted URL. Yes, you can ask ChatGPT how ChatGPT cites you.

1. In ChatGPT on the web, open **Settings → Security and login** and turn on **Developer mode**. It comes with Plus, Pro, Business, Enterprise and Edu.
2. Open **Plugins**, click **+**, then **Create MCP App**.
3. Name it Cituna, paste `https://mcp.cituna.com/mcp`, choose **OAuth**, and create it.
4. Sign in to Cituna and approve with **Also allow changes** ticked if you want writes. Then add Cituna to a chat from the **+** menu.

ChatGPT asks before each change. Reading works on Starter; scans and edits need Pro or Max. Approved ChatGPT connections are listed under **Integrations** in the Cituna app, where you can disconnect them.

### Cursor

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=cituna&config=eyJ1cmwiOiJodHRwczovL21jcC5jaXR1bmEuY29tL21jcCJ9)

Or add it to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "cituna": {
      "url": "https://mcp.cituna.com/mcp"
    }
  }
}
```

Cursor lists the server under its MCP settings with a sign-in button; click it, sign in to Cituna and approve. To skip OAuth, send your API key as a header:

```json
{
  "mcpServers": {
    "cituna": {
      "url": "https://mcp.cituna.com/mcp",
      "headers": { "Authorization": "Bearer cituna_sk_your_generated_key" }
    }
  }
}
```

Or run it locally with `"command": "npx"`, `"args": ["-y", "cituna-mcp"]` and `"env": { "CITUNA_API_KEY": "cituna_sk_..." }`. Use the tools from Cursor's agent chat.

### VS Code (GitHub Copilot)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Cituna_MCP-0098FF?logo=githubcopilot&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=cituna&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.cituna.com%2Fmcp%22%7D)

Or from the command line:

```bash
code --add-mcp '{"name":"cituna","type":"http","url":"https://mcp.cituna.com/mcp"}'
```

Or in `.vscode/mcp.json` for one workspace (run **MCP: Open User Configuration** from the Command Palette for all of them):

```json
{
  "servers": {
    "cituna": {
      "type": "http",
      "url": "https://mcp.cituna.com/mcp"
    }
  }
}
```

VS Code opens the Cituna sign-in the first time a tool runs. To use an API key, let VS Code prompt for it once and keep it out of the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "cituna-key", "description": "Cituna API key (cituna_sk_...)", "password": true }
  ],
  "servers": {
    "cituna": {
      "type": "http",
      "url": "https://mcp.cituna.com/mcp",
      "headers": { "Authorization": "Bearer ${input:cituna-key}" }
    }
  }
}
```

Open Copilot Chat in **Agent** mode and the Cituna tools appear in the tools picker.

### Windsurf

In `~/.codeium/windsurf/mcp_config.json` (or Windsurf's MCP settings, which open the same file):

```json
{
  "mcpServers": {
    "cituna": {
      "serverUrl": "https://mcp.cituna.com/mcp"
    }
  }
}
```

If your Windsurf version does not open a browser sign-in, add `"headers": { "Authorization": "Bearer cituna_sk_your_generated_key" }` next to `serverUrl`.

### Codex CLI

Run the npm package with your API key:

```bash
codex mcp add cituna --env CITUNA_API_KEY=cituna_sk_your_generated_key -- npx -y cituna-mcp
```

That writes the equivalent of this to `~/.codex/config.toml`:

```toml
[mcp_servers.cituna]
command = "npx"
args = ["-y", "cituna-mcp"]
env = { CITUNA_API_KEY = "cituna_sk_your_generated_key" }
```

### Gemini CLI

```bash
gemini mcp add --transport http cituna https://mcp.cituna.com/mcp
```

Then run `/mcp auth cituna` to sign in. Or in `~/.gemini/settings.json`, with an API key instead of OAuth:

```json
{
  "mcpServers": {
    "cituna": {
      "httpUrl": "https://mcp.cituna.com/mcp",
      "headers": { "Authorization": "Bearer cituna_sk_your_generated_key" }
    }
  }
}
```

### Any other MCP client

- **Supports remote servers:** point it at `https://mcp.cituna.com/mcp` over Streamable HTTP. If it supports OAuth it discovers the sign-in on its own from the `401` challenge; if not, send `Authorization: Bearer cituna_sk_...` (or `X-API-Key: cituna_sk_...`).
- **Supports stdio only:** run `npx -y cituna-mcp` with `CITUNA_API_KEY` in its environment.

From source, for development:

```bash
git clone https://github.com/cituna/cituna-mcp && cd cituna-mcp
npm install && npm run build   # then: node dist/index.js
```

### Getting an API key

The hosted connector does not need a key. The npm package and the header options do:

1. In the Cituna app, open **Integrations → Claude / MCP access** and click **Generate token**.
2. Copy the `cituna_sk_...` value. It is shown once.
3. Paste it into your client's config as above.

Keys do not expire on their own, are not your password, and can be revoked in the app at any time. The same key works for the Looker Studio connector and the [REST API](https://cituna.com/developers). Each person should use their own key: a key acts as one workspace, and nothing else.

## Tools

31 tools: 22 read tools and 9 write tools. Reads work from **Starter** with one exception, `list_keywords`, which reads the keyword dataset that is part of **Pro**. The nine write tools need **Pro** or higher, and a connection approved without **Also allow changes** cannot call them on any plan. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so a client can auto-approve reads and ask before a write; `set_prompts`, `update_article` and `enrich_article` are marked destructive because they can delete or overwrite.

### Start here

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `whoami` | Starter | none | The signed-in account (email, workspace, role), backend URL, plan, and every usage meter: per-tool used and limit, brand and prompt-pool counts. Call it first. Search Console state is `gsc_status`'s job. |
| `list_brands` | Starter | none | The brands and domains your workspace tracks, which are the inputs for every other tool. |
| `gsc_status` | Starter | none | Whether Google Search Console is connected, the Google accounts connected (a workspace can connect several) and the verified properties each one can read. |

### Daily AI visibility tracking

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `get_visibility` | Starter | `brand` | The latest daily grid for a brand: for every tracked prompt and each of the seven engines, cited or not, position, the engine mode that ran, and the cell status, plus the current visibility score and the UTC day it was measured. An `unavailable` cell is an engine that gave no answer this time, not a miss, and it is checked again automatically. |
| `get_engine_answers` | Starter | `brand`, `prompt`, `engine` (optional) | The receipts: the answer text each engine gave for one prompt on the latest day (up to about 4,000 characters, with a `truncated` flag), the brands it cited, the source URLs and your position. |
| `set_prompts` | Pro, write | `brand`, then `add`, `remove`, `enable`, `disable` or `replace` | Edit the buyer questions the seven engines are asked every day, with a before-and-after diff. `remove` and `replace` delete a prompt's place in the grid and its history, so `disable` is the reversible way to stop spending on one. |

### Audits and the fix queue

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `list_audits` | Starter | `domain` (optional) | Recent audits, newest first: scan id, domain, date, AI-citation score, SEO, GEO and authority scores, open-gap count and `scoring_epoch`. Compare scores only within one epoch; across epochs, compare citation counts. |
| `get_audit` | Starter | `scanId` | One audit in full: overall and per-engine scores, the query by engine citation matrix with every cell `cited`, `not_cited` or `not_run` (an engine that sat a query out is not a miss), competitors cited, top gaps, and the SEO and GEO checks counted by their verdict across every page the audit read (the same count as the app's "N to fix"), with the checks to fix (pages examined and passing where graded page by page), the cross-page advisories and how many pages the audit read. |
| `run_scan` | Pro, write | `url`, `competitors` (optional) | Run a new audit and return the finished result in about a minute. Uses one scan from the monthly allowance, and a new domain becomes a tracked brand. Reading an existing audit with `get_audit` is free. |
| `list_gaps` | Starter | `domain` or `scanId` | The fix queue: each gap's `gapKey`, status (todo, doing, done), title, category, impact, effort and the concrete fix. |
| `set_gap_status` | Pro, write | `domain`, `gapKey`, `status` | Move one gap to todo, doing or done. |

### Citation sources and competitors

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `list_citation_sources` | Starter | `domain`, then optional `search`, `engine`, `range`, `gapsOnly` | The third-party pages the engines cite for your prompts, rolled up by host: how often each is cited, the rivals it names, which prompts it answers, and `youOnThisSite`, read by opening the page (absent, mentioned, linked, unreachable or unknown). Also up to 50 pages of yours the engines already cite, and the sites each engine leans on most. Pass `search` to look up one brand, host or URL. |
| `set_outreach_status` | Pro, write | `domain`, `host`, `status` | Record where outreach to one source host stands: planned, pitched, placed or declined (`none` clears it). It comes back on every `list_citation_sources` call. |
| `competitor_discovery` | Starter | `domain`, then optional `days`, `minEvidence` | Rivals you are not tracking yet: brands the engines named while answering your prompts, and vendor names people searched before reaching you, ranked by evidence. |

### Google Search Console

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `gsc_overview` | Starter | `domain`, `days` | Clicks, impressions, CTR and average position over the last N days, with top queries and pages, country and device splits, and a daily series. |
| `gsc_query` | Starter | `domain` or `siteUrl`, `dimensions`, `days` or `startDate` and `endDate`, `filters`, `rowLimit` | Any Search Analytics query: by query, page, country, device, search appearance or date, with filters, search type and paging. |
| `gsc_striking_distance` | Starter | `domain`, then optional `minPosition`, `maxPosition`, `minImpressions` | Queries just off page one (positions 11 to 60 by default), ordered by how much a realistic move would unlock, each with the page that ranks. |
| `gsc_zero_click_pages` | Starter | `domain`, then optional `minImpressions`, `maxClicks` | Pages Google shows and nobody clicks, split by cause (branded, snippet, page two or ranking), because each cause needs a different fix. |
| `gsc_query_mix` | Starter | `domain`, then optional `competitors` | The demand a domain earns, grouped by intent (brand, competitor alternative, persona, commercial, tool, how-to, category), with impressions, clicks and position per group. |
| `gsc_coverage_gap` | Starter | `domain`, `days` | Sitemap pages Google has never shown anyone, grouped by URL prefix, so a dead section stands out. Fetches the sitemap from the site itself. |
| `gsc_cannibalisation` | Starter | `domain`, then optional `minImpressions` | Queries where two or more of your own pages compete, with each page's position and impressions and the one Google favours. |
| `gsc_ai_searches` | Starter | `domain`, `days` | Searches worded like AI prompts (follow-ups, chat replies, instructions, pasted text), as a floor on AI use. Search Console has no AI Overviews or AI Mode filter, so these are not Google's AI numbers. |

### Keywords and AutoSEO articles

| Tool | Plan | Inputs | What it does |
|---|---|---|---|
| `list_keywords` | Pro, read | `domain`, then optional `stage`, `includeSearchConsole` | Every tracked keyword with its Google position, monthly volume, competition and the stage of the page behind it. `stage: "none"` is the shortlist: demand with nothing written for it yet. Positions come from the rank checker (top 20) and Search Console (28-day average). |
| `list_content_queue` | Starter | `domain`, then optional `status`, `before` | What AutoSEO has in flight: topics waiting to be written and articles generated or published, with the keyword or prompt behind each, so nothing is queued twice. |
| `list_articles` | Starter | `domain`, then optional `status`, `before` | One row per AutoSEO article, newest first: id, title, live URL, status, keyword, when it was published, last sent to the site, edited and refreshed, its own Search Console numbers, and whether a refresh is due (`enrich.eligible`). No article text. |
| `get_article` | Starter | `id` | One article's stored text (title, meta title and description, dek, sections, FAQs, tags), what the publishing checks flagged, and the last refresh's before and after. |
| `queue_article` | Pro, write | `domain`, `keyword`, then optional `impressions`, `position` | Queue a keyword so AutoSEO drafts it on the next run. Nothing is queued when the keyword already has a topic or article, the site already has a page for it (the result names that page), or the queue is full; `reason` says which. |
| `mark_article_published` | Pro, write | `domain`, `keyword`, `url` | Tell Cituna a page for a keyword is live, one you wrote yourself or published from your own CMS. Without it Cituna keeps the keyword as unwritten and offers to write a competing page. |
| `update_article` | Pro, write | `id`, then any of `title`, `metaTitle`, `metaDescription`, `dek`, `sections`, `faqs`, `tags` | Overwrite fields of an article's stored text. A page already on the site changes when the article is sent again from the Cituna app. |
| `enrich_article` | Pro, write | `id` | Refresh a live article's SEO title, meta description and up to two FAQ answers from its own Search Console queries, on the site it was published to, and return the before and after. Only for an article `list_articles` shows as due; uses one generation from the monthly allowance. |
| `skip_queued_topics` | Pro, write | `ids` | Take up to 50 topics out of the AutoSEO queue so they are never written. Queueing the same text again brings one back. |

## Plans and access

The MCP server comes with every paid Cituna plan. There is no separate add-on and no free MCP tier: the 3-day free trial is app-only, and an ended trial with no plan cannot call the server.

| | Starter ($49/mo) | Pro ($119/mo) | Max ($399/mo) |
|---|---|---|---|
| MCP access | Read only | Read and write | Read and write |
| Read tools (22) | 21: every read except `list_keywords` | All 22 | All 22 |
| Write tools (9) | None (do it in the app) | All 9 | All 9 |
| MCP calls a month | 5,000 | 10,000 | 30,000 |
| Prompts checked daily on all seven engines | 10 | 30 | 90 |
| Brands tracked | 1 | 3 | 10 |
| Re-scans a month (`run_scan` uses one) | 10, run in the app | 15 | 20 |

How the gates behave:

- **A write tool on Starter** returns a plan message naming Pro, and changes nothing. On Starter you still run scans and work the queue in the app, just not from the agent.
- **Writes need the scope as well as the plan.** If you untick **Also allow changes** on the consent screen, the connection is read-only even on Pro or Max. To add writes later, disconnect it under **Integrations** and connect again with the box ticked.
- **The monthly MCP-call allowance** counts every call. A used-up allowance comes back as a plan-limit message (HTTP 402); upgrade or wait for the period to reset. HTTP 429 is a separate burst limit: wait the seconds it names and retry.
- **`run_scan` spends a scan** from the monthly allowance, and scanning a domain you do not track adds it as a brand against your plan's brand cap. Everything else reads data Cituna already collected.
- **`enrich_article` uses one generation** from the monthly allowance and changes a live page on your site.

A custom [Enterprise](https://cituna.com/enterprise) plan lifts the limits further, with invoiced billing. Full limits per plan: [cituna.com/pricing](https://cituna.com/pricing).

## Built-in workflows

The server ships five analysis workflows through the MCP prompts API. In Claude they show up in the prompt picker; in any client, the server's instructions tell the agent which workflow answers which question, so plain English routes itself. Each one joins Search Console data with the engines' actual answer text, which a generic SEO tool cannot do.

| Prompt | Arguments | What it does |
|---|---|---|
| `why-am-i-not-cited` | `brand`, `prompt` (optional) | Sorts every uncited prompt into invisible everywhere, Google-visible but AI-invisible, or partly cited, with evidence from the engine answers and Search Console. |
| `gsc-to-ai-gap` | `domain`, `days` (optional) | Queries with real Google impressions where AI never cites you: the ranked AEO target list. |
| `competitor-teardown` | `brand`, `competitor` (optional) | Tallies who the engines actually cite from the answer text, and compares it with your configured competitor list. |
| `weekly-review` | `brand` | Wins, regressions and this week's 3 actions from audits, Search Console and the gap queue. Reads only. |
| `prioritize-fixes` | `domain` | Re-ranks the fix queue by the Search Console impressions and uncited prompts each gap touches. |

None of them starts a paid scan on its own.

## What a session looks like

An example first conversation, once the server is connected (acme.com stands in for your brand):

> **You:** We sell scheduling software. Why does ChatGPT never mention us?
>
> **Claude:** *(whoami → Pro, 4 of 15 scans used · list_brands → acme.com ·
> gsc_status → connected)* Running the not-cited diagnosis on acme.com.
>
> *(get_visibility)* You are cited in 3 of 18 prompt×engine cells. ChatGPT
> answers all six of your category prompts and cites you in none of them.
>
> *(get_engine_answers on the 3 biggest)* For "best scheduling software for
> clinics" ChatGPT cites Calendly, Acuity and a Capterra roundup. Every citation
> is a third-party list. Not one is a vendor's own site, including your rivals'.
>
> *(gsc_query)* Google already sends you 1,240 impressions for that intent at
> average position 8.4. So this is not an indexation problem.
>
> **The finding:** you are Google-visible and AI-invisible. ChatGPT builds that
> answer out of roundups you are absent from, so no amount of on-site work moves
> it. The lever is getting into those lists.
>
> *(list_keywords stage:"none")* "scheduling software for clinics" has demand and
> no page behind it. Want me to queue it? *(queue_article)*

Nothing above spends a scan: it is all reads over data Cituna already collected.

## Connecting Google Search Console

The `gsc_*` tools need a one-time connect **in the Cituna app**, not in your MCP client. There is no Google OAuth in this server, by design: the browser consent happens in the app, and the refresh token is stored server-side only.

1. In the app, open **Integrations** and click **Connect Google Search Console** (paid plans).
2. Google asks to grant Cituna **read-only** Search Console access (`webmasters.readonly`). Cituna never gets write access to anything at Google.
3. Pick the Google account where your domain is a **verified Search Console property**. This is the step people miss: if that account has never verified the domain, everything connects and every query still comes back empty, because Google has nothing to show it.
4. Back in your agent, run `gsc_status`. It lists each connected account and every property it can query. If your domain is not there, verify the property in Search Console, not in Cituna.

A workspace can connect several Google accounts, and a domain is readable when any of them holds a property for it. Disconnecting in the app (Integrations, Disconnect) cuts off this server at once.

## Authentication and security

The server is a thin client over the Cituna API. It holds no Google credentials and no database: it sends your Cituna credential to the backend, which looks up your workspace's stored Search Console refresh token, mints a short-lived Google access token, and queries Google for you.

**OAuth (the hosted connector).** The server is an OAuth 2.1 protected resource and the Cituna API is the authorization server. A client walks the chain itself:

```
POST /mcp  (no credential)
  → 401 + WWW-Authenticate: Bearer resource_metadata="…"
      → GET https://mcp.cituna.com/.well-known/oauth-protected-resource
          → names https://api.cituna.com as the authorization server
              → GET  /.well-known/oauth-authorization-server
              → POST /oauth/register     (dynamic client registration, RFC 7591)
              → GET  /oauth/authorize    (browser: sign in, then consent)
              → POST /oauth/token        (PKCE S256 required)
```

Clients can also sign in with a published client identity (client ID metadata documents), which is how Claude and ChatGPT connect. Access tokens last 24 hours. Refresh tokens rotate on every use, and a rotated-out refresh token presented again ends the whole connection, so a stolen copy cannot quietly outlive the real client. There are two scopes, `cituna:read` and `cituna:write`, and a write tool needs the scope **and** the plan.

**API keys.** A `cituna_sk_...` key goes in `CITUNA_API_KEY` for the npm package, or in an `Authorization: Bearer` (or `X-API-Key`) header for the hosted URL. A key authenticates as one workspace only, and the hosted server is stateless per request, so keys never mix. Do not wire a gateway to send one shared key for all of its users: every one of them would act as that single workspace.

**What a connection cannot do.** It can call the MCP tools and nothing else. It cannot create API keys, change your password, reach billing, invite teammates, or approve another app; those need you signed in to the app. Tokens are only issued for Cituna's own MCP server (RFC 8707 `resource`), so another server that names Cituna as its authorization server cannot collect one.

**Third-party content.** Answer text, cited titles, URLs and Search Console queries are quoted from AI engines, the pages they read and the people who search. The server tells your agent to treat them as data and never to follow instructions found in them, or call a write tool because tool output asked it to.

Approved apps are listed under **Integrations** in the app, each marked read-only or able to make changes, and can be disconnected there.

## Self-hosting the remote server

The hosted URL is the same code as this repository. Both transports are built from one tool layer (`src/tools.ts`), so the tool list, descriptions and schemas are literally the same objects, and `npm run test:transports` fails the build if they ever diverge.

| | stdio (`dist/index.js`) | remote (`dist/http.js`) |
|---|---|---|
| Runs | on your machine, launched by the client | as a service, reached by URL |
| Needs | Node 20+ locally | nothing local |
| Credential | `CITUNA_API_KEY` env var | `Authorization: Bearer` per request |
| Ships as | the `cituna-mcp` npm package | a container (`Dockerfile`) |

The stdio server reads `CITUNA_API_URL` (backend base URL, default `https://cituna.com`) plus one credential, checked in this order: `CITUNA_API_KEY` (recommended), `CITUNA_TOKEN` (a session token from the app, which expires after about 30 days), or `CITUNA_EMAIL` with `CITUNA_PASSWORD` (the server logs in and refreshes on expiry).

Run the remote server:

```bash
npm run build && npm run start:http    # or: npm run dev:http
```

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `CITUNA_API_URL` | `https://cituna.com` | Backend base URL. |
| `CITUNA_MCP_ALLOWED_HOSTS` | *(unset)* | Comma-separated `Host` allowlist (DNS-rebinding protection). Leave unset behind a proxy that already pins the host. |

There is no `CITUNA_API_KEY` here, deliberately: the remote server holds no credential of its own. Every request carries its own, a fresh client and MCP server are built for it, and both are torn down when the response ends, so one user's key can never be captured into another user's session. A request with no credential gets `401` and cannot even list the tools. Deploy with the included `Dockerfile` (multi-stage; the runtime image carries one production dependency). If you self-host on a domain outside cituna.com, add its origin to `OAUTH_ALLOWED_RESOURCES` on the API so it can be issued tokens (loopback addresses are always allowed).

Endpoints on the remote server:

| Path | What it is |
|---|---|
| `POST /mcp` | The MCP endpoint (Streamable HTTP). |
| `GET /healthz` | Liveness and the version it runs. |
| `GET /` | A short description of the service. |
| `GET /.well-known/oauth-protected-resource` | The OAuth metadata clients discover from the `WWW-Authenticate` header on a 401. |
| `GET /.well-known/mcp-config` | The API-key path, so a config-aware client (for example Smithery) can show a "paste your key" form instead of the OAuth button. |

**Directories and gateways.** The official MCP Registry entry ([`server.json`](https://github.com/cituna/cituna-mcp/blob/main/server.json), `com.cituna/cituna-mcp`) carries a `remotes` entry that tells registry-driven clients, and directories that mirror the registry such as PulseMCP and Glama, to connect directly to `https://mcp.cituna.com/mcp` and prompt for a personal API key. Nothing is routed through the directory.

**Versions.** The hosted URL always runs the newest release, and `npx -y cituna-mcp` fetches the newest one from npm. Pin a version with `npx -y cituna-mcp@<version>`; the npm badge above shows the current one, and `GET /healthz` reports what the hosted server runs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The first call returns 401 | That is the OAuth handshake: your client should open a browser to sign in. If it does not, the client lacks remote OAuth support. Send an API key header, or run `npx -y cituna-mcp`. |
| `Not signed in to Cituna` (HTTP 401) | The request reached `/mcp` without a credential. Send `Authorization: Bearer cituna_sk_...` (or `X-API-Key`). An anonymous caller cannot list tools either, which is intended. |
| 404 with "The MCP endpoint is /mcp" | The URL is missing the path. Use `https://mcp.cituna.com/mcp`, not `https://mcp.cituna.com`. |
| `Your Cituna access has expired or was revoked` (HTTP 401) | The token or key no longer works. A client that supports OAuth refreshes or reopens the sign-in on its own; otherwise reconnect, or create a new key. |
| `That is not a Cituna MCP credential` (HTTP 401) | Only `cituna_at_...` (browser sign-in) and `cituna_sk_...` (API key) are accepted. A session token copied from the web app is refused. |
| `No API key configured` (npm package) | No credential set. Generate a key (Integrations → Claude / MCP access) and set `CITUNA_API_KEY`. |
| `API key invalid, revoked, or the account no longer has access` | Keys never expire on their own: the key was revoked or mistyped, or the account lost access. Mint a new key. If the key is current, check `CITUNA_API_URL` has no trailing path and is not an origin that redirects: a cross-origin redirect strips the `Authorization` header. |
| A write tool says it needs Pro | You are on Starter, where the MCP is read-only. Do it in the app, or upgrade at [cituna.com/pricing](https://cituna.com/pricing). |
| Write tools refused on Pro or Max | The connection was approved without **Also allow changes**. Disconnect it under Integrations and connect again with the box ticked. |
| `requires a paid plan (Starter/Pro/Max)` | The trial and ended plans have no MCP access. Pick a plan at [cituna.com/pricing](https://cituna.com/pricing). |
| `{ "configured": false, ... }` from a `gsc_*` tool | Search Console is not connected, or no connected account holds a property for that domain. Follow the message, then check `gsc_status`. |
| `Rate limited (HTTP 429)` | The burst ceiling, not your monthly allowance. Wait the seconds it names and retry. A used-up monthly allowance is a plan-limit message (HTTP 402). |
| `invalid_target` during sign-in | The client asked for a token for a server that is not Cituna's. Self-hosting on your own domain: add its origin to `OAUTH_ALLOWED_RESOURCES` on the API. |
| `A connected app can only use Cituna's MCP tools` (HTTP 403) | Keys, password, billing and team changes need you signed in to the app in your browser. |
| Tools do not appear (npm package) | Check Node is 20 or later, and on Windows run `npx` through `cmd /c`. From source, run `npm run build` and use the absolute path to `dist/index.js`. Then check the client's MCP logs. |
| An engine shows `unavailable` | That engine gave no answer on that run. It is not a miss, it is not counted against you, and it is checked again automatically. |

## FAQ

**What is the Cituna MCP server?**
A Model Context Protocol server that connects your Cituna workspace to an AI agent. It reads your daily AI visibility tracking, the engine answers behind it, the pages engines cite, your audits, fix queue, keywords, AutoSEO articles and live Search Console data, and on Pro it can act: run a scan, change the prompts you track, move a fix along, queue, edit or refresh an article, and log outreach.

**Which AI engines does it cover?**
Seven, all checked daily: ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews and Google AI Mode. Google AI Overviews and Google AI Mode are tracked separately because they give different answers to the same query. Microsoft Copilot is not tracked.

**Does it work with ChatGPT?**
Yes. Turn on Developer mode, create an MCP app with the hosted URL and choose OAuth (steps [above](#chatgpt)). Developer mode comes with ChatGPT Plus, Pro, Business, Enterprise and Edu, on the web.

**Do I need to install anything?**
No. The hosted connector is a URL and a browser sign-in. Node 20 or later is only needed for the optional npm package.

**Is there a free plan?**
No free MCP. The server comes with every paid plan from Starter ($49/mo), read-only there; write tools come with Pro. The 3-day free trial is app-only.

**Can the agent change my data?**
Only on Pro or Max, only if you ticked **Also allow changes** when you approved it, and only through the nine write tools listed above. Clients that respect MCP annotations ask before each write, and ChatGPT always does.

**Is my Google data safe?**
The server never sees your Google credentials. Cituna holds a read-only Search Console grant server-side and queries Google for you; disconnecting in the app cuts off the MCP at once.

**Is Cituna the only AI visibility tool with an MCP server?**
No. Several AI visibility tools ship one, with different tools, plans and read or write access. Cituna's pairs daily tracking on seven engines with your Search Console data and AutoSEO writes, from $49. See the dated comparison at [cituna.com/learn/ai-visibility-tools-with-mcp-server](https://cituna.com/learn/ai-visibility-tools-with-mcp-server).

**Is there a REST API too?**
Yes. The same data is available over HTTPS with a bearer token for your own dashboards, agents and CI. See [cituna.com/developers](https://cituna.com/developers).

## Links

- **Product page and docs:** [cituna.com/mcp](https://cituna.com/mcp)
- **Pricing and plan limits:** [cituna.com/pricing](https://cituna.com/pricing)
- **Connect, keys and approved apps (in the app):** [cituna.com/integrations](https://cituna.com/integrations)
- **REST API:** [cituna.com/developers](https://cituna.com/developers)
- **AI visibility tools with an MCP server, compared:** [cituna.com/learn/ai-visibility-tools-with-mcp-server](https://cituna.com/learn/ai-visibility-tools-with-mcp-server)
- **npm package:** [cituna-mcp](https://www.npmjs.com/package/cituna-mcp)
- **Official MCP Registry:** [`com.cituna/cituna-mcp`](https://registry.modelcontextprotocol.io/v0/servers?search=cituna)
- **Source mirror:** [github.com/cituna/cituna-mcp](https://github.com/cituna/cituna-mcp)
- **Bugs and requests:** [GitHub issues](https://github.com/cituna/cituna-mcp/issues)
<!-- shared:end -->

## Looker Studio connector

This repository also carries [`looker-connector/`](./looker-connector), a Google Apps Script community connector for Looker Studio dashboards on your Cituna visibility data. Deploy `Code.gs` as a community connector, paste your `cituna_sk_...` key on the KEY auth screen, and build dashboards. Full setup: [`looker-connector/README.md`](./looker-connector/README.md).

## About this repository

This is a **published mirror**, not the working tree. Both integrations are developed in Cituna's private monorepo and released here automatically on tag, so the tool surface and the connector's engine list stay pinned to what the API actually serves.

Pull requests against this repo cannot be merged directly, but issues are read and acted on, so please do open them.

## License

MIT licensed. Bugs and requests: <https://github.com/cituna/cituna-mcp/issues>
