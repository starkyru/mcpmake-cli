/**
 * Shared `--target` (deployment target) support for the `from <source>` commands.
 *
 * `node` (default) emits a Node.js server; `cloudflare` emits a stateless
 * Cloudflare Workers project. The Workers target always runs as an HTTP Fetch
 * handler, so it overrides `--transport`.
 */
import { logger } from '@mcpmake/core';

export type EmitTarget = 'node' | 'cloudflare';

/** Citty arg definition — spread into a command's `args` block. */
export const targetArg = {
  type: 'string' as const,
  description: 'Deployment target: "node" (default) or "cloudflare" (Cloudflare Workers)',
  default: 'node',
};

export function resolveTarget(raw: unknown): EmitTarget {
  return raw === 'cloudflare' ? 'cloudflare' : 'node';
}

/** Workers is stateless HTTP-only; otherwise honour `--transport`. */
export function resolveTransport(target: EmitTarget, rawTransport: unknown): 'stdio' | 'http' {
  if (target === 'cloudflare') return 'http';
  return rawTransport === 'http' ? 'http' : 'stdio';
}

export function printWorkerNextSteps(output: string): void {
  logger.info('');
  logger.info('Next steps:');
  logger.info(`  cd ${output}`);
  logger.info('  npm install');
  logger.info('  cp .dev.vars.example .dev.vars  # fill in MCP_AUTH_TOKEN + API credentials');
  logger.info('  npm run dev            # local Workers runtime (wrangler dev)');
  logger.info('  npx wrangler secret put MCP_AUTH_TOKEN   # then each API credential');
  logger.info('  npx wrangler deploy');
}
