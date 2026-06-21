/**
 * LLM provider selection. Reads the environment and builds the active
 * {@link LlmProvider}; CLI flags populate that environment (see the CLI's
 * provider options) so core code never needs a provider parameter threaded
 * through every call.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
 * This is DNS-aware: a literal private IP or loopback hostname (`localhost` and
 * friends) is rejected on a synchronous fast path, and any other hostname is
 * resolved via DNS so a name like `localtest.me` that maps to `127.0.0.1` is
 * caught too. DNS failure is treated as fatal — we refuse rather than ship the
 * API key to a host we cannot verify is public.
 *
 * Residual limitation (same as {@link assertPublicUrl}): this resolves at
 * config-check time but does not pin DNS at the SDK's socket, so a
 * TOCTOU/DNS-rebinding attacker who flips the record between this lookup and the
 * SDK's own connect can still slip through. SDK-level socket DNS-pinning is out
 * of scope. The `MCPMAKE_ALLOW_PRIVATE_HOSTS` escape hatch (honored via
 * {@link privateHostsAllowed}) is what keeps trusted localhost endpoints like
 * Ollama working; operators must opt in for those.
 */
function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost');
}

async function assertSafeBaseUrl(envVar: string, value: string): Promise<void> {
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

  const refuse = (target: string): never => {
    throw new Error(
      `${envVar} points at private/loopback host ${target}; refusing to send credentials there. ` +
        `Set MCPMAKE_ALLOW_PRIVATE_HOSTS=1 to allow trusted localhost endpoints (e.g. Ollama).`,
    );
  };

  // Synchronous fast path: literal IP or a loopback hostname.
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) refuse(host);
    return;
  }
  if (isLoopbackHostname(host)) refuse(host);

  // Non-literal hostname: resolve every address and reject if ANY is private.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(
      `${envVar} host "${host}" could not be resolved to verify it is public; refusing request.`,
    );
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(
        `${envVar} host "${host}" resolves to private/reserved address ${address}; ` +
          `refusing to send credentials there. Set MCPMAKE_ALLOW_PRIVATE_HOSTS=1 to allow.`,
      );
    }
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
export async function getLlmProvider(): Promise<LlmProvider | null> {
  const kind = resolveProviderKind();

  if (kind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return null;
    const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
    if (baseURL) await assertSafeBaseUrl('ANTHROPIC_BASE_URL', baseURL);
    return new AnthropicProvider({ apiKey, baseURL });
  }

  // openai / openai-compatible
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
  if (baseURL) await assertSafeBaseUrl('OPENAI_BASE_URL', baseURL);

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
export async function requireLlmProvider(feature: string): Promise<LlmProvider> {
  const provider = await getLlmProvider();
  if (provider) return provider;

  const kind = resolveProviderKind();
  const needs = keyVarFor(kind) + (kind === 'openai-compatible' ? ' and OPENAI_BASE_URL' : '');
  throw new Error(`${feature} requires an LLM provider. Set ${needs} (active provider: ${kind}).`);
}
