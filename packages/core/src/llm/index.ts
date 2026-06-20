/**
 * LLM provider selection. Reads the environment and builds the active
 * {@link LlmProvider}; CLI flags populate that environment (see the CLI's
 * provider options) so core code never needs a provider parameter threaded
 * through every call.
 */
import { logger } from '../utils/logger.js';
import { isPrivateOrReservedIp, privateHostsAllowed } from '../utils/ssrf-guard.js';
import { type LlmProvider, type ProviderKind, PROVIDER_KINDS } from './types.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAiProvider } from './openai-provider.js';

export * from './types.js';

/**
 * SSRF guard for a provider base URL. A misconfigured `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` would send the API key to whatever host it names, so reject
 * non-http(s), malformed, and private/loopback/reserved hosts before the URL
 * reaches the SDK.
 *
 * Provider selection is synchronous (callers expect a sync API), so this does
 * the literal-IP/protocol checks that {@link assertPublicUrl} performs without
 * DNS, plus a string match for loopback hostnames (`localhost` and friends) so
 * the common `http://localhost:…` bypass is closed too. It still cannot resolve
 * an arbitrary hostname that maps to a private address (no DNS here) — that
 * residual gap matches {@link assertPublicUrl}'s own TOCTOU note. The
 * `MCPMAKE_ALLOW_PRIVATE_HOSTS` escape hatch (honored via
 * {@link privateHostsAllowed}) is what keeps trusted localhost endpoints like
 * Ollama working; operators must opt in for those.
 */
function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost');
}

function assertSafeBaseUrl(envVar: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envVar} is not a valid URL: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${envVar} must be an http(s) URL, got: ${value}`);
  }

  if (privateHostsAllowed()) return;

  // Strip IPv6 brackets from the hostname for literal checks.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isPrivateOrReservedIp(host) || isLoopbackHostname(host)) {
    throw new Error(
      `${envVar} points at private/loopback host ${host}; refusing to send credentials there. ` +
        `Set MCPMAKE_ALLOW_PRIVATE_HOSTS=1 to allow trusted localhost endpoints (e.g. Ollama).`,
    );
  }
}

/** Resolve the configured provider kind from `MCPMAKE_LLM_PROVIDER` (default: anthropic). */
export function resolveProviderKind(): ProviderKind {
  const raw = process.env.MCPMAKE_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'anthropic';
  if ((PROVIDER_KINDS as readonly string[]).includes(raw)) return raw as ProviderKind;
  logger.warn(`Unknown MCPMAKE_LLM_PROVIDER "${raw}" — falling back to "anthropic"`);
  return 'anthropic';
}

/** The env var that holds the API key for a given provider kind. */
function keyVarFor(kind: ProviderKind): string {
  return kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * Build the active LLM provider from the environment, or return `null` when it
 * is not usable (missing key, or an `openai-compatible` setup with no base
 * URL). Optional AI steps treat `null` as "warn and skip", exactly as the old
 * direct `ANTHROPIC_API_KEY` checks did. Required features should call
 * {@link requireLlmProvider} instead so they fail with a clear message.
 */
export function getLlmProvider(): LlmProvider | null {
  const kind = resolveProviderKind();

  if (kind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return null;
    const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
    if (baseURL) assertSafeBaseUrl('ANTHROPIC_BASE_URL', baseURL);
    return new AnthropicProvider({ apiKey, baseURL });
  }

  // openai / openai-compatible
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
  if (baseURL) assertSafeBaseUrl('OPENAI_BASE_URL', baseURL);

  if (kind === 'openai') {
    if (!apiKey) return null;
    return new OpenAiProvider({ apiKey, baseURL, kind });
  }

  // openai-compatible: self-hosted servers (Ollama, vLLM, …) frequently need no
  // key, but they do need an explicit endpoint.
  if (!baseURL) {
    logger.warn(
      'MCPMAKE_LLM_PROVIDER=openai-compatible requires OPENAI_BASE_URL — skipping AI step',
    );
    return null;
  }
  return new OpenAiProvider({ apiKey: apiKey || 'not-needed', baseURL, kind });
}

/**
 * Like {@link getLlmProvider} but throws a provider-aware error instead of
 * returning null — for features that cannot degrade (spec generation, goal
 * crawl).
 */
export function requireLlmProvider(feature: string): LlmProvider {
  const provider = getLlmProvider();
  if (provider) return provider;

  const kind = resolveProviderKind();
  const needs = keyVarFor(kind) + (kind === 'openai-compatible' ? ' and OPENAI_BASE_URL' : '');
  throw new Error(`${feature} requires an LLM provider. Set ${needs} (active provider: ${kind}).`);
}
