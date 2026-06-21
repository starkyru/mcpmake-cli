/**
 * Centralized failure exit with opt-in, redacted error reporting.
 *
 * Why a shared helper instead of wrapping citty's `runMain`: the commands don't
 * `throw` on user-facing failures — they call `logger.error(...)` and then
 * `process.exit(1)` directly. `process.exit()` terminates the event loop
 * synchronously and bypasses every `try/catch` (including citty's `runMain`
 * handler), so a wrapper around `runMain` would never observe these exits. The
 * only reliable place to hook reporting is the failure site itself, so each
 * command calls `await fail(...)` where it used to log-and-exit.
 *
 * Telemetry is strictly opt-in (consent modes `prompt` | `auto` | `off`), never
 * blocks or breaks the CLI (timeout + swallowed errors, mirroring
 * `fetchPricing`), and auto-degrades to `off` in non-TTY / CI environments so it
 * can never hang a pipeline waiting for input.
 */

import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola';
import { logger } from './logger.js';
import { loadConfig, globalConfig } from '../config/mcpmake-config.js';
import { DEFAULT_PRICING_SERVER } from '../pricing.js';

/**
 * Read this package's version from its own package.json at runtime so the
 * reported version never drifts from the published one. `package.json` always
 * sits two levels up from the compiled `dist/utils/fail.js` (and from this
 * source file), and npm always ships it. Best-effort: this runs on the failure
 * path, so any read/parse error degrades to `'unknown'` rather than throwing.
 */
function readCliVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const CLI_VERSION = readCliVersion();

/** How long to wait for the report POST before giving up (never blocks longer). */
const REPORT_TIMEOUT_MS = 4_000;

type ConsentMode = 'prompt' | 'auto' | 'off';

/** Server-side caps — fields are truncated to these lengths before sending. */
const CAPS = {
  command: 200,
  errorMessage: 2000,
  stack: 16_000,
  cliVersion: 40,
  platform: 60,
  nodeVersion: 40,
} as const;

interface ReportPayload {
  command: string;
  errorMessage: string;
  stack: string;
  cliVersion: string;
  platform: string;
  nodeVersion: string;
}

// --- Redaction helpers -----------------------------------------------------

/** Replace the user's home directory (and generic /Users|/home/<name>) with `~`. */
function redactHomePaths(input: string): string {
  let out = input;
  const home = os.homedir();
  if (home) {
    out = out.split(home).join('~');
  }
  // Catch home dirs other than the current user's (e.g. paths from logs/CI).
  out = out.replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
  return out;
}

/**
 * Strip common credential formats from a header/URL-bearing string, replacing
 * each secret value with `[redacted]` while keeping the surrounding structure
 * (scheme, header name, param name) so the report stays useful for debugging.
 *
 * Covers, case-insensitively: `Authorization` bearer/basic schemes, `Cookie` /
 * `Set-Cookie` header values, `x-api-key` / `api-key` / `apikey` header values,
 * and `token` / `api_key` / `access_token` / `key` / `sig` query-string params.
 * Every value pattern is `\S+` / `[^\s...]+` (no nested quantifiers), so there is
 * no catastrophic-backtracking risk.
 */
function redactSecrets(input: string): string {
  return (
    input
      // `Bearer <token>` / `Basic <base64>` (bare or after `Authorization:`).
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
      // `Cookie:` / `Set-Cookie:` — drop the whole value up to end of line.
      .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi, '$1: [redacted]')
      // `x-api-key` / `api-key` / `apikey` header values (`:`-delimited).
      .replace(/\b((?:x-)?api[-_]?key)\s*:\s*[^\s,;'"]+/gi, '$1: [redacted]')
      // Query-string secrets: `token=`, `api_key=`, `access_token=`, `key=`, `sig=`.
      .replace(/\b(access_token|api_key|apikey|token|sig|key)=[^\s&'"]+/gi, '$1=[redacted]')
  );
}

/**
 * Strip mcpmake tokens — both the legacy `mf_…` and the current `mfd_…` deploy
 * tokens. Deploy tokens are NOT lowercase-hex (e.g. `mfd_Secret-ABC123`), so the
 * value class must cover the full token charset. The boundary is `\b` plus a
 * single `+` quantifier (no nested quantifiers — no catastrophic backtracking).
 * The `mf`/`mfd` prefix is preserved so the redacted report stays informative.
 */
function redactMcpmakeTokens(input: string): string {
  return input.replace(/\bmf(d?)_[A-Za-z0-9._-]+/g, 'mf$1_[redacted]');
}

/**
 * Strip well-known LLM provider API keys by their published shapes, using
 * conservative token boundaries. Order matters: the more specific `sk-ant-` and
 * `sk-proj-` prefixes are matched before the generic `sk-…` so they keep their
 * descriptive prefix in the output. Every value class is a single `+`/`{n,}`
 * (no nested quantifiers — no catastrophic backtracking).
 *
 * - Anthropic: `sk-ant-…`
 * - OpenAI project keys: `sk-proj-…`
 * - OpenAI legacy keys: `sk-<>=10 chars>` (the generic fallback).
 */
function redactApiKeys(input: string): string {
  return input
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]+/g, 'sk-proj-[redacted]')
    .replace(/\bsk-[A-Za-z0-9]{10,}/g, 'sk-[redacted]');
}

/** Strip URL query strings (`?foo=bar` → `?[redacted]`) so creds in URLs don't leak. */
function redactQueryStrings(input: string): string {
  return input.replace(/\?[^\s'"]+/g, '?[redacted]');
}

/**
 * Apply every redaction pass. Run on both errorMessage and stack before use.
 *
 * Exported (as `redactText`) so the redaction contract can be unit-tested
 * directly without invoking `fail()` (which calls `process.exit`).
 */
export function redactText(input: string): string {
  return redactQueryStrings(
    redactApiKeys(redactMcpmakeTokens(redactSecrets(redactHomePaths(input)))),
  );
}

/** @deprecated internal alias — prefer the exported `redactText`. */
const redact = redactText;

function truncate(input: string, max: number): string {
  return input.length > max ? input.slice(0, max) : input;
}

// --- Payload assembly ------------------------------------------------------

/** Known top-level commands. Anything not in this set is never reported. */
const KNOWN_COMMANDS = new Set([
  'from',
  'merge',
  'verify',
  'update',
  'login',
  'logout',
  'whoami',
  'deploy',
  'publish',
  'lint',
  'diff',
  'bundle',
  'ci',
  'rescan',
  'pricing',
]);

/** Known `from <subcommand>` spec sources. */
const KNOWN_FROM_SUBCOMMANDS = new Set([
  'openapi',
  'har',
  'url',
  'describe',
  'postman',
  'website',
  'stainless',
]);

/**
 * Derive the telemetry command name from argv using a strict allowlist — e.g.
 * `from openapi` or `deploy`. The command name is NEVER taken from arbitrary
 * argv values: only recognized command/subcommand tokens are emitted, so a stray
 * secret or path positional (e.g. `login mfd_secret`, `deploy ./secret.yaml`)
 * can never become the reported command. An unrecognized first token yields `''`.
 *
 * Exported so this parsing contract can be unit-tested directly without invoking
 * `fail()` (which calls `process.exit`).
 */
export function deriveCommand(): string {
  const tokens = process.argv.slice(2).filter((t) => !t.startsWith('-'));
  const first = tokens[0];
  if (!first || !KNOWN_COMMANDS.has(first)) {
    return '';
  }
  if (first === 'from') {
    const sub = tokens[1];
    return sub && KNOWN_FROM_SUBCOMMANDS.has(sub) ? `from ${sub}` : 'from';
  }
  return first;
}

function buildPayload(message: string, error?: unknown): ReportPayload {
  const errorMessage = error instanceof Error && error.message ? error.message : message;
  const stack = error instanceof Error && error.stack ? error.stack : '';
  return {
    // `deriveCommand` already emits only allowlisted command tokens, so it can
    // never contain a secret; the `redact()` pass is kept as a defense-in-depth
    // second layer in case the allowlist ever grows a credential-shaped command.
    command: truncate(redact(deriveCommand()), CAPS.command),
    errorMessage: truncate(redact(errorMessage), CAPS.errorMessage),
    stack: truncate(redact(stack), CAPS.stack),
    cliVersion: truncate(CLI_VERSION, CAPS.cliVersion),
    platform: truncate(`${process.platform} ${process.arch}`, CAPS.platform),
    nodeVersion: truncate(process.version, CAPS.nodeVersion),
  };
}

// --- Consent ---------------------------------------------------------------

/** Inputs that decide telemetry consent, injectable so the logic is testable. */
export interface TelemetryEnv {
  /** The mode read from config (anything else is treated as the `prompt` default). */
  configured?: unknown;
  /** Whether stdout is an interactive TTY. */
  isTTY?: boolean;
  /** Whether we are running in CI (truthy `$CI`). */
  ci?: boolean;
}

/**
 * Pure consent resolver: given the configured mode and the environment, decide
 * the effective {@link ConsentMode}.
 *
 * Auto-degrades to `'off'` whenever there is no interactive TTY or we're in CI —
 * otherwise the CLI could hang waiting for input that will never come. Exported
 * so this branchy decision can be unit-tested without touching real env/config.
 */
export function resolveTelemetryMode(env: TelemetryEnv): ConsentMode {
  const value = env.configured;
  const mode: ConsentMode =
    value === 'prompt' || value === 'auto' || value === 'off' ? value : 'prompt';

  // Critical: never prompt or block when there is no interactive TTY or we're in
  // CI — otherwise the CLI hangs waiting for input that will never come.
  if (!env.isTTY || env.ci) {
    return 'off';
  }
  return mode;
}

/** Read the `telemetry` global config key; default `prompt`. Then apply env gates. */
function resolveConsent(): ConsentMode {
  let configured: unknown;
  try {
    const loaded = loadConfig();
    if (loaded) {
      configured = globalConfig(loaded.data).telemetry;
    }
  } catch {
    // A malformed config must never block a failure exit — keep the default.
  }

  return resolveTelemetryMode({
    // consola.prompt reads stdin and writes stdout, so require BOTH to be a TTY —
    // otherwise a redirected stream could let a prompt appear (or block) wrongly.
    configured,
    isTTY: Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY),
    ci: Boolean(process.env.CI),
  });
}

// --- Reporting -------------------------------------------------------------

function reportServer(): string {
  return process.env.MCPMAKE_SERVER || DEFAULT_PRICING_SERVER;
}

/** Multi-line preview of exactly what will be sent (already redacted). */
function previewReport(payload: ReportPayload): void {
  logger.info('');
  logger.info('Opt-in error report (redacted) — exactly what would be sent:');
  logger.info(`  command:     ${payload.command || '(none)'}`);
  logger.info(`  errorMessage: ${payload.errorMessage}`);
  if (payload.stack) {
    logger.info(`  stack:       ${payload.stack.split('\n')[0]} ...`);
  }
  logger.info(`  cliVersion:  ${payload.cliVersion}`);
  logger.info(`  platform:    ${payload.platform}`);
  logger.info(`  nodeVersion: ${payload.nodeVersion}`);
  logger.info('Not sent: no file contents, no environment variables, no secrets.');
  logger.info('');
}

/**
 * POST the report. Mirrors the AbortController + timeout + swallow-everything
 * pattern in `fetchPricing`: this must never throw or block the CLI. The server
 * rejects `Content-Encoding`, so we send a plain JSON body.
 */
async function sendReport(payload: ReportPayload): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const base = reportServer().replace(/\/+$/, '');
    await fetch(`${base}/api/telemetry/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Reporting is best-effort; a failure here must never affect the CLI.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Log a user-facing failure message, optionally report it (consent permitting),
 * then exit with code 1. Never throws; always exits.
 */
export async function fail(message: string, error?: unknown): Promise<never> {
  logger.error(message);

  const consent = resolveConsent();
  if (consent !== 'off') {
    const payload = buildPayload(message, error);
    try {
      if (consent === 'prompt') {
        previewReport(payload);
        const ok = await consola.prompt('Send this report?', { type: 'confirm' });
        if (ok === true) {
          await sendReport(payload);
        }
      } else {
        // auto: send silently.
        await sendReport(payload);
      }
    } catch {
      // Prompting/reporting must never get in the way of the exit.
    }
  }

  process.exit(1);
}
