// Per-client-IP budget for refused credentials on the hosted MCP. Each unknown
// credential costs the backend a lookup, so a flood of made-up tokens is capped
// per caller. Good and cached credentials never spend from it.

// Loopback, private, link-local and carrier-grade NAT ranges: the hops of our own
// proxy chain, never a caller on the open internet.
export function isInternalIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (!v) return true;
  if (v.includes(":")) return v === "::1" || /^f[cd]/i.test(v) || /^fe[89ab]/i.test(v);
  const p = v.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 0;
}

function normalizeIp(ip: string): string {
  return String(ip || "").trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "").replace(/%.*$/, "");
}

// X-Forwarded-For is believed only when the socket peer is one of our own hops,
// and then read from the right: the first address that is not ours is the one our
// edge saw. Entries a caller prepends sit to the left of it and are ignored.
export function trustedClientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  const peer = normalizeIp(remoteAddress ?? "");
  if (peer && !isInternalIp(peer)) return peer;
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isInternalIp(chain[i])) return chain[i];
  }
  return peer || "unknown";
}

type Bucket = { tokens: number; at: number };

export class RefusalLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private opts: { perMinute: number; maxKeys?: number }) {}

  private level(key: string, now: number): Bucket {
    const cap = this.opts.perMinute;
    const b = this.buckets.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * cap);
    b.at = now;
    return b;
  }

  /** Seconds until this caller may present another unchecked credential; 0 = now. */
  retryAfter(key: string, now = Date.now()): number {
    if (!(this.opts.perMinute > 0)) return 0;
    const b = this.level(key, now);
    return b.tokens >= 1 ? 0 : Math.max(1, Math.ceil(((1 - b.tokens) * 60) / this.opts.perMinute));
  }

  /** Spend one refusal for this caller. */
  refused(key: string, now = Date.now()): void {
    if (!(this.opts.perMinute > 0)) return;
    const b = this.level(key, now);
    b.tokens = Math.max(0, b.tokens - 1);
    this.buckets.delete(key); // re-insert so the map stays ordered oldest first
    this.buckets.set(key, b);
    const max = this.opts.maxKeys ?? 10_000;
    while (this.buckets.size > max) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
