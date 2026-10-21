// Every piece of backend or transport error text that reaches an MCP client's chat
// passes through plainMessage first. Some of that text was written for our logs:
// a stack line, a database or network driver message, a host, a vendor's reply.

const INTERNAL_DETAIL: readonly RegExp[] = [
  /\bat\s+[\w$.<>[\]]+\s+\(/, // a stack frame: "at fn ("
  /\bat\s+(?:file:|node:|\/|[A-Za-z]:\\)/, // a stack frame with no function name
  /\.(?:[cm]?[jt]sx?)(?::\d+){1,2}\b/, // file.ts:12:3
  /node_modules|(?:^|[\s("'])\/(?:app|usr|home|var|opt|srv|tmp|root)\//,
  /[A-Za-z]:\\[\w\\.-]+/, // a Windows path
  /\bMongo\w*|\bBSON\w*|\bE11000\b|duplicate key/i,
  /\bE(?:CONNREFUSED|CONNRESET|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /\b(?:Type|Reference|Syntax|Range)Error\b/,
  /Cannot read propert|is not a function|is not defined|of undefined\b|of null\b/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // an IPv4 address
  /\blocalhost\b|\.internal\b|\.local\b|sslip\.io/i,
  /getaddrinfo|socket hang up|fetch failed|certificate|\bTLS\b|\bSSL\b/i,
  /googleapis|invalid_grant|invalid_client|\bgaxios\b|dataforseo|openai|anthropic|serpapi|brightdata/i,
  /status code \d{3}/i, // an HTTP client's own wording
  /\b[A-Z]{2,}(?:_[A-Z0-9]+){2,}\b/, // a server setting's name, e.g. GOOGLE_OAUTH_CLIENT_ID
];

const MAX_CHARS = 300;

/** The backend's message when it is plain customer copy, else `fallback`. */
export function plainMessage(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_CHARS || /[\r\n]/.test(text)) return fallback;
  if (INTERNAL_DETAIL.some((re) => re.test(text))) return fallback;
  return text;
}
