# Cituna - Looker Studio connector

Bring your **Cituna** AI-visibility data into **Google Looker Studio**
(formerly Data Studio) as a native data source. Build dashboards, share them, and
schedule email exports off the same scans you see in the app: overall visibility
score, per-engine citation rates (ChatGPT, Perplexity, Gemini, Claude, Grok, Google AI
Overviews, Google AI Mode), SEO / GEO
/ authority scores, share of voice against competitors, and open-gap counts, per
scan and per domain.

It is a Google Apps Script **community connector**. It holds no secrets: it
authenticates with the same personal API key the Cituna MCP server uses (a
`cituna_sk_...` key you paste once), calls one read-only backend endpoint, and maps
the rows onto Looker fields.

```
Looker Studio  <->  this connector (Apps Script)  <->  (HTTPS + your key)  <->  Cituna backend
```

## Fields

Each row is one scan (a date x brand pair).

### Dimensions

| Field | Notes |
|---|---|
| Scan date | The day the scan ran. |
| Scan ID | Stable id for the scan. |
| Domain | The scanned domain. |
| Brand | Friendly brand name, falls back to the domain. |
| Score band | green / yellow / red band for the visibility score. |
| Authority source | `openpagerank` (real) or `estimated`. |
| Top competitor | The benchmarked competitor's domain. |

### Metrics

| Field | Aggregation | Notes |
|---|---|---|
| Visibility score | Average | Overall AI-visibility score. |
| SEO score / GEO score / Authority score | Average | On-site and authority readiness. |
| ChatGPT / Perplexity / Gemini / Claude / Grok / AI Overviews / AI Mode citation rate | Average | Share of prompts on that engine that cited you (shown as a percent). |
| ChatGPT / Perplexity / Gemini / Claude / Grok / AI Overviews / AI Mode citations | Sum | Prompts on that engine that cited you. |
| ChatGPT / Perplexity / Gemini / Claude / Grok / AI Overviews / AI Mode prompts | Sum | Prompts tested on that engine. |
| ChatGPT / Perplexity / Gemini / Claude / Grok / AI Overviews / AI Mode avg position | Average | Average rank of your mention when cited. |
| Brand citations | Sum | Times your brand was cited across engines. |
| Competitor citations | Sum | Times competitors were cited across engines. |
| Share of voice | Average | Your citations divided by all brand citations (percent). |
| Competitor SEO / GEO / Authority score | Average | The benchmarked competitor's scores. |
| Open gaps | Average | Open fix/gap count at scan time. |

> Citation rate is a ratio, so averaging it across many rows is approximate. For
> an exact blended rate, build a Looker calculated field: `SUM(<engine> citations)
> / SUM(<engine> prompts)`.

## Prerequisites

1. A Cituna account on a **paid plan** (Starter, Pro, or Max). Reporting is
   a paid feature, so the endpoint is plan-gated.
2. A **personal API key** (`cituna_sk_...`). See below.
3. [`clasp`](https://github.com/google/clasp) installed, or access to the
   [Apps Script](https://script.google.com) editor. `clasp` needs Node 14+.

### Get your API key

In the app: **Integrations -> "Claude / MCP access" -> Generate token**, then copy
the `cituna_sk_...` value. It is shown once. The same key powers the MCP server and
this connector, and you can revoke it in the app at any time. Do not paste it into
the script or commit it anywhere; you enter it in Looker's own auth prompt.

## Deploy the connector

You deploy this once (for yourself or your team); everyone who uses it then just
adds it in Looker and pastes their own key.

### Option A: clasp (recommended)

```bash
cd looker-connector
npm install                # pulls @google/clasp locally (optional; you can use a global clasp)
npx clasp login            # authorize clasp against your Google account

# Create a new standalone Apps Script project (writes .clasp.json for you):
npx clasp create --title "Cituna - Looker connector" --type standalone

npx clasp push             # upload Code.gs + appsscript.json
npx clasp deploy           # create a versioned deployment
```

Then get the **Deployment ID** you will paste into Looker:

```bash
npx clasp deployments      # copy the deployment id (starts with AKfyc...)
```

`.clasp.json` (which holds your real script id) is git-ignored. A template lives
in `.clasp.json.example`.

### Option B: Apps Script editor (no clasp)

1. Open <https://script.google.com> and create a **New project**.
2. Paste the contents of `Code.gs` into the editor.
3. Project Settings -> tick **"Show appsscript.json manifest file"**, then replace
   the manifest with the contents of `appsscript.json`.
4. **Deploy -> New deployment -> Type: Looker Studio community connector -> Deploy**.
5. Copy the **Deployment ID**.

## Use it in Looker Studio

1. Open the connector directly by deployment id:
   `https://lookerstudio.google.com/datasources/create?connectorId=YOUR_DEPLOYMENT_ID`
   (or **Create -> Data source** and pick it from **Your connectors** / **Build
   your own**).
2. Authorize the connector when prompted (it needs permission to call the
   Cituna API on your behalf).
3. On the **KEY** auth screen, paste your `cituna_sk_...` key and click **Submit**.
4. Optionally set a **Domain filter** to scope the report to one brand, then click
   **Connect**.
5. Add charts. Pick a date range in Looker; the connector passes it through to the
   backend.

To change or remove the key later, open the data source and use **Edit connection
-> Revoke credentials**, or generate a fresh key in the app and reconnect.

## How auth works (and why it is safe)

- No secret is hardcoded. Your key is entered through Looker's KEY auth flow and
  stored per-user in Apps Script `UserProperties`, not in this source.
- The connector sends the key as `Authorization: Bearer cituna_sk_...` to the backend
  over HTTPS. The backend resolves it to your workspace (the same path the MCP
  uses) and returns only your data.
- The backend keeps the database and any Google OAuth tokens. This connector never
  sees them.
- Revoking the key in the app (Integrations -> Claude / MCP access) cuts off this
  connector immediately.

## Plans

Reporting is available from the **Starter** plan and up (Starter / Pro / Max,
which map to internal `solo` / `agency` / `scale`). If a pull returns *"needs a
paid plan"*, upgrade at <https://cituna.com/pricing>. Plan enforcement is a
backend switch: while it is off, any signed-in key can pull, which is handy for
testing before launch.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "invalid credentials" when submitting the key | The key must start with `cituna_sk_` and be current. Generate a fresh one in the app (Integrations -> Claude / MCP access). |
| "This report needs a paid plan" | The endpoint is plan-gated and your plan is not eligible (or the key's workspace is on free). Upgrade at <https://cituna.com/pricing>. |
| Empty report / no rows | You may have no scans in the selected date range, or your Domain filter does not match any tracked brand. Widen the range or clear the filter. The endpoint returns an honest empty set rather than an error. |
| "Your API key was rejected" (401) | The key was revoked or is wrong. Reconnect with a current key. |
| Self-hosted backend | Set the **Backend URL** config field to your backend origin. Note: the key is first validated against `https://cituna.com`; if that cannot see your key, setup still proceeds and the first data pull hits your configured backend. |
| Changed a field / id | After editing `Code.gs`, run `clasp push` then **create a new deployment** (or update the existing one) so Looker picks up the change. |

## Files

| File | Purpose |
|---|---|
| `Code.gs` | The connector: auth (KEY), config, schema, and data mapping. |
| `appsscript.json` | Apps Script manifest with the `dataStudio` block. |
| `.clasp.json.example` | Template for your local `.clasp.json` (git-ignored). |
| `package.json` | Optional clasp convenience scripts (`npm run push` / `deploy`). |

## License

MIT. See [LICENSE](./LICENSE).
