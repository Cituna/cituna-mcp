# Cituna — MCP server & Looker Studio connector

[![npm](https://img.shields.io/npm/v/cituna-mcp)](https://www.npmjs.com/package/cituna-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Two client integrations for [Cituna](https://cituna.com), which tracks how AI answer
engines — ChatGPT, Perplexity, Gemini, Claude, Grok and Google AI Overviews — mention
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

Read tools work on Starter and above. `run_scan` and `set_gap_status` write, and
require Pro.

| Tool | Does |
|---|---|
| `whoami` | Confirm the connection, plan and usage meters. Start here. For Search Console state use `gsc_status`. |
| `list_brands` | Brands/domains tracked in your workspace |
| `get_visibility` | The daily prompt × engine grid: cited or not, position, per-cell status |
| `get_engine_answers` | What an engine actually said for a prompt, and who it cited instead |
| `list_audits` / `get_audit` | Scan history and a single scan's scores |
| `list_gaps` / `set_gap_status` | The fix queue, and moving items through todo → doing → done |
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

### Built-in prompts (v1.5+)

Five reusable analysis workflows, surfaced in Claude's prompt picker via the MCP
prompts API. Each encodes a join between Search Console data and the engines'
actual answer text:

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
