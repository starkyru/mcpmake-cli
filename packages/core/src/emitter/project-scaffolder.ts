import type { ProjectManifest } from '../types/index.js';
import type { CodeUnit } from './code-writer.js';
import { renderTemplate } from './template-loader.js';

/**
 * At/above this tool count, registering every tool upfront is a real token-cost
 * problem; the README recommends `--dynamic-discovery` (the #1 buyer concern).
 */
const DISCOVERY_RECOMMEND_THRESHOLD = 50;

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
        authEnvVars: manifest.envVars.filter((v) => v.name !== 'BASE_URL'),
        // Pre-seed MCP_ENVIRONMENTS when an importer carried over named
        // environments (e.g. Stainless `environments:`); omitted otherwise.
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
  const templateData = {
    ...manifest,
    hasResources: (manifest.resources?.length ?? 0) > 0,
    hasPrompts: (manifest.prompts?.length ?? 0) > 0,
    hasOAuth,
    hasDynamicDiscovery,
    hasStaticTools,
    hasAsyncTools,
  };
  return [
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
}
