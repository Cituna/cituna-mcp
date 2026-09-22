# Cituna — MCP server & Looker Studio connector

[![npm](https://img.shields.io/npm/v/cituna-mcp)](https://www.npmjs.com/package/cituna-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**The AI visibility tool you use from inside the AI.** Every other tool in this
category hands you a dashboard and leaves the thinking to you. Cituna puts the
measurements where you already do the reasoning: ask Claude why ChatGPT never
mentions you, and it can pull the answer receipts, cross-check them against what
Google already sends you, and queue the page that fixes it, without you opening
a tab.

**Links:** [npm package](https://www.npmjs.com/package/cituna-mcp) ·
[MCP registry listing](https://registry.modelcontextprotocol.io/v0/servers?search=cituna)
(`com.cituna/cituna-mcp`) · [docs and pricing](https://cituna.com/mcp)

Two client integrations for [Cituna](https://cituna.com), which tracks how AI answer
engines — ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI Overviews and Google AI Mode — mention
and cite your brand.

Both are thin clients over the Cituna REST API. They hold no secrets: you paste a
personal API key, and everything else (Google OAuth refresh tokens, the database, the
scan pipeline) stays server-side.

| | What it is |
|---|---|
| **`cituna-mcp`** (this package) | An MCP server, so Claude can query your visibility data, gaps and Search Console directly |
| **[`looker-connector/`](./looker-connector)** | A Google Apps Script community connector for Looker Studio dashboards |

---

## MCP server

### Install

```bash
npx cituna-mcp
```

Or wire it into Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "cituna": {
      "command": "npx",
      "args": ["-y", "cituna-mcp"],
      "env": { "CITUNA_API_KEY": "cituna_sk_..." }
    }
  }
}
```

Generate a key in the app under **Integrations → Claude / MCP access**. It is shown
once. The same key works for the Looker connector.

### Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CITUNA_API_KEY` | yes | — | Personal API key, `cituna_sk_…` |
| `CITUNA_API_URL` | no | `https://cituna.com` | Point at a local backend for development |

### Tools

Twelve read tools work on Starter and above (one exception: `list_keywords`
reads the keyword dataset that is part of Pro). The four write tools —
`run_scan`, `set_gap_status`, `queue_article` and `mark_article_published` —
require Pro. The 3-day trial is app-only and has no MCP access.

| Tool | Does |
|---|---|
| `whoami` | Confirm the connection, plan and usage meters. Start here. For Search Console state use `gsc_status`. |
| `list_brands` | Brands/domains tracked in your workspace |
| `get_visibility` | The daily prompt × engine grid: cited or not, position, per-cell status |
| `get_engine_answers` | What an engine actually said for a prompt, and who it cited instead |
| `list_audits` / `get_audit` | Scan history and a single scan's scores |
| `list_gaps` / `set_gap_status` | The fix queue, and moving items through todo → doing → done |
| `list_keywords` | Keywords with real demand, each with the stage of the page behind it. Filter `stage: "none"` for demand nothing has been written for yet. Needs Pro (the keyword dataset is a Pro feature) |
| `list_content_queue` | What AutoSEO already has in flight, so you never queue a topic twice |
| `queue_article` | Queue a keyword so AutoSEO drafts it on the next run |
| `mark_article_published` | Tell Cituna a page is live, so it stops suggesting the topic and never writes a competing page |
| `gsc_status` / `gsc_overview` / `gsc_query` | Google Search Console, if connected |
| `run_scan` | Trigger a fresh scan |

### Connecting Google Search Console

The `gsc_*` tools need a one-time connect **in the Cituna app** (Integrations →
Connect Google Search Console, paid plans). Google asks for **read-only**
Search Console access; pick the Google account where your domain is a **verified
property**, or every query will come back empty. Verify with `gsc_status`, which
lists the connected account and its queryable properties. Disconnecting in the
app revokes this server's access instantly. There is no Google OAuth in this
server itself: consent happens in the app and the refresh token stays
server-side.

### What it looks like

A real first conversation, once the key is set:

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

### Built-in prompts

Five reusable analysis workflows, surfaced in Claude's prompt picker via the MCP
prompts API. You do not have to pick one from the picker: the server tells Claude
which workflow matches which kind of question, so plain English routes itself.
Each encodes a join between Search Console data and the engines' actual answer
text:

- **`why-am-i-not-cited`** — classifies every uncited prompt: invisible everywhere, Google-visible but AI-invisible, or partially cited, with evidence
- **`gsc-to-ai-gap`** — queries with real Google impressions where AI never cites you
- **`competitor-teardown`** — who the engines actually cite, diffed against your configured competitor list
- **`weekly-review`** — wins, regressions, and the week's 3 actions; reads only
- **`prioritize-fixes`** — re-ranks the fix queue by the impressions each gap touches

None of them triggers a paid scan on its own.

### Troubleshooting

**"API key invalid, revoked, or the account no longer has access"** — regenerate
under Integrations → Claude / MCP access (keys never expire on their own; this
means the key was revoked or mistyped, or the account lost access). If the key is
definitely current, check `CITUNA_API_URL` has no trailing path and is not an
origin that redirects: a cross-origin redirect strips the `Authorization` header,
which surfaces as this exact message.

**Requires Node 18.17+.**

---

## Looker Studio connector

See [`looker-connector/README.md`](./looker-connector/README.md) for the full setup.
Summary: deploy `Code.gs` as a Google Apps Script community connector, paste your
`cituna_sk_…` key on the KEY auth screen, and build dashboards on your visibility
data.

---

## About this repository

This is a **published mirror**, not the working tree. Both integrations are developed
in Cituna's private monorepo and released here automatically on tag, so the connector's
engine list stays pinned to what the API actually serves.

Pull requests against this repo can't be merged directly — but issues are read and
acted on, so please do open them.

MIT licensed. Bugs and requests: <https://github.com/cituna/cituna-mcp/issues>
