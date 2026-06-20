/**
 * Scaffolds the project files and shared modules for a site (Playwright-based) MCP server.
 */

import type { SiteProjectManifest, SiteRegenMetadata, SiteDescriptor } from '../types/site.js';
import type { CodeUnit } from './code-writer.js';
import { isSensitiveField } from '../analyzer/dom-parser.js';
import { renderSiteTemplate } from './site-template-loader.js';
import { renderTemplate } from './template-loader.js';

/**
 * Defense-in-depth before writing `site-descriptor.json`: strip any
 * default/prefilled value from sensitive (password/credential) form fields so
 * a captured live secret can never be serialized into the generated project,
 * even if it slipped through an older parser or hand-edited descriptor (M9).
 */
function stripSensitiveDefaults(descriptor: SiteDescriptor): SiteDescriptor {
  return {
    ...descriptor,
    pages: descriptor.pages.map((page) => ({
      ...page,
      forms: page.forms.map((form) => ({
        ...form,
        fields: form.fields.map((field) =>
          field.defaultValue !== undefined && isSensitiveField(field.name, field.fieldType, '')
            ? { ...field, defaultValue: undefined }
            : field,
        ),
      })),
    })),
  };
}

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
      // Best-effort browser-session telemetry for exact metering on managed
      // hosting. No-ops unless the host injects MCPMAKE_TELEMETRY_URL.
      filePath: 'src/telemetry.ts',
      content: renderSiteTemplate('telemetry.ts', manifest),
    },
    {
      filePath: 'src/site-descriptor.json',
      content: JSON.stringify(stripSensitiveDefaults(manifest.siteDescriptor), null, 2),
    },
  ];
}
