// ─── Cituna API client (used by the MCP server) ───────────────────────
// A thin HTTP client over the Cituna backend. It never talks to Google or
// MongoDB directly — all Google Search Console access goes through the backend,
// which owns the per-workspace OAuth refresh token. This client only needs to
// authenticate AS a user, which the backend accepts three ways (in priority):
//
//   1. CITUNA_API_KEY — a personal API key (cituna_sk_…) generated in the app's
//      Integrations page. RECOMMENDED: long-lived, revocable, not your password.
//      Sent as `Authorization: Bearer cituna_sk_…`.
//   2. CITUNA_TOKEN  — a session JWT you already have (the app's `cituna_token`
//      cookie). Works, but expires ~30 days after issue.
//   3. CITUNA_EMAIL + CITUNA_PASSWORD — email/password login. The client
//      logs in, extracts the minted JWT from the Set-Cookie response, caches it,
//      and silently re-logs-in when the token expires (on any 401).
//
// All paths converge on a single bearer credential. Nothing is written to disk.

export type ClientOptions = {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  email?: string;
  password?: string;
};

type AuthKind = "api-key" | "token" | "login" | "none";

export class CitunaApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "CitunaApiError";
    this.status = status;
    this.body = body;
  }
}

export class CitunaClient {
  private baseUrl: string;
  private token: string | null;
  private email?: string;
  private password?: string;
  private canRelogin: boolean;
  private authKind: AuthKind;
  // The MCP tool currently being served. Stamped on every backend call as
  // `X-Cituna-Mcp-Tool` so the backend can apply the read/write plan split (write
  // tools are Pro+) and attribute per-tool MCP volume. Set via beginTool() at the
  // top of each tool handler; harmless (backend ignores it) for read tools.
  private activeTool: string | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    // Priority: API key → session token → email/password. Keys and tokens are
    // used directly as the bearer; only email/password can re-login on expiry.
    const apiKey = opts.apiKey?.trim() || "";
    const token = opts.token?.trim() || "";
    this.email = opts.email?.trim() || undefined;
    this.password = opts.password || undefined;
    this.canRelogin = !!(this.email && this.password);
    this.token = apiKey || token || null;
    this.authKind = apiKey ? "api-key" : token ? "token" : this.canRelogin ? "login" : "none";
    // Deliberately do NOT throw when unconfigured: the server must still boot and
    // list its tools without credentials (so `tools/list` works and clients can
    // introspect). Each tool call checks hasCredentials() and returns a clean,
    // actionable error instead of crashing the process at startup.
  }

  /** Whether any credential (key / token / login) is configured. */
  hasCredentials(): boolean {
    return this.authKind !== "none";
  }

  /** Record which MCP tool is being served, so backend calls carry X-Cituna-Mcp-Tool. */
  beginTool(tool: string): void {
    this.activeTool = tool || null;
  }

  /** Human-readable summary of how the client is configured (no secrets). */
  describeAuth(): string {
    switch (this.authKind) {
      case "api-key": return "personal API key (CITUNA_API_KEY)";
      case "token": return "session token (CITUNA_TOKEN)";
      case "login": return `email/password login as ${this.email}`;
      default: return "unconfigured";
    }
  }

  // ── GET / POST helpers returning parsed JSON ───────────────────────────────
  async get(path: string, query?: Record<string, string | number | undefined>): Promise<any> {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return this.request("GET", path + qs);
  }

  async post(path: string, body?: unknown): Promise<any> {
    return this.request("POST", path, body);
  }

  // ── Server-Sent-Events consumer for POST /api/scan ─────────────────────────
  // The scan endpoint streams progress frames (event:<type>\ndata:<json>\n\n) and
  // finishes with a `complete` frame carrying the full result. We read the stream
  // to completion, collect the progress stage names, and return the final result.
  // Aborts (clean error) after `timeoutMs`. A non-2xx / auth failure surfaces as a
  // CitunaApiError, exactly like the JSON helpers, so callers map it uniformly.
  async runScanStream(
    body: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ result: any; progress: string[] }> {
    const timeoutMs = opts.timeoutMs ?? 300000; // 5 min default
    const token = await this.ensureToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.baseUrl + "/api/scan", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Cituna-Client": "mcp", // lets the backend meter + cap MCP call volume
          ...(this.activeTool ? { "X-Cituna-Mcp-Tool": this.activeTool } : {}), // read/write plan split
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* raw text */ }
        const msg =
          (parsed && typeof parsed === "object" && (parsed as any).error) ||
          (parsed && typeof parsed === "object" && (parsed as any).message) ||
          `HTTP ${res.status}`;
        throw new CitunaApiError(res.status, String(msg), parsed);
      }
      if (!res.body) throw new Error("Scan response had no stream body.");

      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const progress: string[] = [];
      let finalResult: any = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            let evt: any;
            try { evt = JSON.parse(json); } catch { continue; }
            if (evt.type === "error") throw new Error(evt.message || "scan failed");
            if (evt.type === "complete") finalResult = evt.result;
            else if (evt.type) progress.push(evt.type);
          }
          if (finalResult) break;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          throw new Error(`Scan timed out after ${Math.round(timeoutMs / 1000)}s.`);
        }
        throw e;
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
      }

      if (!finalResult) throw new Error("Scan stream ended without a complete result.");
      return { result: finalResult, progress };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error(`Scan timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Core request with one automatic re-login on 401 ────────────────────────
  private async request(method: string, path: string, body?: unknown, isRetry = false): Promise<any> {
    const token = await this.ensureToken();
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Cituna-Client": "mcp", // lets the backend meter + cap MCP call volume
        ...(this.activeTool ? { "X-Cituna-Mcp-Tool": this.activeTool } : {}), // read/write plan split
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Expired/invalid session → drop the token and re-login once (if we can).
    if (res.status === 401 && this.canRelogin && !isRetry) {
      this.token = null;
      return this.request(method, path, body, true);
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as raw text */
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && (parsed as any).error) ||
        (parsed && typeof parsed === "object" && (parsed as any).message) ||
        `HTTP ${res.status}`;
      throw new CitunaApiError(res.status, String(msg), parsed);
    }
    return parsed;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.canRelogin) throw new Error("Not authenticated and no email/password to log in with.");
    this.token = await this.login();
    return this.token;
  }

  private async login(): Promise<string> {
    const res = await fetch(this.baseUrl + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Login failed (HTTP ${res.status})${t ? ": " + t.slice(0, 200) : ""}`);
    }
    // The JWT is returned as the `cituna_token` cookie, not in the JSON body. Prefer
    // getSetCookie() (array, one entry per cookie); fall back to the combined header.
    const cookies: string[] =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
    for (const c of cookies) {
      const m = /(?:^|[;,\s])cituna_token=([^;]+)/.exec(c);
      if (m && m[1]) return decodeURIComponent(m[1]);
    }
    throw new Error(
      "Login succeeded but no cituna_token cookie was returned — cannot obtain a session token.",
    );
  }
}
