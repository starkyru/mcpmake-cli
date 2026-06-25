import type { ProjectManifest } from '../types/index.js';
import type { CodeUnit } from './code-writer.js';
import { renderTemplate } from './template-loader.js';
import { buildMcpUiModule } from './mcp-ui.js';
import { buildA2aModule } from './a2a.js';
import { buildCompositeToolsModule } from './composite-tools.js';

/**
 * At/above this tool count, registering every tool upfront is a real token-cost
 * problem; the README recommends `--dynamic-discovery` (the #1 buyer concern).
 */
export const DISCOVERY_RECOMMEND_THRESHOLD = 50;

/**
 * Escape an arbitrary string for use as a single-line dotenv value in the
 * generated `.env.example` (the file users are told to copy to `.env`).
 *
 * Untrusted values (e.g. a Stainless `defaultEnvironment` name, a base URL) are
 * interpolated raw by Handlebars (`noEscape: true`), so a value containing a
 * newline or `#` could inject extra `KEY=value` lines or a comment — config
 * injection into the operator's `.env`. We collapse all line breaks to a single
 * space and wrap the value in double quotes (dotenv treats a quoted value as a
 * single token) whenever it contains a character that would otherwise change how
 * dotenv parses the line. Lossless for benign values (those are returned as-is).
 */
export function escapeDotenvValue(raw: string): string {
  // Neutralize any CR/LF — these are what break out into new dotenv lines.
  const oneLine = raw.replace(/[\r\n]+/g, ' ');
  // A bare value is safe only when it has no characters dotenv treats specially
  // at the start/inside an unquoted value (#, quotes, backslash, surrounding ws).
  const needsQuoting = /[#"'\\]/.test(oneLine) || /^\s|\s$/.test(oneLine) || oneLine !== raw;
  if (!needsQuoting) return oneLine;
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function scaffoldProjectFiles(manifest: ProjectManifest): CodeUnit[] {
  const dynamicDiscovery = manifest.dynamicDiscovery ?? false;
  const units: CodeUnit[] = [
    {
      filePath: 'package.json',
      content: renderTemplate('package.json', manifest),
    },
    {
      filePath: 'tsconfig.json',
      content: renderTemplate('tsconfig.json', manifest),
    },
    {
      filePath: '.env.example',
      content: renderTemplate('env.example', {
        ...manifest,
        // Serialize every untrusted scalar through the dotenv escaper at this
        // emit boundary so a value with a newline/`#` cannot inject extra lines.
        baseUrl: escapeDotenvValue(manifest.baseUrl),
        defaultEnvironment: manifest.defaultEnvironment
          ? escapeDotenvValue(manifest.defaultEnvironment)
          : manifest.defaultEnvironment,
        authEnvVars: manifest.envVars.filter((v) => v.name !== 'BASE_URL'),
        // Pre-seed MCP_ENVIRONMENTS when an importer carried over named
        // environments (e.g. Stainless `environments:`); omitted otherwise.
        // JSON.stringify already escapes the keys/values into a single token.
        environmentsJson:
          manifest.environments && Object.keys(manifest.environments).length > 0
            ? JSON.stringify(manifest.environments)
            : undefined,
      }),
    },
    {
      filePath: '.gitignore',
      content: renderTemplate('gitignore', manifest),
    },
    {
      filePath: 'README.md',
      content: renderTemplate('readme.md', {
        ...manifest,
        authEnvVars: manifest.envVars.filter((v) => v.name !== 'BASE_URL'),
        dynamicDiscovery,
        recommendDiscovery:
          !dynamicDiscovery && manifest.tools.length >= DISCOVERY_RECOMMEND_THRESHOLD,
      }),
    },
  ];

  if (manifest.transport === 'http') {
    units.push({
      filePath: 'Dockerfile',
      content: renderTemplate('dockerfile', manifest),
    });
  }

  return units;
}

export function scaffoldSharedModules(manifest: ProjectManifest): CodeUnit[] {
  const hasOAuth = manifest.authSchemes.some((s) => s.type === 'oauth2');
  const hasDynamicDiscovery = manifest.dynamicDiscovery ?? false;
  const hasStaticTools = !hasDynamicDiscovery || (manifest.staticToolCount ?? 0) > 0;
  const hasAsyncTools = manifest.tools.some((t) => t.isAsync);
  const hasMcpUi = manifest.mcpUi ?? false;
  const hasA2a = manifest.a2a ?? false;
  const hasCompositeTools = (manifest.compositeTools?.length ?? 0) > 0;
  const templateData = {
    ...manifest,
    hasResources: (manifest.resources?.length ?? 0) > 0,
    hasPrompts: (manifest.prompts?.length ?? 0) > 0,
    hasOAuth,
    hasDynamicDiscovery,
    hasStaticTools,
    hasAsyncTools,
    hasMcpUi,
    hasA2a,
    hasCompositeTools,
  };
  const units: CodeUnit[] = [
    {
      filePath: 'src/index.ts',
      content: renderTemplate(
        manifest.transport === 'http' ? 'server-main-http.ts' : 'server-main.ts',
        templateData,
      ),
    },
    {
      filePath: 'src/config.ts',
      content: renderTemplate('config.ts', manifest),
    },
    {
      filePath: 'src/auth.ts',
      content: renderTemplate('auth-provider.ts', templateData),
    },
    {
      filePath: 'src/http.ts',
      content: renderTemplate('http-executor.ts', manifest),
    },
    {
      // Minimal dependency-free jq subset for the per-call `jq_filter` argument
      // and any build-time x-mcp-jq-filter.
      filePath: 'src/response-filter.ts',
      content: renderTemplate('response-filter.ts', manifest),
    },
    {
      // W3C Trace Context — the executor stamps the active traceparent onto
      // upstream calls; the HTTP server establishes the context per request.
      filePath: 'src/trace.ts',
      content: renderTemplate('trace.ts', manifest),
    },
    {
      filePath: 'src/types.ts',
      content: renderTemplate('types.ts', manifest),
    },
  ];

  // MCP Apps output: also ship a ui:// tool-launcher module (registered in src/index.ts
  // via the hasMcpUi template branch).
  if (hasMcpUi) {
    units.push({
      filePath: 'src/mcp-ui.ts',
      content: buildMcpUiModule(
        manifest.serverName,
        manifest.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
      ),
    });
  }

  // Composite tools: also ship a composite-tools module that registers each
  // declared composite (one tool spanning several existing tools), registered in
  // src/index.ts via the hasCompositeTools template branch. buildCompositeToolsModule
  // validates every step/returns/tool reference and throws a clear build error on
  // any invalid reference.
  if (hasCompositeTools) {
    units.push({
      filePath: 'src/composite-tools.ts',
      content: buildCompositeToolsModule(manifest.compositeTools ?? [], manifest.tools),
    });
  }

  // A2A output: also ship an A2A server-wrapper module (AgentCard + JSON-RPC),
  // registered in src/index.ts via the hasA2a template branch.
  if (hasA2a) {
    units.push({
      filePath: 'src/a2a.ts',
      content: buildA2aModule({
        serverName: manifest.serverName,
        serverVersion: manifest.serverVersion,
        baseUrl: manifest.baseUrl,
        tools: manifest.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description ?? '',
        })),
      }),
    });
  }

  return units;
}
