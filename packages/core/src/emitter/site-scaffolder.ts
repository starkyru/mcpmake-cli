/**
 * Scaffolds the project files and shared modules for a site (Playwright-based) MCP server.
 */

import type { SiteProjectManifest, SiteRegenMetadata } from '../types/site.js';
import type { CodeUnit } from './code-writer.js';
import { renderSiteTemplate } from './site-template-loader.js';
import { renderTemplate } from './template-loader.js';

/**
 * Generate project skeleton files (package.json, tsconfig, Dockerfile, etc.)
 */
export function scaffoldSiteProjectFiles(manifest: SiteProjectManifest): CodeUnit[] {
  const units: CodeUnit[] = [
    {
      filePath: 'package.json',
      content: renderSiteTemplate('package.json', manifest),
    },
    {
      filePath: 'tsconfig.json',
      // Reuse the existing tsconfig template — it's the same for both server types
      content: renderTemplate('tsconfig.json', manifest),
    },
    {
      filePath: '.env.example',
      content: renderSiteTemplate('env.example', manifest),
    },
    {
      filePath: '.gitignore',
      content: renderTemplate('gitignore', manifest),
    },
    {
      filePath: 'Dockerfile',
      content: renderSiteTemplate('dockerfile', manifest),
    },
    {
      // Regeneration metadata for `mcpmake rescan` (see SiteRegenMetadata).
      filePath: 'mcpmake.site.json',
      content: JSON.stringify(
        {
          serverName: manifest.serverName,
          serverVersion: manifest.serverVersion,
          transport: manifest.transport,
          baseUrl: manifest.baseUrl,
          envVars: manifest.envVars,
          browserConfig: manifest.browserConfig,
        } satisfies SiteRegenMetadata,
        null,
        2,
      ),
    },
  ];

  return units;
}

/**
 * Generate shared source modules (server entry, config, browser manager).
 */
export function scaffoldSiteSharedModules(manifest: SiteProjectManifest): CodeUnit[] {
  const serverMainTemplate =
    manifest.transport === 'http' ? 'server-main-http.ts' : 'server-main.ts';

  return [
    {
      filePath: 'src/index.ts',
      content: renderSiteTemplate(serverMainTemplate, manifest),
    },
    {
      filePath: 'src/config.ts',
      content: renderSiteTemplate('config.ts', manifest),
    },
    {
      filePath: 'src/browser-manager.ts',
      content: renderSiteTemplate('browser-manager.ts', manifest),
    },
    {
      filePath: 'src/site-descriptor.json',
      content: JSON.stringify(manifest.siteDescriptor, null, 2),
    },
  ];
}
