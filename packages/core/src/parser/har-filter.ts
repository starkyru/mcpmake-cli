import type { Cookie, Entry, Header } from 'har-format';

const REDACTED = '<redacted>';

/**
 * Headers whose value is a credential and must be scrubbed from recorded HAR.
 * We keep the header NAME (and, for Authorization, the scheme word) so auth
 * detection downstream still works, but strip the secret material.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'authorization-token',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
]);

// Authorization values are `<scheme> <credential>`; keep the scheme so
// downstream auth detection can still classify bearer/basic/token.
const AUTH_SCHEME_PATTERN = /^(\s*[A-Za-z][\w-]*\s+)\S[\s\S]*$/;

/**
 * Redact the secret value of a single header in place, preserving the header
 * name (and the auth scheme word for Authorization-style headers) so auth
 * detection still sees a scheme exists.
 */
function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === 'cookie') return redactCookiePairs(value);
  if (lower === 'set-cookie') return redactSetCookie(value);
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const m = AUTH_SCHEME_PATTERN.exec(value);
    if (m) return `${m[1].trimStart()}${REDACTED}`;
  }
  return REDACTED;
}

/** Replace a single `name[=value]` segment's value with the redaction marker. */
function redactPairValue(pair: string): string {
  const eq = pair.indexOf('=');
  if (eq === -1) return pair; // attribute flag (e.g. `Secure`) — no value.
  return `${pair.slice(0, eq)}=${REDACTED}`;
}

/**
 * Cookie request header: every `;`-separated segment is a `name=value` cookie.
 * `s=Y; foo=bar` becomes `s=<redacted>; foo=<redacted>` (names kept).
 */
function redactCookiePairs(value: string): string {
  return value
    .split(';')
    .map((part) => part.replace(/^(\s*)(.*)$/, (_, ws, body) => ws + redactPairValue(body)))
    .join(';');
}

/**
 * Set-Cookie response header: only the FIRST segment is the cookie `name=value`;
 * the rest (Path, Domain, Expires, Secure, ...) are attributes carrying no
 * secret, so they are preserved verbatim to keep the HAR shape intact.
 */
function redactSetCookie(value: string): string {
  const semi = value.indexOf(';');
  if (semi === -1) return redactCookiePairs(value);
  const head = value.slice(0, semi);
  const rest = value.slice(semi); // includes leading ';'
  return redactCookiePairs(head) + rest;
}

function redactHeaders(headers: Header[] | undefined): void {
  if (!headers) return;
  for (const header of headers) {
    if (SENSITIVE_HEADERS.has(header.name.toLowerCase())) {
      header.value = redactHeaderValue(header.name, header.value);
    }
  }
}

function redactCookies(cookies: Cookie[] | undefined): void {
  if (!cookies) return;
  for (const cookie of cookies) {
    cookie.value = REDACTED;
  }
}

/**
 * Scrub credentials out of a HAR entry in place: Authorization/Cookie/API-key
 * request & response headers, and the parsed request/response cookie arrays.
 * Recorded HAR is persisted to disk, so this prevents live secrets leaking in
 * cleartext. Safe to call more than once (redaction is idempotent).
 */
export function redactEntrySecrets(entry: Entry): Entry {
  redactHeaders(entry.request?.headers);
  redactHeaders(entry.response?.headers);
  redactCookies(entry.request?.cookies);
  redactCookies(entry.response?.cookies);
  return entry;
}

const NOISE_EXTENSIONS =
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webp|avif)(\?|$)/i;

const ANALYTICS_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'hotjar.com',
  'doubleclick.net',
  'facebook.net',
  'fbcdn.net',
  'sentry.io',
  'newrelic.com',
  'datadoghq.com',
  'clarity.ms',
];

const SKIP_MIME_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'text/javascript',
  'image/',
  'font/',
  'audio/',
  'video/',
];

export interface FilterOptions {
  /** Only include entries from these domains. If empty, include all. */
  allowedDomains?: string[];
  /** Include requests that returned errors (4xx/5xx). Default: false */
  includeErrors?: boolean;
}

export function filterHarEntries(entries: Entry[], options: FilterOptions = {}): Entry[] {
  const kept = entries.filter((entry) => {
    const url = entry.request.url;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }

    // Skip non-HTTP methods
    const method = entry.request.method.toUpperCase();
    if (method === 'CONNECT' || method === 'OPTIONS') return false;

    // Skip static assets by extension
    const pathname = new URL(url).pathname;
    if (NOISE_EXTENSIONS.test(pathname)) return false;

    // Skip analytics/tracking domains
    if (ANALYTICS_DOMAINS.some((d) => hostname.includes(d))) return false;

    // Domain allowlist
    if (options.allowedDomains?.length) {
      if (!options.allowedDomains.some((d) => hostname.includes(d))) return false;
    }

    // Skip error responses unless requested
    if (!options.includeErrors && entry.response.status >= 400) return false;

    // Skip non-API content types in response
    const responseMime = entry.response.content?.mimeType ?? '';
    if (SKIP_MIME_TYPES.some((m) => responseMime.startsWith(m))) {
      // Exception: text/html that's actually an API response (rare but possible)
      // Keep if response body looks like JSON
      if (responseMime.startsWith('text/html') && !entry.response.content?.text?.startsWith('{')) {
        return false;
      }
      if (!responseMime.includes('json') && !responseMime.includes('xml')) {
        return false;
      }
    }

    return true;
  });

  // Scrub credentials before the HAR (or anything derived from it) is persisted.
  for (const entry of kept) redactEntrySecrets(entry);
  return kept;
}
