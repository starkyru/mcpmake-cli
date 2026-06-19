import type { Entry } from 'har-format';

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
  return entries.filter((entry) => {
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
}
